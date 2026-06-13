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

// 解析分页参数（健壮性：处理 NaN）
function parsePage(req, defaultSize = 20, maxSize = 50) {
  const pageRaw = parseInt(req.query.page);
  const pageSizeRaw = parseInt(req.query.pageSize);
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const pageSize = Number.isInteger(pageSizeRaw) && pageSizeRaw > 0
    ? Math.min(maxSize, pageSizeRaw)
    : defaultSize;
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

// 转义 SQL LIKE 通配符，防止注入
function escapeLike(str) {
  if (typeof str !== 'string') return '';
  // 转义 % _ \ 三个特殊字符
  return str.replace(/[%_\\]/g, '\\$&');
}

// 解析和校验标签数组
function parseTags(tags) {
  if (!tags) return null;
  if (!Array.isArray(tags)) {
    throw new Error('标签必须是数组');
  }
  if (tags.length === 0) return null;
  if (tags.length > 5) {
    throw new Error('最多添加 5 个标签');
  }

  const cleaned = [];
  const seen = new Set();

  for (const tag of tags) {
    if (typeof tag !== 'string') {
      throw new Error('标签必须是字符串');
    }
    const trimmed = tag.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > 20) {
      throw new Error('标签最长 20 字符');
    }
    // 去重
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      cleaned.push(trimmed);
    }
  }

  return cleaned.length > 0 ? JSON.stringify(cleaned) : null;
}

// 序列化标签（JSON 字符串转数组）
function serializeTags(tagsJson) {
  if (!tagsJson) return [];
  try {
    const arr = JSON.parse(tagsJson);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// 构建评论树（将扁平评论数组转为树形结构）
function buildCommentTree(comments) {
  const map = new Map();
  const roots = [];

  // 第一遍：创建映射
  for (const comment of comments) {
    const json = comment.toJSON ? comment.toJSON() : comment;
    json.replies = [];
    map.set(json.id, json);
  }

  // 第二遍：构建树
  for (const comment of map.values()) {
    if (comment.parentId === null || comment.parentId === undefined) {
      roots.push(comment);
    } else {
      const parent = map.get(comment.parentId);
      if (parent) {
        parent.replies.push(comment);
      } else {
        // 父评论不存在（可能已删除），作为顶级评论
        roots.push(comment);
      }
    }
  }

  return roots;
}

// 解析和校验提及的用户 ID 数组
async function parseMentions(mentions, User) {
  if (!mentions) return null;
  if (!Array.isArray(mentions)) {
    throw new Error('mentions 必须是数组');
  }
  if (mentions.length === 0) return null;
  if (mentions.length > 20) {
    throw new Error('最多提及 20 个用户');
  }

  const userIds = [];
  const seen = new Set();

  for (const id of mentions) {
    const uid = Number(id);
    if (!Number.isInteger(uid) || uid <= 0) {
      throw new Error('mentions 中的用户 ID 必须是正整数');
    }
    if (!seen.has(uid)) {
      seen.add(uid);
      userIds.push(uid);
    }
  }

  if (userIds.length === 0) return null;

  // 校验用户是否存在
  const users = await User.findAll({
    where: { id: userIds, role: 'user', status: 'active' },
    attributes: ['id']
  });

  if (users.length !== userIds.length) {
    throw new Error('mentions 中包含不存在或已封禁的用户');
  }

  return JSON.stringify(userIds);
}

// 批量发送提及通知
async function notifyMentions(mentions, sourceType, sourceId, mentionerId, postId = null) {
  if (!mentions) return;
  try {
    const userIds = JSON.parse(mentions);
    if (!Array.isArray(userIds)) return;

    for (const userId of userIds) {
      if (userId === mentionerId) continue; // 不通知自己
      await notify({
        userId,
        type: 'mention',
        actorId: mentionerId,
        postId,
        content: `在${sourceType === 'post' ? '动态' : '评论'}中提及了你`
      });
    }
  } catch (err) {
    console.error('[notifyMentions] 发送提及通知失败:', err.message);
  }
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

  // 同一事务绑定单条连接，逐条顺序执行（避免在同一连接上并发多条语句的反模式）
  await Comment.destroy({ where: { postId: { [Op.in]: postIds } }, transaction: t });
  await Like.destroy({ where: { postId: { [Op.in]: postIds } }, transaction: t });
  await Favorite.destroy({ where: { postId: { [Op.in]: postIds } }, transaction: t });
  await Notification.destroy({ where: { postId: { [Op.in]: postIds } }, transaction: t });
  await Report.destroy({
    where: {
      [Op.or]: [
        { targetType: 'post', targetId: { [Op.in]: postIds } },
        ...(commentIds.length ? [{ targetType: 'comment', targetId: { [Op.in]: commentIds } }] : [])
      ]
    },
    transaction: t
  });
  await Post.destroy({ where: { id: { [Op.in]: postIds } }, transaction: t });
}

// 级联删除评论:连带针对这些评论的举报和子评论，最后删评论本身。必须在事务中调用。
async function cascadeDeleteComments(commentIds, t) {
  if (!commentIds || !commentIds.length) return;

  // 查找所有子评论（递归）
  const allCommentIds = new Set(commentIds);
  let toProcess = [...commentIds];

  while (toProcess.length > 0) {
    const children = await Comment.findAll({
      where: { parentId: { [Op.in]: toProcess } },
      attributes: ['id'],
      transaction: t
    });
    toProcess = [];
    for (const child of children) {
      if (!allCommentIds.has(child.id)) {
        allCommentIds.add(child.id);
        toProcess.push(child.id);
      }
    }
  }

  const finalIds = [...allCommentIds];
  await Report.destroy({
    where: { targetType: 'comment', targetId: { [Op.in]: finalIds } },
    transaction: t
  });
  await Comment.destroy({ where: { id: { [Op.in]: finalIds } }, transaction: t });
}

module.exports = {
  validateIdParam, parsePage, notify, isBlockedBetween,
  cascadeDeletePosts, cascadeDeleteComments, escapeLike,
  parseTags, serializeTags, buildCommentTree, parseMentions, notifyMentions
};
