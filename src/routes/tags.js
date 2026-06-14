const router = require('express').Router();
const { Op } = require('sequelize');
const { Post, User, Like } = require('../models');
const { authRequired } = require('../middleware/auth');
const { parsePage, serializeTags, escapeLike } = require('../utils/helpers');

const AUTHOR_ATTRS = ['id', 'nickname', 'avatar'];

router.use(authRequired);

// 热门话题榜
// GET /api/tags/hot?limit=10
router.get('/hot', async (req, res, next) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));

    // 获取所有有标签的动态
    const posts = await Post.findAll({
      where: { tags: { [Op.ne]: null } },
      attributes: ['tags'],
      raw: true
    });

    // 统计标签使用次数
    const tagCount = new Map();
    for (const post of posts) {
      const tags = serializeTags(post.tags);
      for (const tag of tags) {
        tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
      }
    }

    // 排序并返回前 N 个
    const hotTags = Array.from(tagCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([name, count]) => ({ name, count }));

    res.json({ code: 0, data: hotTags });
  } catch (err) { next(err); }
});

// 某话题下的动态列表
// GET /api/tags/:tag/posts?page=1&pageSize=20
router.get('/:tag/posts', async (req, res, next) => {
  try {
    const tag = req.params.tag.trim();
    if (!tag) {
      return res.status(400).json({ code: 400, message: '标签不能为空' });
    }
    // 防止标签过长导致性能问题
    if (tag.length > 20) {
      return res.status(400).json({ code: 400, message: '标签最长 20 字符' });
    }

    const { page, pageSize, offset, limit } = parsePage(req);

    // 使用参数化的 LIKE 查询，防止 SQL 注入
    const escapedTag = escapeLike(tag);
    const { rows, count } = await Post.findAndCountAll({
      where: { tags: { [Op.like]: `%"${escapedTag}"%` } },
      include: [
        { model: User, as: 'author', attributes: AUTHOR_ATTRS },
        { model: Like, as: 'likes', attributes: ['userId'] }
      ],
      order: [['createdAt', 'DESC']],
      offset, limit,
      distinct: true
    });

    const list = rows.map(p => {
      const json = p.toJSON();
      json.tags = serializeTags(json.tags);
      const likes = Array.isArray(json.likes) ? json.likes : [];
      json.likeCount = likes.length;
      json.liked = likes.some(l => l.userId === req.user.id);
      delete json.likes;
      // 解析 images
      if (json.images) {
        try {
          const arr = JSON.parse(json.images);
          json.images = Array.isArray(arr) ? arr : [];
        } catch {
          json.images = [];
        }
      } else {
        json.images = [];
      }
      return json;
    });

    res.json({ code: 0, data: { list, total: count, page, pageSize } });
  } catch (err) { next(err); }
});

module.exports = router;
