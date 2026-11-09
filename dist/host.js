'use strict'
// bronos.github: the person's GitHub work (review requests, their PRs, issues, failed runs) as lanes, an Inbox
// feed (inbox-feed v2) and an item overlay. Signs in through the `gh` CLI's login; the token stays in this
// process's memory (lib/auth.js). This file wires the pieces; the logic lives in lib/.
//
// One poll: login → the lane searches → items → (every 5 minutes) failed runs → read marks → feed and panel.
// The last list is stored per login in ctx.appStorage so a restart answers Inbox with it (stale) at once.

const { normalize } = require('./lib/settings')
const { createAuth } = require('./lib/auth')
const { createClient } = require('./lib/client')
const { searchAll } = require('./lib/search')
const { buildItems } = require('./lib/model')
const { repoSet, pushedRepos, failedRuns, runItem, linkPrRuns } = require('./lib/runs')
const { createSeen } = require('./lib/seen')
const { createNotifications } = require('./lib/notifications')
const { createFeed, actionsOf } = require('./lib/feed')
const { createPoller } = require('./lib/poll')

const PANEL = 'main'
const RUNS_EVERY = 5 * 60_000
const LIST_KEY = (login) => `list:${String(login).toLowerCase()}`
const LAST_LOGIN = 'lastLogin'
const STORE_CAP = 900 * 1024 // appStorage takes 1 MiB less 8 KiB per value

/** A github.com web address of an item, or null: the only kind of URL Open on GitHub opens. */
function webUrl(item) {
  const u = item && item._ && item._.url
  if (typeof u !== 'string') return null
  try {
    const p = new URL(u)
    return p.protocol === 'https:' && p.hostname === 'github.com' ? p.href : null
  } catch {
    return null
  }
}

/** What the panel gets per row: plain facts, no url (the host opens things). */
function rowOf(item) {
  return {
    id: item.id,
    kind: item._.kind,
    lanes: item._.lanes,
    title: item.title,
    preview: item.preview || '',
    from: item.from ? item.from.name : '',
    time: item.time,
    read: item.read,
    status: item.place ? item.place.status : '',
    repo: item._.repo,
    labels: item.labels,
    actions: actionsOf(item).filter((a) => a.id !== 'open'),
  }
}

/** The stored list, trimmed (oldest first) until it fits the store. */
function storable(persisted) {
  const items = [...persisted.items].sort((a, b) => b.time - a.time)
  let out = { items, asOf: persisted.asOf }
  while (out.items.length && JSON.stringify(out).length > STORE_CAP) out = { items: out.items.slice(0, Math.floor(out.items.length * 0.8)), asOf: out.asOf }
  return out
}

/**
 * Start the plugin. `deps` (tests): `{ fetch, now, timers }`. Returns the internals a test drives.
 */
function start(ctx, deps = {}) {
  const fetchFn = deps.fetch || ((...a) => fetch(...a))
  const now = deps.now || Date.now
  const log = ctx.log
  let settings = normalize(ctx.settings && ctx.settings.project)
  for (const w of settings.warnings) log.warn(`github: ${w}`)

  let auth
  let client
  let notifications
  function connect() {
    auth = createAuth({ exec: ctx.exec, fetch: fetchFn, ghPath: settings.ghPath, log })
    client = createClient({ fetch: fetchFn, auth, now, log })
    notifications = createNotifications({ client, now, log })
  }
  connect()

  const seen = createSeen({ store: ctx.appStorage, now, log })
  let login = null
  let runItems = []
  let failures = []
  let runsAt = 0
  let lastError = ''
  // Hooks the overlay (Task 11) and the details module (Task 10) fill in; until then open goes to the web.
  const hooks = {
    open: async (item) => openWeb(item),
    rerun: async () => ({ ok: false, message: 'Re-run is not available yet.' }),
  }

  async function openWeb(item) {
    const url = webUrl(item)
    if (!url) return { ok: false, message: 'That item has no GitHub address.' }
    await ctx.openExternal(url)
    return { ok: true }
  }

  async function mark(item, action) {
    if (action === 'markRead') {
      await seen.markRead(item)
      feed.update({ ...item, read: true })
      void notifications.markRead(item)
    } else if (action === 'markUnread') {
      await seen.markUnread(item)
      feed.update({ ...item, read: false })
    } else if (action === 'done') {
      await seen.done(item)
      feed.remove(item.id)
      void notifications.markDone(item)
    }
    postState()
    return { ok: true }
  }

  const feed = createFeed({
    emit: (event, data) => ctx.services.emit('inbox-feed', event, data),
    getSettings: () => settings,
    handlers: { mark, open: (i) => hooks.open(i), rerun: (i) => hooks.rerun(i), openWeb },
    now,
    log,
  })

  // ---- panel ----

  function stateMessage() {
    return {
      type: 'state',
      login,
      state: feed.state,
      message: feed.state === 'ok' ? '' : feed.message,
      asOf: feed.persisted().asOf || 0,
      lanes: settings.lanes,
      rowsPerLane: settings.rowsPerLane,
      rows: feed.items.map(rowOf),
    }
  }

  function postState() {
    try {
      ctx.panels.post(PANEL, stateMessage())
    } catch (e) {
      log.warn(`github: panel post: ${e && e.message ? e.message : e}`)
    }
    setHeader()
  }

  function setHeader() {
    if (!ctx.panels || typeof ctx.panels.header !== 'function') return
    const parts = []
    if (login) parts.push(login)
    if (feed.state === 'signedOut') parts.push('signed out')
    else if (feed.state === 'error' && feed.message) parts.push(feed.message)
    try {
      ctx.panels.header(PANEL, { meta: parts.join(' · ').slice(0, 120), actions: [{ id: 'refresh', icon: 'refresh', title: 'Refresh', busy: poller.running }] })
    } catch (e) {
      log.warn(`github: panel header: ${e && e.message ? e.message : e}`)
    }
  }

  async function onPanelMessage(m) {
    if (!m || typeof m !== 'object') return
    if (m.type === 'hello') return postState()
    if (m.type === 'refresh') return poller.now()
    if (m.type === 'act' && typeof m.id === 'string' && typeof m.action === 'string') {
      const r = await feed.provider.act(m.id, m.action)
      if (!r.ok) ctx.panels.post(PANEL, { type: 'notice', text: r.message })
    }
  }

  // ---- polling ----

  async function storeList() {
    if (!login) return
    try {
      await ctx.appStorage.set(LIST_KEY(login), storable(feed.persisted()))
      await ctx.appStorage.set(LAST_LOGIN, login)
    } catch (e) {
      log.warn(`github: could not store the list: ${e && e.message ? e.message : e}`)
    }
  }

  async function restore() {
    try {
      const last = await ctx.appStorage.get(LAST_LOGIN)
      if (typeof last !== 'string') return
      const stored = await ctx.appStorage.get(LIST_KEY(last))
      login = last
      await seen.use(last)
      // The stored list's read flags are as of its poll; the marks (shared by every window) are the truth.
      if (stored && Array.isArray(stored.items)) {
        const items = stored.items.filter((i) => i && typeof i.id === 'string' && typeof i.rev === 'string' && i._)
        feed.restore({ items: await seen.apply(items), asOf: stored.asOf })
      }
    } catch (e) {
      log.warn(`github: could not restore the list: ${e && e.message ? e.message : e}`)
    }
  }

  async function pollOnce() {
    let me
    try {
      me = await auth.login()
    } catch (e) {
      return failed(e)
    }
    try {
      if (me !== login || seen.login !== me) {
        login = me
        await seen.use(me)
      }
      const { results } = await searchAll(client, settings.lanes)
      const items = buildItems(results, me, settings)
      if (!settings.lanes.failedRuns) {
        runItems = []
        failures = []
        runsAt = 0
      } else if (!runsAt || now() - runsAt >= RUNS_EVERY) {
        const prRepos = items.filter((i) => i._.kind === 'pr' && i.labels.includes('my-pr')).map((i) => i._.repo)
        const repos = repoSet(prRepos, await pushedRepos(client), now(), settings)
        const r = await failedRuns(client, repos, me, now(), log)
        runItems = r.runs.map(runItem)
        failures = r.failures
        runsAt = now()
      }
      if (settings.lanes.myPrs) linkPrRuns(items, failures)
      const visible = await seen.apply(items.concat(runItems))
      feed.setItems(visible, now())
      lastError = ''
      await storeList()
      postState()
      return { ok: true }
    } catch (e) {
      return failed(e)
    }
  }

  function failed(e) {
    if (e && e.signedOut) {
      feed.setState('signedOut', e.message)
      postState()
      return { ok: false, signedOut: true }
    }
    const msg = e && e.message ? e.message : 'GitHub could not be reached'
    if (msg !== lastError) log.warn(`github: ${msg}`)
    lastError = msg
    feed.setState('error', msg)
    postState()
    return e && e.rateLimited ? { ok: false, until: e.until } : { ok: false }
  }

  const poller = createPoller({ run: pollOnce, minutes: () => settings.pollMinutes, now, timers: deps.timers, log })

  async function onSettings(next) {
    const prev = settings
    settings = normalize(next && next.project)
    for (const w of settings.warnings) log.warn(`github: ${w}`)
    if (settings.ghPath !== prev.ghPath) connect()
    if (JSON.stringify(settings.lanes) !== JSON.stringify(prev.lanes) && !settings.lanes.failedRuns) runsAt = 0
    poller.now()
  }

  const disposers = []
  const ready = (async () => {
    await restore()
    ctx.services.provide('inbox-feed', feed.provider)
    disposers.push(ctx.panels.onMessage(PANEL, onPanelMessage))
    if (typeof ctx.panels.onAction === 'function') disposers.push(ctx.panels.onAction(PANEL, (id) => id === 'refresh' && poller.now()))
    disposers.push(ctx.onSettingsChange(onSettings))
    postState()
    poller.now()
  })()

  return {
    ready,
    feed,
    seen,
    hooks,
    poller,
    get auth() {
      return auth
    },
    get client() {
      return client
    },
    get settings() {
      return settings
    },
    get login() {
      return login
    },
    pollOnce,
    postState,
    stop() {
      poller.stop()
      for (const d of disposers) if (typeof d === 'function') d()
    },
  }
}

let running = null

exports.activate = async (ctx) => {
  running = start(ctx)
  await running.ready
}

exports.deactivate = () => {
  if (running) running.stop()
  running = null
}

exports._start = start
exports._webUrl = webUrl
exports._storable = storable
