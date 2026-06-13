const { DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');
const { sequelize } = require('../config/database');

// ===== 用户 =====
const User = sequelize.define('User', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  username: { type: DataTypes.STRING(32), allowNull: false, unique: true },
  password: { type: DataTypes.STRING(100), allowNull: false },
  nickname: { type: DataTypes.STRING(32), allowNull: false },
  gender: { type: DataTypes.ENUM('male', 'female', 'secret'), defaultValue: 'secret' },
  age: { type: DataTypes.INTEGER, allowNull: true },
  city: { type: DataTypes.STRING(64), allowNull: true },
  bio: { type: DataTypes.STRING(500), allowNull: true },
  avatar: { type: DataTypes.STRING(255), allowNull: true },
  role: { type: DataTypes.ENUM('user', 'admin'), defaultValue: 'user' },
  status: { type: DataTypes.ENUM('active', 'banned'), defaultValue: 'active' }
}, { tableName: 'users' });

User.prototype.checkPassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

User.prototype.toSafeJSON = function () {
  const { password, ...rest } = this.toJSON();
  return rest;
};

User.beforeCreate(async (user) => {
  user.password = await bcrypt.hash(user.password, 10);
});
User.beforeUpdate(async (user) => {
  if (user.changed('password')) {
    user.password = await bcrypt.hash(user.password, 10);
  }
});

// ===== 好友关系（申请方 -> 接收方）=====
const Friendship = sequelize.define('Friendship', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  requesterId: { type: DataTypes.INTEGER, allowNull: false },
  addresseeId: { type: DataTypes.INTEGER, allowNull: false },
  status: { type: DataTypes.ENUM('pending', 'accepted', 'rejected'), defaultValue: 'pending' },
  message: { type: DataTypes.STRING(200), allowNull: true }
}, {
  tableName: 'friendships',
  indexes: [{ unique: true, fields: ['requesterId', 'addresseeId'] }]
});

// ===== 关注（单向）=====
const Follow = sequelize.define('Follow', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  followerId: { type: DataTypes.INTEGER, allowNull: false },   // 关注者
  followingId: { type: DataTypes.INTEGER, allowNull: false }   // 被关注者
}, {
  tableName: 'follows',
  indexes: [{ unique: true, fields: ['followerId', 'followingId'] }]
});

// ===== 黑名单 =====
const Block = sequelize.define('Block', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  userId: { type: DataTypes.INTEGER, allowNull: false },    // 拉黑操作者
  blockedId: { type: DataTypes.INTEGER, allowNull: false }  // 被拉黑者
}, {
  tableName: 'blocks',
  indexes: [{ unique: true, fields: ['userId', 'blockedId'] }]
});

// ===== 动态 =====
const Post = sequelize.define('Post', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  userId: { type: DataTypes.INTEGER, allowNull: false },
  content: { type: DataTypes.TEXT, allowNull: false },
  images: { type: DataTypes.TEXT, allowNull: true }, // JSON 数组字符串
  tags: { type: DataTypes.STRING(200), allowNull: true } // JSON 数组字符串，如 '["旅行","美食"]'
}, { tableName: 'posts' });

// ===== 评论 =====
const Comment = sequelize.define('Comment', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  postId: { type: DataTypes.INTEGER, allowNull: false },
  userId: { type: DataTypes.INTEGER, allowNull: false },
  content: { type: DataTypes.STRING(500), allowNull: false },
  parentId: { type: DataTypes.INTEGER, allowNull: true },      // 父评论 ID，NULL 表示顶级评论
  rootId: { type: DataTypes.INTEGER, allowNull: true },        // 根评论 ID
  replyToUserId: { type: DataTypes.INTEGER, allowNull: true }  // 回复的目标用户 ID
}, { tableName: 'comments' });

// ===== 点赞 =====
const Like = sequelize.define('Like', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  postId: { type: DataTypes.INTEGER, allowNull: false },
  userId: { type: DataTypes.INTEGER, allowNull: false }
}, {
  tableName: 'likes',
  indexes: [{ unique: true, fields: ['postId', 'userId'] }]
});

// ===== 收藏 =====
const Favorite = sequelize.define('Favorite', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  postId: { type: DataTypes.INTEGER, allowNull: false },
  userId: { type: DataTypes.INTEGER, allowNull: false }
}, {
  tableName: 'favorites',
  indexes: [{ unique: true, fields: ['postId', 'userId'] }]
});

// ===== 私信 =====
const Message = sequelize.define('Message', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  senderId: { type: DataTypes.INTEGER, allowNull: false },
  receiverId: { type: DataTypes.INTEGER, allowNull: false },
  content: { type: DataTypes.STRING(1000), allowNull: false },
  isRead: { type: DataTypes.BOOLEAN, defaultValue: false },
  isRecalled: { type: DataTypes.BOOLEAN, defaultValue: false },        // 已撤回
  deletedBySender: { type: DataTypes.BOOLEAN, defaultValue: false },   // 发送方删除（仅对自己隐藏）
  deletedByReceiver: { type: DataTypes.BOOLEAN, defaultValue: false }  // 接收方删除（仅对自己隐藏）
}, { tableName: 'messages' });

// ===== 通知 =====
const Notification = sequelize.define('Notification', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  userId: { type: DataTypes.INTEGER, allowNull: false },     // 接收者
  type: {
    type: DataTypes.ENUM('friend_request', 'friend_accept', 'like', 'comment', 'follow', 'system'),
    allowNull: false
  },
  actorId: { type: DataTypes.INTEGER, allowNull: true },     // 触发者
  postId: { type: DataTypes.INTEGER, allowNull: true },      // 关联动态（点赞/评论）
  content: { type: DataTypes.STRING(500), allowNull: true },
  isRead: { type: DataTypes.BOOLEAN, defaultValue: false }
}, { tableName: 'notifications' });

// ===== 举报 =====
const Report = sequelize.define('Report', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  reporterId: { type: DataTypes.INTEGER, allowNull: false },
  targetType: { type: DataTypes.ENUM('user', 'post', 'comment'), allowNull: false },
  targetId: { type: DataTypes.INTEGER, allowNull: false },
  reason: { type: DataTypes.STRING(500), allowNull: false },
  status: { type: DataTypes.ENUM('pending', 'resolved', 'dismissed'), defaultValue: 'pending' },
  handledAt: { type: DataTypes.DATE, allowNull: true }
}, { tableName: 'reports' });

// ===== 关联 =====
User.hasMany(Post, { foreignKey: 'userId', as: 'posts' });
Post.belongsTo(User, { foreignKey: 'userId', as: 'author' });

Post.hasMany(Comment, { foreignKey: 'postId', as: 'comments' });
Comment.belongsTo(Post, { foreignKey: 'postId' });
Comment.belongsTo(User, { foreignKey: 'userId', as: 'author' });
Comment.belongsTo(User, { foreignKey: 'replyToUserId', as: 'replyToUser' });
Comment.hasMany(Comment, { foreignKey: 'parentId', as: 'replies' });
Comment.belongsTo(Comment, { foreignKey: 'parentId', as: 'parent' });

Post.hasMany(Like, { foreignKey: 'postId', as: 'likes' });
Like.belongsTo(User, { foreignKey: 'userId' });

Favorite.belongsTo(Post, { foreignKey: 'postId', as: 'post' });
Favorite.belongsTo(User, { foreignKey: 'userId' });

Friendship.belongsTo(User, { foreignKey: 'requesterId', as: 'requester' });
Friendship.belongsTo(User, { foreignKey: 'addresseeId', as: 'addressee' });

Follow.belongsTo(User, { foreignKey: 'followerId', as: 'follower' });
Follow.belongsTo(User, { foreignKey: 'followingId', as: 'following' });

Block.belongsTo(User, { foreignKey: 'blockedId', as: 'blocked' });

Message.belongsTo(User, { foreignKey: 'senderId', as: 'sender' });
Message.belongsTo(User, { foreignKey: 'receiverId', as: 'receiver' });

Notification.belongsTo(User, { foreignKey: 'actorId', as: 'actor' });
Notification.belongsTo(Post, { foreignKey: 'postId', as: 'post' });

Report.belongsTo(User, { foreignKey: 'reporterId', as: 'reporter' });

module.exports = {
  sequelize, User, Friendship, Follow, Block,
  Post, Comment, Like, Favorite, Message, Notification, Report
};
