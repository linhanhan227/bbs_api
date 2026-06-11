require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');

const { env } = require('./config/database');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const friendRoutes = require('./routes/friends');
const followRoutes = require('./routes/follows');
const blockRoutes = require('./routes/blocks');
const postRoutes = require('./routes/posts');
const messageRoutes = require('./routes/messages');
const notificationRoutes = require('./routes/notifications');
const reportRoutes = require('./routes/reports');
const adminRoutes = require('./routes/admin');

const app = express();

// 视图引擎（管理后台）
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 管理后台 session
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 4 } // 4 小时
}));

// 健康检查
app.get('/health', (req, res) => res.json({ status: 'ok', env }));

// API 路由
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/follows', followRoutes);
app.use('/api/blocks', blockRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportRoutes);

// 管理后台
app.use('/admin', adminRoutes);
app.get('/', (req, res) => res.redirect('/admin'));

// 404
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ code: 404, message: '接口不存在' });
  }
  res.status(404).send('404 Not Found');
});

// 统一错误处理：区分客户端错误与服务器错误
app.use((err, req, res, next) => {
  const isApi = req.path.startsWith('/api/');

  // JSON 请求体解析失败
  if (err.type === 'entity.parse.failed') {
    return isApi
      ? res.status(400).json({ code: 400, message: '请求体不是合法的 JSON' })
      : res.status(400).send('请求体格式错误');
  }
  // Sequelize 数据校验失败（如枚举非法、超长）
  if (err.name === 'SequelizeValidationError') {
    const detail = err.errors && err.errors[0] ? err.errors[0].message : '数据校验失败';
    return isApi
      ? res.status(400).json({ code: 400, message: detail })
      : res.status(400).send(detail);
  }
  // 唯一约束冲突
  if (err.name === 'SequelizeUniqueConstraintError') {
    return isApi
      ? res.status(409).json({ code: 409, message: '数据已存在，请勿重复操作' })
      : res.status(409).send('数据已存在');
  }
  // 外键约束失败
  if (err.name === 'SequelizeForeignKeyConstraintError') {
    return isApi
      ? res.status(400).json({ code: 400, message: '关联数据不存在' })
      : res.status(400).send('关联数据不存在');
  }

  console.error(err);
  if (isApi) {
    return res.status(500).json({ code: 500, message: '服务器内部错误' });
  }
  res.status(500).send('服务器内部错误');
});

module.exports = app;
