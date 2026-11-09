'use strict'
// GitHub's REST and GraphQL APIs, with the token from auth.js. Every authenticated request goes to
// https://api.github.com and nowhere else: a path is checked before it is joined, pagination links are checked
// against the origin, and the one place GitHub sends us elsewhere (job logs, a 302 to blob storage) is followed
// by hand without the token. Rate limits block every later call until GitHub's reset time, so a limited poll
// does not keep hammering.

const { SignedOut } = require('./auth')

const API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const USER_AGENT = 'cc-cockpit-github'
const JSON_CAP = 5 * 1024 * 1024
const BLOB_STREAM_CAP = 32 * 1024 * 1024
// Paths we build from GitHub's own names (owner, repo, numbers, ids). Narrow on purpose: no `..` segment, no
// `//`, no scheme, no backslash, no query (that goes in `query`), and no `%`: the URL parser reads `%2e%2e` as a
// `..` segment.
const PATH_SHAPE = /^\/[A-Za-z0-9._~\-/:@+]*$/

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

class RateLimited extends Error {
  constructor(until) {
    const d = new Date(until)
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    super(`GitHub rate limit, back at ${hm}`)
    this.name = 'RateLimited'
    this.until = until
    this.rateLimited = true
  }
}

class NetworkError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NetworkError'
    this.network = true
  }
}

function checkPath(path) {
  if (typeof path !== 'string' || !PATH_SHAPE.test(path) || path.includes('//') || /(^|\/)\.\.?(\/|$)/.test(path)) {
    throw new Error(`refused GitHub path ${JSON.stringify(String(path)).slice(0, 80)}`)
  }
  return path
}

/** The body as bytes, at most `max`; `{ buf, truncated }`. Stops reading (and cancels the body) past the cap. */
async function readCapped(res, max) {
  if (!res.body) return { buf: Buffer.alloc(0), truncated: false }
  const chunks = []
  let size = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength - (size - max)))
      await reader.cancel().catch(() => {})
      return { buf: Buffer.concat(chunks), truncated: true }
    }
    chunks.push(Buffer.from(value))
  }
  return { buf: Buffer.concat(chunks), truncated: false }
}

/** The last `keep` bytes of a body read to its end (at most `cap` read); `{ buf, truncated }`. */
async function readTail(res, keep, cap) {
  if (!res.body) return { buf: Buffer.alloc(0), truncated: false }
  let tail = Buffer.alloc(0)
  let size = 0
  let cut = false
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    tail = Buffer.concat([tail, Buffer.from(value)])
    if (tail.length > keep) {
      tail = tail.subarray(tail.length - keep)
      cut = true
    }
    if (size > cap) {
      await reader.cancel().catch(() => {})
      break
    }
  }
  return { buf: Buffer.from(tail), truncated: cut }
}

/** The `next` URL of a Link header, only when it stays on api.github.com. */
function nextLink(link) {
  if (!link) return null
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (!m) continue
    try {
      const u = new URL(m[1])
      if (u.origin === API) return u
    } catch {
      return null
    }
  }
  return null
}

/**
 * `{ rest, restPages, graphql, restRedirect, fetchBlob, blockedUntil }`. `now` is the clock (tests move it).
 * Errors: `SignedOut` (401 after one refresh), `RateLimited` (with `until`), `HttpError` (status), `NetworkError`.
 */
function createClient({ fetch, auth, now = Date.now, log, timeoutMs = 20_000 }) {
  let blocked = 0

  function checkBlocked() {
    if (blocked > now()) throw new RateLimited(blocked)
  }

  function block(res) {
    const retry = Number(res.headers.get('retry-after'))
    const reset = Number(res.headers.get('x-ratelimit-reset'))
    let until = now() + 60_000
    if (Number.isFinite(retry) && retry > 0) until = now() + retry * 1000
    else if (Number.isFinite(reset) && reset > 0) until = reset * 1000
    blocked = Math.max(blocked, until)
    log.warn(`github: rate limited until ${new Date(blocked).toISOString()}`)
    return new RateLimited(blocked)
  }

  function isRateLimit(res) {
    if (res.status !== 403 && res.status !== 429) return false
    return res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after') || res.status === 429
  }

  /** One authenticated request to api.github.com, with the 401 refresh and the rate-limit block. */
  async function send(url, init) {
    checkBlocked()
    let token = await auth.token()
    for (let attempt = 0; ; attempt++) {
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: init.accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': USER_AGENT,
      }
      if (init.body !== undefined) headers['Content-Type'] = 'application/json'
      if (init.headers) Object.assign(headers, init.headers)
      let res
      try {
        res = await fetch(url, {
          method: init.method || 'GET',
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          redirect: init.redirect || 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        throw new NetworkError(e && e.name === 'TimeoutError' ? 'GitHub did not answer in time' : 'Could not reach GitHub')
      }
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {})
        if (attempt > 0) {
          auth.signOut()
          throw new SignedOut()
        }
        token = await auth.refresh()
        continue
      }
      if (isRateLimit(res)) {
        await res.body?.cancel().catch(() => {})
        throw block(res)
      }
      return res
    }
  }

  async function errorOf(res) {
    let message = `GitHub answered ${res.status}`
    try {
      const { buf } = await readCapped(res, 64 * 1024)
      const body = JSON.parse(buf.toString('utf8'))
      if (body && typeof body.message === 'string') message += `: ${body.message.slice(0, 200)}`
    } catch {
      // not JSON: the status says enough
    }
    return new HttpError(res.status, message)
  }

  function urlOf(path, query) {
    const u = new URL(API + checkPath(path))
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
    return u
  }

  async function parse(res, { raw, maxBytes = JSON_CAP }) {
    if (res.status === 204 || res.status === 205) return { status: res.status, data: null, headers: res.headers }
    const { buf, truncated } = await readCapped(res, maxBytes)
    if (raw) return { status: res.status, data: buf.toString('utf8'), truncated, headers: res.headers }
    if (truncated) throw new HttpError(res.status, 'GitHub sent more than the plugin reads')
    let data = null
    if (buf.length) {
      try {
        data = JSON.parse(buf.toString('utf8'))
      } catch {
        throw new HttpError(res.status, 'GitHub sent something that is not JSON')
      }
    }
    return { status: res.status, data, headers: res.headers }
  }

  /** `rest(method, path, { query, accept, body, raw, maxBytes })` → `{ status, data, headers, truncated? }`. */
  async function rest(method, path, o = {}) {
    const res = await send(urlOf(path, o.query), { method, accept: o.accept, body: o.body })
    if (!res.ok) throw await errorOf(res)
    return parse(res, o)
  }

  /** GET every page of a list (following `Link: next` on api.github.com), at most `pages`; concatenated arrays. */
  async function restPages(path, o = {}) {
    let url = urlOf(path, { per_page: 100, ...o.query })
    const out = []
    for (let i = 0; i < (o.pages || 5) && url; i++) {
      const res = await send(url, { accept: o.accept })
      if (!res.ok) throw await errorOf(res)
      const { data } = await parse(res, {})
      const items = o.key ? data && data[o.key] : data
      if (Array.isArray(items)) out.push(...items)
      url = nextLink(res.headers.get('link'))
    }
    return out
  }

  /**
   * POST /graphql. `{ data, partialErrors }`; GitHub reports its GraphQL rate limit as HTTP 200 with an error of
   * type RATE_LIMITED, which blocks like a REST limit. Errors with no data reject.
   */
  async function graphql(query, variables = {}) {
    const res = await send(new URL(`${API}/graphql`), { method: 'POST', body: { query, variables } })
    if (!res.ok) throw await errorOf(res)
    const { data: body } = await parse(res, {})
    const errors = Array.isArray(body && body.errors) ? body.errors : []
    if (errors.some((e) => e && e.type === 'RATE_LIMITED')) throw block(res)
    if (errors.length && !(body && body.data)) {
      const first = errors[0] && typeof errors[0].message === 'string' ? errors[0].message.slice(0, 200) : 'unknown error'
      throw new HttpError(200, `GitHub GraphQL: ${first}`)
    }
    if (errors.length) log.warn(`github: GraphQL answered with ${errors.length} partial error(s); kept the rest`)
    return { data: body.data, partialErrors: errors.map((e) => String((e && e.message) || '').slice(0, 200)) }
  }

  /** A GET that GitHub answers with a redirect (job logs): the `Location`, only when it is https. */
  async function restRedirect(path) {
    const res = await send(urlOf(path), { redirect: 'manual' })
    await res.body?.cancel().catch(() => {})
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      let u
      try {
        u = new URL(loc)
      } catch {
        throw new HttpError(res.status, 'GitHub sent a broken redirect')
      }
      if (u.protocol !== 'https:') throw new HttpError(res.status, 'GitHub redirected to a non-https address')
      return u
    }
    if (!res.ok) throw new HttpError(res.status, `GitHub answered ${res.status}`)
    throw new HttpError(res.status, 'GitHub sent no redirect')
  }

  /**
   * The tail (`tailBytes`) of a blob GitHub redirected us to. Never sends the token: the URL is signed and the
   * storage host is not GitHub's API. Asks for a byte range; a server that ignores it is read to the end (at most
   * 32 MB) keeping only the tail.
   */
  async function fetchBlob(url, { tailBytes = 64 * 1024 } = {}) {
    const u = url instanceof URL ? url : new URL(url)
    if (u.protocol !== 'https:') throw new HttpError(0, 'refused a non-https blob address')
    let res
    try {
      res = await fetch(u, { headers: { Range: `bytes=-${tailBytes}`, 'User-Agent': USER_AGENT }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      throw new NetworkError(e && e.name === 'TimeoutError' ? 'The log did not arrive in time' : 'Could not fetch the log')
    }
    if (res.status === 206) {
      const { buf } = await readCapped(res, tailBytes)
      return { text: buf.toString('utf8'), truncated: true }
    }
    if (res.status === 416) return { text: '', truncated: false } // empty blob
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new HttpError(res.status, `The log store answered ${res.status}`)
    }
    const { buf, truncated } = await readTail(res, tailBytes, BLOB_STREAM_CAP)
    return { text: buf.toString('utf8'), truncated }
  }

  return {
    rest,
    restPages,
    graphql,
    restRedirect,
    fetchBlob,
    get blockedUntil() {
      return blocked > now() ? blocked : 0
    },
  }
}

module.exports = { createClient, HttpError, RateLimited, NetworkError, checkPath, nextLink, API }
