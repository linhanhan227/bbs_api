require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { Sequelize } = require('sequelize');

const env = process.env.NODE_ENV || 'development';

let sequelize;

if (env === 'production') {
  // 正式运行版：MySQL
  sequelize = new Sequelize(
    process.env.MYSQL_DATABASE || 'friend_community',
    process.env.MYSQL_USER || 'root',
    process.env.MYSQL_PASSWORD || '',
    {
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.MYSQL_PORT) || 3306,
      dialect: 'mysql',
      logging: false,
      define: { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' },
      pool: { max: 10, min: 0, acquire: 30000, idle: 10000 }
    }
  );
} else {
  // 测试/开发版：SQLite
  const storage = process.env.SQLITE_STORAGE || path.join(__dirname, '../../data/community.sqlite');
  fs.mkdirSync(path.dirname(storage), { recursive: true });
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false
  });
}

module.exports = { sequelize, env };
