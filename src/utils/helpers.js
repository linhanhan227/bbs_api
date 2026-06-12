const { Op } = require('sequelize');
const { Notification, Block, Comment, Like, Favorite, Post, Report } = require('../models');

// 校验路径参数为正整数，否则返回 400（REST 规范：客户端错误不应产生 500）
function validateIdParam(...names) {
  return (req, res, next) => {
    for (const name of names) {
      const v = Number(req.params[name]);
      if (!Number.isInteger(v) || v <= 0) {
        return res.status(400).json({ code: 400, message: `参数 ${name} 必须是正整数` });
      }
      req.params[name] = v;
    }
    next();
  };
}

// 解析分页参数
function parsePage(req, defaultSize = 20, maxSize = 50) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, parseInt(req.query.pageSize) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

// 创建通知（自己触发自己的行为不通知；失败不影响主流程）
async function notify({ userId, type, actorId = null, postId = null, content = null }) {
  if (actorId && actorId === userId) return;
  try {
    await Notification.create({ userId, type, actorId, postId, content });
  } catch (err) {
    console.error('[notify] 创建通知失败:', err.message);
  }
}

// 任一方向存在拉黑关系
async function isBlockedBetween(a, b) {
  const row = await Block.findOne({
    where: {
      [Op.or]: [
        { userId: a, blockedId: b },
        { userId: b, blockedId: a }
      ]
    }
  });
  return !!row;
}

// 级联删除动态:连带评论、点赞、收藏、关联通知、针对动态/其评论的举报，最后删动态本身。
// 必须在事务中调用，保证一致性（各删除接口共用此逻辑，避免行为分叉）。
async function cascadeDeletePosts(postIds, t) {
  if (!postIds || !postIds.length) return;
  const comments = await Comment.findAll({
    where: { postId: { [Op.in]: postIds } },
    attributes: ['id'],
    transaction: t
  });
  const commentIds = comments.map(c => c.id);

  await Promise.all([
    Comment.destroy({ where: { postId: { [Op.in]: postIds } }, transaction: t }),
    Like.destroy({ where: { postId: { [Op.in]: postIds } }, transaction: t }),
    Favorite.destroy({ where: { postId: { [Op.in]: postIds } }, transaction: t }),
    Notification.destroy({ where: { postId: { [Op.in]: postIds } }, transaction: t }),
    Report.destroy({
      where: {
        [Op.or]: [
          { targetType: 'post', targetId: { [Op.in]: postIds } },
          ...(commentIds.length ? [{ targetType: 'comment', targetId: { [Op.in]: commentIds } }] : [])
        ]
      },
      transaction: t
    })
  ]);
  await Post.destroy({ where: { id: { [Op.in]: postIds } }, transaction: t });
}

// 级联删除评论:连带针对这些评论的举报，最后删评论本身。必须在事务中调用。
async function cascadeDeleteComments(commentIds, t) {
  if (!commentIds || !commentIds.length) return;
  await Report.destroy({
    where: { targetType: 'comment', targetId: { [Op.in]: commentIds } },
    transaction: t
  });
  await Comment.destroy({ where: { id: { [Op.in]: commentIds } }, transaction: t });
}

module.exports = {
  validateIdParam, parsePage, notify, isBlockedBetween,
  cascadeDeletePosts, cascadeDeleteComments
};
