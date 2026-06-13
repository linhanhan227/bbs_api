# 社区核心功能完善计划

## 概述

本文档规划了交友社区系统缺失的 4 个核心功能的完整技术方案，按优先级和依赖关系分阶段实施。

---

## 第一阶段：话题标签系统（30-60 分钟）

### 业务价值
- **最高 ROI**：改动最小，效果明显
- 内容组织和分类的基础设施
- 用户发现感兴趣内容的核心入口
- 提升内容曝光和互动率

### 数据库变更

#### 1. Post 模型增加字段
```javascript
// src/models/index.js
const Post = sequelize.define('Post', {
  // ... 现有字段
  tags: { type: DataTypes.STRING(200), allowNull: true }, // JSON 数组，如 '["旅行","美食"]'
});
```

#### 2. 新增 Tag 统计表（可选，用于热门话题）
```javascript
const Tag = sequelize.define('Tag', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING(50), allowNull: false, unique: true },
  usageCount: { type: DataTypes.INTEGER, defaultValue: 1 }
}, { tableName: 'tags' });
```

### API 设计

#### 1. 修改发布动态接口
**POST /api/posts**

新增参数：
```json
{
  "content": "今天去了杭州西湖",
  "images": ["..."],
  "tags": ["旅行", "杭州"]  // 新增：标签数组，最多 5 个，每个最长 20 字符
}
```

校验规则：
- tags 必须是数组（可选）
- 数组长度不超过 5
- 每个标签必须是字符串，去除首尾空格后 1-20 字符
- 自动去重

#### 2. 修改动态列表接口
**GET /api/posts**

新增查询参数：
- `tag`: 按标签筛选，如 `?tag=旅行`

返回结构增加 tags 字段：
```json
{
  "id": 1,
  "content": "...",
  "tags": ["旅行", "杭州"],
  // ... 其他字段
}
```

#### 3. 新增热门话题接口
**GET /api/tags/hot**

查询参数：
- `limit`: 返回数量，默认 10，最大 50

返回结构：
```json
{
  "code": 0,
  "data": [
    { "name": "旅行", "count": 128 },
    { "name": "美食", "count": 95 }
  ]
}
```

实现方式：
- 方案 A（简单）：实时统计 `SELECT tags FROM posts WHERE tags IS NOT NULL`，解析后统计
- 方案 B（推荐）：维护 Tag 表，发布/删除动态时更新计数

#### 4. 新增话题动态列表接口
**GET /api/tags/:tag/posts**

等同于 `GET /api/posts?tag=xxx`，提供 RESTful 风格的访问方式。

### 实现步骤

1. **修改 models/index.js**
   - Post 模型添加 `tags` 字段
   - 可选：添加 Tag 模型和关联

2. **修改 routes/posts.js**
   - 发布动态：解析和校验 tags 参数，存储为 JSON 字符串
   - 列表接口：支持 tag 查询参数（WHERE tags LIKE '%"旅行"%'）
   - 详情接口：返回时将 tags 字符串解析为数组

3. **新增 routes/tags.js**
   - GET /hot：热门话题统计
   - GET /:tag/posts：话题动态列表（复用 posts.js 逻辑）

4. **修改 utils/helpers.js**
   - 新增 `parseTags(tags)` 函数：校验和清洗标签数组
   - 新增 `serializeTags(tagsJson)` 函数：JSON 字符串转数组
   - 可选：新增 `updateTagCount(tags, delta)` 函数：更新标签计数

5. **更新管理后台**
   - 动态列表显示标签
   - 删除动态时同步更新标签计数（如使用方案 B）

### 迁移策略
- 新字段 `tags` 默认 NULL，兼容现有数据
- 无需数据迁移脚本

---

## 第二阶段：评论回复功能（60-90 分钟）

### 业务价值
- 用户强需求，当前评论平铺无法形成对话
- 提升讨论深度和用户粘性
- 是 @提及 功能的基础

### 数据库变更

#### 修改 Comment 模型
```javascript
const Comment = sequelize.define('Comment', {
  // ... 现有字段
  parentId: { type: DataTypes.INTEGER, allowNull: true },  // 父评论 ID，NULL 表示顶级评论
  rootId: { type: DataTypes.INTEGER, allowNull: true },    // 根评论 ID，便于查询某条评论的全部回复树
  replyToUserId: { type: DataTypes.INTEGER, allowNull: true }  // 回复的目标用户 ID
});

// 添加自关联
Comment.hasMany(Comment, { foreignKey: 'parentId', as: 'replies' });
Comment.belongsTo(Comment, { foreignKey: 'parentId', as: 'parent' });
Comment.belongsTo(User, { foreignKey: 'replyToUserId', as: 'replyToUser' });
```

### API 设计

#### 1. 修改发表评论接口
**POST /api/posts/:id/comments**

新增参数：
```json
{
  "content": "我也觉得杭州很美",
  "parentId": 5,        // 可选，回复某条评论时传入
  "replyToUserId": 2    // 可选，明确回复的目标用户
}
```

校验规则：
- 如果传入 parentId，必须是该动态下的评论
- replyToUserId 必须存在且是 parentId 评论的作者或其子评论的作者

通知逻辑：
- 顶级评论：通知动态作者
- 回复评论：通知被回复的评论作者 + 动态作者（如果不同）

#### 2. 修改评论列表接口
**GET /api/posts/:id/comments**

新增查询参数：
- `flat`: 是否扁平化，默认 false（树形结构），传 true 则按时间排序的平铺列表

返回结构（树形）：
```json
{
  "code": 0,
  "data": {
    "list": [
      {
        "id": 1,
        "content": "真不错",
        "author": { "id": 2, "nickname": "Alice" },
        "replies": [
          {
            "id": 5,
            "content": "是的，我也去过",
            "parentId": 1,
            "replyToUser": { "id": 2, "nickname": "Alice" },
            "author": { "id": 3, "nickname": "Bob" },
            "replies": []
          }
        ]
      }
    ],
    "total": 2,  // 顶级评论数
    "page": 1,
    "pageSize": 20
  }
}
```

返回结构（扁平）：
```json
{
  "list": [
    {
      "id": 1,
      "content": "真不错",
      "parentId": null,
      "replyToUser": null,
      "author": { ... }
    },
    {
      "id": 5,
      "content": "是的，我也去过",
      "parentId": 1,
      "replyToUser": { "id": 2, "nickname": "Alice" },
      "author": { ... }
    }
  ]
}
```

#### 3. 新增评论详情接口（可选）
**GET /api/comments/:id**

返回某条评论及其全部回复树，用于"查看对话"功能。

### 实现步骤

1. **修改 models/index.js**
   - Comment 模型添加 `parentId`、`rootId`、`replyToUserId` 字段
   - 添加 Comment 自关联

2. **修改 routes/posts.js**
   - 发表评论：校验 parentId，计算 rootId，发送通知给被回复者
   - 评论列表：
     - 默认返回树形结构（嵌套查询或递归构建）
     - 支持 flat 参数返回扁平列表

3. **修改 utils/helpers.js**
   - 新增 `buildCommentTree(comments)` 函数：将扁平评论数组构建为树
   - 修改 `cascadeDeleteComments()` 函数：删除评论时级联删除其所有子评论

4. **修改 routes/admin.js**
   - 管理后台删除评论时级联删除子评论

### 迁移策略

需要数据迁移脚本：
```javascript
// migrations/add-comment-reply-fields.js
await sequelize.query(`
  ALTER TABLE comments ADD COLUMN parentId INTEGER NULL;
  ALTER TABLE comments ADD COLUMN rootId INTEGER NULL;
  ALTER TABLE comments ADD COLUMN replyToUserId INTEGER NULL;
`);

// 现有评论的 parentId/rootId 保持 NULL（顶级评论）
```

### 性能考虑
- 评论树深度建议限制在 3 层（顶级 -> 一级回复 -> 二级回复）
- 分页时仅对顶级评论分页，子评论全量加载
- 单条动态评论数超过 1000 时考虑懒加载

---

## 第三阶段：动态转发功能（60-90 分钟）

### 业务价值
- 内容传播的核心机制
- 提升优质内容曝光
- 用户表达认同的重要方式

### 数据库变更

#### Post 模型增加字段
```javascript
const Post = sequelize.define('Post', {
  // ... 现有字段
  isRepost: { type: DataTypes.BOOLEAN, defaultValue: false },      // 是否为转发动态
  originalPostId: { type: DataTypes.INTEGER, allowNull: true },    // 原动态 ID
  repostComment: { type: DataTypes.STRING(500), allowNull: true }  // 转发时的评论
});

// 添加关联
Post.belongsTo(Post, { foreignKey: 'originalPostId', as: 'originalPost' });
Post.hasMany(Post, { foreignKey: 'originalPostId', as: 'reposts' });
```

### API 设计

#### 1. 新增转发动态接口
**POST /api/posts/:id/repost**

参数：
```json
{
  "comment": "这个地方我也去过，确实很美"  // 可选，转发时的评论，最长 500 字符
}
```

校验规则：
- 原动态必须存在且可见（未被删除，非拉黑关系）
- 不能转发自己的动态（可选限制）
- 不能重复转发同一条动态（可选限制，或允许但提示）
- 不能转发已经是转发的动态（避免多层转发，或限制最多二次转发）

返回结构：
```json
{
  "code": 0,
  "message": "转发成功",
  "data": {
    "id": 123,
    "userId": 2,
    "isRepost": true,
    "repostComment": "这个地方我也去过",
    "originalPost": {
      "id": 1,
      "content": "杭州西湖真美",
      "images": ["..."],
      "author": { "id": 3, "nickname": "原作者" }
    },
    "createdAt": "..."
  }
}
```

通知逻辑：
- 通知原动态作者（type: 'repost'）

#### 2. 修改动态列表接口
**GET /api/posts**

返回结构增加转发相关字段：
```json
{
  "id": 123,
  "isRepost": true,
  "repostComment": "转发时的评论",
  "originalPost": {
    "id": 1,
    "content": "原动态内容",
    "author": { ... },
    // 可选：仅返回摘要，不包含完整的点赞/评论等
    "isDeleted": false  // 原动态是否已删除
  },
  "author": { "id": 2, "nickname": "转发者" },
  "likeCount": 5,    // 转发动态的点赞数
  "repostCount": 2,  // 本条转发动态又被转发的次数（可选）
  // ...
}
```

如果原动态已被删除，显示占位信息：
```json
{
  "isRepost": true,
  "originalPost": {
    "id": 1,
    "isDeleted": true,
    "content": "原动态已被删除"
  }
}
```

#### 3. 修改动态详情接口
**GET /api/posts/:id**

同上，增加转发相关字段和原动态完整信息。

#### 4. 新增转发列表接口（可选）
**GET /api/posts/:id/reposts**

查看某条动态的所有转发，用于"xx 人转发了"功能。

分页参数：page, pageSize

返回结构：
```json
{
  "code": 0,
  "data": {
    "list": [
      {
        "id": 123,
        "repostComment": "...",
        "author": { ... },
        "createdAt": "..."
      }
    ],
    "total": 10,
    "page": 1,
    "pageSize": 20
  }
}
```

### 实现步骤

1. **修改 models/index.js**
   - Post 模型添加 `isRepost`、`originalPostId`、`repostComment` 字段
   - 添加 Post 自关联

2. **修改 routes/posts.js**
   - 新增 `POST /:id/repost` 接口
   - 修改列表和详情接口，支持 include originalPost
   - serializePost() 函数增加转发信息处理

3. **修改 utils/helpers.js**
   - 修改 `cascadeDeletePosts()` 函数：
     - 删除原动态时，转发动态的 originalPostId 保留（显示"原动态已删除"）
     - 或者同时删除所有转发（看产品需求）

4. **修改 Notification 类型**
   - 添加 `repost` 类型通知

### 迁移策略

数据迁移脚本：
```javascript
await sequelize.query(`
  ALTER TABLE posts ADD COLUMN isRepost BOOLEAN DEFAULT 0;
  ALTER TABLE posts ADD COLUMN originalPostId INTEGER NULL;
  ALTER TABLE posts ADD COLUMN repostComment VARCHAR(500) NULL;
`);
```

### 业务规则讨论点
1. **是否允许转发转发？**
   - 方案 A：禁止（微博模式），统一转发到原动态
   - 方案 B：允许一次（Twitter 模式），最多二次转发
   - 推荐：方案 A，简化逻辑

2. **删除原动态的处理？**
   - 方案 A：保留转发，显示"原动态已删除"
   - 方案 B：级联删除所有转发
   - 推荐：方案 A，保留用户内容

3. **是否允许转发自己的动态？**
   - 推荐：允许，用户可能希望重新推一遍旧动态

---

## 第四阶段：@提及功能（60-90 分钟）

### 业务价值
- 社交互动的基本需求
- 增强用户粘性和活跃度
- 评论和动态中提及他人是标准功能

### 数据库变更

#### 1. 新增 Mention 表
```javascript
const Mention = sequelize.define('Mention', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  sourceType: { type: DataTypes.ENUM('post', 'comment'), allowNull: false },  // 来源类型
  sourceId: { type: DataTypes.INTEGER, allowNull: false },                    // 来源 ID
  mentionedUserId: { type: DataTypes.INTEGER, allowNull: false },             // 被提及的用户
  mentionerId: { type: DataTypes.INTEGER, allowNull: false }                  // 提及者
}, { 
  tableName: 'mentions',
  indexes: [
    { fields: ['sourceType', 'sourceId'] },
    { fields: ['mentionedUserId'] }
  ]
});

Mention.belongsTo(User, { foreignKey: 'mentionedUserId', as: 'mentionedUser' });
Mention.belongsTo(User, { foreignKey: 'mentionerId', as: 'mentioner' });
```

或者简化方案（不建新表）：
- Post 模型增加 `mentions` 字段：JSON 数组 `[2, 5, 8]`（被提及的用户 ID）
- Comment 模型同上

#### 2. 修改 Notification 类型
```javascript
type: DataTypes.ENUM(
  'friend_request', 'friend_accept', 'like', 'comment', 'follow', 
  'mention',  // 新增：被提及
  'repost',   // 前一阶段新增
  'system'
)
```

### API 设计

#### 1. 修改发布动态接口
**POST /api/posts**

前端在用户输入 `@用户名` 时，通过自动补全接口获取用户 ID，提交时传入：

```json
{
  "content": "@Alice 杭州西湖真的很美，@Bob 你有空也去看看",
  "mentions": [2, 5]  // 新增：被提及的用户 ID 数组
}
```

后端逻辑：
1. 校验 mentions 数组中的用户 ID 都存在
2. 存储 mentions 到 Post 表或 Mention 表
3. 给每个被提及用户发送通知（type: 'mention'）

#### 2. 修改发表评论接口
**POST /api/posts/:id/comments**

同上，增加 `mentions` 参数。

#### 3. 新增@我的动态/评论接口
**GET /api/mentions**

查询参数：
- `type`: post / comment / all（默认 all）
- `page`, `pageSize`

返回结构：
```json
{
  "code": 0,
  "data": {
    "list": [
      {
        "id": 1,
        "sourceType": "post",
        "sourceId": 123,
        "post": {
          "id": 123,
          "content": "@Alice 杭州西湖...",
          "author": { ... }
        },
        "mentioner": { "id": 3, "nickname": "Bob" },
        "createdAt": "..."
      },
      {
        "id": 2,
        "sourceType": "comment",
        "sourceId": 456,
        "comment": {
          "id": 456,
          "content": "@Alice 我也觉得",
          "postId": 789
        },
        "mentioner": { ... }
      }
    ],
    "total": 15,
    "page": 1,
    "pageSize": 20
  }
}
```

### 实现步骤

1. **修改 models/index.js**
   - 方案 A：新增 Mention 模型和关联
   - 方案 B（推荐）：Post 和 Comment 模型添加 `mentions` 字段（JSON 数组）

2. **修改 routes/posts.js**
   - 发布动态：解析 mentions 参数，校验用户 ID，存储，发送通知
   - 发表评论：同上

3. **新增 routes/mentions.js**
   - GET /：我被提及的列表
   - 或者将此接口放在 users.js 中作为 `GET /api/users/me/mentions`

4. **修改 utils/helpers.js**
   - 新增 `extractMentions(content)` 函数：从文本中提取 @username（可选，如果前端已处理则不需要）
   - 新增 `notifyMentions(mentions, sourceType, sourceId, mentionerId)` 函数：批量发送提及通知

5. **修改 Notification 类型枚举**
   - 添加 `mention` 类型

6. **前端配合**
   - 输入框支持 @自动补全：调用 `GET /api/users?keyword=xxx` 搜索用户
   - 提及用户高亮显示：前端渲染时将 @username 高亮或转为链接

### 迁移策略

数据迁移脚本：
```javascript
// 方案 B（简化）
await sequelize.query(`
  ALTER TABLE posts ADD COLUMN mentions TEXT NULL;
  ALTER TABLE comments ADD COLUMN mentions TEXT NULL;
  ALTER TABLE notifications MODIFY COLUMN type ENUM(
    'friend_request', 'friend_accept', 'like', 'comment', 
    'follow', 'mention', 'repost', 'system'
  );
`);
```

### 实现细节

#### @提及的展示逻辑
前端需要将文本中的 `@username` 渲染为：
- 高亮显示（不同颜色）
- 可点击跳转到用户主页

方案：
- 后端返回 mentions 数组：`[{ userId: 2, username: 'Alice' }]`
- 前端根据此数组替换文本中的 @username 为链接

#### @提及的隐私
- 只能 @可见的用户（非拉黑关系）
- 动态可见性为 private 时，被提及用户仍能收到通知和查看（可选）

---

## 实施时间线

### 总时间估算：4-6 小时

| 阶段 | 功能 | 开发时间 | 测试时间 | 总计 |
|------|------|---------|---------|------|
| 1 | 话题标签系统 | 30-45 分钟 | 15 分钟 | 60 分钟 |
| 2 | 评论回复功能 | 60 分钟 | 30 分钟 | 90 分钟 |
| 3 | 动态转发功能 | 60 分钟 | 30 分钟 | 90 分钟 |
| 4 | @提及功能 | 45 分钟 | 15 分钟 | 60 分钟 |
| - | 文档更新和提交 | - | - | 30 分钟 |
| **总计** | - | - | - | **5.5 小时** |

### 推荐实施顺序

1. **第一天**：话题标签系统（完整）
2. **第二天**：评论回复功能（完整）
3. **第三天**：动态转发 + @提及（可合并，因为都涉及通知）

### 每阶段验收标准

#### 阶段 1（话题标签）
- ✅ 发布动态可添加标签
- ✅ 按标签筛选动态
- ✅ 查看热门话题榜
- ✅ 所有接口通过 Postman 测试
- ✅ README 更新

#### 阶段 2（评论回复）
- ✅ 可回复评论
- ✅ 评论列表显示树形结构
- ✅ 被回复用户收到通知
- ✅ 删除评论级联删除子评论
- ✅ 所有接口通过测试

#### 阶段 3（动态转发）
- ✅ 可转发动态并附加评论
- ✅ 转发动态显示原动态信息
- ✅ 原作者收到转发通知
- ✅ 处理原动态删除的情况
- ✅ 所有接口通过测试

#### 阶段 4（@提及）
- ✅ 动态和评论可提及用户
- ✅ 被提及用户收到通知
- ✅ 可查看@我的列表
- ✅ 所有接口通过测试

---

## 后续规划

### 第二批功能（优先级中）
5. 内容搜索增强
6. 推荐系统（推荐动态/推荐用户）
7. 消息会话置顶
8. 动态可见性控制
9. 草稿箱

### 第三批功能（优先级低）
10. 动态编辑
11. 阅读历史
12. 特别关注
13. 好友备注
14. 多表情回应

---

## 技术债务和注意事项

### 性能考虑
1. **评论树深度限制**：建议最多 3 层，避免无限嵌套
2. **标签索引**：如果使用 Tag 表，需要在 name 字段建索引
3. **转发查询优化**：获取原动态时使用 JOIN，避免 N+1 查询
4. **@提及通知批量发送**：一次最多通知 20 个用户，避免性能问题

### 安全考虑
1. **XSS 防护**：标签、@提及、转发评论都需要前端转义
2. **防刷控制**：转发和评论需要频率限制（可选实现）
3. **权限校验**：转发和@提及需检查拉黑关系

### 兼容性
- 所有新字段默认 NULL 或有默认值，兼容现有数据
- API 采用渐进增强，老客户端仍可正常使用基础功能

---

## 开发准备清单

### 开始前确认
- [ ] 数据库备份（开发/测试环境）
- [ ] Git 创建新分支 `feature/community-enhancements`
- [ ] 准备测试用例和测试数据
- [ ] 确认生产环境迁移方案

### 每阶段完成后
- [ ] 代码审查
- [ ] 单元测试/接口测试
- [ ] 更新 API 文档
- [ ] Git 提交并推送
- [ ] 部署到测试环境验证

---

**文档版本**: v1.0  
**创建日期**: 2026-06-13  
**预计完成日期**: 2026-06-14 ~ 2026-06-16
