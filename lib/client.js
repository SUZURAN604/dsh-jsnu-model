// dsh-jsnu-model —— 客户端半边（侧边栏图标 + 整页面板）
//
// 手工编写的 __ModuleLoader__ bundle（无需打包器）。宿主半边 lib/index.js 提供
// /jsnu-model/* 接口；本文件只负责 UI。

window.__ModuleLoader__.load({
  id: 'dsh-jsnu-model',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var e = React.createElement

    var PANEL_ID = 'jsnu-model'
    var PANEL_ORDER = 58
    var CONSOLE_URL = 'https://model.jsnu.edu.cn'

    // 运行时服务名（fiber）
    var inject = ['slots']

    /* ---------------- 与宿主通信 ---------------- */

    function call(path, init) {
      var urls = ['jsnu-model' + path, '/jsnu-model' + path]
      var i = 0
      function attempt() {
        if (i >= urls.length) return Promise.reject(new Error('无法连接本机插件服务 /jsnu-model/*'))
        var url = urls[i++]
        return fetch(url, init).then(
          function (r) {
            if (r.status === 404) return attempt()
            return r.json().catch(function () { return null }).then(function (j) {
              return { ok: r.ok, status: r.status, json: j }
            })
          },
          function () { return attempt() }
        )
      }
      return attempt()
    }

    /* ---------------- 小工具 ---------------- */

    function money(n) {
      if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '—'
      var s = String(Math.round(Number(n) * 10000) / 10000)
      if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '')
      return '¥' + s
    }

    function when(ts) {
      if (!ts) return '—'
      try {
        return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false })
      } catch (err) { return String(ts) }
    }

    var C = {
      bg: 'var(--dsh-color-bg, transparent)',
      fg: 'var(--dsh-color-fg, inherit)',
      dim: 'color-mix(in srgb, currentColor 62%, transparent)',
      line: 'color-mix(in srgb, currentColor 16%, transparent)',
      card: 'color-mix(in srgb, currentColor 5%, transparent)',
    }

    function Card(props) {
      return e('div', {
        style: {
          border: '1px solid ' + C.line,
          borderRadius: 10,
          background: C.card,
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        },
      }, props.title ? e('div', { style: { fontWeight: 600, fontSize: 13, opacity: 0.9 } }, props.title) : null, props.children)
    }

    function KV(props) {
      return e('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, lineHeight: '20px' } },
        e('span', { style: { opacity: 0.62 } }, props.k),
        e('span', { style: { fontVariantNumeric: 'tabular-nums', fontWeight: props.strong ? 600 : 400 } }, props.v))
    }

    function Btn(props) {
      return e('button', {
        type: 'button',
        disabled: props.disabled,
        onClick: props.onClick,
        style: {
          padding: '6px 12px',
          fontSize: 13,
          borderRadius: 8,
          border: '1px solid ' + C.line,
          background: props.primary ? 'color-mix(in srgb, currentColor 14%, transparent)' : 'transparent',
          color: 'inherit',
          cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.5 : 1,
        },
      }, props.label)
    }

    function Input(props) {
      return e('input', {
        type: 'text',
        value: props.value,
        placeholder: props.placeholder,
        spellCheck: false,
        onChange: function (ev) { props.onChange(ev.target.value) },
        style: {
          width: '100%',
          boxSizing: 'border-box',
          padding: '6px 9px',
          fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          borderRadius: 8,
          border: '1px solid ' + C.line,
          background: 'transparent',
          color: 'inherit',
        },
      })
    }

    /* ---------------- 侧边栏图标 ---------------- */

    function Icon(props) {
      var size = (props && props.size) || 18
      return e('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { opacity: props && props.active ? 1 : 0.78 },
      },
        e('rect', { x: 2.5, y: 6, width: 19, height: 12.5, rx: 2.5 }),
        e('path', { d: 'M2.5 10.5h19' }),
        e('path', { d: 'M5.8 15.2h4.2' }),
        e('circle', { cx: 17.2, cy: 15.2, r: 1.15, fill: 'currentColor', stroke: 'none' }))
    }

    /* ---------------- 面板主体 ---------------- */

    function Page() {
      var s1 = React.useState({ loading: true, error: '', status: null, summary: null })
      var st = s1[0], setSt = s1[1]
      var s2 = React.useState(false)
      var frame = s2[0], setFrame = s2[1]
      var s3 = React.useState({ token: '', refresh: '' })
      var cred = s3[0], setCred = s3[1]
      var s4 = React.useState('')
      var note = s4[0], setNote = s4[1]
      var s5 = React.useState(false)
      var busy = s5[0], setBusy = s5[1]

      var load = React.useCallback(function () {
        setSt(function (p) { return Object.assign({}, p, { loading: true, error: '' }) })
        return call('/status').then(function (r1) {
          return call('/summary').then(function (r2) {
            setSt({ loading: false, error: '', status: r1.json, summary: r2.json })
          })
        }).catch(function (err) {
          setSt({ loading: false, error: String((err && err.message) || err), status: null, summary: null })
        })
      }, [])

      React.useEffect(function () {
        load()
        var t = setInterval(load, 60000)
        return function () { clearInterval(t) }
      }, [load])

      function saveCreds() {
        setBusy(true); setNote('正在验证…')
        call('/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken: cred.token, refreshToken: cred.refresh }),
        }).then(function (r) {
          var j = r.json || {}
          setBusy(false)
          setNote(j.ok ? '已验证，凭据可用。' : ('保存失败：' + (j.error || '')))
          if (j.ok) setCred({ token: '', refresh: '' })
          return load()
        }).catch(function (err) {
          setBusy(false); setNote('请求失败：' + String((err && err.message) || err))
        })
      }

      function whaleSetup() {
        setBusy(true); setNote('正在写入鲸鱼挂件注册表…')
        call('/whale-setup').then(function (r) {
          var j = r.json || {}
          setBusy(false)
          setNote(j.ok ? ('已写入 ' + j.file + '（模型 id：' + j.entry.id + '）') : ('失败：' + (j.error || '')))
        }).catch(function (err) {
          setBusy(false); setNote('请求失败：' + String((err && err.message) || err))
        })
      }

      var status = st.status || {}
      var sess = status.session || {}
      var sum = st.summary || {}
      var acct = sum.account || null
      var usage = sum.usage || null

      var header = e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
        e('div', { style: { fontSize: 15, fontWeight: 600 } }, '江苏师范大学大模型广场'),
        e('div', { style: { fontSize: 12, opacity: 0.55 } }, sess.hasToken ? ('令牌剩余 ' + (sess.secondsLeft || 0) + ' 秒') : '未连接'),
        e('div', { style: { flex: 1 } }),
        e(Btn, { label: '刷新', onClick: load, disabled: busy }),
        e(Btn, { label: frame ? '隐藏内嵌控制台' : '内嵌控制台', onClick: function () { setFrame(!frame) } }),
        e(Btn, { label: '在浏览器打开', onClick: function () { window.open(CONSOLE_URL, '_blank', 'noopener') } }))

      var body = []

      if (st.error) {
        body.push(e(Card, { key: 'err', title: '连接异常' }, e('div', { style: { fontSize: 13 } }, st.error)))
      }

      if (acct) {
        body.push(e(Card, { key: 'bal', title: '账户与余额' },
          e(KV, { k: '账号', v: acct.displayName || acct.username || ('#' + acct.id) }),
          e(KV, { k: '用户组', v: acct.group || '—' }),
          e(KV, { k: '剩余额度', v: money(acct.remaining), strong: true }),
          e(KV, { k: '已用额度', v: money(acct.used) }),
          e(KV, { k: '累计额度', v: money(acct.total) }),
          e(KV, { k: '请求次数', v: String(acct.requestCount || 0) })))
      } else {
        body.push(e(Card, { key: 'noauth', title: '尚未连接' },
          e('div', { style: { fontSize: 13, lineHeight: '20px', opacity: 0.8 } },
            '该站点的登录态不使用 Cookie 会话，而是 15 分钟有效期的 Bearer 令牌，续期需要 HttpOnly Cookie new_api_refresh。',
            e('br'),
            '请在已登录的控制台里取得这两项后填入下方（续期 Cookie 决定长期可用性）。')))
      }

      if (usage) {
        body.push(e(Card, { key: 'use', title: '工作台用量（最近 50 条记录内统计）' },
          e(KV, { k: '今日请求', v: String(usage.todayRequests || 0) }),
          e(KV, { k: '今日消耗', v: money(usage.todayCost), strong: true }),
          e(KV, { k: '今日 Token', v: String(usage.todayTokens || 0) }),
          e(KV, { k: '历史请求总数', v: String(usage.totalRequests || 0) }),
          usage.recent && usage.recent.length
            ? e('div', { style: { marginTop: 4, borderTop: '1px solid ' + C.line, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 } },
                usage.recent.slice(0, 6).map(function (it, i) {
                  return e('div', { key: i, style: { display: 'flex', justifyContent: 'space-between', fontSize: 12, gap: 10, opacity: 0.85 } },
                    e('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, it.model || '未知模型'),
                    e('span', { style: { fontVariantNumeric: 'tabular-nums', opacity: 0.75 } }, String(it.tokens) + ' tok · ' + money(it.cost) + ' · ' + when(it.at)))
                }))
            : null))
      }

      body.push(e(Card, { key: 'creds', title: '凭据' },
        e('div', { style: { fontSize: 12, opacity: 0.62, lineHeight: '18px' } },
          'accessToken：控制台请求头 Authorization 的 Bearer 值（15 分钟过期，可留空）'),
        e(Input, { value: cred.token, placeholder: 'eyJhbGciOi… 或 Bearer eyJhbGciOi…', onChange: function (v) { setCred(Object.assign({}, cred, { token: v })) } }),
        e('div', { style: { fontSize: 12, opacity: 0.62, lineHeight: '18px', marginTop: 4 } },
          'refreshToken：new_api_refresh Cookie 的值（长期有效，推荐填写）'),
        e(Input, { value: cred.refresh, placeholder: 'new_api_refresh=… 里的值', onChange: function (v) { setCred(Object.assign({}, cred, { refresh: v })) } }),
        e('div', { style: { display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' } },
          e(Btn, { label: '保存并验证', primary: true, disabled: busy, onClick: saveCreds }),
          e(Btn, { label: '接入鲸鱼挂件', disabled: busy, onClick: whaleSetup }),
          e(Btn, {
            label: '清除凭据', disabled: busy,
            onClick: function () {
              setBusy(true)
              call('/clear').then(function () { setBusy(false); setNote('已清除。'); return load() })
                .catch(function () { setBusy(false) })
            },
          })),
        note ? e('div', { style: { fontSize: 12, opacity: 0.75, marginTop: 2 } }, note) : null))

      if (sum.error) {
        body.push(e(Card, { key: 'serr', title: '站点返回' }, e('div', { style: { fontSize: 12, opacity: 0.75, wordBreak: 'break-all' } }, sum.error)))
      }

      return e('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
        e('div', { style: { padding: '16px 20px 10px', display: 'flex', flexDirection: 'column', gap: 12, overflowY: frame ? 'hidden' : 'auto', flex: frame ? '0 0 auto' : '1 1 auto' } },
          header, body),
        frame
          ? e('div', { style: { flex: '1 1 auto', borderTop: '1px solid ' + C.line, minHeight: 0 } },
              e('iframe', {
                src: CONSOLE_URL,
                style: { width: '100%', height: '100%', border: '0', background: '#fff' },
                sandbox: 'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox',
              }))
          : null)
    }

    /* ---------------- 注册 ---------------- */

    function apply(ctx) {
      var slots = ctx && ctx.slots
      if (!slots || typeof slots.register !== 'function') {
        console.warn('[jsnu-model] 没有 slots 服务，面板未注册')
        return
      }
      var disposers = []
      try {
        disposers.push(slots.inject('sidebar.panellist', function () {
          return slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: function () { return '大模型广场' },
          }, Icon)
        }))
        disposers.push(slots.inject('main', function () {
          return slots.register({ name: 'main', key: PANEL_ID }, Page)
        }))
      } catch (err) {
        console.warn('[jsnu-model] 注册面板失败', err)
      }
      if (typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            for (var i = 0; i < disposers.length; i++) { try { disposers[i]() } catch (err) { /* ignore */ } }
            disposers.length = 0
          }
        })
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
