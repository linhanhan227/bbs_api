const router = require('express').Router();
const { Op } = require('sequelize');
const { Friendship, User } = require('../models');
const { authRequired } = require('../middleware/auth');
const { validateIdParam, parsePage, notify, isBlockedBetween } = require('../utils/helpers');

const USER_ATTRS = ['id', 'nickname', 'gender', 'age', 'city', 'avatar'];

router.use(authRequired);

// 发送好友申请
router.post('/requests', async (req, res, next) => {
  try {
    const targetId = Number(req.body.userId);
    const message = req.body.message;
    if (!Number.isInteger(targetId) || targetId <= 0 || targetId === req.user.id) {
      return res.status(400).json({ code: 400, message: '无效的目标用户' });
    }
    const target = await User.findOne({ where: { id: targetId, role: 'user' } });
    if (!target) return res.status(404).json({ code: 404, message: '用户不存在' });
    if (target.status === 'banned') {
      return res.status(403).json({ code: 403, message: '该用户已被封禁' });
    }

    if (await isBlockedBetween(req.user.id, targetId)) {
      return res.status(403).json({ code: 403, message: '无法向该用户发送好友申请' });
    }

    // 查找双向所有状态的既有关系
    const existing = await Friendship.findOne({
      where: {
        [Op.or]: [
          { requesterId: req.user.id, addresseeId: targetId },
          { requesterId: targetId, addresseeId: req.user.id }
        ]
      }
    });

    if (existing) {
      if (existing.status === 'accepted') {
        return res.status(409).json({ code: 409, message: '你们已经是好友了' });
      }
      if (existing.status === 'pending') {
        return res.status(409).json({ code: 409, message: '已有待处理的好友申请' });
      }
      // rejected：复用记录重新发起（避免唯一索引冲突），并修正申请方向
      existing.requesterId = req.user.id;
      existing.addresseeId = targetId;
      existing.status = 'pending';
      existing.message = message || null;
      await existing.save();
      await notify({ userId: targetId, type: 'friend_request', actorId: req.user.id, content: message || null });
      return res.status(201).json({ code: 0, message: '好友申请已发送', data: existing });
    }

    const fr = await Friendship.create({ requesterId: req.user.id, addresseeId: targetId, message });
    await notify({ userId: targetId, type: 'friend_request', actorId: req.user.id, content: message || null });
    res.status(201).json({ code: 0, message: '好友申请已发送', data: fr });
  } catch (err) { next(err); }
});

// 收到的待处理申请列表
router.get('/requests', async (req, res, next) => {
  try {
    const { page, pageSize, offset, limit } = parsePage(req);
    const { rows, count } = await Friendship.findAndCountAll({
      where: { addresseeId: req.user.id, status: 'pending' },
      include: [{ model: User, as: 'requester', attributes: USER_ATTRS }],
      order: [['createdAt', 'DESC']],
      offset, limit
    });
    res.json({ code: 0, data: { list: rows, total: count, page, pageSize } });
  } catch (err) { next(err); }
});

// 我发出的待处理申请
router.get('/requests/sent', async (req, res, next) => {
  try {
    const { page, pageSize, offset, limit } = parsePage(req);
    const { rows, count } = await Friendship.findAndCountAll({
      where: { requesterId: req.user.id, status: 'pending' },
      include: [{ model: User, as: 'addressee', attributes: USER_ATTRS }],
      order: [['createdAt', 'DESC']],
      offset, limit
    });
    res.json({ code: 0, data: { list: rows, total: count, page, pageSize } });
  } catch (err) { next(err); }
});

// 处理申请：accept / reject
router.put('/requests/:id', validateIdParam('id'), async (req, res, next) => {
  try {
    const { action } = req.body;
    if (!['accept', 'reject'].includes(action)) {
      return res.status(400).json({ code: 400, message: 'action 必须是 accept 或 reject' });
    }
    const fr = await Friendship.findByPk(req.params.id);
    if (!fr) return res.status(404).json({ code: 404, message: '申请不存在' });
    if (fr.addresseeId !== req.user.id) {
      return res.status(403).json({ code: 403, message: '无权处理该申请' });
    }
    if (fr.status !== 'pending') {
      return res.status(409).json({
        code: 409,
        message: `该申请已被${fr.status === 'accepted' ? '同意' : '拒绝'}，不能重复处理`
      });
    }

    fr.status = action === 'accept' ? 'accepted' : 'rejected';
    await fr.save();
    if (action === 'accept') {
      await notify({ userId: fr.requesterId, type: 'friend_accept', actorId: req.user.id });
    }
    res.json({ code: 0, message: action === 'accept' ? '已同意' : '已拒绝', data: fr });
  } catch (err) { next(err); }
});

// 撤回我发出的待处理申请
router.delete('/requests/:id', validateIdParam('id'), async (req, res, next) => {
  try {
    const fr = await Friendship.findByPk(req.params.id);
    if (!fr) return res.status(404).json({ code: 404, message: '申请不存在' });
    if (fr.requesterId !== req.user.id) {
      return res.status(403).json({ code: 403, message: '只能撤回自己发出的申请' });
    }
    if (fr.status !== 'pending') {
      return res.status(409).json({ code: 409, message: '该申请已被处理，无法撤回' });
    }
    await fr.destroy();
    res.json({ code: 0, message: '已撤回申请' });
  } catch (err) { next(err); }
});

// 好友列表
router.get('/', async (req, res, next) => {
  try {
    const { page, pageSize, offset, limit } = parsePage(req);
    const { rows, count } = await Friendship.findAndCountAll({
      where: {
        status: 'accepted',
        [Op.or]: [{ requesterId: req.user.id }, { addresseeId: req.user.id }]
      },
      include: [
        { model: User, as: 'requester', attributes: USER_ATTRS },
        { model: User, as: 'addressee', attributes: USER_ATTRS }
      ],
      order: [['updatedAt', 'DESC']],
      offset, limit
    });
    const friends = rows.map(fr => {
      const friend = fr.requesterId === req.user.id ? fr.addressee : fr.requester;
      return { friendshipId: fr.id, since: fr.updatedAt, user: friend };
    });
    res.json({ code: 0, data: { list: friends, total: count, page, pageSize } });
  } catch (err) { next(err); }
});

// 删除好友
router.delete('/:friendshipId', validateIdParam('friendshipId'), async (req, res, next) => {
  try {
    const fr = await Friendship.findByPk(req.params.friendshipId);
    if (!fr || fr.status !== 'accepted') {
      return res.status(404).json({ code: 404, message: '好友关系不存在' });
    }
    if (fr.requesterId !== req.user.id && fr.addresseeId !== req.user.id) {
      return res.status(403).json({ code: 403, message: '无权删除该好友关系' });
    }
    await fr.destroy();
    res.json({ code: 0, message: '已删除好友' });
  } catch (err) { next(err); }
});

module.exports = router;
