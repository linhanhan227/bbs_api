# 安全审计报告

## 概述
本报告涵盖了项目中发现的所有安全漏洞、逻辑错误和改进建议。按照严重程度分类：🔴 高危、🟠 中危、🟡 低危。

---

## 🔴 高危问题

### 1. 生产环境密钥未强制配置
**位置**: `src/middleware/auth.js:4`, `src/app.js:29`

**问题描述**:
```javascript
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
secret: process.env.SESSION_SECRET || 'dev-session-secret',
```

生产环境若未配置 `JWT_SECRET` 和 `SESSION_SECRET`，将使用默认弱密钥，攻击者可伪造任意用户的 JWT 令牌和会话。

**修复建议**:
```javascript
// src/middleware/auth.js
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET 环境变量未配置，应用无法启动');
}

// src/app.js
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET 环境变量未配置，应用无法启动');
}
```

或者仅在生产环境强制检查：
```javascript
const { env } = require('./config/database');
if (env === 'production') {
  if (!process.env.JWT_SECRET || !process.env.SESSION_SECRET) {
    throw new Error('生产环境必须配置 JWT_SECRET 和 SESSION_SECRET');
  }
}
```

---

### 2. 密码强度不一致（注册8位 vs 修改6位）
**位置**: `src/routes/auth.js:12-13`, `src/routes/users.js:74-75`

**问题描述**:
- 注册时要求密码至少 8 位
- 修改资料时仅要求 6 位，可绕过注册限制降低密码强度

**修复建议**:
```javascript
// src/routes/users.js:74-75
if (typeof req.body.password !== 'string' || req.body.password.length < 8) {
  return res.status(400).json({ code: 400, message: '密码至少 8 位' });
}
```

---

### 3. 管理后台缺少 CSRF 防护
**位置**: `src/routes/admin.js` (所有 POST 请求)

**问题描述**:
虽然 `sameSite: 'lax'` 提供了基础防护，但不足以抵御所有 CSRF 攻击（如 GET 改 POST、浏览器兼容性问题）。管理后台的破坏性操作（封禁用户、删除内容、处理举报）缺少 CSRF Token 验证。

**受影响端点**:
- `POST /admin/users/:id/toggle-ban` - 封禁/解封用户
- `POST /admin/users/:id/delete` - 删除用户及全部数据
- `POST /admin/posts/:id/delete` - 删除动态
- `POST /admin/comments/:id/delete` - 删除评论
- `POST /admin/reports/:id/handle` - 处理举报

**修复建议**:

1. 使用 `csurf` 中间件：
```javascript
// src/app.js
const csrf = require('csurf');
const csrfProtection = csrf({ cookie: false }); // 使用 session 存储

// 管理后台路由前添加
app.use('/admin', csrfProtection);

// 错误处理中添加
if (err.code === 'EBADCSRFTOKEN') {
  return isApi
    ? res.status(403).json({ code: 403, message: 'CSRF 验证失败' })
    : res.status(403).send('无效的请求');
}
```

2. 在所有管理后台表单中添加 CSRF Token：
```ejs
<!-- views/admin/*.ejs -->
<input type="hidden" name="_csrf" value="<%= csrfToken %>">
```

3. 传递 token 到视图：
```javascript
// src/routes/admin.js (所有 render 调用)
res.render('admin/dashboard', {
  csrfToken: req.csrfToken(),
  // ... 其他数据
});
```

---

## 🟠 中危问题

### 4. SQL LIKE 注入风险（虽已有转义，仍需验证完整性）
**位置**: `src/utils/helpers.js:30-34`, 使用处：`src/routes/posts.js:114`, `src/routes/users.js:29`, `src/routes/admin.js:74-75`, `src/routes/admin.js:209`

**当前实现**:
```javascript
function escapeLike(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[%_\\]/g, '\\$&');
}
```

**问题**:
- 已正确转义 `%`, `_`, `\`，但需确认 Sequelize 是否正确处理转义符
- MySQL 和 SQLite 的 ESCAPE 子句处理可能不同

**验证建议**:
测试以下输入是否被正确转义：
```javascript
// 测试用例
escapeLike('100%')      // 应返回 '100\\%'
escapeLike('test_case') // 应返回 'test\\_case'
escapeLike('a\\b')      // 应返回 'a\\\\b'
```

**强化建议**（如果 Sequelize 未自动处理 ESCAPE 子句）:
```javascript
// 在 Sequelize 查询中显式指定 ESCAPE
where: {
  content: sequelize.where(
    sequelize.fn('LOWER', sequelize.col('content')),
    'LIKE',
    sequelize.literal(`'%${escapeLike(keyword)}%' ESCAPE '\\\\'`)
  )
}
```

---

### 5. 输入长度限制不完整
**位置**: 多个路由文件

**缺少长度验证的字段**:

| 字段 | 当前限制 | 建议 |
|------|---------|------|
| `username` | 数据库 32 字符 | 注册时应前端验证 1-32 字符 |
| `nickname` | 数据库 32 字符 | 已验证 ✓ (users.js:54) |
| `city` | 数据库 64 字符 | 应验证不超过 64 字符 |
| `bio` | 数据库 500 字符 | 应验证不超过 500 字符 |
| `avatar` | 数据库 255 字符 | 应验证 URL 格式和长度 |
| `content` (动态) | 数据库 TEXT (65535) | 应添加合理上限（如 5000 字符） |
| `Friendship.message` | 数据库 200 字符 | 应前端验证不超过 200 字符 |

**修复示例**:
```javascript
// src/routes/auth.js 注册时
if (username.length < 3 || username.length > 32) {
  return res.status(400).json({ code: 400, message: '用户名长度 3-32 字符' });
}
if (!/^[a-zA-Z0-9_]+$/.test(username)) {
  return res.status(400).json({ code: 400, message: '用户名只能包含字母、数字和下划线' });
}

// src/routes/users.js 修改资料时
if (req.body.city !== undefined) {
  const city = String(req.body.city).trim();
  if (city.length > 64) {
    return res.status(400).json({ code: 400, message: '城市名最长 64 字符' });
  }
  req.user.city = city;
}

if (req.body.bio !== undefined) {
  const bio = String(req.body.bio).trim();
  if (bio.length > 500) {
    return res.status(400).json({ code: 400, message: '个人简介最长 500 字符' });
  }
  req.user.bio = bio;
}

// src/routes/posts.js 发布动态时
if (content.trim().length > 5000) {
  return res.status(400).json({ code: 400, message: '动态内容最长 5000 字符' });
}
```

---

### 6. 私信内容类型检查缺失
**位置**: `src/routes/messages.js:54-56`

**问题描述**:
```javascript
if (!content || !content.trim()) {
  return res.status(400).json({ code: 400, message: '消息内容不能为空' });
}
```

如果 `content` 不是字符串（如数字、对象），调用 `.trim()` 会抛出异常导致 500 错误。

**修复建议**:
```javascript
if (typeof content !== 'string' || !content.trim()) {
  return res.status(400).json({ code: 400, message: '消息内容不能为空' });
}
```

---

### 7. 举报原因长度限制
**位置**: `src/routes/reports.js:25`, 数据库 `src/models/index.js:138`

**问题**:
虽然数据库限制为 500 字符，但代码未在应用层验证，可能导致 Sequelize 抛出验证错误。

**修复建议**:
```javascript
// src/routes/reports.js:25 之后添加
if (reason.trim().length > 500) {
  return res.status(400).json({ code: 400, message: '举报原因最长 500 字符' });
}
```

---

## 🟡 低危问题 / 代码质量改进

### 8. 整数解析未统一处理 NaN
**位置**: 多处

**已正确处理的**:
- ✓ `src/utils/helpers.js:18-27` (parsePage)
- ✓ `src/routes/posts.js:102` (userId 参数)
- ✓ `src/routes/users.js:64` (age 参数)
- ✓ `src/routes/messages.js:49` (targetId 参数)
- ✓ `src/routes/friends.js:14` (targetId 参数)
- ✓ `src/routes/reports.js:20` (targetId 参数)
- ✓ `src/routes/admin.js:68, 170, 205` (page 参数)
- ✓ `src/routes/admin.js:192` (id 参数并显式检查)

**可能的改进点**:
虽然大部分地方已用 `Number.isInteger()` 检查，但为确保一致性，建议：

```javascript
// src/utils/helpers.js 添加通用函数
function parsePositiveInt(value, fieldName = '参数') {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`${fieldName} 必须是正整数`);
  }
  return num;
}

module.exports = {
  validateIdParam, parsePage, notify, isBlockedBetween,
  cascadeDeletePosts, cascadeDeleteComments, escapeLike,
  parsePositiveInt // 新增
};
```

---

### 9. 管理后台删除操作的参数校验
**位置**: `src/routes/admin.js:189-200`, `src/routes/admin.js:230-237`

**当前实现**:
```javascript
// 删除动态
router.post('/posts/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isInteger(id) && id > 0) {
      await sequelize.transaction(async (t) => {
        await cascadeDeletePosts([id], t);
      });
    }
    res.redirect(req.get('referer') || '/admin/posts');
  } catch (err) { next(err); }
});

// 删除评论
router.post('/comments/:id/delete', async (req, res, next) => {
  try {
    await sequelize.transaction(async (t) => {
      await cascadeDeleteComments([Number(req.params.id)], t);
    });
    res.redirect(req.get('referer') || '/admin/comments');
  } catch (err) { next(err); }
});
```

**问题**:
- 删除动态：有 id 校验，但 NaN 时静默失败（不报错也不删除）
- 删除评论：缺少 id 校验，NaN 会传入 `cascadeDeleteComments([NaN], t)`

**修复建议**:
```javascript
// 删除动态：不合法时应提示而非静默
router.post('/posts/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).send('无效的动态 ID');
    }
    await sequelize.transaction(async (t) => {
      await cascadeDeletePosts([id], t);
    });
    res.redirect(req.get('referer') || '/admin/posts');
  } catch (err) { next(err); }
});

// 删除评论：添加校验
router.post('/comments/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).send('无效的评论 ID');
    }
    await sequelize.transaction(async (t) => {
      await cascadeDeleteComments([id], t);
    });
    res.redirect(req.get('referer') || '/admin/comments');
  } catch (err) { next(err); }
});
```

---

### 10. images 数组元素未验证
**位置**: `src/routes/posts.js:44-46`

**当前实现**:
```javascript
if (images !== undefined && !Array.isArray(images)) {
  return res.status(400).json({ code: 400, message: 'images 必须是数组' });
}
```

**问题**:
仅验证是数组，未验证元素类型和长度。攻击者可提交：
```json
{
  "content": "test",
  "images": ["https://example.com/1.jpg", null, {}, 123, "x".repeat(10000)]
}
```

**修复建议**:
```javascript
if (images !== undefined) {
  if (!Array.isArray(images)) {
    return res.status(400).json({ code: 400, message: 'images 必须是数组' });
  }
  if (images.length > 9) {
    return res.status(400).json({ code: 400, message: '最多上传 9 张图片' });
  }
  for (const img of images) {
    if (typeof img !== 'string' || img.length > 500) {
      return res.status(400).json({ code: 400, message: '图片 URL 必须是字符串且不超过 500 字符' });
    }
    // 可选：验证 URL 格式
    try {
      new URL(img);
    } catch {
      return res.status(400).json({ code: 400, message: '图片 URL 格式不正确' });
    }
  }
}
```

---

### 11. 好友申请消息长度未验证
**位置**: `src/routes/friends.js:15`, 数据库 `src/models/index.js:44`

**问题**:
数据库限制 `message` 为 200 字符，但应用层未验证，依赖 Sequelize 抛出验证错误。

**修复建议**:
```javascript
// src/routes/friends.js:15 之后添加
if (message !== undefined && message !== null) {
  if (typeof message !== 'string') {
    return res.status(400).json({ code: 400, message: '附加消息必须是字符串' });
  }
  if (message.length > 200) {
    return res.status(400).json({ code: 400, message: '附加消息最长 200 字符' });
  }
}
```

---

### 12. 原型链污染防护
**位置**: `src/routes/reports.js:17-18`

**当前实现** (已正确防护):
```javascript
if (!Object.prototype.hasOwnProperty.call(TARGET_MODELS, targetType)) {
  return res.status(400).json({ code: 400, message: 'targetType 必须是 user / post / comment' });
}
```

**评价**: ✓ 已正确使用 `hasOwnProperty.call()` 防止原型链污染攻击。

**其他需要类似防护的地方**:
无。其他枚举字段都通过数组白名单验证（如 gender、action、status），已足够安全。

---

### 13. 管理员账户创建的密码强度
**位置**: `.env.example:25`

**问题**:
默认管理员密码 `admin123456` 仅 12 位，虽然符合最低要求，但不够强。

**建议**:
在文档中建议管理员首次登录后立即修改密码，并要求：
- 至少 16 字符
- 包含大小写字母、数字、特殊符号

可在 `src/routes/users.js` 中为管理员角色添加更强的密码策略。

---

### 14. Session Cookie 安全配置
**位置**: `src/app.js:34`

**当前实现**:
```javascript
cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 4 }
```

**建议**:
生产环境（HTTPS）应启用 `secure` 标志：
```javascript
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: env === 'production', // 生产环境强制 HTTPS
    maxAge: 1000 * 60 * 60 * 4
  }
}));

// 如果使用反向代理（如 Nginx），需添加：
if (env === 'production') {
  app.set('trust proxy', 1);
}
```

---

### 15. 级联删除的事务一致性
**位置**: `src/utils/helpers.js:59-96`

**当前实现评价**:
✓ 已正确使用事务
✓ 已顺序执行删除操作（避免并发问题）
✓ 已处理孤儿举报

**小优化建议**:
添加日志记录，便于审计：
```javascript
async function cascadeDeletePosts(postIds, t) {
  if (!postIds || !postIds.length) return;
  console.log(`[cascadeDeletePosts] 准备删除动态: ${postIds.join(', ')}`);
  
  const comments = await Comment.findAll({
    where: { postId: { [Op.in]: postIds } },
    attributes: ['id'],
    transaction: t
  });
  const commentIds = comments.map(c => c.id);
  console.log(`[cascadeDeletePosts] 同时删除 ${commentIds.length} 条评论`);
  
  // ... 其余删除逻辑 ...
}
```

---

## 📋 修复优先级建议

### 立即修复（本周内）:
1. ✅ **强制生产环境密钥配置** (#1)
2. ✅ **统一密码强度要求为 8 位** (#2)
3. ✅ **添加管理后台 CSRF 防护** (#3)

### 高优先级（本月内）:
4. ✅ **私信内容类型检查** (#6)
5. ✅ **完善输入长度限制** (#5)
6. ✅ **验证图片数组元素** (#10)

### 中优先级（下一版本）:
7. ✅ **管理后台删除操作参数校验** (#9)
8. ✅ **好友申请消息长度验证** (#11)
9. ✅ **举报原因长度验证** (#7)
10. ✅ **Session Cookie 安全配置** (#14)

### 低优先级（优化迭代）:
11. ⚠️ **验证 SQL LIKE 转义完整性** (#4) - 需测试确认
12. 📝 **添加级联删除日志** (#15) - 可选
13. 📝 **管理员密码策略文档** (#13) - 文档更新

---

## 🧪 测试建议

### 安全测试用例:
1. **JWT 伪造测试**: 尝试使用 `dev-secret` 伪造 JWT（修复后应失败）
2. **密码强度测试**: 注册 8 位密码后，尝试修改为 6 位（修复后应失败）
3. **CSRF 测试**: 从外部域提交管理后台表单（修复后应被拒绝）
4. **SQL LIKE 注入**: 搜索 `%`、`_`、`\`，确认不会匹配所有结果
5. **类型混淆测试**: 
   - 发送 `{"content": 123}` 到发布动态接口
   - 发送 `{"images": "not-an-array"}` 
   - 发送 `{"userId": "not-a-number"}`
6. **长度溢出测试**: 
   - 提交 10000 字符的动态内容
   - 提交 1000 字符的城市名
7. **原型污染测试**: 
   - 发送 `{"targetType": "__proto__"}` 到举报接口
   - 发送 `{"targetType": "constructor"}`

---

## 📚 参考资源

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [Sequelize Security](https://sequelize.org/docs/v6/core-concepts/raw-queries/#replacements)

---

**审计完成时间**: 2026-06-13  
**审计工具**: 人工代码审查
