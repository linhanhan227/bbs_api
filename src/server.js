require('dotenv').config();
const app = require('./app');
const { sequelize, env } = require('./config/database');
const { User } = require('./models');

const PORT = process.env.PORT || 3000;

async function ensureAdmin() {
  const username = process.env.ADMIN_USERNAME || 'admin';

  // 生产环境强制配置管理员密码
  if (env === 'production' && !process.env.ADMIN_PASSWORD) {
    throw new Error('生产环境必须配置 ADMIN_PASSWORD 环境变量');
  }

  const exists = await User.findOne({ where: { role: 'admin' } });
  if (!exists) {
    const password = process.env.ADMIN_PASSWORD || 'admin123456';
    await User.create({
      username,
      password,
      nickname: '管理员',
      role: 'admin'
    });
    // 仅开发环境输出默认账号信息
    if (env !== 'production') {
      console.log(`[init] 已创建默认管理员账号: ${username}`);
    }
  }
}

async function start() {
  try {
    await sequelize.authenticate();
    console.log(`[db] 数据库连接成功 (${env === 'production' ? 'MySQL' : 'SQLite'})`);
    // 自动建表（生产环境请用迁移工具管理表结构变更）
    // 注意：SQLite 下禁止使用 sync({ alter: true })——Sequelize 重建表时会把
    // 复合唯一索引错误拆成单列 UNIQUE 约束，破坏数据完整性。
    // 开发/测试环境如改了模型结构，删除 data/*.sqlite 重新生成即可。
    await sequelize.sync();
    await ensureAdmin();
    app.listen(PORT, () => {
      console.log(`[server] 运行环境: ${env}`);
      console.log(`[server] API 地址:      http://localhost:${PORT}/api`);
      console.log(`[server] 管理后台:      http://localhost:${PORT}/admin`);
    });
  } catch (err) {
    console.error('[server] 启动失败:', err.message);
    process.exit(1);
  }
}

start();
