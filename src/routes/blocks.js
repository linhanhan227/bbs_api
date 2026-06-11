const router = require('express').Router();
const { Op } = require('sequelize');
const { Block, User, Friendship, Follow } = require('../models');
const { authRequired } = require('../middleware/auth');
const { validateIdParam, parsePage } = require('../utils/helpers');

const USER_ATTRS = ['id', 'nickname', 'gender', 'avatar'];

router.use(authRequired);

// 黑名单列表
router.get('/', async (req, res, next) => {
  try {
    const { page, pageSize, offset, limit } = parsePage(req);
    const { rows, count } = await Block.findAndCountAll({
      where: { userId: req.user.id },
      include: [{ model: User, as: 'blocked', attributes: USER_ATTRS }],
      order: [['createdAt', 'DESC']],
      offset, limit
    });
    res.json({
      code: 0,
      data: { list: rows.map(b => ({ blockId: b.id, since: b.createdAt, user: b.blocked })), total: count, page, pageSize }
    });
  } catch (err) { next(err); }
});

// 拉黑某人（幂等；拉黑会解除好友关系和双向关注）
router.put('/:userId', validateIdParam('userId'), async (req, res, next) => {
  try {
    const targetId = req.params.userId;
    if (targetId === req.user.id) {
      return res.status(400).json({ code: 400, message: '不能拉黑自己' });
    }
    const target = await User.findOne({ where: { id: targetId, role: 'user' } });
    if (!target) return res.status(404).json({ code: 404, message: '用户不存在' });

    const [, created] = await Block.findOrCreate({
      where: { userId: req.user.id, blockedId: targetId }
    });
    if (created) {
      // 解除既有关系
      await Friendship.destroy({
        where: {
          [Op.or]: [
            { requesterId: req.user.id, addresseeId: targetId },
            { requesterId: targetId, addresseeId: req.user.id }
          ]
        }
      });
      await Follow.destroy({
        where: {
          [Op.or]: [
            { followerId: req.user.id, followingId: targetId },
            { followerId: targetId, followingId: req.user.id }
          ]
        }
      });
    }
    res.status(created ? 201 : 200).json({ code: 0, message: created ? '已拉黑' : '已在黑名单中', data: { blocked: true } });
  } catch (err) { next(err); }
});

// 取消拉黑（幂等）
router.delete('/:userId', validateIdParam('userId'), async (req, res, next) => {
  try {
    await Block.destroy({ where: { userId: req.user.id, blockedId: req.params.userId } });
    res.json({ code: 0, message: '已移出黑名单', data: { blocked: false } });
  } catch (err) { next(err); }
});

module.exports = router;
