'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createNotifications, subjectUrl } = require('../dist/lib/notifications')
const { createAuth } = require('../dist/lib/auth')
const { createClient } = require('../dist/lib/client')
const { fakeGitHub, fakeCtx, fakeClock, json } = require('./fakes')

const pr = { id: 'pr:acme/widgets#12', _: { kind: 'pr', repo: 'acme/widgets', number: 12 } }
const iss = { id: 'issue:acme/widgets#5', _: { kind: 'issue', repo: 'acme/widgets', number: 5 } }
const runIt = { id: 'run:acme/widgets/9', _: { kind: 'run', repo: 'acme/widgets', runId: 9 } }

const thread = (id, kind, n) => ({ id: String(id), subject: { type: kind === 'pulls' ? 'PullRequest' : 'Issue', url: `https://api.github.com/repos/acme/widgets/${kind}/${n}` } })

function setup(pages, extra = []) {
  const ctx = fakeCtx()
  const clock = fakeClock()
  const gh = fakeGitHub({
    routes: [
      [
        'GET',
        '/repos/acme/widgets/notifications',
        (u) => {
          const p = Number(u.searchParams.get('page') || 1)
          const next = p < pages.length ? { link: `<https://api.github.com/repos/acme/widgets/notifications?page=${p + 1}>; rel="next"` } : {}
          return json(pages[p - 1] || [], 200, next)
        },
      ],
      ['PATCH', /^\/notifications\/threads\/(\d+)$/, () => new Response(null, { status: 205 })],
      ['DELETE', /^\/notifications\/threads\/(\d+)$/, () => new Response(null, { status: 204 })],
      ...extra,
    ],
  })
  const auth = createAuth({ exec: ctx.exec, fetch: gh.fetch, ghPath: 'gh', log: ctx.log })
  const client = createClient({ fetch: gh.fetch, auth, now: clock.now, log: ctx.log })
  return { ctx, gh, clock, n: createNotifications({ client, now: clock.now, log: ctx.log }) }
}

test('subjectUrl: PR and issue API urls; none for a run', () => {
  assert.equal(subjectUrl(pr), 'https://api.github.com/repos/acme/widgets/pulls/12')
  assert.equal(subjectUrl(iss), 'https://api.github.com/repos/acme/widgets/issues/5')
  assert.equal(subjectUrl(runIt), null)
})

test('markRead finds the thread across pages and PATCHes it; markDone DELETEs', async () => {
  const { gh, n } = setup([[thread(1, 'issues', 99)], [thread(2, 'pulls', 12), thread(3, 'issues', 5)]])
  assert.equal(await n.markRead(pr), true)
  assert.equal(await n.markDone(iss), true)
  const writes = gh.calls.filter((c) => c.method !== 'GET').map((c) => [c.method, new URL(c.url).pathname])
  assert.deepEqual(writes, [
    ['PATCH', '/notifications/threads/2'],
    ['DELETE', '/notifications/threads/3'],
  ])
})

test('no matching thread or a run: nothing is written', async () => {
  const { gh, n } = setup([[thread(1, 'issues', 99)]])
  assert.equal(await n.markRead(pr), false)
  assert.equal(await n.markRead(runIt), false)
  assert.equal(gh.calls.filter((c) => c.method !== 'GET').length, 0)
})

test('the thread list is cached per repo for 60 s', async () => {
  const { gh, clock, n } = setup([[thread(1, 'issues', 99)]])
  await n.markRead(pr)
  await n.markRead(iss)
  assert.equal(gh.calls.filter((c) => c.method === 'GET').length, 1)
  clock.advance(61_000)
  await n.markRead(pr)
  assert.equal(gh.calls.filter((c) => c.method === 'GET').length, 2)
})

test('a thread id that is not a number is never sent back', async () => {
  const { gh, n } = setup([[{ id: '../user', subject: { url: 'https://api.github.com/repos/acme/widgets/pulls/12' } }]])
  assert.equal(await n.markRead(pr), false)
  assert.equal(gh.calls.filter((c) => c.method !== 'GET').length, 0)
})

test('failures are logged and never thrown: a refused PATCH, a failing list', async () => {
  const gh = fakeGitHub({
    routes: [
      ['GET', '/repos/acme/widgets/notifications', () => json([thread(2, 'pulls', 12)])],
      ['PATCH', /^\/notifications\/threads\/\d+$/, () => json({ message: 'Server Error' }, 500)],
    ],
  })
  const ctx = fakeCtx()
  const auth = createAuth({ exec: ctx.exec, fetch: gh.fetch, ghPath: 'gh', log: ctx.log })
  const n = createNotifications({ client: createClient({ fetch: gh.fetch, auth, log: ctx.log }), log: ctx.log })
  assert.equal(await n.markRead(pr), false)
  assert.ok(ctx.logs.some(([, m]) => /notification of pr:acme\/widgets#12 read: GitHub answered 500/.test(m)))
  const failing = createNotifications({ client: { restPages: async () => Promise.reject(new Error('boom')) }, log: ctx.log })
  assert.equal(await failing.markDone(pr), false)
  assert.ok(ctx.logs.some(([, m]) => /notification of pr:acme\/widgets#12 done: boom/.test(m)))
})
