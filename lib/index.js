// dsh-jsnu-model —— 宿主半边（host half）
//
// 作用：把「江苏师范大学大模型广场」（model.jsnu.edu.cn，New API 系）的
//      登录态与余额/工作台数据，接进 DSH 本机，供
//        ① 控制台面板（侧边栏入口）读取；
//        ② dsh-whale-widget「自定义 API 模型」读取余额。
//
// 背景（为什么需要它）：
//   - 该站不能用账号密码登录（本地密码被管理员关闭），只能走江苏师范大学统一身份认证（CAS + reCAPTCHA）；
//   - 登录态不走 Cookie 会话，而是 `Authorization: Bearer <access token>`（JWT，**有效期仅 15 分钟**）；
//   - 续期靠一个 HttpOnly Cookie `new_api_refresh`（浏览器 JS 读不到，只能由本插件在宿主侧保存并代替浏览器发起）。
//   ⇒ 所以必须有一个常驻的宿主侧组件持有并自动续期这个 token，浏览器/挂件都拿不到。
//
// 凭据存放：$DSH_HOME/.dsh-jsnu-model-session.json（原子写）。
// 旧版（dsh-jsnu-console）的 .dsh-jsnu-session.json 会在首次读取时自动迁移过来。
// 本文件不打印 token 明文。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PLUGIN_NAME = 'dsh-jsnu-model'
const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  ? process.env.DSH_HOME
  : path.join(os.homedir(), '.dsh')
const SESSION_FILE = path.join(DSH_HOME, '.dsh-jsnu-model-session.json')
// 旧版（dsh-jsnu-console）用的文件名；读不到新文件时回落到它，并自动迁移过来
const LEGACY_SESSION_FILE = path.join(DSH_HOME, '.dsh-jsnu-session.json')

// 供应商站点
const API_BASE = 'https://model.jsnu.edu.cn'
const QUOTA_PER_UNIT = 500000 // 站点 system-config: currency.quotaPerUnit
const CURRENCY = 'CNY'

// 本插件挂的路由前缀
const ROUTE_BASE = '/jsnu-model'

// access token 剩余不足这么久就先续期，避免临界失败
const REFRESH_SKEW_MS = 90 * 1000

// 续期 Cookie 名（New API 约定）
const REFRESH_COOKIE = 'new_api_refresh'

// 写进鲸鱼挂件注册表的条目
const WIDGET_MODEL_ID = 'jsnu'
const WIDGET_KEY_REF = 'JSNU_API_KEY' // 该凭据已存在于 DSH 凭据库；auth 为空 ⇒ 不会真的发出去

// 鲸鱼挂件注册表候选路径（与 dsh-whale-widget/lib/index.js:158-163 保持一致的前两项）
const WIDGET_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-api.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-api.json'),
  path.join(DSH_HOME, 'profiles', 'desktop', '.dshw-api.json'),
]

export const inject = ['webServer']

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function b64urlToJson(part) {
  try {
    const b = Buffer.from(String(part).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    return JSON.parse(b.toString('utf8'))
  } catch {
    return null
  }
}

/** 从 JWT（或 "Bearer JWT"）里取 payload */
function jwtPayload(token) {
  if (!token) return null
  const raw = String(token).replace(/^Bearer\s+/i, '').trim()
  const parts = raw.split('.')
  if (parts.length < 2) return null
  return b64urlToJson(parts[1])
}

/** access token 的绝对过期时间（毫秒）；解析不出来返回 0 */
function tokenExpMs(token) {
  const p = jwtPayload(token)
  return p && typeof p.exp === 'number' && isFinite(p.exp) ? p.exp * 1000 : 0
}

function tokenSid(token) {
  const p = jwtPayload(token)
  return p && typeof p.sid === 'string' ? p.sid : ''
}

function nowMs() { return Date.now() }

function money(units) {
  const n = Number(units)
  if (!isFinite(n)) return null
  return Math.round((n / QUOTA_PER_UNIT) * 1e6) / 1e6
}

function maskSecret(s) {
  const v = String(s || '')
  if (v.length <= 12) return v ? '***' : ''
  return v.slice(0, 6) + '…' + v.slice(-4)
}

/* ------------------------------------------------------------------ *
 * 会话持久化
 * ------------------------------------------------------------------ */

function defaultSession() {
  return {
    version: 1,
    accessToken: '',
    refreshToken: '',
    sid: '',
    lastUser: null,
    updatedAt: 0,
    lastError: '',
  }
}

function readSession() {
  for (const file of [SESSION_FILE, LEGACY_SESSION_FILE]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (raw && typeof raw === 'object') {
        const sess = Object.assign(defaultSession(), raw)
        // 从旧文件名读到的：顺手写进新文件，之后旧文件就可以删了
        if (file === LEGACY_SESSION_FILE) writeSession(sess)
        return sess
      }
    } catch { /* 首次运行 / 文件损坏都当作空会话，继续试下一个候选 */ }
  }
  return defaultSession()
}

function writeSession(s) {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true })
    const tmp = SESSION_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
    fs.renameSync(tmp, SESSION_FILE)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * 站点请求
 * ------------------------------------------------------------------ */

function baseHeaders(sess) {
  const h = {
    Accept: 'application/json',
    Origin: API_BASE,
    Referer: API_BASE + '/',
  }
  if (sess && sess.accessToken) h.Authorization = 'Bearer ' + sess.accessToken
  return h
}

function setCookieList(res) {
  try {
    if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie()
  } catch { /* 老 Node 没有这个 API */ }
  const one = res.headers.get('set-cookie')
  return one ? [one] : []
}

function pickCookieValue(list, name) {
  for (const line of list || []) {
    const m = String(line).match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'))
    if (m) return decodeURIComponent(m[1])
  }
  return ''
}

/**
 * 用 refresh cookie 换一个新的 access token。
 * 成功时顺带把轮换后的 refresh cookie 写回会话（New API 会 Set-Cookie 轮换）。
 */
async function doRefresh(sess, log) {
  if (!sess.refreshToken) return { ok: false, code: 'NO_REFRESH', error: '还没有保存续期凭据（new_api_refresh）' }
  const sid = sess.sid || tokenSid(sess.refreshToken) || ''
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: API_BASE,
    Referer: API_BASE + '/',
    Cookie: REFRESH_COOKIE + '=' + sess.refreshToken,
  }
  if (sid) headers['X-Auth-Session'] = sid

  let res
  try {
    res = await fetch(API_BASE + '/api/user/auth/refresh', { method: 'POST', headers, body: '{}' })
  } catch (err) {
    return { ok: false, code: 'NETWORK', error: String((err && err.message) || err) }
  }
  const text = await res.text()
  let j = null
  try { j = JSON.parse(text) } catch { /* 非 JSON */ }

  if (!res.ok || !j || j.success === false) {
    const msg = (j && (j.message || j.error)) || text.slice(0, 200) || ('HTTP ' + res.status)
    return { ok: false, code: res.status === 401 ? 'NEEDS_LOGIN' : 'HTTP_' + res.status, error: String(msg) }
  }

  const d = (j && j.data) || {}
  const token = d.access_token || d.token || (d.session && d.session.access_token) || j.access_token || j.token || ''
  if (!token) return { ok: false, code: 'SHAPE', error: '续期成功但响应里没有 access token' }

  const rotated = pickCookieValue(setCookieList(res), REFRESH_COOKIE)
  const next = Object.assign({}, sess, {
    accessToken: String(token),
    refreshToken: rotated || sess.refreshToken,
    sid: tokenSid(token) || sid,
    updatedAt: nowMs(),
    lastError: '',
  })
  writeSession(next)
  log?.info?.('[jsnu-model] access token 已续期，新过期时间 ' + new Date(tokenExpMs(token)).toISOString())
  return { ok: true, session: next, expiresAt: tokenExpMs(token), rotated: !!rotated }
}

/** 保证会话里有可用的 access token（不够新就续期一次） */
async function ensureFresh(sess, log) {
  const exp = tokenExpMs(sess.accessToken)
  if (exp && exp - nowMs() > REFRESH_SKEW_MS) return { ok: true, session: sess, expiresAt: exp }
  if (!sess.refreshToken) return { ok: false, code: 'NO_REFRESH', error: '尚未保存续期凭据', session: sess, expiresAt: exp }
  const r = await doRefresh(sess, log)
  if (r.ok) return { ok: true, session: r.session, expiresAt: r.expiresAt }
  return { ok: false, code: r.code, error: r.error, session: sess, expiresAt: exp }
}

/** 带自动续期的站点请求；返回 { status, ok, json, text, session, error } */
async function apiGet(sess, apiPath, log) {
  const fresh = await ensureFresh(sess, log)
  const use = fresh.ok ? fresh.session : sess
  if (!use.accessToken) {
    return { status: 0, ok: false, json: null, text: '', session: use, error: fresh.error || '未登录' }
  }
  let res
  try {
    res = await fetch(API_BASE + apiPath, { headers: baseHeaders(use) })
  } catch (err) {
    return { status: 0, ok: false, json: null, text: '', session: use, error: String((err && err.message) || err) }
  }
  const text = await res.text()
  let j = null
  try { j = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, ok: res.ok, json: j, text, session: use, error: '' }
}

/* ------------------------------------------------------------------ *
 * 余额 / 概览
 * ------------------------------------------------------------------ */

function selfToNumbers(self) {
  if (!self || typeof self !== 'object') return null
  const quota = Number(self.quota)
  const used = Number(self.used_quota)
  return {
    id: self.id,
    username: self.username || '',
    displayName: self.display_name || self.username || '',
    group: self.group || '',
    role: self.role,
    requestCount: Number(self.request_count) || 0,
    quota: isFinite(quota) ? quota : null,
    usedQuota: isFinite(used) ? used : null,
    remaining: isFinite(quota) ? money(quota) : null,
    used: isFinite(used) ? money(used) : null,
    total: isFinite(quota) && isFinite(used) ? money(quota + used) : null,
    currency: CURRENCY,
    quotaPerUnit: QUOTA_PER_UNIT,
  }
}

/** 汇总：账号 + 余额 + 今日/累计用量 */
async function buildSummary(sess, log) {
  const selfRes = await apiGet(sess, '/api/user/self', log)
  const out = {
    ok: false,
    updatedAt: new Date().toISOString(),
    account: null,
    balance: null,
    usage: null,
    session: sessionView(selfRes.session || sess),
    error: '',
  }
  if (!selfRes.json || selfRes.json.success !== true) {
    out.error = selfRes.error || (selfRes.json && selfRes.json.message) || ('HTTP ' + selfRes.status)
    if (selfRes.status === 401) out.session.needsLogin = true
    return out
  }
  const acct = selfToNumbers(selfRes.json.data)
  out.account = acct
  out.balance = acct
  out.ok = true

  const logs = await apiGet(selfRes.session, '/api/log/self?p=0&page_size=50', log)
  if (logs.json && logs.json.success === true && logs.json.data && Array.isArray(logs.json.data.items)) {
    const items = logs.json.data.items
    const dayKey = (ts) => {
      try {
        return new Date(ts * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
      } catch { return '' }
    }
    const today = dayKey(Math.floor(Date.now() / 1000))
    let todayQuota = 0
    let todayTokens = 0
    let todayReqs = 0
    for (const it of items) {
      if (dayKey(it.created_at) !== today) continue
      todayReqs += 1
      todayQuota += Number(it.quota) || 0
      todayTokens += (Number(it.prompt_tokens) || 0) + (Number(it.completion_tokens) || 0)
    }
    out.usage = {
      totalRequests: (logs.json.data.total != null ? logs.json.data.total : acct.requestCount),
      todayRequests: todayReqs,
      todayQuota,
      todayTokens,
      todayCost: money(todayQuota),
      recent: items.slice(0, 10).map((it) => ({
        at: it.created_at,
        model: it.model_name || '',
        tokens: (Number(it.prompt_tokens) || 0) + (Number(it.completion_tokens) || 0),
        quota: Number(it.quota) || 0,
        cost: money(it.quota),
        tokenName: it.token_name || '',
      })),
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 鲸鱼挂件注册表
 * ------------------------------------------------------------------ */

function readWidgetRegistry() {
  for (const p of WIDGET_FILE_CANDIDATES) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (parsed && Array.isArray(parsed.models)) return { file: p, reg: parsed }
    } catch { /* 继续找下一个候选 */ }
  }
  return { file: WIDGET_FILE_CANDIDATES[0], reg: { version: 1, models: [], usage: {} } }
}

function widgetEntryFor(origin) {
  return {
    id: WIDGET_MODEL_ID,
    name: '江苏师范大学大模型广场',
    provider: 'custom',
    currency: CURRENCY,
    // keyRef 只为了让挂件的「凭据目的地」闸门放行；auth 里没有 {key} ⇒ 凭据一个字节都不会发出去。
    keyRef: WIDGET_KEY_REF,
    allowCustomHost: true,
    baseUrl: '',
    balance: {
      url: origin + ROUTE_BASE + '/raw/self',
      auth: 'X-DSH-Jsnu-Bridge: 1',
      json: {
        remaining: 'data.quota',
        used: 'data.used_quota',
        scale: 1 / QUOTA_PER_UNIT,
      },
    },
  }
}

function writeWidgetEntry(origin) {
  const { file, reg } = readWidgetRegistry()
  const models = Array.isArray(reg.models) ? reg.models.filter((m) => m && m.id !== WIDGET_MODEL_ID) : []
  models.push(widgetEntryFor(origin))
  const next = Object.assign({}, reg, { version: reg.version || 1, models })
  if (!next.usage || typeof next.usage !== 'object') next.usage = {}
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  return { file, entry: widgetEntryFor(origin) }
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  // 有意不发 CORS 头：面板与本站同源，跨源页面不该能读到这些数据。
  res.end(text)
}

async function readBody(req, limit = 256 * 1024) {
  return await new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { resolve(''); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

function sessionView(sess) {
  const exp = tokenExpMs(sess.accessToken)
  return {
    hasToken: !!sess.accessToken,
    hasRefresh: !!sess.refreshToken,
    sid: sess.sid ? maskSecret(sess.sid) : '',
    expiresAt: exp ? new Date(exp).toISOString() : null,
    secondsLeft: exp ? Math.max(0, Math.round((exp - nowMs()) / 1000)) : 0,
    updatedAt: sess.updatedAt ? new Date(sess.updatedAt).toISOString() : null,
    needsLogin: !sess.accessToken && !sess.refreshToken,
    lastError: sess.lastError || '',
  }
}

/** 把「浏览器里复制出来的凭据」存进会话 */
async function saveCredentials(sess, input, log) {
  let accessToken = String(input.accessToken || input.token || '').trim()
  if (/^authorization\s*:/i.test(accessToken)) accessToken = accessToken.replace(/^[^:]*:\s*/i, '')
  if (/^bearer\s+/i.test(accessToken)) accessToken = accessToken.replace(/^bearer\s+/i, '')
  accessToken = accessToken.trim()

  let refreshToken = String(input.refreshToken || input.refresh || '').trim()
  const m = refreshToken.match(new RegExp(REFRESH_COOKIE + '=?([^;\\s]+)'))
  if (m) refreshToken = m[1]
  refreshToken = refreshToken.trim()

  const next = Object.assign({}, sess)
  if (accessToken) next.accessToken = accessToken
  if (refreshToken) next.refreshToken = refreshToken
  const sid = tokenSid(accessToken) || tokenSid(refreshToken)
  if (sid) next.sid = sid
  next.updatedAt = nowMs()
  next.lastError = ''
  writeSession(next)
  log?.info?.('[jsnu-model] 已保存凭据 access=' + maskSecret(accessToken) + ' refresh=' + maskSecret(refreshToken) + ' sid=' + maskSecret(next.sid))
  return next
}

function registerRoutes(ctx, webServer, log) {
  const disposers = []

  const add = (p, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path: ROUTE_BASE + p, handler }))
  }

  // —— 健康检查 ——
  add('/health', async (req, res) => {
    const sess = readSession()
    sendJson(res, 200, { ok: true, plugin: PLUGIN_NAME, version: '0.1.0', session: sessionView(sess) })
  })

  // —— 本机状态（不联网）——
  add('/status', async (req, res) => {
    const sess = readSession()
    sendJson(res, 200, { ok: true, session: sessionView(sess) })
  })

  // —— 原始 self（给鲸鱼挂件用；上游响应原样透传，所以挂件里配的 JSON 路径就是上游路径）——
  add('/raw/self', async (req, res) => {
    const sess = readSession()
    const r = await apiGet(sess, '/api/user/self', log)
    if (r.json) { sendJson(res, r.status || 200, r.json); return }
    sendJson(res, r.status || 502, { success: false, message: r.error || '上游没有返回 JSON' })
  })

  // —— 汇总（账号 + 余额 + 用量）——
  add('/summary', async (req, res) => {
    const sess = readSession()
    const out = await buildSummary(sess, log)
    sendJson(res, out.ok ? 200 : 502, out)
  })

  // —— 通用代理：/proxy?path=/api/log/self&p=0&page_size=20 ——
  add('/proxy', async (req, res) => {
    let url
    try { url = new URL(req.url, 'http://x.invalid') } catch { sendJson(res, 400, { ok: false, error: 'bad url' }); return }
    const target = url.searchParams.get('path') || ''
    if (!/^\/api\//.test(target)) { sendJson(res, 400, { ok: false, error: 'path 必须以 /api/ 开头' }); return }
    const qs = new URLSearchParams(url.searchParams)
    qs.delete('path')
    const tail = qs.toString()
    const sess = readSession()
    const r = await apiGet(sess, target + (tail ? (target.includes('?') ? '&' : '?') + tail : ''), log)
    if (r.json) { sendJson(res, r.status || 200, r.json); return }
    sendJson(res, r.status || 502, { success: false, message: r.error || '上游没有返回 JSON' })
  })

  // —— 保存凭据（POST JSON，或 GET ?token=&refresh= 方便手点）——
  const connectHandler = async (req, res, input) => {
    const sess = readSession()
    if (!input.accessToken && !input.token && !input.refreshToken && !input.refresh) {
      sendJson(res, 400, { ok: false, error: '需要 accessToken 或 refreshToken' })
      return
    }
    const next = await saveCredentials(sess, input, log)
    const probe = await apiGet(next, '/api/user/self', log)
    const acct = probe.json && probe.json.success === true ? selfToNumbers(probe.json.data) : null
    const after = readSession()
    if (!acct) {
      after.lastError = probe.error || (probe.json && probe.json.message) || ('HTTP ' + probe.status)
      writeSession(after)
    }
    sendJson(res, acct ? 200 : 502, {
      ok: !!acct,
      session: sessionView(readSession()),
      account: acct,
      error: acct ? '' : (probe.error || (probe.json && probe.json.message) || '凭据无效'),
    })
  }

  add('/connect', async (req, res) => {
    let url
    try { url = new URL(req.url, 'http://x.invalid') } catch { sendJson(res, 400, { ok: false }); return }
    await connectHandler(req, res, {
      accessToken: url.searchParams.get('token') || url.searchParams.get('accessToken') || '',
      refreshToken: url.searchParams.get('refresh') || url.searchParams.get('refreshToken') || '',
    })
  })

  add('/session', async (req, res) => {
    if ((req.method || 'GET').toUpperCase() !== 'POST') { sendJson(res, 405, { ok: false, error: 'use POST' }); return }
    const raw = await readBody(req)
    let input = {}
    try { input = JSON.parse(raw || '{}') } catch { input = { accessToken: raw.trim() } }
    await connectHandler(req, res, input)
  })

  // —— 主动续期 ——
  add('/refresh', async (req, res) => {
    const sess = readSession()
    const r = await doRefresh(sess, log)
    if (!r.ok) {
      const s = readSession()
      s.lastError = r.error || r.code
      writeSession(s)
    }
    sendJson(res, r.ok ? 200 : 502, {
      ok: r.ok,
      code: r.code || '',
      error: r.error || '',
      rotated: !!r.rotated,
      session: sessionView(readSession()),
    })
  })

  // —— 清空凭据 ——
  add('/clear', async (req, res) => {
    writeSession(defaultSession())
    sendJson(res, 200, { ok: true, session: sessionView(readSession()) })
  })

  // —— 一键接入鲸鱼挂件 ——
  const whaleSetup = async (req, res) => {
    try {
      const host = String(req.headers.host || '').trim()
      const origin = host ? 'http://' + host : 'http://127.0.0.1:19387'
      const out = writeWidgetEntry(origin)
      log?.info?.('[jsnu-model] 已写入鲸鱼挂件模型条目 -> ' + out.file)
      sendJson(res, 200, { ok: true, file: out.file, origin, entry: out.entry })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
    }
  }
  add('/whale-setup', whaleSetup)

  return () => { for (const d of disposers.splice(0)) { try { d() } catch { /* ignore */ } } }
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  const log = typeof ctx.logger === 'function' ? ctx.logger(PLUGIN_NAME) : ctx.logger
  log?.info?.(`[${PLUGIN_NAME}] host half loaded v0.1.0 (session file: ${SESSION_FILE})`)

  const webServer = ctx.webServer || (typeof ctx.get === 'function' ? ctx.get('webServer') : null)
  if (!webServer || typeof webServer.register !== 'function') {
    log?.warn?.(`[${PLUGIN_NAME}] 没有 webServer 服务，路由 ${ROUTE_BASE}/* 未注册`)
    return () => {}
  }

  const dispose = registerRoutes(ctx, webServer, log)
  log?.info?.(`[${PLUGIN_NAME}] 路由已注册：${ROUTE_BASE}/status|summary|raw/self|proxy|connect|session|refresh|clear|whale-setup`)

  return () => {
    try { dispose() } catch { /* ignore */ }
    log?.info?.(`[${PLUGIN_NAME}] 已卸载`)
  }
}
