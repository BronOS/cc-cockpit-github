'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const host = require('../dist/host')
const { fakeGitHub, fakeCtx, fakeClock, memStore, json, NOW, TOKEN } = require('./fakes')

const T = (h) => `2026-11-08T${String(h).padStart(2, '0')}:00:00Z`

function prNode(n, over = {}) {
  return {
    __typename: 'PullRequest',
    number: n,
    title: `PR ${n}`,
    url: `https://github.com/acme/widgets/pull/${n}`,
    isDraft: false,
    createdAt: T(1),
    updatedAt: T(2),
    author: { login: 'me' },
    repository: { nameWithOwner: 'acme/widgets' },
    headRefName: `b${n}`,
    baseRefName: 'main',
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    comments: { nodes: [] },
    commits: { nodes: [{ commit: { oid: `sha${n}`, statusCheckRollup: { state: 'SUCCESS' } } }] },
    ...over,
  }
}

/** A GitHub where `world` decides what each search returns; runs per status. */
function fakeWorld(world) {
  return fakeGitHub({
    routes: [
      ['GET', '/user', () => json({ login: 'me' })],
      [
        'POST',
        '/graphql',
        (u, init) => {
          const { variables } = JSON.parse(init.body)
          const q = variables.q
          if (world.graphql) return world.graphql(q)
          const key = q.includes('review-requested') ? 'reviewRequested' : q.includes('author:@me') ? 'myPrs' : q.includes('assignee') ? 'assigned' : 'mentioned'
          return json({ data: { search: { nodes: world[key] || [], pageInfo: { hasNextPage: false } } } })
        },
      ],
      ['GET', '/user/repos', () => json(world.repos || [])],
      ['GET', /^\/repos\/acme\/widgets\/actions\/runs$/, (u) => json({ workflow_runs: (world.runs && world.runs[u.searchParams.get('status')]) || [] })],
    ],
  })
}

const flush = () => new Promise((r) => setImmediate(r))
const noTimers = { set: () => 0, clear() {} }

async function boot(world, opts = {}) {
  const gh = fakeWorld(world)
  const ctx = fakeCtx({ appStorage: opts.appStorage, project: opts.project, exec: opts.exec })
  const clock = fakeClock()
  const h = host._start(ctx, { fetch: gh.fetch, now: clock.now, timers: noTimers })
  await h.ready
  await flush()
  await flush()
  return { gh, ctx, clock, h }
}

test('start: provides inbox-feed, polls, seeds read marks, posts lanes to the panel, sets the header', async () => {
  const { ctx, h } = await boot({ myPrs: [prNode(1), prNode(2)] })
  assert.ok(ctx.provided['inbox-feed'])
  const s = await ctx.callService('inbox-feed', 'snapshot')
  assert.equal(s.state, 'ok')
  assert.deepEqual(s.items.map((i) => [i.id, i.read]), [['pr:acme/widgets#1', true], ['pr:acme/widgets#2', true]])
  const st = ctx.lastState()
  assert.equal(st.login, 'me')
  assert.equal(st.rows.length, 2)
  assert.equal(st.rows[0].kind, 'pr')
  assert.equal(st.rows[0].url, undefined)
  assert.ok(ctx.headers.at(-1).meta.startsWith('me'))
  assert.equal(ctx.headers.at(-1).actions[0].id, 'refresh')
  assert.equal(h.login, 'me')
})

test('panel: hello answers the state; act runs through the feed; a refusal comes back as a notice', async () => {
  const { ctx } = await boot({ myPrs: [prNode(1)] })
  ctx.posts.length = 0
  await ctx.sendPanel({ type: 'hello' })
  assert.equal(ctx.posts[0].type, 'state')
  await ctx.sendPanel({ type: 'act', id: 'pr:acme/widgets#1', action: 'markUnread' })
  assert.equal(ctx.lastState().rows[0].read, false)
  await ctx.sendPanel({ type: 'act', id: 'pr:acme/nope#1', action: 'markRead' })
  assert.equal(ctx.posts.at(-1).type, 'notice')
})

test('Open on GitHub opens only the github.com address', async () => {
  const { ctx } = await boot({ myPrs: [prNode(1)] })
  assert.deepEqual(await ctx.callService('inbox-feed', 'act', ['pr:acme/widgets#1', 'openWeb']), { ok: true })
  assert.deepEqual(ctx.externals, ['https://github.com/acme/widgets/pull/1'])
  assert.equal(host._webUrl({ _: { url: 'https://evil.example/x' } }), null)
  assert.equal(host._webUrl({ _: { url: 'http://github.com/x' } }), null)
  assert.equal(host._webUrl({ _: { url: 'javascript:alert(1)' } }), null)
})

test('done hides the item, tells Inbox gone, survives the next poll', async () => {
  const world = { myPrs: [prNode(1), prNode(2)] }
  const { ctx, h } = await boot(world)
  ctx.emitted.length = 0
  await ctx.callService('inbox-feed', 'act', ['pr:acme/widgets#1', 'done'])
  assert.deepEqual(ctx.emitted.map((e) => [e.event, e.data.ids]), [['gone', ['pr:acme/widgets#1']]])
  await h.pollOnce()
  assert.deepEqual((await ctx.callService('inbox-feed', 'snapshot')).items.map((i) => i.id), ['pr:acme/widgets#2'])
})

test('a lane switched off: not queried, its items gone', async () => {
  const world = { myPrs: [prNode(1)], assigned: [] }
  const { gh, ctx, h } = await boot(world)
  ctx.emitted.length = 0
  gh.calls.length = 0
  await ctx.changeSettings({ lanes: { myPrs: false } })
  await flush()
  await flush()
  await h.pollOnce()
  const queries = gh.calls.filter((c) => c.url.endsWith('/graphql')).map((c) => JSON.parse(c.body).variables.q)
  assert.ok(queries.length > 0)
  assert.ok(!queries.some((q) => q.includes('author:@me')))
  assert.ok(ctx.emitted.some((e) => e.event === 'gone' && e.data.ids.includes('pr:acme/widgets#1')))
})

test('failed runs: fetched on the first poll, at most every 5 minutes, linked to the failing own PR', async () => {
  const failing = prNode(3, { commits: { nodes: [{ commit: { oid: 'shaX', statusCheckRollup: { state: 'FAILURE' } } }] } })
  const run = { id: 77, name: 'CI', workflow_id: 1, head_branch: 'b3', head_sha: 'shaX', run_number: 5, run_attempt: 1, status: 'completed', created_at: T(10), updated_at: T(10), html_url: 'https://github.com/acme/widgets/actions/runs/77' }
  const { gh, clock, ctx, h } = await boot({ myPrs: [failing], runs: { failure: [run] } })
  const snap = await ctx.callService('inbox-feed', 'snapshot')
  assert.deepEqual(snap.items.map((i) => i.id).sort(), ['pr:acme/widgets#3', 'run:acme/widgets/77'])
  assert.ok(snap.items.find((i) => i.id === 'pr:acme/widgets#3').actions.some((a) => a.id === 'rerun'))
  const runCalls = () => gh.calls.filter((c) => c.url.includes('/actions/runs')).length
  const before = runCalls()
  clock.advance(2 * 60_000)
  await h.pollOnce()
  assert.equal(runCalls(), before)
  clock.advance(3 * 60_000)
  await h.pollOnce()
  assert.ok(runCalls() > before)
})

test('signed out: the feed says so with the gh hint; the panel too', async () => {
  const { ctx } = await boot({}, { exec: async () => ({ code: 1, stdout: '', stderr: 'not logged in' }) })
  const s = await ctx.callService('inbox-feed', 'snapshot')
  assert.equal(s.state, 'signedOut')
  assert.match(s.message, /gh auth login/)
  assert.equal(ctx.lastState().state, 'signedOut')
  assert.ok(ctx.headers.at(-1).meta.includes('signed out'))
})

test('a rate limit keeps the last list and reports the time', async () => {
  let limited = false
  const world = {
    myPrs: [prNode(1)],
    graphql: (q) => (limited ? json({ errors: [{ type: 'RATE_LIMITED', message: 'limit' }] }, 200, { 'x-ratelimit-reset': String(Math.floor((NOW + 600_000) / 1000)) }) : json({ data: { search: { nodes: q.includes('author:@me') ? [prNode(1)] : [], pageInfo: {} } } })),
  }
  const { ctx, h } = await boot(world)
  limited = true
  const r = await h.pollOnce()
  assert.equal(r.until, NOW + 600_000)
  const s = await ctx.callService('inbox-feed', 'snapshot')
  assert.equal(s.state, 'error')
  assert.match(s.message, /rate limit, back at/)
  assert.deepEqual(s.items.map((i) => i.id), ['pr:acme/widgets#1'])
})

test('restart: the stored list answers at once as stale; read marks shared through appStorage', async () => {
  const shared = memStore()
  const first = await boot({ myPrs: [prNode(1)] }, { appStorage: shared })
  await first.ctx.callService('inbox-feed', 'act', ['pr:acme/widgets#1', 'markUnread'])
  first.h.stop()
  // Second start: GitHub unreachable this time.
  const ctx = fakeCtx({ appStorage: shared })
  const h = host._start(ctx, { fetch: async () => Promise.reject(new TypeError('offline')), now: () => NOW, timers: noTimers })
  await h.ready
  await flush()
  const s = await ctx.callService('inbox-feed', 'snapshot')
  assert.equal(s.state, 'error')
  assert.deepEqual(s.items.map((i) => [i.id, i.read]), [['pr:acme/widgets#1', false]])
  h.stop()
})

test('the token never reaches storage, posts, emits, headers or logs', async () => {
  const shared = memStore()
  const { ctx } = await boot({ myPrs: [prNode(1)] }, { appStorage: shared })
  const all = JSON.stringify([[...shared.map.entries()], [...ctx.storage.map.entries()], ctx.posts, ctx.emitted, ctx.headers, ctx.logs])
  assert.ok(!all.includes(TOKEN))
})

test('storable trims the oldest items until the list fits', () => {
  const big = Array.from({ length: 3000 }, (_, i) => ({ id: `i${i}`, time: i, title: 'x'.repeat(400), _: {} }))
  const s = host._storable({ items: big, asOf: 1 })
  assert.ok(JSON.stringify(s).length <= 900 * 1024)
  assert.equal(s.items[0].id, 'i2999')
})

test('the header Refresh action polls again', async () => {
  const { gh, ctx } = await boot({ myPrs: [prNode(1)] })
  const before = gh.calls.filter((c) => c.url.endsWith('/graphql')).length
  await ctx.clickAction('refresh')
  await flush()
  await flush()
  assert.ok(gh.calls.filter((c) => c.url.endsWith('/graphql')).length > before)
})

test('a poll logs one line when the picture changes, not on every poll', async () => {
  const world = { myPrs: [prNode(1)] }
  const { ctx, h } = await boot(world)
  const oks = () => ctx.logs.filter((l) => JSON.stringify(l).includes('poll ok')).length
  assert.equal(oks(), 1)
  await h.pollOnce()
  assert.equal(oks(), 1)
  world.myPrs = [prNode(1), prNode(2)]
  await h.pollOnce()
  assert.equal(oks(), 2)
  assert.match(JSON.stringify(ctx.logs.at(-1)), /me: 2 PRs\/issues, 0 failed runs/)
})
