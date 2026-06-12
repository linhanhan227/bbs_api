const router = require('express').Router();
const { Op } = require('sequelize');
const {
  User, Post, Comment, Like, Favorite, Friendship,
  Follow, Block, Message, Notification, Report
} = require('../models');
const { adminRequired } = require('../middleware/auth');
const { sequelize } = require('../config/database');

// ===== 登录 / 登出 =====
router.get('/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ where: { username: username || '', role: 'admin' } });
    if (!user || !(await user.checkPassword(password || ''))) {
      return res.render('admin/login', { error: '用户名或密码错误' });
    }
    req.session.admin = { id: user.id, username: user.username, nickname: user.nickname };
    res.redirect('/admin');
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
        { username: { [Op.like]: `%${keyword}%` } },
        { nickname: { [Op.like]: `%${keyword}%` } }
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
          Report.destroy({ where: { reporterId: uid }, transaction: t })
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
      posts: rows,
      page,
      totalPages: Math.max(1, Math.ceil(count / pageSize)),
      total: count
    });
  } catch (err) { next(err); }
});

router.post('/posts/:id/delete', async (req, res, next) => {
  try {
    await sequelize.transaction(async (t) => {
      await Promise.all([
        Comment.destroy({ where: { postId: req.params.id }, transaction: t }),
        Like.destroy({ where: { postId: req.params.id }, transaction: t }),
        Favorite.destroy({ where: { postId: req.params.id }, transaction: t })
      ]);
      await Post.destroy({ where: { id: req.params.id }, transaction: t });
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
    if (keyword) where.content = { [Op.like]: `%${keyword}%` };

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
    await Comment.destroy({ where: { id: req.params.id } });
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

    // 补充举报对象摘要
    const reports = await Promise.all(rows.map(async (r) => {
      const json = r.toJSON();
      let summary = '（已删除）';
      if (r.targetType === 'user') {
        const u = await User.findByPk(r.targetId, { attributes: ['username', 'nickname', 'status'] });
        if (u) summary = `${u.nickname} (${u.username}) [${u.status === 'banned' ? '已封禁' : '正常'}]`;
      } else if (r.targetType === 'post') {
        const p = await Post.findByPk(r.targetId, { attributes: ['content'] });
        if (p) summary = p.content.slice(0, 60);
      } else if (r.targetType === 'comment') {
        const c = await Comment.findByPk(r.targetId, { attributes: ['content'] });
        if (c) summary = c.content.slice(0, 60);
      }
      json.targetSummary = summary;
      return json;
    }));

    res.render('admin/reports', {
      admin: req.session.admin,
      active: 'reports',
      reports,
      status,
      page,
      totalPages: Math.max(1, Math.ceil(count / pageSize)),
      total: count
    });
  } catch (err) { next(err); }
});

// 处理举报：resolve（已处理）/ dismiss（驳回）
router.post('/reports/:id/handle', async (req, res, next) => {
  try {
    const action = req.body.action === 'dismiss' ? 'dismissed' : 'resolved';
    await Report.update(
      { status: action, handledAt: new Date() },
      { where: { id: req.params.id, status: 'pending' } }
    );
    res.redirect(req.get('referer') || '/admin/reports');
  } catch (err) { next(err); }
});

module.exports = router;
