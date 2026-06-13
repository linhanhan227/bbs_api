const router = require('express').Router();
const { Op } = require('sequelize');
const { User, Follow, Block, Friendship, Post } = require('../models');
const { authRequired } = require('../middleware/auth');
const { validateIdParam, parsePage, escapeLike } = require('../utils/helpers');

const PUBLIC_ATTRS = ['id', 'username', 'nickname', 'gender', 'age', 'city', 'bio', 'avatar', 'createdAt'];

router.use(authRequired);

// 用户列表 / 搜索（交友广场，自动排除与我有拉黑关系的用户）
// GET /api/users?keyword=&gender=&city=&page=&pageSize=
router.get('/', async (req, res, next) => {
  try {
    const { keyword, gender, city } = req.query;
    const { page, pageSize, offset, limit } = parsePage(req);

    // 与我存在任一方向拉黑关系的用户
    const blockRows = await Block.findAll({
      where: { [Op.or]: [{ userId: req.user.id }, { blockedId: req.user.id }] },
      attributes: ['userId', 'blockedId']
    });
    const excludeIds = new Set([req.user.id]);
    for (const b of blockRows) {
      excludeIds.add(b.userId === req.user.id ? b.blockedId : b.userId);
    }

    const where = { status: 'active', role: 'user', id: { [Op.notIn]: [...excludeIds] } };
    if (keyword) where.nickname = { [Op.like]: `%${escapeLike(keyword)}%` };
    if (gender) {
      if (!['male', 'female', 'secret'].includes(gender)) {
        return res.status(400).json({ code: 400, message: 'gender 必须是 male / female / secret' });
      }
      where.gender = gender;
    }
    if (city) where.city = city;

    const { rows, count } = await User.findAndCountAll({
      where,
      attributes: PUBLIC_ATTRS,
      order: [['createdAt', 'DESC']],
      offset, limit
    });
    res.json({ code: 0, data: { list: rows, total: count, page, pageSize } });
  } catch (err) { next(err); }
});

// 修改自己的资料
router.put('/me', async (req, res, next) => {
  try {
    if (req.body.nickname !== undefined) {
      const nickname = String(req.body.nickname).trim();
      if (!nickname) return res.status(400).json({ code: 400, message: '昵称不能为空' });
      if (nickname.length > 32) return res.status(400).json({ code: 400, message: '昵称最长 32 个字符' });
      req.user.nickname = nickname;
    }
    if (req.body.gender !== undefined) {
      if (!['male', 'female', 'secret'].includes(req.body.gender)) {
        return res.status(400).json({ code: 400, message: 'gender 必须是 male / female / secret' });
      }
      req.user.gender = req.body.gender;
    }
    if (req.body.age !== undefined) {
      const age = Number(req.body.age);
      if (req.body.age !== null && (!Number.isInteger(age) || age < 0 || age > 150)) {
        return res.status(400).json({ code: 400, message: 'age 必须是 0-150 的整数' });
      }
      req.user.age = req.body.age === null ? null : age;
    }
    for (const key of ['city', 'bio', 'avatar']) {
      if (req.body[key] !== undefined) {
        if (key === 'city' && req.body[key] !== null) {
          const city = String(req.body[key]).trim();
          if (city.length > 64) {
            return res.status(400).json({ code: 400, message: '城市名最长 64 字符' });
          }
          req.user.city = city || null;
        } else if (key === 'bio' && req.body[key] !== null) {
          const bio = String(req.body[key]).trim();
          if (bio.length > 500) {
            return res.status(400).json({ code: 400, message: '个人简介最长 500 字符' });
          }
          req.user.bio = bio || null;
        } else if (key === 'avatar' && req.body[key] !== null) {
          const avatar = String(req.body[key]).trim();
          if (avatar.length > 255) {
            return res.status(400).json({ code: 400, message: '头像 URL 最长 255 字符' });
          }
          req.user.avatar = avatar || null;
        } else {
          req.user[key] = req.body[key];
        }
      }
    }
    if (req.body.password !== undefined) {
      if (typeof req.body.password !== 'string' || req.body.password.length < 8) {
        return res.status(400).json({ code: 400, message: '密码至少 8 位' });
      }
      req.user.password = req.body.password;
    }
    await req.user.save();
    res.json({ code: 0, message: '资料已更新', data: req.user.toSafeJSON() });
  } catch (err) { next(err); }
});

// 查看指定用户主页（含统计与关系状态）
router.get('/:id', validateIdParam('id'), async (req, res, next) => {
  try {
    const user = await User.findOne({
      where: { id: req.params.id, role: 'user' },
      attributes: [...PUBLIC_ATTRS, 'status']
    });
    if (!user) return res.status(404).json({ code: 404, message: '用户不存在' });
    if (user.status === 'banned') {
      return res.status(403).json({ code: 403, message: '该用户已被封禁' });
    }

    const targetId = user.id;
    const [followerCount, followingCount, postCount, isFollowing, friendship, blockedByMe, blockedByOther] = await Promise.all([
      Follow.count({ where: { followingId: targetId } }),
      Follow.count({ where: { followerId: targetId } }),
      Post.count({ where: { userId: targetId } }),
      Follow.findOne({ where: { followerId: req.user.id, followingId: targetId } }),
      Friendship.findOne({
        where: {
          status: 'accepted',
          [Op.or]: [
            { requesterId: req.user.id, addresseeId: targetId },
            { requesterId: targetId, addresseeId: req.user.id }
          ]
        }
      }),
      Block.findOne({ where: { userId: req.user.id, blockedId: targetId } }),
      Block.findOne({ where: { userId: targetId, blockedId: req.user.id } })
    ]);

    // 对方拉黑了我：不可查看其主页（我拉黑对方时仍可查看，便于解除）
    if (blockedByOther && targetId !== req.user.id) {
      return res.status(403).json({ code: 403, message: '无法查看该用户' });
    }

    const { status, ...profile } = user.toJSON();
    res.json({
      code: 0,
      data: {
        ...profile,
        stats: { followerCount, followingCount, postCount },
        relation: {
          isSelf: targetId === req.user.id,
          isFollowing: !!isFollowing,
          isFriend: !!friendship,
          isBlockedByMe: !!blockedByMe
        }
      }
    });
  } catch (err) { next(err); }
});

module.exports = router;
