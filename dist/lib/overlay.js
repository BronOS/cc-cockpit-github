'use strict'
// The item overlay, host side: opens `panels/item.html` at once (`ready: 'manual'`, the app's loader shows until the
// page has drawn), typed `inbox-item { source, id }` so Inbox and core's Discuss know what it shows, then fetches
// the details and posts them. Also:
// - the links the page may open: only those the host found itself in the details it posted (GitHub's HTML hrefs,
//   the item, check and job addresses), http(s) only; a page message naming anything else is refused (the page
//   is untrusted content's renderer, so a URL from it is never opened as is);
// - the toolbar buttons for our own items, only on overlays this plugin opened (`info.opener`, the app's record,
//   not anything in the spec) and only for an item still in the list;
// - Discuss with Claude's text (details.discussText).

const { discussText } = require('./details')
const { actionsOf } = require('./feed')

const SETTLE_MS = 500 // main refuses (3 open, 10 a minute) by rejecting `result` right away

const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>' }

/** http(s) as the URL parser writes it, or null. */
function safeUrl(href) {
  if (typeof href !== 'string') return null
  try {
    const u = new URL(href.trim())
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

/** The http(s) hrefs and image srcs in GitHub's HTML (it writes attributes double-quoted). */
function hrefsIn(html) {
  const out = []
  if (typeof html !== 'string') return out
  const re = /\s(?:href|src)\s*=\s*"([^"]*)"/gi
  let m
  while ((m = re.exec(html))) {
    const u = safeUrl(m[1].replace(/&(?:amp|quot|#39|lt|gt);/g, (e) => ENTITIES[e]))
    if (u) out.push(u)
  }
  return out
}

/** Every address the page may ask to open for these details. */
function linksOf(d) {
  const out = new Set()
  const add = (u) => {
    const s = safeUrl(u)
    if (s) out.add(s)
  }
  add(d.url)
  for (const h of hrefsIn(d.body)) out.add(h)
  for (const e of d.timeline || []) for (const h of hrefsIn(e.html)) out.add(h)
  for (const c of d.checks || []) add(c.url)
  for (const j of d.jobs || []) add(j.url)
  return out
}

/**
 * `ctx`, `getItem(id)` (the current item or null), `fetchDetails(item)`, `onOpened(item)` (mark read on open),
 * `act(id, action)` (the feed's act). Returns `{ open, register }`.
 */
function createOverlays({ ctx, getItem, fetchDetails, onOpened, act, log }) {
  /** Open an item's overlay: `{ ok }`, or `{ ok: false, message }` when the app refused it. */
  async function open(item) {
    let handle
    try {
      handle = ctx.overlay.start({
        kind: 'html',
        file: 'panels/item.html',
        title: item.title.length > 100 ? `${item.title.slice(0, 99)}…` : item.title,
        size: 'large',
        ready: 'manual',
        type: { name: 'inbox-item', data: { source: ctx.pluginId, id: item.id } },
      })
    } catch (e) {
      return { ok: false, message: `Cannot open the item: ${e && e.message ? e.message : e}` }
    }
    let timer
    const refusal = await Promise.race([
      handle.result.then(() => null, (e) => e || new Error('refused')),
      new Promise((r) => (timer = setTimeout(r, SETTLE_MS, null))),
    ]).finally(() => clearTimeout(timer))
    if (refusal) return { ok: false, message: `Cannot open the item: ${refusal.message || 'the app refused'}` }

    let details = null
    let links = new Set()
    let ended = false
    handle.result.then(
      () => (ended = true),
      () => (ended = true)
    )

    if (typeof handle.onDiscuss === 'function') {
      handle.onDiscuss(() => ({ text: details ? discussText(details) : `${item.title}\nURL: ${item._.url}` }))
    }

    async function load() {
      try {
        details = await fetchDetails(item)
        links = linksOf(details)
        if (!ended) handle.post({ type: 'details', details })
      } catch (e) {
        if (!ended) handle.post({ type: 'error', message: e && e.message ? String(e.message).slice(0, 300) : 'This item could not be loaded.' })
      }
    }

    handle.onMessage(async (m) => {
      if (!m || typeof m !== 'object') return
      if (m.type === 'retry') return load()
      if (typeof m.open === 'string') {
        const u = safeUrl(m.open)
        if (!u || !links.has(u)) {
          log.warn('github: the item page asked to open an address that is not in the item; refused')
          return
        }
        await ctx.openExternal(u)
      }
    })

    if (onOpened) await onOpened(item)
    void load()
    return { ok: true }
  }

  /** The toolbar buttons of our `inbox-item` overlays. */
  function register() {
    if (typeof ctx.overlay.buttons !== 'function') return null
    return ctx.overlay.buttons('inbox-item', (info) => {
      if (!info || info.opener !== ctx.pluginId) return []
      const d = info.type && info.type.data
      if (!d || d.source !== ctx.pluginId || typeof d.id !== 'string') return []
      const item = getItem(d.id)
      if (!item) return []
      return actionsOf(item)
        .filter((a) => a.id !== 'open')
        .slice(0, 4)
        .map((a) => ({
          id: a.id,
          label: a.label,
          run: async () => {
            const r = await act(item.id, a.id)
            if (r && r.ok === false) throw new Error(r.message)
            return a.id === 'done' ? { close: true } : undefined
          },
        }))
    })
  }

  return { open, register }
}

module.exports = { createOverlays, linksOf, hrefsIn, safeUrl }
