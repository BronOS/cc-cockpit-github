'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { detailsOf, rerun, discussText, plain, DIFF_CAP, DISCUSS } = require('../dist/lib/details')
const { createAuth } = require('../dist/lib/auth')
const { createClient } = require('../dist/lib/client')
const { fakeGitHub, fakeCtx, json, text, TOKEN } = require('./fakes')

const prItem = { id: 'pr:acme/widgets#12', title: 'acme/widgets#12 Fix login', place: { status: 'failing' }, _: { kind: 'pr', repo: 'acme/widgets', number: 12 } }
const issueItem = { id: 'issue:acme/widgets#5', title: 'acme/widgets#5 Crash', _: { kind: 'issue', repo: 'acme/widgets', number: 5 } }
const runItem = { id: 'run:acme/widgets/77', title: 'acme/widgets CI failed: CI on main', _: { kind: 'run', repo: 'acme/widgets', runId: 77, attempt: 1 } }

const B = '/repos/acme/widgets'
const LOG = ['2026-11-08T10:00:00Z ##[group]Run npm test', '2026-11-08T10:00:01Z FAIL a.test.js', '2026-11-08T10:00:02Z ##[error]exit 1'].join('\n')

function world(over = {}) {
  const runState = { status: 'completed', run_attempt: 1, conclusion: 'failure', ...over.run }
  const routes = [
    ['GET', `${B}/pulls/12`, (u, init) => json({ html_url: 'https://github.com/acme/widgets/pull/12', state: 'open', draft: false, merged: false, head: { ref: 'fix', sha: 'abcdef1234' }, base: { ref: 'main' }, user: { login: 'me' }, body_html: '<p>Fixes <b>login</b></p>', additions: 3, deletions: 1, changed_files: 2, _accept: new Headers(init.headers).get('accept') })],
    ['GET', `${B}/issues/12/comments`, () => json([{ user: { login: 'bob' }, created_at: '2026-11-08T09:00:00Z', body_html: '<p>Why this?</p>' }])],
    ['GET', `${B}/pulls/12/reviews`, () => json([{ user: { login: 'alice' }, submitted_at: '2026-11-08T10:00:00Z', state: 'CHANGES_REQUESTED', body_html: '<p>Add a test</p>' }, { user: { login: 'carol' }, state: 'PENDING' }])],
    ['GET', `${B}/pulls/12/files`, () => json(over.files || [{ filename: 'a.js', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' }, { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 }])],
    ['GET', `${B}/commits/abcdef1234/check-runs`, () => json({ check_runs: [{ id: 501, name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/acme/widgets/runs/501', app: { slug: 'github-actions' } }, { id: 502, name: 'lint', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }, { id: 9, name: 'external', conclusion: 'failure', app: { slug: 'circleci' } }] })],
    ['GET', /\/actions\/jobs\/(\d+)\/logs$/, (u, i, m) => (m[1] === '666' ? json({ message: 'gone' }, 410) : new Response(null, { status: 302, headers: { location: `https://blob.example.net/job/${m[1]}?sig=1` } }))],
    ['GET', `${B}/issues/5`, () => json({ html_url: 'https://github.com/acme/widgets/issues/5', state: 'open', user: { login: 'bob' }, assignees: [{ login: 'me' }], body_html: '<p>It crashes</p>' })],
    ['GET', `${B}/issues/5/comments`, () => json([])],
    ['GET', `${B}/actions/runs/77`, () => json({ html_url: 'https://github.com/acme/widgets/actions/runs/77', name: 'CI', head_branch: 'main', head_sha: 'abcdef1234567890', event: 'push', run_number: 5, display_title: 'Fix login', ...runState })],
    ['GET', `${B}/actions/runs/77/jobs`, () => json({ jobs: [{ id: 601, name: 'build', conclusion: 'success', steps: [] }, { id: 666, name: 'test', conclusion: 'failure', steps: [{ name: 'Run npm test', conclusion: 'failure' }, { name: 'setup', conclusion: 'success' }] }] })],
    ['POST', `${B}/actions/runs/77/rerun-failed-jobs`, () => new Response(null, { status: 201 })],
  ]
  const gh = fakeGitHub({ routes, blob: () => text(LOG) })
  const ctx = fakeCtx()
  const auth = createAuth({ exec: ctx.exec, fetch: gh.fetch, ghPath: 'gh', log: ctx.log })
  return { gh, ctx, client: createClient({ fetch: gh.fetch, auth, log: ctx.log }) }
}

test('PR details: header, HTML body asked as html, timeline in order without pending reviews, checks failed first with a log tail', async () => {
  const { gh, client, ctx } = world()
  const d = await detailsOf(client, prItem, ctx.log)
  assert.equal(d.kind, 'pr')
  assert.equal(d.url, 'https://github.com/acme/widgets/pull/12')
  assert.deepEqual(d.header, { repo: 'acme/widgets', number: 12, state: 'open', head: 'fix', base: 'main', author: 'me', additions: 3, deletions: 1, changedFiles: 2, status: 'failing' })
  assert.equal(d.body, '<p>Fixes <b>login</b></p>')
  assert.deepEqual(d.timeline.map((e) => [e.kind, e.who, e.state]), [['comment', 'bob', undefined], ['review', 'alice', 'CHANGES_REQUESTED']])
  assert.deepEqual(d.checks.map((c) => [c.name, c.failed]), [['external', true], ['test', true], ['lint', false]])
  const t = d.checks.find((c) => c.name === 'test')
  assert.equal(t.tail, '##[group]Run npm test\nFAIL a.test.js\n##[error]exit 1')
  assert.equal(d.checks.find((c) => c.name === 'external').tail, undefined, 'not an Actions job: no log')
  assert.ok(gh.calls.find((c) => c.url.endsWith('/pulls/12')).headers.get('accept').includes('html'))
  assert.ok(gh.calls.filter((c) => c.url.startsWith('https://blob')).every((c) => c.auth === null))
  assert.deepEqual(d.files.map((f) => [f.name, Boolean(f.patch), Boolean(f.noPatch)]), [['a.js', true, false], ['logo.png', false, true]])
})

test('PR files: patches until 1 MB in total, the rest marked too big', async () => {
  const big = 'x'.repeat(600 * 1024)
  const { client, ctx } = world({ files: [{ filename: 'a', patch: big }, { filename: 'b', patch: big }, { filename: 'c', patch: 'small' }] })
  const d = await detailsOf(client, prItem, ctx.log)
  assert.deepEqual(d.files.map((f) => [f.name, Boolean(f.patch), Boolean(f.tooBig)]), [['a', true, false], ['b', false, true], ['c', true, false]])
  assert.equal(d.filesCut, 1)
  assert.ok(d.files.reduce((n, f) => n + (f.patch ? f.patch.length : 0), 0) <= DIFF_CAP)
})

test('issue details', async () => {
  const { client, ctx } = world()
  const d = await detailsOf(client, issueItem, ctx.log)
  assert.deepEqual(d.header, { repo: 'acme/widgets', number: 5, state: 'open', author: 'bob', assignees: ['me'] })
  assert.equal(d.body, '<p>It crashes</p>')
})

test('run details: failed jobs first with failed steps; a log that cannot be fetched says so', async () => {
  const { client, ctx } = world()
  const d = await detailsOf(client, runItem, ctx.log)
  assert.equal(d.header.workflow, 'CI')
  assert.equal(d.header.sha, 'abcdef123456')
  assert.deepEqual(d.jobs.map((j) => [j.name, j.failed, j.failedSteps]), [['test', true, ['Run npm test']], ['build', false, []]])
  assert.equal(d.jobs[0].tail, '')
  assert.match(d.jobs[0].tailError, /410/)
})

test('rerun: POSTs once per attempt; refused while going, after a pass, or without a run', async () => {
  const attempts = new Set()
  const { gh, client } = world()
  assert.deepEqual(await rerun(client, runItem, attempts), { ok: true })
  assert.deepEqual(await rerun(client, runItem, attempts), { ok: false, message: 'This run attempt was already re-run.' })
  assert.equal(gh.calls.filter((c) => c.method === 'POST').length, 1)
  const going = world({ run: { status: 'in_progress' } })
  assert.deepEqual(await rerun(going.client, runItem, new Set()), { ok: false, message: 'The run is still going.' })
  const passed = world({ run: { conclusion: 'success' } })
  assert.deepEqual(await rerun(passed.client, runItem, new Set()), { ok: false, message: 'The run passed since.' })
  assert.equal((await rerun(client, issueItem, attempts)).ok, false)
})

test('discussText: item and URL first, GitHub content quoted, failed checks with log tails, no token', async () => {
  const { client, ctx } = world()
  const d = await detailsOf(client, prItem, ctx.log)
  const t = discussText(d)
  const lines = t.split('\n')
  assert.equal(lines[0], 'acme/widgets#12 Fix login')
  assert.equal(lines[1], 'URL: https://github.com/acme/widgets/pull/12')
  assert.match(t, /content from GitHub, quoted/)
  assert.match(t, /Review by alice \(changes requested\):\nAdd a test/)
  assert.match(t, /Comment by bob:\nWhy this\?/)
  assert.match(t, /Failed checks: external, test/)
  assert.match(t, /End of the log of test:\n```\n##\[group\]Run npm test/)
  assert.ok(!t.includes(TOKEN))
  assert.ok(!t.includes('<p>'))
})

test('discussText: capped per event and in total', () => {
  const long = '<p>' + 'y'.repeat(5000) + '</p>'
  const d = { kind: 'issue', title: 't', url: 'u', header: {}, body: long, timeline: Array.from({ length: 20 }, () => ({ kind: 'comment', who: 'bob', html: long })), checks: [] }
  const t = discussText(d)
  assert.ok(t.length <= DISCUSS.total)
  assert.ok(!t.includes('y'.repeat(DISCUSS.event + 1)))
  assert.equal((t.match(/Comment by bob/g) || []).length, 5)
})

test('plain: tags out, entities back, blocks as lines', () => {
  assert.equal(plain('<p>a &amp; b</p><p>&lt;c&gt;</p><script>evil()</script>'), 'a & b\n<c>')
})
