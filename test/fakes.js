'use strict'
// Fakes shared by the suites: GitHub behind a fake fetch (answers from fixtures/ or a test's own routes, never
// the network), a cc-cockpit ctx written from `ccc guide api`, and a settable clock. Every name in here is made up.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const API = 'https://api.github.com'
const TOKEN = 'gho_testTokenNeverReal0123456789abcdef'
const TOKEN2 = 'gho_secondTokenNeverReal9876543210fedcba'
const ME = 'me'
const NOW = Date.parse('2026-11-08T12:00:00Z')

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'))
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const text = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } })

/**
 * A fake GitHub. `routes` is a list of `[method, pathOrRegExp, handler]`, matched in order against requests to
 * api.github.com (path without the query); a handler gets `(url, init, match)` and returns a Response. Requests to
 * any other origin go to `blob(url, init)` (log storage) or throw. `token` is the token the fake accepts (a request
 * with another one gets 401). Every request is recorded in `calls` with its auth header, so a test can prove the
 * token never left api.github.com.
 */
function fakeGitHub(opts = {}) {
  const calls = []
  let accepted = opts.token === undefined ? TOKEN : opts.token
  async function fetch(url, init = {}) {
    const headers = new Headers(init.headers || {})
    const u = new URL(url)
    calls.push({ url: String(url), method: init.method || 'GET', auth: headers.get('authorization'), headers, body: init.body, redirect: init.redirect })
    if (u.origin !== API) {
      if (opts.blob) return opts.blob(u, init, headers)
      throw new Error(`fake github: unexpected host ${u.origin}`)
    }
    if (headers.get('authorization') !== `Bearer ${accepted}`) return json({ message: 'Bad credentials' }, 401)
    const method = init.method || 'GET'
    for (const [m, p, handler] of opts.routes || []) {
      if (m !== method) continue
      const match = typeof p === 'string' ? (u.pathname === p ? [p] : null) : u.pathname.match(p)
      if (match) return handler(u, init, match)
    }
    return json({ message: 'Not Found' }, 404)
  }
  return {
    fetch,
    calls,
    accept(token) {
      accepted = token
    },
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'github-test-'))
}

/** An in-memory key-value store with the shape of ctx.storage / ctx.appStorage. */
function memStore() {
  const map = new Map()
  return {
    map,
    async get(k) {
      return map.has(k) ? structuredClone(map.get(k)) : undefined
    },
    async set(k, v) {
      map.set(k, structuredClone(v))
    },
    async delete(k) {
      map.delete(k)
    },
    async keys() {
      return [...map.keys()]
    },
    async increment(k, by = 1) {
      const v = (map.get(k) || 0) + by
      map.set(k, v)
      return v
    },
  }
}

/**
 * A ctx good enough for dist/host.js: storage and appStorage in memory (pass `appStorage` to share one between two
 * ctxs, as two windows do), recorded posts, headers, logs, execs, emits, overlays and opened URLs. `exec` answers
 * with `opts.exec(argv)` (default: gh prints TOKEN).
 */
function fakeCtx(opts = {}) {
  const panelListeners = []
  const actionListeners = []
  const settingsListeners = []
  const dataDir = opts.dataDir || tmpDir()
  const ctx = {
    api: 1,
    pluginId: 'bronos.github',
    projectDir: dataDir,
    dataDir,
    appDataDir: dataDir,
    settings: Object.freeze({ project: opts.project || {}, app: {} }),
    posts: [],
    headers: [],
    logs: [],
    execs: [],
    overlays: [],
    buttonProviders: [],
    externals: [],
    provided: {},
    emitted: [],
    storage: memStore(),
    appStorage: opts.appStorage || memStore(),
    onSettingsChange(fn) {
      settingsListeners.push(fn)
      return () => {}
    },
    async changeSettings(project) {
      ctx.settings = Object.freeze({ project, app: {} })
      for (const fn of settingsListeners) await fn(ctx.settings)
    },
    log: {
      info: (...a) => ctx.logs.push(['info', a.join(' ')]),
      warn: (...a) => ctx.logs.push(['warn', a.join(' ')]),
      error: (...a) => ctx.logs.push(['error', a.join(' ')]),
    },
    async exec(argv, o) {
      ctx.execs.push({ argv, o })
      if (opts.exec) return opts.exec(argv, o)
      return { code: 0, stdout: `${TOKEN}\n`, stderr: '' }
    },
    async openExternal(url) {
      ctx.externals.push(url)
    },
    panels: {
      post: (panel, m) => ctx.posts.push(structuredClone(m)),
      onMessage: (panel, fn) => (panelListeners.push(fn), () => {}),
      header: (panel, h) => ctx.headers.push(structuredClone(h)),
      onAction: (panel, fn) => (actionListeners.push(fn), () => {}),
      show() {},
    },
    async sendPanel(m) {
      for (const fn of panelListeners) await fn(structuredClone(m))
    },
    async clickAction(id) {
      for (const fn of actionListeners) await fn(id)
    },
    overlay: {
      start(spec) {
        if (opts.overlayRefuse) {
          const err = new Error(opts.overlayRefuse)
          return { result: Promise.reject(err), post() {}, onMessage: () => () => {}, onDiscuss: () => () => {}, close() {}, focus() {} }
        }
        const o = { spec, posts: [], listeners: [] }
        ctx.overlays.push(o)
        let close
        const result = new Promise((r) => (close = r))
        o.close = (answer) => close(answer || { kind: 'dismissed' })
        o.send = async (m) => {
          for (const fn of o.listeners) await fn(structuredClone(m))
        }
        return {
          result,
          post: (m) => o.posts.push(structuredClone(m)),
          onMessage: (fn) => (o.listeners.push(fn), () => {}),
          onDiscuss: (fn) => ((o.discuss = fn), () => {}),
          close() {
            o.closed = true
            close({ kind: 'dismissed' })
          },
          focus() {},
        }
      },
      buttons: (name, provider) => (ctx.buttonProviders.push({ name, provider }), () => {}),
    },
    services: {
      provide(name, impl) {
        ctx.provided[name] = impl
        return () => {}
      },
      emit(service, event, data) {
        ctx.emitted.push({ service, event, data: structuredClone(data) })
      },
      caller: () => ctx.callerId,
    },
    callerId: undefined,
    /** Call a provided service method the way another plugin would: arguments and result cloned. */
    async callService(name, method, args = [], as = 'bronos.inbox') {
      const impl = ctx.provided[name]
      if (!impl) throw new Error(`no provider of ${name}`)
      ctx.callerId = as
      try {
        return structuredClone(await impl[method](...structuredClone(args)))
      } finally {
        ctx.callerId = undefined
      }
    },
    lastState() {
      return [...ctx.posts].reverse().find((m) => m.type === 'state')
    },
  }
  return ctx
}

/** A clock a test moves by hand: `now()` and `advance(ms)`. */
function fakeClock(start = NOW) {
  let t = start
  return {
    now: () => t,
    advance(ms) {
      t += ms
    },
    set(ms) {
      t = ms
    },
  }
}

module.exports = { fakeGitHub, fakeCtx, fakeClock, memStore, fixture, json, text, tmpDir, API, TOKEN, TOKEN2, ME, NOW }
