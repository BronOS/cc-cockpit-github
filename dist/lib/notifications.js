'use strict'
// Keeps the bell on github.com in step with Mark read / Done on GitHub, best-effort: the thread of an item is found
// in its repo's notifications (by the subject's API url), then marked read or done. Only a thread id GitHub just
// listed is ever sent back; any failure is logged and the local mark stands. Runs have no thread to match (a
// CheckSuite notification has no subject url), so they are left alone.

const API = 'https://api.github.com'
const CACHE_MS = 60_000

function subjectUrl(item) {
  const x = item && item._
  if (!x || !x.repo || !Number.isInteger(x.number)) return null
  if (x.kind === 'pr') return `${API}/repos/${x.repo}/pulls/${x.number}`
  if (x.kind === 'issue') return `${API}/repos/${x.repo}/issues/${x.number}`
  return null
}

function createNotifications({ client, now = Date.now, log }) {
  const cache = new Map() // repo (lower case) -> { at, threads }

  async function threadsOf(repo) {
    const k = repo.toLowerCase()
    const c = cache.get(k)
    if (c && now() - c.at < CACHE_MS) return c.threads
    const [owner, name] = repo.split('/')
    const threads = await client.restPages(`/repos/${owner}/${name}/notifications`, { query: { all: false, per_page: 50 }, pages: 5 })
    cache.set(k, { at: now(), threads })
    return threads
  }

  async function threadFor(item) {
    const url = subjectUrl(item)
    if (!url) return null
    const threads = await threadsOf(item._.repo)
    const t = threads.find((th) => th && th.subject && typeof th.subject.url === 'string' && th.subject.url.toLowerCase() === url.toLowerCase())
    return t && /^\d{1,20}$/.test(String(t.id)) ? String(t.id) : null
  }

  async function act(item, method, what) {
    try {
      const id = await threadFor(item)
      if (!id) return false
      await client.rest(method, `/notifications/threads/${id}`)
      cache.delete(item._.repo.toLowerCase())
      return true
    } catch (e) {
      log.warn(`github: could not mark the notification of ${item.id} ${what}: ${e && e.message ? e.message : e}`)
      return false
    }
  }

  return {
    /** PATCH the item's thread read. Resolves whether a thread was marked; never rejects. */
    markRead: (item) => act(item, 'PATCH', 'read'),
    /** DELETE the item's thread (GitHub's "done"). Resolves whether a thread was marked; never rejects. */
    markDone: (item) => act(item, 'DELETE', 'done'),
  }
}

module.exports = { createNotifications, subjectUrl }
