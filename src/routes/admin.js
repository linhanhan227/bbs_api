const router = require('express').Router();
const { Op } = require('sequelize');
const {
  User, Post, Comment, Like, Favorite, Friendship,
  Follow, Block, Message, Notification, Report
} = require('../models');
const { adminRequired } = require('../middleware/auth');
const { sequelize } = require('../config/database');
const { cascadeDeletePosts, cascadeDeleteComments, escapeLike } = require('../utils/helpers');

// ===== 登录 / 登出 =====
router.get('/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.render('admin/login', { error: null, csrfToken: req.csrfToken() });
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ where: { username: username || '', role: 'admin' } });
    if (!user || !(await user.checkPassword(password || ''))) {
      return res.render('admin/login', { error: '用户名或密码错误', csrfToken: req.csrfToken() });
    }

    // 重新生成 session ID，防止会话固定攻击
    const adminData = { id: user.id, username: user.username, nickname: user.nickname };
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.admin = adminData;
      res.redirect('/admin');
    });
  } catch (err) { next(err); }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

router.use(adminRequired);

// ===== 仪表盘 =====
router.get('/', async (req, res, next) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [
      userCount, postCount, commentCount, friendshipCount, messageCount,
      todayUsers, todayPosts, bannedCount, pendingReports
    ] = await Promise.all([
      User.count({ where: { role: 'user' } }),
      Post.count(),
      Comment.count(),
      Friendship.count({ where: { status: 'accepted' } }),
      Message.count(),
      User.count({ where: { role: 'user', createdAt: { [Op.gte]: today } } }),
      Post.count({ where: { createdAt: { [Op.gte]: today } } }),
      User.count({ where: { status: 'banned' } }),
      Report.count({ where: { status: 'pending' } })
    ]);
    res.render('admin/dashboard', {
      admin: req.session.admin,
      active: 'dashboard',
      csrfToken: req.csrfToken(),
      stats: {
        userCount, postCount, commentCount, friendshipCount, messageCount,
        todayUsers, todayPosts, bannedCount, pendingReports
      }
    });
  } catch (err) { next(err); }
});

// ===== 用户管理 =====
router.get('/users', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = 15;
    const keyword = (req.query.keyword || '').trim();
    const where = { role: 'user' };
    if (keyword) {
      where[Op.or] = [
        { username: { [Op.like]: `%${escapeLike(keyword)}%` } },
        { nickname: { [Op.like]: `%${escapeLike(keyword)}%` } }
      ];
    }
    const { rows, count } = await User.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      offset: (page - 1) * pageSize,
      limit: pageSize
    });
    res.render('admin/users', {
      admin: req.session.admin,
      active: 'users',
      csrfToken: req.csrfToken(),
      users: rows,
      keyword,
      page,
      totalPages: Math.max(1, Math.ceil(count / pageSize)),
      total: count
    });
  } catch (err) { next(err); }
});

// 封禁 / 解封
router.post('/users/:id/toggle-ban', async (req, res, next) => {
  try {
    const user = await User.findOne({ where: { id: req.params.id, role: 'user' } });
    if (user) {
      user.status = user.status === 'banned' ? 'active' : 'banned';
      await user.save();
    }
    res.redirect(req.get('referer') || '/admin/users');
  } catch (err) { next(err); }
});

// 删除用户（连带其全部数据）
router.post('/users/:id/delete', async (req, res, next) => {
  try {
    const user = await User.findOne({ where: { id: req.params.id, role: 'user' } });
    if (user) {
      await sequelize.transaction(async (t) => {
        const uid = user.id;
        const posts = await Post.findAll({ where: { userId: uid }, attributes: ['id'], transaction: t });
        const postIds = posts.map(p => p.id);
        // 该用户作为作者的评论 + 其动态下的评论（用于清理这些评论的举报）
        const comments = await Comment.findAll({
          where: {
            [Op.or]: [
              { userId: uid },
              ...(postIds.length ? [{ postId: { [Op.in]: postIds } }] : [])
            ]
          },
          attributes: ['id'],
          transaction: t
        });
        const commentIds = comments.map(c => c.id);
        if (postIds.length) {
          await Promise.all([
            Comment.destroy({ where: { postId: { [Op.in]: postIds } }, transaction: t }),
            Like.destroy({ where: { postId: { [Op.in]: postIds } }, transaction: t }),
            Favorite.destroy({ where: { postId: { [Op.in]: postIds } }, transaction: t }),
            Notification.destroy({ where: { postId: { [Op.in]: postIds } }, transaction: t })
          ]);
        }
        await Promise.all([
          Post.destroy({ where: { userId: uid }, transaction: t }),
          Comment.destroy({ where: { userId: uid }, transaction: t }),
          Like.destroy({ where: { userId: uid }, transaction: t }),
          Favorite.destroy({ where: { userId: uid }, transaction: t }),
          Friendship.destroy({ where: { [Op.or]: [{ requesterId: uid }, { addresseeId: uid }] }, transaction: t }),
          Follow.destroy({ where: { [Op.or]: [{ followerId: uid }, { followingId: uid }] }, transaction: t }),
          Block.destroy({ where: { [Op.or]: [{ userId: uid }, { blockedId: uid }] }, transaction: t }),
          Message.destroy({ where: { [Op.or]: [{ senderId: uid }, { receiverId: uid }] }, transaction: t }),
          Notification.destroy({ where: { [Op.or]: [{ userId: uid }, { actorId: uid }] }, transaction: t }),
          // 清理孤儿举报：该用户提交的 / 针对该用户的 / 针对其动态的 / 针对其评论的
          Report.destroy({
            where: {
              [Op.or]: [
                { reporterId: uid },
                { targetType: 'user', targetId: uid },
                ...(postIds.length ? [{ targetType: 'post', targetId: { [Op.in]: postIds } }] : []),
                ...(commentIds.length ? [{ targetType: 'comment', targetId: { [Op.in]: commentIds } }] : [])
              ]
            },
            transaction: t
          })
        ]);
        await user.destroy({ transaction: t });
      });
    }
    res.redirect('/admin/users');
  } catch (err) { next(err); }
});

// ===== 动态管理 =====
router.get('/posts', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = 15;
    const { rows, count } = await Post.findAndCountAll({
      include: [{ model: User, as: 'author', attributes: ['id', 'username', 'nickname'] }],
      order: [['createdAt', 'DESC']],
      offset: (page - 1) * pageSize,
      limit: pageSize
    });
    res.render('admin/posts', {
      admin: req.session.admin,
      active: 'posts',
      csrfToken: req.csrfToken(),
      posts: rows,
      page,
      totalPages: Math.max(1, Math.ceil(count / pageSize)),
      total: count
    });
  } catch (err) { next(err); }
});

router.post('/posts/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    // 校验 id 为正整数：非法 id（如 NaN）不应进入事务/查询
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).send('无效的动态 ID');
    }
    await sequelize.transaction(async (t) => {
      await cascadeDeletePosts([id], t);
    });
    res.redirect(req.get('referer') || '/admin/posts');
  } catch (err) { next(err); }
});

// ===== 评论管理 =====
router.get('/comments', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = 20;
    const keyword = (req.query.keyword || '').trim();
    const where = {};
    if (keyword) where.content = { [Op.like]: `%${escapeLike(keyword)}%` };

    const { rows, count } = await Comment.findAndCountAll({
      where,
      include: [{ model: User, as: 'author', attributes: ['id', 'username', 'nickname'] }],
      order: [['createdAt', 'DESC']],
      offset: (page - 1) * pageSize,
      limit: pageSize
    });
    res.render('admin/comments', {
      admin: req.session.admin,
      active: 'comments',
      csrfToken: req.csrfToken(),
      comments: rows,
      keyword,
      page,
      totalPages: Math.max(1, Math.ceil(count / pageSize)),
      total: count
    });
  } catch (err) { next(err); }
});

router.post('/comments/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).send('无效的评论 ID');
    }
    await sequelize.transaction(async (t) => {
      await cascadeDeleteComments([id], t);
    });
    res.redirect(req.get('referer') || '/admin/comments');
  } catch (err) { next(err); }
});

// ===== 举报管理 =====
router.get('/reports', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = 15;
    const status = ['pending', 'resolved', 'dismissed'].includes(req.query.status)
      ? req.query.status : 'pending';

    const { rows, count } = await Report.findAndCountAll({
      where: { status },
      include: [{ model: User, as: 'reporter', attributes: ['id', 'username', 'nickname'] }],
      order: [['createdAt', 'DESC']],
      offset: (page - 1) * pageSize,
      limit: pageSize
    });

    // 批量预加载举报目标（优化 N+1 查询）
    const userIds = new Set();
    const postIds = new Set();
    const commentIds = new Set();

    for (const r of rows) {
      if (r.targetType === 'user') userIds.add(r.targetId);
      else if (r.targetType === 'post') postIds.add(r.targetId);
      else if (r.targetType === 'comment') commentIds.add(r.targetId);
    }

    // 批量查询（3次查询代替 N 次）
    const [users, posts, comments] = await Promise.all([
      userIds.size > 0 ? User.findAll({
        where: { id: [...userIds] },
        attributes: ['id', 'username', 'nickname', 'status']
      }) : [],
      postIds.size > 0 ? Post.findAll({
        where: { id: [...postIds] },
        attributes: ['id', 'content']
      }) : [],
      commentIds.size > 0 ? Comment.findAll({
        where: { id: [...commentIds] },
        attributes: ['id', 'content']
      }) : []
    ]);

    // 构建映射
    const userMap = new Map(users.map(u => [u.id, u]));
    const postMap = new Map(posts.map(p => [p.id, p]));
    const commentMap = new Map(comments.map(c => [c.id, c]));

    // 组装结果
    const reports = rows.map(r => {
      const json = r.toJSON();
      let summary = '（已删除）';

      if (r.targetType === 'user') {
        const u = userMap.get(r.targetId);
        if (u) summary = `${u.nickname} (${u.username}) [${u.status === 'banned' ? '已封禁' : '正常'}]`;
      } else if (r.targetType === 'post') {
        const p = postMap.get(r.targetId);
        if (p) summary = p.content.slice(0, 60);
      } else if (r.targetType === 'comment') {
        const c = commentMap.get(r.targetId);
        if (c) summary = c.content.slice(0, 60);
      }

      json.targetSummary = summary;
      return json;
    });

    res.render('admin/reports', {
      admin: req.session.admin,
      active: 'reports',
      csrfToken: req.csrfToken(),
      reports,
      status,
      page,
      totalPages: Math.max(1, Math.ceil(count / pageSize)),
      total: count
    });
  } catch (err) { next(err); }
});

// 处理举报：resolve（已处理）/ dismiss（驳回），resolve 可选对目标处置
// body: { action: 'resolve'|'dismiss', disposal?: 'ban_user'|'delete_post'|'delete_comment'|'none' }
router.post('/reports/:id/handle', async (req, res, next) => {
  try {
    const report = await Report.findOne({ where: { id: req.params.id, status: 'pending' } });
    // 已处理或不存在：幂等返回，不报错
    if (!report) return res.redirect(req.get('referer') || '/admin/reports');

    if (req.body.action === 'dismiss') {
      await Report.update(
        { status: 'dismissed', handledAt: new Date() },
        { where: { id: report.id, status: 'pending' } }
      );
      return res.redirect(req.get('referer') || '/admin/reports');
    }

    const disposal = req.body.disposal || 'none';
    await sequelize.transaction(async (t) => {
      // 按目标类型执行处置（目标可能已被删除，处置 0 行不报错）
      if (disposal === 'ban_user' && report.targetType === 'user') {
        await User.update(
          { status: 'banned' },
          { where: { id: report.targetId, role: 'user' }, transaction: t }
        );
      } else if (disposal === 'delete_post' && report.targetType === 'post') {
        await cascadeDeletePosts([report.targetId], t);
      } else if (disposal === 'delete_comment' && report.targetType === 'comment') {
        await cascadeDeleteComments([report.targetId], t);
      }
      // 当前举报置为已处理
      await Report.update(
        { status: 'resolved', handledAt: new Date() },
        { where: { id: report.id, status: 'pending' }, transaction: t }
      );
      // 已处置目标时，针对同一对象的其余待处理举报一并标记为已处理
      if (disposal !== 'none') {
        await Report.update(
          { status: 'resolved', handledAt: new Date() },
          {
            where: {
              targetType: report.targetType,
              targetId: report.targetId,
              status: 'pending'
            },
            transaction: t
          }
        );
      }
    });
    res.redirect(req.get('referer') || '/admin/reports');
  } catch (err) { next(err); }
});

module.exports = router;
