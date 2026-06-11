const router = require('express').Router();
const { Notification, User, Post } = require('../models');
const { authRequired } = require('../middleware/auth');
const { validateIdParam, parsePage } = require('../utils/helpers');

router.use(authRequired);

// 通知列表
// GET /api/notifications?unread=1&page=&pageSize=
router.get('/', async (req, res, next) => {
  try {
    const { page, pageSize, offset, limit } = parsePage(req);
    const where = { userId: req.user.id };
    if (req.query.unread === '1') where.isRead = false;

    const { rows, count } = await Notification.findAndCountAll({
      where,
      include: [
        { model: User, as: 'actor', attributes: ['id', 'nickname', 'avatar'] },
        { model: Post, as: 'post', attributes: ['id', 'content'] }
      ],
      order: [['createdAt', 'DESC']],
      offset, limit
    });
    res.json({ code: 0, data: { list: rows, total: count, page, pageSize } });
  } catch (err) { next(err); }
});

// 未读数
router.get('/unread-count', async (req, res, next) => {
  try {
    const count = await Notification.count({ where: { userId: req.user.id, isRead: false } });
    res.json({ code: 0, data: { count } });
  } catch (err) { next(err); }
});

// 全部标记已读
router.put('/read-all', async (req, res, next) => {
  try {
    const [affected] = await Notification.update(
      { isRead: true },
      { where: { userId: req.user.id, isRead: false } }
    );
    res.json({ code: 0, message: '已全部标记为已读', data: { affected } });
  } catch (err) { next(err); }
});

// 单条标记已读
router.put('/:id/read', validateIdParam('id'), async (req, res, next) => {
  try {
    const n = await Notification.findByPk(req.params.id);
    if (!n) return res.status(404).json({ code: 404, message: '通知不存在' });
    if (n.userId !== req.user.id) {
      return res.status(403).json({ code: 403, message: '无权操作该通知' });
    }
    if (!n.isRead) {
      n.isRead = true;
      await n.save();
    }
    res.json({ code: 0, message: '已标记为已读', data: n });
  } catch (err) { next(err); }
});

// 删除单条通知
router.delete('/:id', validateIdParam('id'), async (req, res, next) => {
  try {
    const n = await Notification.findByPk(req.params.id);
    if (!n) return res.status(404).json({ code: 404, message: '通知不存在' });
    if (n.userId !== req.user.id) {
      return res.status(403).json({ code: 403, message: '无权操作该通知' });
    }
    await n.destroy();
    res.json({ code: 0, message: '已删除' });
  } catch (err) { next(err); }
});

module.exports = router;
