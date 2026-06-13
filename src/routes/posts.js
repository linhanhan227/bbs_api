const router = require('express').Router();
const { Op } = require('sequelize');
const { Post, Comment, Like, Favorite, User, Block } = require('../models');
const { authRequired } = require('../middleware/auth');
const {
  validateIdParam, parsePage, notify, isBlockedBetween,
  cascadeDeletePosts, cascadeDeleteComments, escapeLike,
  parseTags, serializeTags, buildCommentTree
} = require('../utils/helpers');
const { sequelize } = require('../config/database');

const AUTHOR_ATTRS = ['id', 'nickname', 'avatar'];

router.use(authRequired);

function parseImages(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function serializePost(post, currentUserId) {
  const json = post.toJSON();
  json.images = parseImages(json.images);
  json.tags = serializeTags(json.tags);

  // 处理转发信息
  if (json.isRepost && json.originalPost) {
    const originalPost = json.originalPost;
    json.originalPost = {
      id: originalPost.id,
      content: originalPost.content,
      images: parseImages(originalPost.images),
      tags: serializeTags(originalPost.tags),
      author: originalPost.author,
      createdAt: originalPost.createdAt,
      isDeleted: false
    };
  } else if (json.isRepost && !json.originalPost && json.originalPostId) {
    // 原动态已被删除
    json.originalPost = {
      id: json.originalPostId,
      isDeleted: true,
      content: '原动态已被删除'
    };
  }

  // likes 可能未被 include（如刚发布的动态）；统一输出 likeCount/liked，保证响应结构一致
  const likes = Array.isArray(json.likes) ? json.likes : [];
  json.likeCount = likes.length;
  json.liked = likes.some(l => l.userId === currentUserId);
  delete json.likes;
  return json;
}

// 发布动态
router.post('/', async (req, res, next) => {
  try {
    const { content, images, tags } = req.body;
    // 先判类型：content 非字符串（如客户端误传数字/对象）时 .trim() 会抛异常导致 500
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ code: 400, message: '内容不能为空' });
    }
    if (content.trim().length > 5000) {
      return res.status(400).json({ code: 400, message: '动态内容最长 5000 字符' });
    }
    if (images !== undefined) {
      if (!Array.isArray(images)) {
        return res.status(400).json({ code: 400, message: 'images 必须是数组' });
      }
      if (images.length > 9) {
        return res.status(400).json({ code: 400, message: '最多上传 9 张图片' });
      }
      for (const img of images) {
        if (typeof img !== 'string' || img.length > 500) {
          return res.status(400).json({ code: 400, message: '图片 URL 必须是字符串且不超过 500 字符' });
        }
      }
    }

    // 解析和校验标签
    let tagsJson = null;
    try {
      tagsJson = parseTags(tags);
    } catch (err) {
      return res.status(400).json({ code: 400, message: err.message });
    }

    const post = await Post.create({
      userId: req.user.id,
      content: content.trim(),
      images: Array.isArray(images) && images.length ? JSON.stringify(images) : null,
      tags: tagsJson
    });
    res.status(201).json({ code: 0, message: '发布成功', data: serializePost(post, req.user.id) });
  } catch (err) { next(err); }
});

// 我的收藏列表（必须定义在 /:id 之前，避免被参数路由吞掉）
router.get('/favorites/mine', async (req, res, next) => {
  try {
    const { page, pageSize, offset, limit } = parsePage(req);
    const { rows, count } = await Favorite.findAndCountAll({
      where: { userId: req.user.id },
      include: [{
        model: Post, as: 'post',
        include: [
          { model: User, as: 'author', attributes: AUTHOR_ATTRS },
          { model: Like, as: 'likes', attributes: ['userId'] }
        ]
      }],
      order: [['createdAt', 'DESC']],
      offset, limit,
      distinct: true // 内层 include 了 Post->likes(hasMany),不加 distinct 会使 count 因 JOIN 放大而虚高
    });
    const list = rows
      .filter(f => f.post) // 动态可能已被删除
      .map(f => {
        const json = serializePost(f.post, req.user.id);
        return { favoriteId: f.id, favoritedAt: f.createdAt, post: json };
      });
    res.json({ code: 0, data: { list, total: count, page, pageSize } });
  } catch (err) { next(err); }
});

// 动态列表（广场，支持按用户筛选 + 关键词搜索 + 标签筛选）
// GET /api/posts?userId=&keyword=&tag=&page=&pageSize=
router.get('/', async (req, res, next) => {
  try {
    const { page, pageSize, offset, limit } = parsePage(req);
    const where = {};

    // 排除与我有任一方向拉黑关系的用户的动态（与用户广场 users.js 保持一致）
    const blockRows = await Block.findAll({
      where: { [Op.or]: [{ userId: req.user.id }, { blockedId: req.user.id }] },
      attributes: ['userId', 'blockedId']
    });
    const excludeIds = new Set();
    for (const b of blockRows) {
      excludeIds.add(b.userId === req.user.id ? b.blockedId : b.userId);
    }

    if (req.query.userId !== undefined) {
      const uid = Number(req.query.userId);
      if (!Number.isInteger(uid) || uid <= 0) {
        return res.status(400).json({ code: 400, message: 'userId 必须是正整数' });
      }
      // 精确筛选被拉黑用户：直接返回空列表
      if (excludeIds.has(uid)) {
        return res.json({ code: 0, data: { list: [], total: 0, page, pageSize } });
      }
      where.userId = uid;
    } else if (excludeIds.size) {
      where.userId = { [Op.notIn]: [...excludeIds] };
    }
    if (req.query.keyword) {
      where.content = { [Op.like]: `%${escapeLike(req.query.keyword)}%` };
    }
    // 按标签筛选
    if (req.query.tag) {
      const tag = req.query.tag.trim();
      if (tag) {
        // 使用 JSON 搜索：tags 字段包含该标签
        where.tags = { [Op.like]: `%"${escapeLike(tag)}"%` };
      }
    }

    const { rows, count } = await Post.findAndCountAll({
      where,
      include: [
        { model: User, as: 'author', attributes: AUTHOR_ATTRS },
        { model: Like, as: 'likes', attributes: ['userId'] },
        {
          model: Post,
          as: 'originalPost',
          required: false,
          include: [{ model: User, as: 'author', attributes: AUTHOR_ATTRS }]
        }
      ],
      order: [['createdAt', 'DESC']],
      offset, limit,
      distinct: true
    });

    res.json({
      code: 0,
      data: { list: rows.map(p => serializePost(p, req.user.id)), total: count, page, pageSize }
    });
  } catch (err) { next(err); }
});

// 动态详情（含评论、是否已收藏）
router.get('/:id', validateIdParam('id'), async (req, res, next) => {
  try {
    const post = await Post.findByPk(req.params.id, {
      include: [
        { model: User, as: 'author', attributes: AUTHOR_ATTRS },
        {
          model: Comment,
          as: 'comments',
          include: [
            { model: User, as: 'author', attributes: AUTHOR_ATTRS },
            { model: User, as: 'replyToUser', attributes: AUTHOR_ATTRS }
          ]
        },
        { model: Like, as: 'likes', attributes: ['userId'] },
        {
          model: Post,
          as: 'originalPost',
          required: false,
          include: [{ model: User, as: 'author', attributes: AUTHOR_ATTRS }]
        }
      ],
      order: [[{ model: Comment, as: 'comments' }, 'createdAt', 'ASC']]
    });
    if (!post) return res.status(404).json({ code: 404, message: '动态不存在' });

    // 与作者存在拉黑关系时视为不可见
    if (await isBlockedBetween(req.user.id, post.userId)) {
      return res.status(404).json({ code: 404, message: '动态不存在' });
    }

    const json = serializePost(post, req.user.id);
    // 构建评论树
    json.comments = buildCommentTree(json.comments || []);
    const fav = await Favorite.findOne({ where: { postId: post.id, userId: req.user.id } });
    json.favorited = !!fav;
    res.json({ code: 0, data: json });
  } catch (err) { next(err); }
});

// 转发动态
router.post('/:id/repost', validateIdParam('id'), async (req, res, next) => {
  try {
    const { comment } = req.body;

    // 校验转发评论
    if (comment !== undefined && comment !== null) {
      if (typeof comment !== 'string') {
        return res.status(400).json({ code: 400, message: '转发评论必须是字符串' });
      }
      if (comment.trim().length > 500) {
        return res.status(400).json({ code: 400, message: '转发评论最长 500 字符' });
      }
    }

    const originalPost = await Post.findByPk(req.params.id, {
      include: [{ model: User, as: 'author', attributes: AUTHOR_ATTRS }]
    });
    if (!originalPost) {
      return res.status(404).json({ code: 404, message: '原动态不存在' });
    }

    // 检查拉黑关系
    if (await isBlockedBetween(req.user.id, originalPost.userId)) {
      return res.status(403).json({ code: 403, message: '无法转发该动态' });
    }

    // 不能转发已经是转发的动态（避免多层转发）
    if (originalPost.isRepost) {
      return res.status(400).json({ code: 400, message: '不能转发转发动态，请转发原动态' });
    }

    // 检查是否已转发过（可选限制）
    const existingRepost = await Post.findOne({
      where: {
        userId: req.user.id,
        originalPostId: originalPost.id,
        isRepost: true
      }
    });
    if (existingRepost) {
      return res.status(409).json({ code: 409, message: '你已转发过该动态' });
    }

    // 创建转发动态
    const repost = await Post.create({
      userId: req.user.id,
      content: originalPost.content, // 继承原动态内容
      images: originalPost.images,   // 继承原动态图片
      tags: originalPost.tags,       // 继承原动态标签
      isRepost: true,
      originalPostId: originalPost.id,
      repostComment: comment ? comment.trim() : null
    });

    // 通知原作者
    if (originalPost.userId !== req.user.id) {
      await notify({
        userId: originalPost.userId,
        type: 'repost',
        actorId: req.user.id,
        postId: originalPost.id,
        content: comment ? comment.trim().slice(0, 100) : null
      });
    }

    // 加载完整信息返回
    const fullRepost = await Post.findByPk(repost.id, {
      include: [
        { model: User, as: 'author', attributes: AUTHOR_ATTRS },
        {
          model: Post,
          as: 'originalPost',
          include: [{ model: User, as: 'author', attributes: AUTHOR_ATTRS }]
        }
      ]
    });

    res.status(201).json({
      code: 0,
      message: '转发成功',
      data: serializePost(fullRepost, req.user.id)
    });
  } catch (err) { next(err); }
});

// 删除自己的动态（连带评论、点赞、收藏）
router.delete('/:id', validateIdParam('id'), async (req, res, next) => {
  try {
    const post = await Post.findByPk(req.params.id);
    if (!post) return res.status(404).json({ code: 404, message: '动态不存在' });
    if (post.userId !== req.user.id) {
      return res.status(403).json({ code: 403, message: '只能删除自己的动态' });
    }
    await sequelize.transaction(async (t) => {
      await cascadeDeletePosts([post.id], t);
    });
    res.json({ code: 0, message: '已删除' });
  } catch (err) { next(err); }
});

// 点赞（幂等：重复点赞返回 200 而非报错）
router.put('/:id/like', validateIdParam('id'), async (req, res, next) => {
  try {
    const post = await Post.findByPk(req.params.id);
    if (!post) return res.status(404).json({ code: 404, message: '动态不存在' });
    if (await isBlockedBetween(req.user.id, post.userId)) {
      return res.status(403).json({ code: 403, message: '无法操作该动态' });
    }

    const [, created] = await Like.findOrCreate({
      where: { postId: post.id, userId: req.user.id }
    });
    if (created) {
      await notify({ userId: post.userId, type: 'like', actorId: req.user.id, postId: post.id });
    }
    res.status(created ? 201 : 200).json({ code: 0, message: created ? '点赞成功' : '已点过赞', data: { liked: true } });
  } catch (err) { next(err); }
});

// 取消点赞（幂等）
router.delete('/:id/like', validateIdParam('id'), async (req, res, next) => {
  try {
    await Like.destroy({ where: { postId: req.params.id, userId: req.user.id } });
    res.json({ code: 0, message: '已取消点赞', data: { liked: false } });
  } catch (err) { next(err); }
});

// 收藏（幂等）
router.put('/:id/favorite', validateIdParam('id'), async (req, res, next) => {
  try {
    const post = await Post.findByPk(req.params.id);
    if (!post) return res.status(404).json({ code: 404, message: '动态不存在' });

    const [, created] = await Favorite.findOrCreate({
      where: { postId: post.id, userId: req.user.id }
    });
    res.status(created ? 201 : 200).json({ code: 0, message: created ? '收藏成功' : '已收藏过', data: { favorited: true } });
  } catch (err) { next(err); }
});

// 取消收藏（幂等）
router.delete('/:id/favorite', validateIdParam('id'), async (req, res, next) => {
  try {
    await Favorite.destroy({ where: { postId: req.params.id, userId: req.user.id } });
    res.json({ code: 0, message: '已取消收藏', data: { favorited: false } });
  } catch (err) { next(err); }
});

// 发表评论
router.post('/:id/comments', validateIdParam('id'), async (req, res, next) => {
  try {
    const { content, parentId, replyToUserId } = req.body;
    // 同上：先判类型，避免非字符串 content 触发 .trim() 异常 → 500
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ code: 400, message: '评论内容不能为空' });
    }
    const post = await Post.findByPk(req.params.id);
    if (!post) return res.status(404).json({ code: 404, message: '动态不存在' });
    if (await isBlockedBetween(req.user.id, post.userId)) {
      return res.status(403).json({ code: 403, message: '无法评论该动态' });
    }

    // 校验 parentId（如果是回复评论）
    let rootId = null;
    let validReplyToUserId = null;
    if (parentId !== undefined && parentId !== null) {
      const parentIdNum = Number(parentId);
      if (!Number.isInteger(parentIdNum) || parentIdNum <= 0) {
        return res.status(400).json({ code: 400, message: 'parentId 必须是正整数' });
      }
      const parentComment = await Comment.findOne({
        where: { id: parentIdNum, postId: post.id }
      });
      if (!parentComment) {
        return res.status(404).json({ code: 404, message: '父评论不存在或不属于该动态' });
      }
      // 计算 rootId：如果父评论本身就是顶级评论，rootId 就是它；否则继承父评论的 rootId
      rootId = parentComment.rootId || parentComment.id;

      // 校验 replyToUserId
      if (replyToUserId !== undefined && replyToUserId !== null) {
        const targetUserId = Number(replyToUserId);
        if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
          return res.status(400).json({ code: 400, message: 'replyToUserId 必须是正整数' });
        }
        validReplyToUserId = targetUserId;
      } else {
        // 默认回复父评论作者
        validReplyToUserId = parentComment.userId;
      }
    }

    const comment = await Comment.create({
      postId: post.id,
      userId: req.user.id,
      content: content.trim(),
      parentId: parentId || null,
      rootId: rootId,
      replyToUserId: validReplyToUserId
    });

    // 发送通知
    if (validReplyToUserId && validReplyToUserId !== req.user.id) {
      // 回复评论：通知被回复者
      await notify({
        userId: validReplyToUserId,
        type: 'comment',
        actorId: req.user.id,
        postId: post.id,
        content: comment.content.slice(0, 100)
      });
    }
    // 如果不是回复评论，或动态作者与被回复者不同，也通知动态作者
    if (post.userId !== req.user.id && (!validReplyToUserId || post.userId !== validReplyToUserId)) {
      await notify({
        userId: post.userId,
        type: 'comment',
        actorId: req.user.id,
        postId: post.id,
        content: comment.content.slice(0, 100)
      });
    }

    res.status(201).json({ code: 0, message: '评论成功', data: comment });
  } catch (err) { next(err); }
});

// 评论列表（分页，支持扁平或树形）
// GET /api/posts/:id/comments?flat=0&page=1&pageSize=20
router.get('/:id/comments', validateIdParam('id'), async (req, res, next) => {
  try {
    const post = await Post.findByPk(req.params.id);
    if (!post) return res.status(404).json({ code: 404, message: '动态不存在' });

    const flat = req.query.flat === '1' || req.query.flat === 'true';
    const { page, pageSize, offset, limit } = parsePage(req, 20, 100);

    if (flat) {
      // 扁平模式：按时间顺序返回所有评论
      const { rows, count } = await Comment.findAndCountAll({
        where: { postId: post.id },
        include: [
          { model: User, as: 'author', attributes: AUTHOR_ATTRS },
          { model: User, as: 'replyToUser', attributes: AUTHOR_ATTRS }
        ],
        order: [['createdAt', 'ASC']],
        offset, limit
      });
      res.json({ code: 0, data: { list: rows, total: count, page, pageSize } });
    } else {
      // 树形模式：仅对顶级评论分页，子评论全量加载
      const { rows: topComments, count } = await Comment.findAndCountAll({
        where: { postId: post.id, parentId: null },
        attributes: ['id'],
        order: [['createdAt', 'ASC']],
        offset, limit
      });

      if (topComments.length === 0) {
        return res.json({ code: 0, data: { list: [], total: count, page, pageSize } });
      }

      const topIds = topComments.map(c => c.id);

      // 加载这些顶级评论及其所有子孙评论
      const allComments = await Comment.findAll({
        where: {
          [Op.or]: [
            { id: { [Op.in]: topIds } },
            { rootId: { [Op.in]: topIds } }
          ]
        },
        include: [
          { model: User, as: 'author', attributes: AUTHOR_ATTRS },
          { model: User, as: 'replyToUser', attributes: AUTHOR_ATTRS }
        ],
        order: [['createdAt', 'ASC']]
      });

      const tree = buildCommentTree(allComments);
      res.json({ code: 0, data: { list: tree, total: count, page, pageSize } });
    }
  } catch (err) { next(err); }
});

// 删除评论（评论作者或动态作者均可删除）
router.delete('/:postId/comments/:commentId', validateIdParam('postId', 'commentId'), async (req, res, next) => {
  try {
    const comment = await Comment.findOne({
      where: { id: req.params.commentId, postId: req.params.postId },
      include: [{ model: Post, attributes: ['userId'] }]
    });
    if (!comment) return res.status(404).json({ code: 404, message: '评论不存在' });
    const isCommentAuthor = comment.userId === req.user.id;
    const isPostAuthor = comment.Post && comment.Post.userId === req.user.id;
    if (!isCommentAuthor && !isPostAuthor) {
      return res.status(403).json({ code: 403, message: '无权删除该评论' });
    }
    await sequelize.transaction(async (t) => {
      await cascadeDeleteComments([comment.id], t);
    });
    res.json({ code: 0, message: '已删除' });
  } catch (err) { next(err); }
});

module.exports = router;
