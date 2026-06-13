const router = require('express').Router();
const { Op } = require('sequelize');
const { Post, Comment, Like, Favorite, User, Block } = require('../models');
const { authRequired } = require('../middleware/auth');
const {
  validateIdParam, parsePage, notify, isBlockedBetween,
  cascadeDeletePosts, cascadeDeleteComments, escapeLike
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
    const { content, images } = req.body;
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
    const post = await Post.create({
      userId: req.user.id,
      content: content.trim(),
      images: Array.isArray(images) && images.length ? JSON.stringify(images) : null
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

// 动态列表（广场，支持按用户筛选 + 关键词搜索）
// GET /api/posts?userId=&keyword=&page=&pageSize=
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

    const { rows, count } = await Post.findAndCountAll({
      where,
      include: [
        { model: User, as: 'author', attributes: AUTHOR_ATTRS },
        { model: Like, as: 'likes', attributes: ['userId'] }
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
        { model: Comment, as: 'comments', include: [{ model: User, as: 'author', attributes: AUTHOR_ATTRS }] },
        { model: Like, as: 'likes', attributes: ['userId'] }
      ],
      order: [[{ model: Comment, as: 'comments' }, 'createdAt', 'ASC']]
    });
    if (!post) return res.status(404).json({ code: 404, message: '动态不存在' });

    // 与作者存在拉黑关系时视为不可见
    if (await isBlockedBetween(req.user.id, post.userId)) {
      return res.status(404).json({ code: 404, message: '动态不存在' });
    }

    const json = serializePost(post, req.user.id);
    const fav = await Favorite.findOne({ where: { postId: post.id, userId: req.user.id } });
    json.favorited = !!fav;
    res.json({ code: 0, data: json });
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
    const { content } = req.body;
    // 同上：先判类型，避免非字符串 content 触发 .trim() 异常 → 500
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ code: 400, message: '评论内容不能为空' });
    }
    const post = await Post.findByPk(req.params.id);
    if (!post) return res.status(404).json({ code: 404, message: '动态不存在' });
    if (await isBlockedBetween(req.user.id, post.userId)) {
      return res.status(403).json({ code: 403, message: '无法评论该动态' });
    }

    const comment = await Comment.create({
      postId: post.id,
      userId: req.user.id,
      content: content.trim()
    });
    await notify({
      userId: post.userId, type: 'comment', actorId: req.user.id,
      postId: post.id, content: comment.content.slice(0, 100)
    });
    res.status(201).json({ code: 0, message: '评论成功', data: comment });
  } catch (err) { next(err); }
});

// 评论列表（分页）
router.get('/:id/comments', validateIdParam('id'), async (req, res, next) => {
  try {
    const post = await Post.findByPk(req.params.id);
    if (!post) return res.status(404).json({ code: 404, message: '动态不存在' });

    const { page, pageSize, offset, limit } = parsePage(req, 20, 100);
    const { rows, count } = await Comment.findAndCountAll({
      where: { postId: post.id },
      include: [{ model: User, as: 'author', attributes: AUTHOR_ATTRS }],
      order: [['createdAt', 'ASC']],
      offset, limit
    });
    res.json({ code: 0, data: { list: rows, total: count, page, pageSize } });
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
