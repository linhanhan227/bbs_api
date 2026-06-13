const router = require('express').Router();
const { Report, User, Post, Comment } = require('../models');
const { authRequired } = require('../middleware/auth');
const { parsePage } = require('../utils/helpers');

router.use(authRequired);

const TARGET_MODELS = { user: User, post: Post, comment: Comment };

// 提交举报
// POST /api/reports {targetType: "user"|"post"|"comment", targetId, reason}
router.post('/', async (req, res, next) => {
  try {
    const { targetType, targetId, reason } = req.body;
    // 用 hasOwnProperty 校验，避免 targetType 传入 'constructor'/'__proto__' 等
    // 原型链属性时绕过白名单（绕过后 .findByPk 会抛异常导致 500）
    if (!Object.prototype.hasOwnProperty.call(TARGET_MODELS, targetType)) {
      return res.status(400).json({ code: 400, message: 'targetType 必须是 user / post / comment' });
    }
    const id = Number(targetId);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ code: 400, message: 'targetId 必须是正整数' });
    }
    // 先判类型：reason 非字符串时 .trim() 会抛异常导致 500
    if (typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ code: 400, message: '请填写举报原因' });
    }
    if (reason.trim().length > 500) {
      return res.status(400).json({ code: 400, message: '举报原因最长 500 字符' });
    }
    if (targetType === 'user' && id === req.user.id) {
      return res.status(400).json({ code: 400, message: '不能举报自己' });
    }

    const target = await TARGET_MODELS[targetType].findByPk(id);
    if (!target) return res.status(404).json({ code: 404, message: '举报对象不存在' });

    // 同一人对同一对象的待处理举报不重复创建
    const exists = await Report.findOne({
      where: { reporterId: req.user.id, targetType, targetId: id, status: 'pending' }
    });
    if (exists) return res.status(409).json({ code: 409, message: '你已举报过，请等待处理' });

    const report = await Report.create({
      reporterId: req.user.id,
      targetType,
      targetId: id,
      reason: reason.trim()
    });
    res.status(201).json({ code: 0, message: '举报已提交，我们会尽快处理', data: report });
  } catch (err) { next(err); }
});

// 我提交的举报记录
router.get('/mine', async (req, res, next) => {
  try {
    const { page, pageSize, offset, limit } = parsePage(req);
    const { rows, count } = await Report.findAndCountAll({
      where: { reporterId: req.user.id },
      order: [['createdAt', 'DESC']],
      offset, limit
    });
    res.json({ code: 0, data: { list: rows, total: count, page, pageSize } });
  } catch (err) { next(err); }
});

module.exports = router;
