'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAuth } = require('../dist/lib/auth')
const { createClient, checkPath, nextLink } = require('../dist/lib/client')
const { fakeGitHub, fakeCtx, fakeClock, json, text, TOKEN, TOKEN2, NOW } = require('./fakes')

function setup({ routes = [], token, exec, blob } = {}) {
  const gh = fakeGitHub({ routes, token, blob })
  const ctx = fakeCtx({ exec })
  const clock = fakeClock()
  const auth = createAuth({ exec: ctx.exec, fetch: gh.fetch, ghPath: 'gh', log: ctx.log })
  const client = createClient({ fetch: gh.fetch, auth, now: clock.now, log: ctx.log })
  return { gh, ctx, clock, auth, client }
}

test('rest: headers, query, JSON body', async () => {
  const { gh, client } = setup({ routes: [['GET', '/repos/acme/widgets/pulls', (u) => json([{ n: u.searchParams.get('state') }])]] })
  const r = await client.rest('GET', '/repos/acme/widgets/pulls', { query: { state: 'open', skip: undefined } })
  assert.deepEqual(r.data, [{ n: 'open' }])
  const c = gh.calls[0]
  assert.equal(c.auth, `Bearer ${TOKEN}`)
  assert.equal(c.headers.get('accept'), 'application/vnd.github+json')
  assert.equal(c.headers.get('x-github-api-version'), '2022-11-28')
  assert.equal(c.headers.get('user-agent'), 'cc-cockpit-github')
  assert.equal(new URL(c.url).search, '?state=open')
})

test('paths: only our own shapes, never another origin or a dot segment', () => {
  for (const ok of ['/user', '/repos/acme/my.repo_x-1/actions/runs/123', '/notifications/threads/9']) assert.equal(checkPath(ok), ok)
  for (const bad of ['user', '//evil.example/x', '/repos/../user', '/repos/a/..', '/a/./b', 'https://evil.example', '/a?b=c', '/a\\b', '/a%2e%2e/b', '/a b']) {
    assert.throws(() => checkPath(bad), /refused/, bad)
  }
})

test('a 401 refreshes the token once and retries', async () => {
  let n = 0
  const exec = async () => ({ code: 0, stdout: n++ ? TOKEN2 : TOKEN, stderr: '' })
  const { gh, client } = setup({ token: TOKEN2, exec, routes: [['GET', '/user', () => json({ login: 'me' })]] })
  assert.equal((await client.rest('GET', '/user')).data.login, 'me')
  assert.deepEqual(gh.calls.map((c) => c.auth), [`Bearer ${TOKEN}`, `Bearer ${TOKEN2}`])
})

test('401 after the refresh: SignedOut, and auth says signedOut', async () => {
  const { auth, client } = setup({ token: 'nope' })
  await assert.rejects(client.rest('GET', '/user'), (e) => e.signedOut === true)
  assert.equal(auth.state, 'signedOut')
})

test('REST rate limit: blocks every call until the reset, then lets them through', async () => {
  let limited = true
  const reset = Math.floor((NOW + 10 * 60_000) / 1000)
  const { gh, clock, client } = setup({
    routes: [['GET', '/user', () => (limited ? json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }) : json({ login: 'me' }))]],
  })
  await assert.rejects(client.rest('GET', '/user'), (e) => e.rateLimited && e.until === reset * 1000 && /back at/.test(e.message))
  await assert.rejects(client.rest('GET', '/user'), (e) => e.rateLimited)
  assert.equal(gh.calls.length, 1, 'the second call never went out')
  assert.equal(client.blockedUntil, reset * 1000)
  limited = false
  clock.advance(10 * 60_000 + 1)
  assert.equal((await client.rest('GET', '/user')).data.login, 'me')
  assert.equal(client.blockedUntil, 0)
})

test('secondary rate limit: retry-after seconds', async () => {
  const { client } = setup({ routes: [['GET', '/user', () => json({ message: 'secondary' }, 403, { 'retry-after': '30' })]] })
  await assert.rejects(client.rest('GET', '/user'), (e) => e.rateLimited && e.until === NOW + 30_000)
})

test('a 403 that is not a rate limit is an ordinary HttpError', async () => {
  const { client } = setup({ routes: [['GET', '/repos/acme/x', () => json({ message: 'Resource not accessible' }, 403, { 'x-ratelimit-remaining': '4000' })]] })
  await assert.rejects(client.rest('GET', '/repos/acme/x'), (e) => e.status === 403 && /not accessible/.test(e.message) && !e.rateLimited)
})

test('GraphQL: data, partial errors kept, errors without data reject', async () => {
  let reply
  const { gh, client } = setup({ routes: [['POST', '/graphql', () => reply]] })
  reply = json({ data: { viewer: { login: 'me' } } })
  assert.deepEqual(await client.graphql('query { viewer { login } }', { a: 1 }), { data: { viewer: { login: 'me' } }, partialErrors: [] })
  assert.deepEqual(JSON.parse(gh.calls[0].body), { query: 'query { viewer { login } }', variables: { a: 1 } })
  reply = json({ data: { search: { nodes: [] } }, errors: [{ type: 'FORBIDDEN', message: 'Resource protected by organization SAML' }] })
  const r = await client.graphql('q')
  assert.deepEqual(r.partialErrors, ['Resource protected by organization SAML'])
  reply = json({ errors: [{ message: 'Parse error' }] })
  await assert.rejects(client.graphql('q'), /Parse error/)
})

test('GraphQL rate limit arrives as HTTP 200 with RATE_LIMITED: blocks until the reset', async () => {
  const reset = Math.floor((NOW + 5 * 60_000) / 1000)
  const { gh, client } = setup({
    routes: [['POST', '/graphql', () => json({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, 200, { 'x-ratelimit-reset': String(reset) })]],
  })
  await assert.rejects(client.graphql('q'), (e) => e.rateLimited && e.until === reset * 1000)
  await assert.rejects(client.rest('GET', '/user'), (e) => e.rateLimited)
  assert.equal(gh.calls.length, 1)
})

test('network failure and timeout become NetworkError', async () => {
  const ctx = fakeCtx()
  const auth = createAuth({ exec: ctx.exec, fetch: async () => json({ login: 'me' }), ghPath: 'gh', log: ctx.log })
  const failing = createClient({ fetch: async () => Promise.reject(new TypeError('fetch failed')), auth, log: ctx.log })
  await assert.rejects(failing.rest('GET', '/user'), (e) => e.network && e.message === 'Could not reach GitHub')
  const slow = createClient({
    fetch: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('t'), { name: 'TimeoutError' })))),
    auth,
    log: ctx.log,
    timeoutMs: 20,
  })
  await assert.rejects(slow.rest('GET', '/user'), (e) => e.network && /in time/.test(e.message))
})

test('restPages: follows Link next on api.github.com only, up to the page cap', async () => {
  const page = (n, next) => json([n], 200, next ? { link: `<${next}>; rel="next", <https://api.github.com/x?page=9>; rel="last"` } : {})
  const { client } = setup({
    routes: [
      [
        'GET',
        '/repos/acme/w/notifications',
        (u) => {
          const p = Number(u.searchParams.get('page') || 1)
          if (p === 1) return page(1, 'https://api.github.com/repos/acme/w/notifications?page=2')
          if (p === 2) return page(2, 'https://evil.example/steal?page=3')
          return page(p)
        },
      ],
    ],
  })
  assert.deepEqual(await client.restPages('/repos/acme/w/notifications'), [1, 2])
  assert.equal(nextLink('<https://api.github.com/a?page=2>; rel="next"').href, 'https://api.github.com/a?page=2')
  assert.equal(nextLink('<http://api.github.com/a>; rel="next"'), null)
  assert.equal(nextLink(null), null)
})

test('job logs: the redirect is followed by hand, https only, and the blob never sees the token', async () => {
  const logText = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n')
  let location = 'https://blob.example.net/logs/1?sig=abc'
  const { gh, client } = setup({
    routes: [['GET', '/repos/acme/w/actions/jobs/7/logs', () => new Response(null, { status: 302, headers: { location } })]],
    blob: (u, init, headers) => {
      const m = (headers.get('range') || '').match(/^bytes=-(\d+)$/)
      return m ? new Response(logText.slice(-Number(m[1])), { status: 206 }) : text(logText)
    },
  })
  const url = await client.restRedirect('/repos/acme/w/actions/jobs/7/logs')
  assert.equal(gh.calls[0].redirect, 'manual')
  const { text: tail, truncated } = await client.fetchBlob(url, { tailBytes: 100 })
  assert.equal(tail, logText.slice(-100))
  assert.equal(truncated, true)
  const blobCall = gh.calls.find((c) => c.url.startsWith('https://blob.example.net'))
  assert.equal(blobCall.auth, null)
  assert.equal(blobCall.headers.get('range'), 'bytes=-100')
  location = 'http://blob.example.net/logs/1'
  await assert.rejects(client.restRedirect('/repos/acme/w/actions/jobs/7/logs'), /non-https/)
  await assert.rejects(client.fetchBlob('http://blob.example.net/x'), /non-https/)
})

test('fetchBlob: a store that ignores Range is read to the end keeping only the tail', async () => {
  const body = 'a'.repeat(10_000) + 'THE END'
  const { client } = setup({ blob: () => text(body) })
  const r = await client.fetchBlob('https://blob.example.net/x', { tailBytes: 7 })
  assert.equal(r.text, 'THE END')
  assert.equal(r.truncated, true)
})

test('a JSON body over the cap is refused, a raw one is cut and flagged', async () => {
  const big = 'x'.repeat(2000)
  const { client } = setup({ routes: [['GET', '/big', () => text(big)], ['GET', '/bigjson', () => json({ s: big })]] })
  const r = await client.rest('GET', '/big', { raw: true, maxBytes: 100 })
  assert.equal(r.data.length, 100)
  assert.equal(r.truncated, true)
  await assert.rejects(client.rest('GET', '/bigjson', { maxBytes: 100 }), /more than the plugin reads/)
})
