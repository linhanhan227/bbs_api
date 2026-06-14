const rateLimit = require('express-rate-limit');

// 全局 API 限制: 100 次/15分钟
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { code: 429, message: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false
});

// 认证接口限制: 3 次/15分钟
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  skipSuccessfulRequests: true,
  message: { code: 429, message: '登录尝试过多，请 15 分钟后再试' }
});

// 内容创建限制: 1 次/分钟
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1,
  message: { code: 429, message: '操作过于频繁，请 1 分钟后再试' }
});

module.exports = { apiLimiter, authLimiter, createLimiter };
