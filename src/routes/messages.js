const router = require('express').Router();
const { Op } = require('sequelize');
const { Message, User, Friendship } = require('../models');
const { authRequired } = require('../middleware/auth');
const { validateIdParam, parsePage, isBlockedBetween } = require('../utils/helpers');
const { sequelize } = require('../config/database');

const USER_ATTRS = ['id', 'nickname', 'avatar'];
const RECALL_WINDOW_MS = 2 * 60 * 1000; // 撤回时限：2 分钟

router.use(authRequired);

// 判断两人是否为好友
async function areFriends(a, b) {
  const fr = await Friendship.findOne({
    where: {
      status: 'accepted',
      [Op.or]: [
        { requesterId: a, addresseeId: b },
        { requesterId: b, addresseeId: a }
      ]
    }
  });
  return !!fr;
}

// 当前用户对消息的可见条件（自己删除过的不可见）
function visibleTo(userId, otherId) {
  return {
    [Op.or]: [
      { senderId: userId, receiverId: otherId, deletedBySender: false },
      { senderId: otherId, receiverId: userId, deletedByReceiver: false }
    ]
  };
}

// 撤回的消息不暴露原文
function serializeMessage(m) {
  const json = m.toJSON();
  delete json.deletedBySender;
  delete json.deletedByReceiver;
  if (json.isRecalled) json.content = null;
  return json;
}

// 发送私信（仅限好友之间，且双方无拉黑关系）
router.post('/', async (req, res, next) => {
  try {
    const targetId = Number(req.body.userId);
    const { content } = req.body;
    if (!Number.isInteger(targetId) || targetId <= 0 || targetId === req.user.id) {
      return res.status(400).json({ code: 400, message: '无效的接收者' });
    }
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ code: 400, message: '消息内容不能为空' });
    }
    if (content.trim().length > 1000) {
      return res.status(400).json({ code: 400, message: '消息最长 1000 字' });
    }
    const target = await User.findByPk(targetId);
    if (!target) return res.status(404).json({ code: 404, message: '用户不存在' });
    if (target.status === 'banned') {
      return res.status(403).json({ code: 403, message: '该用户已被封禁' });
    }

    if (await isBlockedBetween(req.user.id, targetId)) {
      return res.status(403).json({ code: 403, message: '无法向该用户发送私信' });
    }
    if (!(await areFriends(req.user.id, targetId))) {
      return res.status(403).json({ code: 403, message: '只能给好友发送私信' });
    }
    const msg = await Message.create({
      senderId: req.user.id,
      receiverId: targetId,
      content: content.trim()
    });
    res.status(201).json({ code: 0, message: '发送成功', data: serializeMessage(msg) });
  } catch (err) { next(err); }
});

// 会话列表（每个聊天对象的最后一条可见消息 + 未读数）
router.get('/conversations', async (req, res, next) => {
  try {
    const me = req.user.id;
    
    // 查找所有与我相关的可见消息
    const messages = await Message.findAll({
      where: {
        [Op.or]: [
          { senderId: me, deletedBySender: false },
          { receiverId: me, deletedByReceiver: false }
        ]
      },
      order: [['createdAt', 'DESC']],
      include: [
        { model: User, as: 'sender', attributes: USER_ATTRS },
        { model: User, as: 'receiver', attributes: USER_ATTRS }
      ]
    });

    const conversationsMap = new Map();

    for (const msg of messages) {
      const otherId = msg.senderId === me ? msg.receiverId : msg.senderId;
      
      if (!conversationsMap.has(otherId)) {
        const otherUser = msg.senderId === me ? msg.receiver : msg.sender;
        conversationsMap.set(otherId, {
          user: otherUser,
          lastMessage: serializeMessage(msg),
          unreadCount: 0
        });
      }
      
      if (msg.receiverId === me && !msg.isRead && !msg.isRecalled) {
        conversationsMap.get(otherId).unreadCount++;
      }
    }

    const conversations = Array.from(conversationsMap.values());
    res.json({ code: 0, data: conversations });
  } catch (err) { next(err); }
});

// 全部未读私信数
router.get('/unread-count', async (req, res, next) => {
  try {
    const count = await Message.count({
      where: { receiverId: req.user.id, isRead: false, isRecalled: false, deletedByReceiver: false }
    });
    res.json({ code: 0, data: { count } });
  } catch (err) { next(err); }
});

// 与某人的聊天记录（自动标记为已读）
// GET /api/messages/with/:userId?page=&pageSize=
router.get('/with/:userId', validateIdParam('userId'), async (req, res, next) => {
  try {
    const otherId = req.params.userId;
    const { page, pageSize, offset, limit } = parsePage(req, 30, 100);

    const { rows, count } = await Message.findAndCountAll({
      where: visibleTo(req.user.id, otherId),
      order: [['createdAt', 'DESC']],
      offset, limit
    });

    await Message.update(
      { isRead: true },
      { where: { senderId: otherId, receiverId: req.user.id, isRead: false } }
    );

    res.json({
      code: 0,
      data: { list: rows.reverse().map(serializeMessage), total: count, page, pageSize }
    });
  } catch (err) { next(err); }
});

// 撤回消息（仅发送者，发送后 2 分钟内）
router.put('/:id/recall', validateIdParam('id'), async (req, res, next) => {
  try {
    const msg = await Message.findByPk(req.params.id);
    if (!msg) return res.status(404).json({ code: 404, message: '消息不存在' });
    if (msg.senderId !== req.user.id) {
      return res.status(403).json({ code: 403, message: '只能撤回自己发送的消息' });
    }
    if (msg.isRecalled) {
      return res.json({ code: 0, message: '消息已撤回', data: serializeMessage(msg) });
    }
    if (Date.now() - new Date(msg.createdAt).getTime() > RECALL_WINDOW_MS) {
      return res.status(400).json({ code: 400, message: '发送超过 2 分钟的消息不能撤回' });
    }
    msg.isRecalled = true;
    msg.content = '';
    await msg.save();
    res.json({ code: 0, message: '已撤回', data: serializeMessage(msg) });
  } catch (err) { next(err); }
});

// 删除单条消息（仅对自己隐藏；双方都删除后物理删除）
router.delete('/:id', validateIdParam('id'), async (req, res, next) => {
  try {
    const msg = await Message.findByPk(req.params.id);
    if (!msg) return res.status(404).json({ code: 404, message: '消息不存在' });
    if (msg.senderId !== req.user.id && msg.receiverId !== req.user.id) {
      return res.status(403).json({ code: 403, message: '无权删除该消息' });
    }

    if (msg.senderId === req.user.id) msg.deletedBySender = true;
    if (msg.receiverId === req.user.id) msg.deletedByReceiver = true;

    if (msg.deletedBySender && msg.deletedByReceiver) {
      await msg.destroy();
    } else {
      await msg.save();
    }
    res.json({ code: 0, message: '已删除' });
  } catch (err) { next(err); }
});

// 清空与某人的会话（仅对自己隐藏；双方都删除的消息物理删除）
router.delete('/conversations/:userId', validateIdParam('userId'), async (req, res, next) => {
  try {
    const me = req.user.id;
    const otherId = req.params.userId;

    await sequelize.transaction(async (t) => {
      await Promise.all([
        Message.update(
          { deletedBySender: true },
          { where: { senderId: me, receiverId: otherId }, transaction: t }
        ),
        Message.update(
          { deletedByReceiver: true },
          { where: { senderId: otherId, receiverId: me }, transaction: t }
        )
      ]);
      // 双方都已删除的消息物理清除
      await Message.destroy({
        where: {
          deletedBySender: true,
          deletedByReceiver: true,
          [Op.or]: [
            { senderId: me, receiverId: otherId },
            { senderId: otherId, receiverId: me }
          ]
        },
        transaction: t
      });
    });
    res.json({ code: 0, message: '会话已清空' });
  } catch (err) { next(err); }
});

module.exports = router;
