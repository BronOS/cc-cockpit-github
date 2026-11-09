'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createAuth, SIGNED_OUT_MESSAGE } = require('../dist/lib/auth')
const { fakeGitHub, fakeCtx, json, TOKEN, TOKEN2 } = require('./fakes')

const userRoute = ['GET', '/user', () => json({ login: 'me', id: 1 })]

function setup({ exec, token } = {}) {
  const gh = fakeGitHub({ routes: [userRoute], token })
  const ctx = fakeCtx({ exec })
  const auth = createAuth({ exec: ctx.exec, fetch: gh.fetch, ghPath: 'gh', log: ctx.log })
  return { gh, ctx, auth }
}

/** Every string the plugin let out: logs, posts, emits, headers. The token must be in none. */
function leaked(ctx, secret) {
  return JSON.stringify([ctx.logs, ctx.posts, ctx.emitted, ctx.headers]).includes(secret)
}

test('token: runs gh auth token for github.com only, as argv, once', async () => {
  const { ctx, auth } = setup()
  assert.equal(await auth.token(), TOKEN)
  assert.equal(await auth.token(), TOKEN)
  assert.equal(ctx.execs.length, 1)
  assert.deepEqual(ctx.execs[0].argv, ['gh', 'auth', 'token', '--hostname', 'github.com'])
  assert.equal(ctx.execs[0].o.timeoutMs, 10_000)
})

test('login: GET /user with the token, cached; state ok', async () => {
  const { gh, auth } = setup()
  assert.equal(auth.state, 'unknown')
  assert.equal(await auth.login(), 'me')
  assert.equal(await auth.login(), 'me')
  assert.equal(gh.calls.length, 1)
  assert.equal(gh.calls[0].auth, `Bearer ${TOKEN}`)
  assert.equal(auth.state, 'ok')
})

for (const [name, exec] of [
  ['gh missing (exec rejects)', async () => Promise.reject(Object.assign(new Error('spawn gh ENOENT: secret-ish detail'), { name: 'Error' }))],
  ['gh exits 1', async () => ({ code: 1, stdout: '', stderr: 'no oauth token found for github.com' })],
  ['gh prints nothing', async () => ({ code: 0, stdout: '\n', stderr: '' })],
  ['gh prints a sentence', async () => ({ code: 0, stdout: 'You are not logged in\n', stderr: '' })],
]) {
  test(`signed out when ${name}: the message names gh auth login, not gh's output`, async () => {
    const { ctx, auth } = setup({ exec })
    await assert.rejects(auth.token(), (e) => e.signedOut === true && e.message === SIGNED_OUT_MESSAGE)
    assert.equal(auth.state, 'signedOut')
    assert.match(auth.message, /gh auth login/)
    assert.ok(!auth.message.includes('no oauth token'))
    assert.ok(!JSON.stringify(ctx.logs).includes('secret-ish'))
  })
}

test("gh's reason reaches the log (one line, token shapes masked), never the message", async () => {
  const exec = async () => ({ code: 1, stdout: '', stderr: `\nno oauth token found for github.com (was ${TOKEN})\nsecond line\n` })
  const { ctx, auth } = setup({ exec })
  await assert.rejects(auth.token())
  const logged = JSON.stringify(ctx.logs)
  assert.match(logged, /exited 1 .*: no oauth token found for github\.com/)
  assert.ok(!logged.includes(TOKEN))
  assert.ok(!logged.includes('second line'))
  assert.equal(auth.message, SIGNED_OUT_MESSAGE)
})

test('a 401 refreshes once and retries with the new token', async () => {
  let n = 0
  const exec = async () => ({ code: 0, stdout: n++ === 0 ? `${TOKEN}\n` : `${TOKEN2}\n`, stderr: '' })
  const { gh, ctx, auth } = setup({ exec, token: TOKEN2 })
  assert.equal(await auth.login(), 'me')
  assert.equal(ctx.execs.length, 2)
  assert.deepEqual(
    gh.calls.map((c) => c.auth),
    [`Bearer ${TOKEN}`, `Bearer ${TOKEN2}`]
  )
})

test('401 again after the refresh: signed out, token forgotten', async () => {
  const { ctx, auth } = setup({ token: 'something-else' })
  await assert.rejects(auth.login(), (e) => e.signedOut === true)
  assert.equal(auth.state, 'signedOut')
  assert.equal(ctx.execs.length, 2)
  // The next call asks gh again (the person may have logged in meanwhile).
  await assert.rejects(auth.login())
  assert.equal(ctx.execs.length, 4)
})

test('concurrent refreshes share one gh run', async () => {
  const { ctx, auth } = setup()
  await auth.token()
  const [a, b, c] = await Promise.all([auth.refresh(), auth.refresh(), auth.refresh()])
  assert.equal(a, TOKEN)
  assert.equal(b, TOKEN)
  assert.equal(c, TOKEN)
  assert.equal(ctx.execs.length, 2)
})

test('the token never reaches a log, post, emit or header', async () => {
  const { ctx, auth } = setup({ token: 'other' })
  await auth.login().catch(() => {})
  assert.equal(leaked(ctx, TOKEN), false)
  assert.ok(ctx.logs.length >= 0)
})
