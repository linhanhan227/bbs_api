const router = require('express').Router();
const { User } = require('../models');
const { signToken, authRequired } = require('../middleware/auth');

// 注册
router.post('/register', async (req, res, next) => {
  try {
    const { username, password, nickname, gender, age, city, bio } = req.body;
    if (!username || !password) {
      return res.status(400).json({ code: 400, message: '用户名和密码不能为空' });
    }
    if (username.length < 3 || username.length > 32) {
      return res.status(400).json({ code: 400, message: '用户名长度 3-32 字符' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ code: 400, message: '用户名只能包含字母、数字和下划线' });
    }
    if (password.length < 8) {
      return res.status(400).json({ code: 400, message: '密码至少 8 位' });
    }
    if (password.length > 128) {
      return res.status(400).json({ code: 400, message: '密码最长 128 位' });
    }
    const exists = await User.findOne({ where: { username } });
    if (exists) return res.status(409).json({ code: 409, message: '用户名已存在' });

    const user = await User.create({
      username,
      password,
      nickname: nickname || username,
      gender, age, city, bio
    });
    res.status(201).json({ code: 0, message: '注册成功', data: { user: user.toSafeJSON(), token: signToken(user) } });
  } catch (err) { next(err); }
});

// 登录
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ where: { username: username || '' } });
    if (!user || !(await user.checkPassword(password || ''))) {
      return res.status(401).json({ code: 401, message: '用户名或密码错误' });
    }
    if (user.status === 'banned') {
      return res.status(403).json({ code: 403, message: '账号已被封禁' });
    }
    res.json({ code: 0, message: '登录成功', data: { user: user.toSafeJSON(), token: signToken(user) } });
  } catch (err) { next(err); }
});

// 当前登录用户信息
router.get('/me', authRequired, (req, res) => {
  res.json({ code: 0, data: req.user.toSafeJSON() });
});

module.exports = router;
