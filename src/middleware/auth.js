const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { env } = require('../config/database');

// 生产环境必须配置 JWT_SECRET
if (env === 'production' && !process.env.JWT_SECRET) {
  throw new Error('生产环境必须配置 JWT_SECRET 环境变量');
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
}

// API 认证中间件：Authorization: Bearer <token>
async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ code: 401, message: '未登录' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await User.findByPk(payload.id);
    if (!user) return res.status(401).json({ code: 401, message: '用户不存在' });
    if (user.status === 'banned') return res.status(403).json({ code: 403, message: '账号已被封禁' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ code: 401, message: '登录已过期，请重新登录' });
  }
}

// 管理后台 session 认证中间件
function adminRequired(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.redirect('/admin/login');
}

module.exports = { signToken, authRequired, adminRequired };
