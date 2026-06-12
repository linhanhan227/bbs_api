const router = require('express').Router();
const { Follow, User } = require('../models');
const { authRequired } = require('../middleware/auth');
const { validateIdParam, parsePage, notify, isBlockedBetween } = require('../utils/helpers');

const USER_ATTRS = ['id', 'nickname', 'gender', 'age', 'city', 'avatar'];

router.use(authRequired);

// 关注某人（幂等：重复关注返回 200）
router.put('/:userId', validateIdParam('userId'), async (req, res, next) => {
  try {
    const targetId = req.params.userId;
    if (targetId === req.user.id) {
      return res.status(400).json({ code: 400, message: '不能关注自己' });
    }
    const target = await User.findOne({ where: { id: targetId, role: 'user' } });
    if (!target) return res.status(404).json({ code: 404, message: '用户不存在' });
    if (target.status === 'banned') {
      return res.status(403).json({ code: 403, message: '该用户已被封禁' });
    }

    const blocked = await isBlockedBetween(req.user.id, targetId);
    if (blocked) return res.status(403).json({ code: 403, message: '无法关注该用户' });

    const [, created] = await Follow.findOrCreate({
      where: { followerId: req.user.id, followingId: targetId }
    });
    if (created) {
      await notify({ userId: targetId, type: 'follow', actorId: req.user.id });
    }
    res.status(created ? 201 : 200).json({ code: 0, message: created ? '关注成功' : '已关注过', data: { following: true } });
  } catch (err) { next(err); }
});

// 取消关注（幂等）
router.delete('/:userId', validateIdParam('userId'), async (req, res, next) => {
  try {
    await Follow.destroy({ where: { followerId: req.user.id, followingId: req.params.userId } });
    res.json({ code: 0, message: '已取消关注', data: { following: false } });
  } catch (err) { next(err); }
});

// 我的关注列表
router.get('/following', async (req, res, next) => {
  try {
    const { page, pageSize, offset, limit } = parsePage(req);
    const { rows, count } = await Follow.findAndCountAll({
      where: { followerId: req.user.id },
      include: [{ model: User, as: 'following', attributes: USER_ATTRS }],
      order: [['createdAt', 'DESC']],
      offset, limit
    });
    res.json({
      code: 0,
      data: { list: rows.map(f => ({ followId: f.id, since: f.createdAt, user: f.following })), total: count, page, pageSize }
    });
  } catch (err) { next(err); }
});

// 我的粉丝列表
router.get('/followers', async (req, res, next) => {
  try {
    const { page, pageSize, offset, limit } = parsePage(req);
    const { rows, count } = await Follow.findAndCountAll({
      where: { followingId: req.user.id },
      include: [{ model: User, as: 'follower', attributes: USER_ATTRS }],
      order: [['createdAt', 'DESC']],
      offset, limit
    });
    res.json({
      code: 0,
      data: { list: rows.map(f => ({ followId: f.id, since: f.createdAt, user: f.follower })), total: count, page, pageSize }
    });
  } catch (err) { next(err); }
});

module.exports = router;
