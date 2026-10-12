# dsh-jsnu-model

江苏师范大学大模型广场（<https://model.jsnu.edu.cn>）的 [DeepSeek Harness](https://github.com/deepseek-ai) 插件。

把「余额 + 工作台用量」接进 DSH：左侧边栏一个「大模型广场」面板，同时把余额喂给 `dsh-whale-widget` 挂件。

难点全在认证上——这个站是 **New API**，登录态不用 Cookie 会话，而是 **15 分钟有效期的 Bearer 令牌**，续期又只能靠一个 **HttpOnly** Cookie。浏览器的页面脚本读不到它，所以必须由一个常驻的宿主侧组件来持有并自动续期。这就是这个插件存在的原因。

## 它能做什么

- **侧边栏面板**：剩余 / 已用 / 累计额度、今日请求数、今日消耗、今日 Token、最近调用记录。
- **自动续期**：宿主侧持有 `new_api_refresh`，每次请求前检查令牌剩余寿命，不足 90 秒就静默换新（并把轮换后的新 Cookie 存回去）。
- **接入鲸鱼挂件**：一条命令把余额写进 `dsh-whale-widget` 的模型注册表，让挂件气泡显示本校余额。
- **内嵌控制台 / 一键跳转**到官网。

## 安装

从源码目录安装（`link:` 方式，适合自行修改）：

```powershell
dsh plugin --profile desktop add link:C:\path\to\dsh-jsnu-model
```

装完刷新 GUI 页面。宿主半边跑在 GUI 自己的端口上（默认 `19387`），路由前缀 `/jsnu-model`。

> **改完代码要重启 DSH。** 宿主只在 `dsh plugin add` 那一刻读一次插件代码，之后既不监视 `link:` 目录，也不会因为重装同一个依赖而重读。详见「已知限制」。

## 使用

1. 打开 DSH 侧边栏的「大模型广场」。
2. 在官网登录后，取得两项凭据（见下节），填进面板的「凭据」卡片，点「保存并验证」。
3. 想接鲸鱼挂件就点「接入鲸鱼挂件」。

### 续期凭据怎么拿（人工一次）

**推荐**：F12 → **应用 / Application** → 存储 → **Cookie** → `https://model.jsnu.edu.cn` → 找 `new_api_refresh`，复制「值」那一格（这个面板能看到 `HttpOnly` 的 Cookie）。

**或者**：F12 → **网络 / Network** → 点任意一条 `/api/...` 请求 → **请求标头** → 复制 `cookie:` 那一整行。

两种格式都收（裸值，或一整行 `new_api_refresh=...; ...`）。也可以用 API：

```powershell
Invoke-RestMethod -Method POST http://127.0.0.1:19387/jsnu-model/session `
  -ContentType application/json `
  -Body '{"refreshToken":"<new_api_refresh 的值>"}'
```

## 认证协议（这块是全部难点，记下来）

站点是 **New API**，有两种完全不同的凭据：

| | 形态 | 有效期 | 用途 |
|---|---|---|---|
| access token | JWT，`Authorization: Bearer <jwt>` | **15 分钟** | 调 `/api/user/self`、`/api/log/self` 等 |
| refresh token | `new_api_refresh` Cookie | **30 天** | 只用来换新的 access token |

### 续期只能靠那个 Cookie

```
POST https://model.jsnu.edu.cn/api/user/auth/refresh
Cookie: new_api_refresh=<sid>.<hmac>
```

这是**唯一**能续期的办法。实测过且全部 401 的替代方案：

- 只带 `X-Auth-Session: <sid>` → 401
- 带一个**有效的** `Authorization: Bearer <access token>` → 401
- 加 `Origin` / `Referer` / JSON body / 各种大小写 header → 401

而且每次失败都会回一个 `Set-Cookie: new_api_refresh=; Max-Age=0`，即服务端主动清空该 Cookie——明确表示「你没有这个 Cookie，别试了」。

**成功时的响应**（`200`）：

```json
{ "data": { "access_token": "eyJ...", "access_expires_at": 1791740295 } }
```

同时 `Set-Cookie` 会**轮换**出一个新的 refresh token：

```
new_api_refresh=<sid>.<新的hmac>; Path=/api/user/auth; Expires=Tue, 10 Nov 2026 16:46:52 GMT; Max-Age=2589794; HttpOnly; SameSite=Strict
```

⚠️ 所以每次续期都必须把新的 Cookie 值存回去。它是**滑动 30 天**的——只要 30 天内成功续过一次，会话就能一直活下去。

### 为什么必须由宿主侧代管

`new_api_refresh` 是 `HttpOnly`，页面里的 `document.cookie` 读不到、跨源 iframe 也拿不到。所以只能由拓扑上的「宿主」进程保存这个值并代替浏览器发请求。这正是 `lib/index.js` 里 `doRefresh()` 干的事。

### 其它死路（别再试了）

- 站点的 `sk-` API key **读不了钱包**：`Authorization: Bearer sk-...` 打 `/api/user/self` 一律 401。
- OpenAI 兼容的计费端点能过，但对 `unlimited_quota` 的 key 毫无意义：
  `GET /v1/dashboard/billing/subscription` → `{"hard_limit_usd":100000000,...}`。
- **没有本地密码**：`POST /api/user/login` 用统一身份认证的账号密码会返回
  `{"message":"Username or password is incorrect, or user has been banned","success":false}`。
  这个站走 SSO，New API 侧没有设置过本地密码。
- 自动 OAuth 也走不通：回调地址有 `redirect_uri` 白名单，headless 触发从来不会落到自己的回调页。
- 统一身份认证走 CAS（`sid.jsnu.edu.cn/cas`），带 Google reCAPTCHA + 加密口令，无法自动化。

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/jsnu-model/health` | 存活 + 版本 + 会话状态 |
| GET | `/jsnu-model/status` | 会话状态（含 `secondsLeft`、`needsLogin`） |
| GET | `/jsnu-model/summary` | 账户 + 余额 + 工作台用量（面板用这个） |
| GET | `/jsnu-model/raw/self` | 原样返回 `/api/user/self`，给鲸鱼挂件消费 |
| GET | `/jsnu-model/proxy?path=/api/...` | 通用只读代理 |
| POST | `/jsnu-model/session` | 保存 `{accessToken, refreshToken}` |
| GET | `/jsnu-model/connect?token=&refresh=` | 同上，Query 形式，方便手点 |
| GET | `/jsnu-model/refresh` | 强制续期一次 |
| GET | `/jsnu-model/clear` | 清空凭据 |
| POST | `/jsnu-model/whale-setup` | 写入鲸鱼挂件的模型条目 |

会话持久化在 `$DSH_HOME/.dsh-jsnu-model-session.json`，每次请求都重新从磁盘读，所以外部改它立即生效。
（旧版文件名 `.dsh-jsnu-session.json` 会在首次读取时自动迁移。）

安全设计：所有路由**有意不发 CORS 头**——面板与宿主同源，跨源页面不该能读到这些数据。

## 数据口径

- 余额字段：`quota`（剩余）/ `used_quota`（已用），单位是 New API 的 quota。
- `quotaPerUnit = 500000` ⇒ **¥ = quota / 500000**（所以挂件那边 `scale: 0.000002`）。
- 工作台用量：`/api/log/self` 按 `created_at` 过滤当天，聚合请求数 / quota / tokens。

## 接入 dsh-whale-widget

`POST /jsnu-model/whale-setup` 会往 `$DSH_HOME/.dshw-api.json` 写一条：

```json
{
  "id": "jsnu",
  "provider": "custom",
  "keyRef": "JSNU_API_KEY",
  "allowCustomHost": true,
  "balance": {
    "url": "http://127.0.0.1:19387/jsnu-model/raw/self",
    "auth": "X-DSH-Jsnu-Bridge: 1",
    "json": { "remaining": "data.quota", "used": "data.used_quota", "scale": 0.000002 }
  }
}
```

两个容易踩的点（来自读挂件 `lib/index.js` 的实现）：

- `keyForDestination` 要求 `keyRef` 能解析，否则直接 `NO_KEY`；而且 `credentialMayGoTo` 只放行模板自带域名 **或** `allowCustomHost === true`。指向 `127.0.0.1` 属于后者，**必须显式打开**。
- 挂件自己的 `API_TEMPLATES.custom` 里 `keyRef` 是 `CUSTOM_API_KEY`，所以这里覆盖成 `JSNU_API_KEY`（该 ref 需要存在于 DSH 凭据库，`auth` 里不含 `{key}` ⇒ 凭据一个字节都不会发出去）。

写的时候只动 `models` 里 id 为 `jsnu` 的那条，`usage` 段（挂件自己记的 `dayStart` / `lastBalance` / `delta`）原样保留。

## 项目结构

```
lib/index.js        宿主半边：令牌管理、续期、路由、鲸鱼挂件注册表读写
lib/client.js       客户端半边：手工编写的 __ModuleLoader__ bundle，侧边栏面板（无需打包器）
cordis.patch.yml    只做「新增一行」的补充层
```

`lib/client.js` 是手写的，不走构建：

```js
window.__ModuleLoader__.load({
  id: 'dsh-jsnu-model',
  factory: (require) => { /* ... */ exports.apply = apply; exports.inject = inject; return module.exports },
})
```

## 已知限制

- **宿主只在 `dsh plugin add` 那一刻读一次插件代码**，之后既不监视 `link:` 目录，也不会因为重装同一个依赖而重读（`reconcilePackage` 在 `sourceKey` 不变时提前返回，连 bundle 快照都不刷新）。改完 `lib/*.js` 要么重启 DSH，要么把包挪到新路径重新 `add`。
- 客户端 bundle `lib/client.js` 同样按安装时的快照下发（`compose()` 用 `record.bundle`），不热更新。
- 手写的 `client.js` 只能通过 **combo** URL 取到：`/plugins/??dsh-jsnu-model/client.js&rev=<entryRev>`，其中 `<entryRev> = sha1("plugin-artifact\0" + len("mtimeMs")+":"+mtimeMs + ...)` 取前 12 位。逐包的 `/plugins/<id>/client.X.js` 路由只服务构建产物名（`CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/`），手写包名对不上，探到 404 是正常的。
- 续期 Cookie 是**滑动 30 天**：超过 30 天没有成功续期，就得重新去浏览器里复制一次。

## 免责声明

本插件需要你保存自己账号的续期 Cookie，它等同于该站点上的登录态。凭据只写在**本机** `$DSH_HOME` 下（已加入 `.gitignore`），除了 `model.jsnu.edu.cn` 之外不会发往任何地方。请自行评估风险，不要把它提交进任何仓库。

仅供个人在本校账号上使用。请遵守站点的使用条款。

## 许可证

[MIT](LICENSE)
