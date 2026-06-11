# 交友社区后端 API 文档

基于 Express + Sequelize 的交友社区后端，自带 EJS 管理后台。

- **正式运行版**：MySQL（`NODE_ENV=production`）
- **测试/开发版**：SQLite（`NODE_ENV=test` 或 `development`），零配置开箱即用

## 快速开始

```bash
npm install
# 国内网络如 sqlite3 预编译包下载超时，用镜像：
# npm_config_sqlite3_binary_host_mirror=https://npmmirror.com/mirrors/sqlite3/ npm install

cp .env.example .env   # 按需修改密钥和数据库配置

npm run test:run       # 测试版（SQLite，数据存 ./data/community.sqlite）
npm run dev            # 开发版（SQLite）
npm start              # 正式版（MySQL，需先建库：CREATE DATABASE friend_community CHARSET utf8mb4）
```

启动后：

- API 地址：`http://localhost:3000/api`
- 健康检查：`GET http://localhost:3000/health`
- 管理后台：`http://localhost:3000/admin`（默认账号 `admin` / `admin123456`，可在 `.env` 中修改）

首次启动自动建表并创建管理员账号。

> 开发/测试环境如修改了模型结构，删除 `data/*.sqlite` 后重启即可重建。
> 注意不要对 SQLite 使用 `sync({ alter: true })`——Sequelize 重建表时会把复合唯一索引错误拆成单列 UNIQUE 约束。

## 项目结构

```
src/
  config/database.js    # 数据库配置（按 NODE_ENV 切换 MySQL / SQLite）
  models/index.js       # User / Friendship / Follow / Block / Post / Comment
                        # / Like / Favorite / Message / Notification / Report
  middleware/auth.js    # JWT 认证（API）+ session 认证（管理后台）
  utils/helpers.js      # 分页、ID 参数校验、通知创建、拉黑判断等公共函数
  routes/
    auth.js             # 注册 / 登录 / 当前用户
    users.js            # 用户广场 / 资料修改 / 用户主页
    friends.js          # 好友申请（发送/撤回/处理）/ 好友列表 / 删除好友
    follows.js          # 关注 / 取关 / 关注列表 / 粉丝列表
    blocks.js           # 拉黑 / 取消拉黑 / 黑名单
    posts.js            # 动态 / 点赞 / 收藏 / 评论
    messages.js         # 私信 / 会话 / 撤回 / 删除
    notifications.js    # 通知列表 / 未读数 / 标记已读
    reports.js          # 举报提交 / 我的举报记录
    admin.js            # 管理后台路由
  app.js                # Express 应用装配
  server.js             # 启动入口（建表 + 初始化管理员）
views/admin/            # 管理后台 EJS 模板
```

---

# 全局约定

## 基础 URL

文档中所有示例以 `http://localhost:3000` 为基础 URL，**部署后请替换为实际地址**。API 统一前缀为 `/api`。

## 通用请求头

| 请求头 | 值 | 说明 |
|---|---|---|
| `Content-Type` | `application/json` | 所有带请求体的接口（POST / PUT） |
| `Authorization` | `Bearer <token>` | 除注册 / 登录外的所有 `/api` 接口必填 |

`token` 由注册或登录接口返回，JWT 格式，默认有效期 **7 天**（`.env` 中 `JWT_EXPIRES_IN` 可调）。

## 统一响应格式

```json
{ "code": 0, "message": "操作结果描述（可选）", "data": "业务数据（可选）" }
```

- `code = 0` 表示成功；失败时 `code` 与 HTTP 状态码一致。
- 列表类接口统一支持 query 参数 `page`（默认 1）、`pageSize`（默认 20，上限 50；评论列表默认 20 上限 100；聊天记录默认 30 上限 100），返回结构：

```json
{ "code": 0, "data": { "list": [], "total": 0, "page": 1, "pageSize": 20 } }
```

## 错误码约定

错误响应区分具体场景，**资源不存在（404）与无权限（403）不再混用**：

| HTTP 状态码 | 含义 | 示例消息 |
|---|---|---|
| 400 | 参数错误（缺失、格式非法、超长） | `参数 id 必须是正整数`、`内容不能为空` |
| 401 | 未登录或 token 无效 / 过期 | `未登录`、`登录已过期，请重新登录` |
| 403 | 无权限 / 被禁止 | `只能删除自己的动态`、`该用户已被封禁`、`只能给好友发送私信` |
| 404 | 资源不存在 | `动态不存在`、`接口不存在` |
| 409 | 状态冲突 | `已有待处理的好友申请`、`你已举报过，请等待处理` |
| 500 | 服务器内部错误 | `服务器内部错误` |

错误响应示例：

```json
{ "code": 403, "message": "只能删除自己的动态" }
```

账号被封禁后，所有需登录接口返回 `403 账号已被封禁`。

---

# 接口汇总

| 模块 | 方法 | 路径 | 说明 |
|---|---|---|---|
| 认证 | POST | `/api/auth/register` | 注册（返回 token） |
| 认证 | POST | `/api/auth/login` | 登录（返回 token） |
| 认证 | GET | `/api/auth/me` | 当前登录用户信息 |
| 用户 | GET | `/api/users` | 交友广场（搜索筛选） |
| 用户 | PUT | `/api/users/me` | 修改自己的资料 / 密码 |
| 用户 | GET | `/api/users/:id` | 用户主页（统计 + 关系状态） |
| 好友 | POST | `/api/friends/requests` | 发送好友申请 |
| 好友 | GET | `/api/friends/requests` | 收到的待处理申请 |
| 好友 | GET | `/api/friends/requests/sent` | 我发出的待处理申请 |
| 好友 | PUT | `/api/friends/requests/:id` | 同意 / 拒绝申请 |
| 好友 | DELETE | `/api/friends/requests/:id` | 撤回我发出的申请 |
| 好友 | GET | `/api/friends` | 好友列表 |
| 好友 | DELETE | `/api/friends/:friendshipId` | 删除好友 |
| 关注 | PUT | `/api/follows/:userId` | 关注某人（幂等） |
| 关注 | DELETE | `/api/follows/:userId` | 取消关注（幂等） |
| 关注 | GET | `/api/follows/following` | 我的关注列表 |
| 关注 | GET | `/api/follows/followers` | 我的粉丝列表 |
| 黑名单 | PUT | `/api/blocks/:userId` | 拉黑某人（幂等） |
| 黑名单 | DELETE | `/api/blocks/:userId` | 取消拉黑（幂等） |
| 黑名单 | GET | `/api/blocks` | 黑名单列表 |
| 动态 | POST | `/api/posts` | 发布动态 |
| 动态 | GET | `/api/posts` | 动态广场 / 按用户 / 关键词搜索 |
| 动态 | GET | `/api/posts/:id` | 动态详情（含评论） |
| 动态 | DELETE | `/api/posts/:id` | 删除自己的动态 |
| 动态 | PUT | `/api/posts/:id/like` | 点赞（幂等） |
| 动态 | DELETE | `/api/posts/:id/like` | 取消点赞（幂等） |
| 动态 | PUT | `/api/posts/:id/favorite` | 收藏（幂等） |
| 动态 | DELETE | `/api/posts/:id/favorite` | 取消收藏（幂等） |
| 动态 | GET | `/api/posts/favorites/mine` | 我的收藏列表 |
| 动态 | POST | `/api/posts/:id/comments` | 发表评论 |
| 动态 | GET | `/api/posts/:id/comments` | 评论列表（分页） |
| 动态 | DELETE | `/api/posts/:postId/comments/:commentId` | 删除评论 |
| 私信 | POST | `/api/messages` | 发送私信（仅好友） |
| 私信 | GET | `/api/messages/conversations` | 会话列表 |
| 私信 | GET | `/api/messages/unread-count` | 全部未读私信数 |
| 私信 | GET | `/api/messages/with/:userId` | 与某人的聊天记录 |
| 私信 | PUT | `/api/messages/:id/recall` | 撤回消息（2 分钟内） |
| 私信 | DELETE | `/api/messages/:id` | 删除单条消息 |
| 私信 | DELETE | `/api/messages/conversations/:userId` | 清空与某人的会话 |
| 通知 | GET | `/api/notifications` | 通知列表 |
| 通知 | GET | `/api/notifications/unread-count` | 未读通知数 |
| 通知 | PUT | `/api/notifications/read-all` | 全部标记已读 |
| 通知 | PUT | `/api/notifications/:id/read` | 单条标记已读 |
| 通知 | DELETE | `/api/notifications/:id` | 删除单条通知 |
| 举报 | POST | `/api/reports` | 提交举报 |
| 举报 | GET | `/api/reports/mine` | 我提交的举报记录 |

---

# 认证模块

## POST `/api/auth/register` — 注册

权限：公开。

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| username | body | string | 是 | 用户名，唯一，最长 32 字符 |
| password | body | string | 是 | 密码，至少 6 位（bcrypt 加密存储） |
| nickname | body | string | 否 | 昵称，默认同 username，最长 32 字符 |
| gender | body | string | 否 | `male` / `female` / `secret`，默认 `secret` |
| age | body | integer | 否 | 年龄 |
| city | body | string | 否 | 城市，最长 64 字符 |
| bio | body | string | 否 | 个人简介，最长 500 字符 |

请求示例：

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"pass123","nickname":"爱丽丝","gender":"female","age":25,"city":"上海","bio":"喜欢旅行"}'
```

成功响应（201）：

```json
{
  "code": 0,
  "message": "注册成功",
  "data": {
    "user": {
      "id": 2, "username": "alice", "nickname": "爱丽丝",
      "gender": "female", "age": 25, "city": "上海", "bio": "喜欢旅行",
      "role": "user", "status": "active",
      "createdAt": "2026-06-11T16:58:07.094Z", "updatedAt": "2026-06-11T16:58:07.094Z"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...."
  }
}
```

错误响应：

```json
{ "code": 409, "message": "用户名已存在" }
```

| 状态码 | 场景 |
|---|---|
| 400 | 用户名或密码为空；密码少于 6 位；字段超长或枚举非法 |
| 409 | 用户名已存在 |

## POST `/api/auth/login` — 登录

权限：公开。

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| username | body | string | 是 | 用户名 |
| password | body | string | 是 | 密码 |

请求示例：

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"pass123"}'
```

成功响应（200）：结构同注册，返回 `data.user` 与 `data.token`。

| 状态码 | 场景 |
|---|---|
| 401 | 用户名或密码错误 |
| 403 | 账号已被封禁 |

## GET `/api/auth/me` — 当前登录用户

权限：需登录（下文所有接口均需请求头 `Authorization: Bearer <token>`，不再重复标注）。

无参数。成功响应（200）：

```json
{
  "code": 0,
  "data": {
    "id": 2, "username": "alice", "nickname": "爱丽丝", "gender": "female",
    "age": 25, "city": "上海", "bio": "喜欢旅行", "avatar": null,
    "role": "user", "status": "active",
    "createdAt": "2026-06-11T16:58:07.094Z", "updatedAt": "2026-06-11T16:58:07.094Z"
  }
}
```

---

# 用户模块

## GET `/api/users` — 交友广场（搜索筛选）

自动排除自己、管理员、被封禁用户，以及与我存在任一方向拉黑关系的用户。

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| keyword | query | string | 否 | 按昵称模糊搜索 |
| gender | query | string | 否 | `male` / `female` / `secret` |
| city | query | string | 否 | 城市精确匹配 |
| page | query | integer | 否 | 页码，默认 1 |
| pageSize | query | integer | 否 | 每页条数，默认 20，上限 50 |

请求示例：

```bash
curl "http://localhost:3000/api/users?keyword=爱丽丝&gender=female&page=1&pageSize=10" \
  -H "Authorization: Bearer <token>"
```

成功响应（200）：

```json
{
  "code": 0,
  "data": {
    "list": [
      {
        "id": 2, "username": "alice", "nickname": "爱丽丝", "gender": "female",
        "age": 25, "city": "上海", "bio": "喜欢旅行", "avatar": null,
        "createdAt": "2026-06-11T16:58:07.094Z"
      }
    ],
    "total": 1, "page": 1, "pageSize": 10
  }
}
```

| 状态码 | 场景 |
|---|---|
| 400 | gender 不是 male / female / secret |

## PUT `/api/users/me` — 修改自己的资料 / 密码

所有字段均可选，只更新传入的字段。

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| nickname | body | string | 否 | 昵称，非空，最长 32 字符 |
| gender | body | string | 否 | `male` / `female` / `secret` |
| age | body | integer \| null | 否 | 0-150 的整数，传 `null` 清空 |
| city | body | string | 否 | 城市 |
| bio | body | string | 否 | 个人简介 |
| avatar | body | string | 否 | 头像 URL |
| password | body | string | 否 | 新密码，至少 6 位 |

成功响应（200）：

```json
{ "code": 0, "message": "资料已更新", "data": { "id": 2, "username": "alice", "city": "杭州", "bio": "喜欢旅行和摄影", "...": "..." } }
```

| 状态码 | 场景 |
|---|---|
| 400 | 昵称为空 / 超长；gender 非法；age 越界；密码少于 6 位 |

## GET `/api/users/:id` — 用户主页

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| id | path | integer | 是 | 用户 ID（正整数） |

成功响应（200），含统计与我和他的关系状态：

```json
{
  "code": 0,
  "data": {
    "id": 2, "username": "alice", "nickname": "爱丽丝", "gender": "female",
    "age": 25, "city": "杭州", "bio": "喜欢旅行和摄影", "avatar": null,
    "createdAt": "2026-06-11T16:58:07.094Z",
    "stats": { "followerCount": 0, "followingCount": 0, "postCount": 0 },
    "relation": { "isSelf": false, "isFollowing": false, "isFriend": false, "isBlockedByMe": false }
  }
}
```

| 状态码 | 场景 |
|---|---|
| 400 | id 不是正整数 |
| 403 | 该用户已被封禁 |
| 404 | 用户不存在 |

---

# 好友模块

## POST `/api/friends/requests` — 发送好友申请

对方会收到 `friend_request` 类型通知。被拒绝过可重新发起。

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| userId | body | integer | 是 | 目标用户 ID，不能是自己 |
| message | body | string | 否 | 申请附言，最长 200 字符 |

请求示例：

```bash
curl -X POST http://localhost:3000/api/friends/requests \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"userId":3,"message":"交个朋友吧"}'
```

成功响应（201）：

```json
{
  "code": 0,
  "message": "好友申请已发送",
  "data": {
    "id": 1, "requesterId": 2, "addresseeId": 3, "status": "pending",
    "message": "交个朋友吧",
    "createdAt": "2026-06-11T16:58:07.712Z", "updatedAt": "2026-06-11T16:58:07.712Z"
  }
}
```

| 状态码 | 场景 |
|---|---|
| 400 | userId 非法或是自己 |
| 403 | 对方已被封禁；存在拉黑关系 |
| 404 | 用户不存在 |
| 409 | 已是好友；已有待处理申请 |

## GET `/api/friends/requests` — 收到的待处理申请

支持分页参数。成功响应（200）：

```json
{
  "code": 0,
  "data": {
    "list": [
      {
        "id": 1, "requesterId": 2, "addresseeId": 3, "status": "pending",
        "message": "交个朋友吧", "createdAt": "2026-06-11T16:58:07.712Z", "updatedAt": "2026-06-11T16:58:07.712Z",
        "requester": { "id": 2, "nickname": "爱丽丝", "gender": "female", "age": 25, "city": "杭州", "avatar": null }
      }
    ],
    "total": 1, "page": 1, "pageSize": 20
  }
}
```

## GET `/api/friends/requests/sent` — 我发出的待处理申请

支持分页参数。结构同上，`requester` 换为 `addressee`（申请对象信息）。

## PUT `/api/friends/requests/:id` — 处理申请

仅申请的接收者可操作。同意后双方互为好友，申请人收到 `friend_accept` 通知。

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| id | path | integer | 是 | 申请 ID |
| action | body | string | 是 | `accept`（同意）或 `reject`（拒绝） |

请求示例：

```bash
curl -X PUT http://localhost:3000/api/friends/requests/1 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"action":"accept"}'
```

成功响应（200）：

```json
{ "code": 0, "message": "已同意", "data": { "id": 1, "requesterId": 2, "addresseeId": 3, "status": "accepted", "message": "交个朋友吧", "createdAt": "2026-06-11T16:58:07.712Z", "updatedAt": "2026-06-11T16:58:07.771Z" } }
```

| 状态码 | 场景 |
|---|---|
| 400 | action 不是 accept / reject；id 非法 |
| 403 | 不是该申请的接收者 |
| 404 | 申请不存在 |
| 409 | 申请已被同意 / 拒绝，不能重复处理 |

## DELETE `/api/friends/requests/:id` — 撤回申请

仅申请人可撤回，且仅限待处理状态。

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| id | path | integer | 是 | 申请 ID |

成功响应（200）：`{ "code": 0, "message": "已撤回申请" }`

| 状态码 | 场景 |
|---|---|
| 403 | 只能撤回自己发出的申请 |
| 404 | 申请不存在 |
| 409 | 申请已被处理，无法撤回 |

## GET `/api/friends` — 好友列表

支持分页参数。成功响应（200）：

```json
{
  "code": 0,
  "data": {
    "list": [
      {
        "friendshipId": 1,
        "since": "2026-06-11T16:58:07.771Z",
        "user": { "id": 3, "nickname": "小波", "gender": "secret", "age": null, "city": null, "avatar": null }
      }
    ],
    "total": 1, "page": 1, "pageSize": 20
  }
}
```

## DELETE `/api/friends/:friendshipId` — 删除好友

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| friendshipId | path | integer | 是 | 好友关系 ID（好友列表中的 `friendshipId`） |

成功响应（200）：`{ "code": 0, "message": "已删除好友" }`

| 状态码 | 场景 |
|---|---|
| 403 | 不是该好友关系的当事人 |
| 404 | 好友关系不存在 |

---

# 关注模块

## PUT `/api/follows/:userId` — 关注某人

幂等：首次关注返回 201，重复关注返回 200。对方收到 `follow` 通知。

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| userId | path | integer | 是 | 目标用户 ID，不能是自己 |

成功响应（201 / 200）：

```json
{ "code": 0, "message": "关注成功", "data": { "following": true } }
```

| 状态码 | 场景 |
|---|---|
| 400 | 不能关注自己；userId 非法 |
| 403 | 该用户已被封禁；对方已将你拉黑 |
| 404 | 用户不存在 |

## DELETE `/api/follows/:userId` — 取消关注

幂等，未关注时也返回成功。成功响应（200）：`{ "code": 0, "message": "已取消关注", "data": { "following": false } }`

## GET `/api/follows/following` — 我的关注列表

支持分页参数。成功响应（200）：

```json
{
  "code": 0,
  "data": {
    "list": [
      { "followId": 1, "since": "2026-06-11T16:58:07.866Z", "user": { "id": 3, "nickname": "小波", "gender": "secret", "age": null, "city": null, "avatar": null } }
    ],
    "total": 1, "page": 1, "pageSize": 20
  }
}
```

## GET `/api/follows/followers` — 我的粉丝列表

支持分页参数，结构同上。

---

# 黑名单模块

## PUT `/api/blocks/:userId` — 拉黑某人

幂等：首次拉黑返回 201，重复返回 200。**拉黑会自动解除双方好友关系和双向关注**；被拉黑者无法关注你、向你发好友申请或私信；交友广场中互相不可见。

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| userId | path | integer | 是 | 目标用户 ID，不能是自己 |

成功响应（201 / 200）：`{ "code": 0, "message": "已拉黑", "data": { "blocked": true } }`

| 状态码 | 场景 |
|---|---|
| 400 | 不能拉黑自己；userId 非法 |
| 404 | 用户不存在 |

## DELETE `/api/blocks/:userId` — 取消拉黑

幂等。成功响应（200）：`{ "code": 0, "message": "已移出黑名单", "data": { "blocked": false } }`

## GET `/api/blocks` — 黑名单列表

支持分页参数。成功响应（200）：

```json
{
  "code": 0,
  "data": {
    "list": [
      { "blockId": 1, "since": "2026-06-11T16:58:08.343Z", "user": { "id": 3, "nickname": "小波", "gender": "secret", "avatar": null } }
    ],
    "total": 1, "page": 1, "pageSize": 20
  }
}
```

---

# 动态模块

## POST `/api/posts` — 发布动态

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| content | body | string | 是 | 动态正文，非空 |
| images | body | string[] | 否 | 图片 URL 数组 |

请求示例：

```bash
curl -X POST http://localhost:3000/api/posts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"content":"今天天气真好，出去走走","images":["https://example.com/1.jpg"]}'
```

成功响应（201）：

```json
{
  "code": 0,
  "message": "发布成功",
  "data": {
    "id": 1, "userId": 2, "content": "今天天气真好，出去走走",
    "images": ["https://example.com/1.jpg"],
    "createdAt": "2026-06-11T16:58:07.921Z", "updatedAt": "2026-06-11T16:58:07.921Z"
  }
}
```

| 状态码 | 场景 |
|---|---|
| 400 | 内容为空；images 不是数组 |

## GET `/api/posts` — 动态列表（广场 / 按用户 / 搜索）

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| userId | query | integer | 否 | 只看某人的动态 |
| keyword | query | string | 否 | 按正文模糊搜索 |
| page / pageSize | query | integer | 否 | 分页，默认 1 / 20 |

成功响应（200），每条含作者、点赞数和我是否已赞：

```json
{
  "code": 0,
  "data": {
    "list": [
      {
        "id": 1, "userId": 2, "content": "今天天气真好，出去走走",
        "images": ["https://example.com/1.jpg"],
        "createdAt": "2026-06-11T16:58:07.921Z", "updatedAt": "2026-06-11T16:58:07.921Z",
        "author": { "id": 2, "nickname": "爱丽丝", "avatar": null },
        "likeCount": 0, "liked": false
      }
    ],
    "total": 1, "page": 1, "pageSize": 10
  }
}
```

## GET `/api/posts/:id` — 动态详情

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| id | path | integer | 是 | 动态 ID |

成功响应（200），在列表字段基础上额外返回 `comments`（按时间正序，含作者）和 `favorited`（我是否已收藏）：

```json
{
  "code": 0,
  "data": {
    "id": 1, "userId": 2, "content": "今天天气真好，出去走走",
    "images": ["https://example.com/1.jpg"],
    "author": { "id": 2, "nickname": "爱丽丝", "avatar": null },
    "comments": [
      {
        "id": 1, "postId": 1, "userId": 3, "content": "同感！",
        "createdAt": "2026-06-11T16:58:08.007Z", "updatedAt": "2026-06-11T16:58:08.007Z",
        "author": { "id": 3, "nickname": "小波", "avatar": null }
      }
    ],
    "likeCount": 1, "liked": true, "favorited": true,
    "createdAt": "2026-06-11T16:58:07.921Z", "updatedAt": "2026-06-11T16:58:07.921Z"
  }
}
```

| 状态码 | 场景 |
|---|---|
| 404 | 动态不存在 |

## DELETE `/api/posts/:id` — 删除自己的动态

连带删除其评论、点赞、收藏。

成功响应（200）：`{ "code": 0, "message": "已删除" }`

| 状态码 | 场景 |
|---|---|
| 403 | 只能删除自己的动态 |
| 404 | 动态不存在 |

## PUT `/api/posts/:id/like` — 点赞 / DELETE — 取消点赞

均幂等。首次点赞返回 201（作者收到 `like` 通知），重复点赞返回 200；取消点赞始终返回 200。

成功响应：`{ "code": 0, "message": "点赞成功", "data": { "liked": true } }` / `{ "code": 0, "message": "已取消点赞", "data": { "liked": false } }`

| 状态码 | 场景 |
|---|---|
| 404 | （点赞时）动态不存在 |

## PUT `/api/posts/:id/favorite` — 收藏 / DELETE — 取消收藏

行为与点赞一致（无通知）。响应字段为 `favorited`。

## GET `/api/posts/favorites/mine` — 我的收藏列表

支持分页参数。成功响应（200）：

```json
{
  "code": 0,
  "data": {
    "list": [
      {
        "favoriteId": 1,
        "favoritedAt": "2026-06-11T16:58:07.992Z",
        "post": {
          "id": 1, "userId": 2, "content": "今天天气真好，出去走走",
          "images": ["https://example.com/1.jpg"],
          "author": { "id": 2, "nickname": "爱丽丝", "avatar": null },
          "createdAt": "2026-06-11T16:58:07.921Z", "updatedAt": "2026-06-11T16:58:07.921Z"
        }
      }
    ],
    "total": 1, "page": 1, "pageSize": 20
  }
}
```

已被删除的动态不会出现在列表中。

## POST `/api/posts/:id/comments` — 发表评论

动态作者收到 `comment` 通知（含评论前 100 字）。

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| id | path | integer | 是 | 动态 ID |
| content | body | string | 是 | 评论内容，非空，最长 500 字符 |

成功响应（201）：

```json
{ "code": 0, "message": "评论成功", "data": { "id": 1, "postId": 1, "userId": 3, "content": "同感！", "createdAt": "2026-06-11T16:58:08.007Z", "updatedAt": "2026-06-11T16:58:08.007Z" } }
```

| 状态码 | 场景 |
|---|---|
| 400 | 评论内容为空 |
| 404 | 动态不存在 |

## GET `/api/posts/:id/comments` — 评论列表

按时间正序分页（默认 pageSize 20，上限 100），每条含 `author`。

| 状态码 | 场景 |
|---|---|
| 404 | 动态不存在 |

## DELETE `/api/posts/:postId/comments/:commentId` — 删除评论

**评论作者或动态作者**均可删除。

成功响应（200）：`{ "code": 0, "message": "已删除" }`

| 状态码 | 场景 |
|---|---|
| 403 | 既不是评论作者也不是动态作者 |
| 404 | 评论不存在 |

---

# 私信模块（仅好友之间）

## POST `/api/messages` — 发送私信

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| userId | body | integer | 是 | 接收者用户 ID，必须是好友 |
| content | body | string | 是 | 消息内容，非空，最长 1000 字 |

请求示例：

```bash
curl -X POST http://localhost:3000/api/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"userId":3,"content":"你好呀"}'
```

成功响应（201）：

```json
{
  "code": 0,
  "message": "发送成功",
  "data": {
    "id": 1, "senderId": 2, "receiverId": 3, "content": "你好呀",
    "isRead": false, "isRecalled": false,
    "createdAt": "2026-06-11T16:58:08.122Z", "updatedAt": "2026-06-11T16:58:08.122Z"
  }
}
```

| 状态码 | 场景 |
|---|---|
| 400 | 接收者非法或是自己；内容为空 / 超 1000 字 |
| 403 | 对方已被封禁；存在拉黑关系；不是好友 |
| 404 | 用户不存在 |

## GET `/api/messages/conversations` — 会话列表

返回每个聊天对象的最后一条可见消息和未读数（不分页，`data` 为数组）：

```json
{
  "code": 0,
  "data": [
    {
      "user": { "id": 2, "nickname": "爱丽丝", "avatar": null },
      "lastMessage": {
        "id": 1, "senderId": 2, "receiverId": 3, "content": "你好呀",
        "isRead": false, "isRecalled": false,
        "createdAt": "2026-06-11T16:58:08.122Z", "updatedAt": "2026-06-11T16:58:08.122Z",
        "sender": { "id": 2, "nickname": "爱丽丝", "avatar": null },
        "receiver": { "id": 3, "nickname": "小波", "avatar": null }
      },
      "unreadCount": 1
    }
  ]
}
```

## GET `/api/messages/unread-count` — 全部未读私信数

成功响应（200）：`{ "code": 0, "data": { "count": 1 } }`

## GET `/api/messages/with/:userId` — 聊天记录

调用后自动把对方发来的消息标记为已读。返回按时间正序；自己删除过的消息不可见；撤回的消息 `content` 为 `null`。

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| userId | path | integer | 是 | 对方用户 ID |
| page / pageSize | query | integer | 否 | 分页，默认 1 / 30，上限 100 |

成功响应（200）：

```json
{
  "code": 0,
  "data": {
    "list": [
      { "id": 1, "senderId": 2, "receiverId": 3, "content": "你好呀", "isRead": false, "isRecalled": false, "createdAt": "2026-06-11T16:58:08.122Z", "updatedAt": "2026-06-11T16:58:08.122Z" }
    ],
    "total": 1, "page": 1, "pageSize": 30
  }
}
```

## PUT `/api/messages/:id/recall` — 撤回消息

仅发送者可撤回，且仅限发送后 **2 分钟内**。撤回后双方都看不到原文。

成功响应（200）：

```json
{ "code": 0, "message": "已撤回", "data": { "id": 1, "senderId": 2, "receiverId": 3, "content": null, "isRead": true, "isRecalled": true, "createdAt": "2026-06-11T16:58:08.122Z", "updatedAt": "2026-06-11T16:58:08.183Z" } }
```

| 状态码 | 场景 |
|---|---|
| 400 | 发送超过 2 分钟 |
| 403 | 只能撤回自己发送的消息 |
| 404 | 消息不存在 |

## DELETE `/api/messages/:id` — 删除单条消息

仅对自己隐藏，对方仍可见；双方都删除后物理删除。

成功响应（200）：`{ "code": 0, "message": "已删除" }`

| 状态码 | 场景 |
|---|---|
| 403 | 不是该消息的发送者或接收者 |
| 404 | 消息不存在 |

## DELETE `/api/messages/conversations/:userId` — 清空会话

将与某人的全部消息对自己隐藏（对方不受影响）。

成功响应（200）：`{ "code": 0, "message": "会话已清空" }`

---

# 通知模块

好友申请（`friend_request`）、申请通过（`friend_accept`）、点赞（`like`）、评论（`comment`）、被关注（`follow`）时自动产生通知；另有 `system` 类型预留。自己触发自己的行为不产生通知。

## GET `/api/notifications` — 通知列表

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| unread | query | string | 否 | 传 `1` 只看未读 |
| page / pageSize | query | integer | 否 | 分页，默认 1 / 20 |

成功响应（200）：

```json
{
  "code": 0,
  "data": {
    "list": [
      {
        "id": 4, "userId": 3, "type": "follow", "actorId": 2,
        "postId": null, "content": null, "isRead": false,
        "createdAt": "2026-06-11T16:58:07.879Z", "updatedAt": "2026-06-11T16:58:07.879Z",
        "actor": { "id": 2, "nickname": "爱丽丝", "avatar": null },
        "post": null
      }
    ],
    "total": 2, "page": 1, "pageSize": 20
  }
}
```

`actor` 为触发者；`post` 为关联动态（仅点赞 / 评论通知有值，含 `id` 和 `content`）。

## GET `/api/notifications/unread-count` — 未读通知数

成功响应（200）：`{ "code": 0, "data": { "count": 2 } }`

## PUT `/api/notifications/read-all` — 全部标记已读

成功响应（200）：`{ "code": 0, "message": "已全部标记为已读", "data": { "affected": 1 } }`

## PUT `/api/notifications/:id/read` — 单条标记已读

成功响应（200）：`{ "code": 0, "message": "已标记为已读", "data": { "...": "通知对象，isRead 为 true" } }`

| 状态码 | 场景 |
|---|---|
| 403 | 不是自己的通知 |
| 404 | 通知不存在 |

## DELETE `/api/notifications/:id` — 删除单条通知

成功响应（200）：`{ "code": 0, "message": "已删除" }`。错误同上。

---

# 举报模块

## POST `/api/reports` — 提交举报

同一人对同一对象只能有一条待处理举报。

| 参数名 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| targetType | body | string | 是 | `user` / `post` / `comment` |
| targetId | body | integer | 是 | 被举报对象 ID |
| reason | body | string | 是 | 举报原因，非空，最长 500 字符 |

请求示例：

```bash
curl -X POST http://localhost:3000/api/reports \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"targetType":"user","targetId":2,"reason":"资料涉嫌虚假"}'
```

成功响应（201）：

```json
{
  "code": 0,
  "message": "举报已提交，我们会尽快处理",
  "data": {
    "id": 1, "reporterId": 4, "targetType": "user", "targetId": 2,
    "reason": "资料涉嫌虚假", "status": "pending",
    "createdAt": "2026-06-11T16:58:08.307Z", "updatedAt": "2026-06-11T16:58:08.307Z"
  }
}
```

| 状态码 | 场景 |
|---|---|
| 400 | targetType 非法；targetId 不是正整数；原因为空；举报自己 |
| 404 | 举报对象不存在 |
| 409 | 已举报过，等待处理中 |

## GET `/api/reports/mine` — 我提交的举报记录

支持分页参数。成功响应（200）：

```json
{
  "code": 0,
  "data": {
    "list": [
      { "id": 1, "reporterId": 4, "targetType": "user", "targetId": 2, "reason": "资料涉嫌虚假", "status": "pending", "handledAt": null, "createdAt": "2026-06-11T16:58:08.307Z", "updatedAt": "2026-06-11T16:58:08.307Z" }
    ],
    "total": 1, "page": 1, "pageSize": 20
  }
}
```

`status`：`pending` 待处理 / `resolved` 已处理 / `dismissed` 已驳回。

---

# 管理后台（`/admin`）

服务端渲染的 EJS 页面，使用 **session 认证**（非 JWT），表单以 `application/x-www-form-urlencoded` 提交，操作完成后重定向回原页面。session 有效期 4 小时。

| 方法 | 路径 | 说明 | 参数 |
|---|---|---|---|
| GET | `/admin/login` | 登录页 | — |
| POST | `/admin/login` | 登录 | body：`username`、`password`（须为 admin 角色账号） |
| POST | `/admin/logout` | 登出 | — |
| GET | `/admin` | 仪表盘（用户/动态/评论/好友/私信总数、今日新增、封禁数、待处理举报数） | — |
| GET | `/admin/users` | 用户管理列表 | query：`keyword`（用户名/昵称模糊搜索）、`page` |
| POST | `/admin/users/:id/toggle-ban` | 封禁 / 解封用户 | path：`id` |
| POST | `/admin/users/:id/delete` | 删除用户（连带其动态、评论、点赞、收藏、好友、关注、拉黑、私信、通知、举报） | path：`id` |
| GET | `/admin/posts` | 动态管理列表 | query：`page` |
| POST | `/admin/posts/:id/delete` | 删除动态（连带评论、点赞、收藏） | path：`id` |
| GET | `/admin/comments` | 评论管理列表 | query：`keyword`、`page` |
| POST | `/admin/comments/:id/delete` | 删除评论 | path：`id` |
| GET | `/admin/reports` | 举报管理列表（含举报对象摘要） | query：`status`（pending/resolved/dismissed，默认 pending）、`page` |
| POST | `/admin/reports/:id/handle` | 处理举报 | path：`id`；body：`action`（`dismiss` 驳回，其他值视为已处理） |

未登录访问受保护页面时重定向到 `/admin/login`。

---

# 环境变量（`.env`）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务端口 |
| `JWT_SECRET` | `dev-secret` | JWT 签名密钥（**上线必改**） |
| `JWT_EXPIRES_IN` | `7d` | token 有效期 |
| `SESSION_SECRET` | `dev-session-secret` | 管理后台 session 密钥（**上线必改**） |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `admin123456` | 初始管理员账号（**上线必改**） |
| `MYSQL_*` | — | 生产环境 MySQL 连接配置 |

## 切换到 MySQL（正式部署）

1. 创建数据库：`CREATE DATABASE friend_community DEFAULT CHARSET utf8mb4;`
2. 在 `.env` 中填写 `MYSQL_*` 配置，并修改 `JWT_SECRET` / `SESSION_SECRET` / `ADMIN_PASSWORD`
3. `npm start`

## 安全说明

- 密码使用 bcrypt 加密存储，接口永不返回密码字段
- 上线前务必修改 `.env` 中的所有密钥和默认管理员密码
- 生产环境建议挂在 HTTPS 反向代理（如 Nginx）之后，并为 session cookie 开启 `secure`
