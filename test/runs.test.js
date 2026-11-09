'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { repoSet, failedRuns, runItem, linkPrRuns, pushedRepos } = require('../dist/lib/runs')
const { normalize } = require('../dist/lib/settings')
const { NOW } = require('./fakes')

const S = normalize({ exclude: ['globex'] })
const iso = (msAgo) => new Date(NOW - msAgo).toISOString()
const H = 36e5

function run(id, over = {}) {
  return {
    id,
    name: 'CI',
    workflow_id: 100,
    head_branch: 'main',
    head_sha: `sha${id}`,
    run_number: id,
    run_attempt: 1,
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    display_title: 'Fix the build',
    html_url: `https://github.com/acme/widgets/actions/runs/${id}`,
    created_at: iso(H),
    updated_at: iso(H / 2),
    ...over,
  }
}

/** A client answering actions/runs per repo and status from `table[repo][status]` (or throwing `table[repo]`). */
function client(table) {
  const calls = []
  return {
    calls,
    async rest(method, path, o) {
      calls.push({ path, query: o.query })
      const m = path.match(/^\/repos\/([^/]+\/[^/]+)\/actions\/runs$/)
      const entry = table[m[1]]
      if (entry instanceof Error) throw entry
      return { data: { workflow_runs: (entry && entry[o.query.status]) || [] } }
    },
  }
}

test('repoSet: PR repos first, then pushed in the last 7 days; excluded out; deduped; at most 10', () => {
  const pushed = [
    { full_name: 'acme/widgets', pushed_at: iso(H) },
    { full_name: 'acme/old', pushed_at: iso(8 * 24 * H) },
    { full_name: 'globex/core', pushed_at: iso(H) },
    ...Array.from({ length: 12 }, (_, i) => ({ full_name: `acme/r${i}`, pushed_at: iso(H) })),
  ]
  const set = repoSet(['acme/Widgets', 'acme/api', 'bad name'], pushed, NOW, S)
  assert.deepEqual(set.slice(0, 2), ['acme/Widgets', 'acme/api'])
  assert.equal(set.length, 10)
  assert.ok(!set.includes('acme/old'))
  assert.ok(!set.includes('globex/core'))
  assert.equal(set.filter((r) => r.toLowerCase() === 'acme/widgets').length, 1)
})

test('failedRuns: asks with actor, status and a 7-day created filter', async () => {
  const c = client({})
  await failedRuns(c, ['acme/widgets'], 'me', NOW)
  assert.deepEqual(c.calls[0].query, { actor: 'me', status: 'failure', created: '>=2026-11-01', per_page: 30 })
  assert.equal(c.calls[1].query.status, 'success')
})

test('failedRuns: one item per workflow and branch, the newest failure', async () => {
  const c = client({
    'acme/widgets': {
      failure: [run(1, { created_at: iso(5 * H) }), run(3, { created_at: iso(1 * H) }), run(2, { created_at: iso(3 * H) }), run(4, { head_branch: 'dev' }), run(5, { workflow_id: 200, name: 'Release' })],
    },
  })
  const { runs, failures } = await failedRuns(c, ['acme/widgets'], 'me', NOW)
  assert.deepEqual(runs.map((r) => r.id).sort(), [3, 4, 5])
  assert.equal(failures.length, 5)
})

test('failedRuns: a later success of the same workflow and branch supersedes; an older one does not', async () => {
  const c = client({
    'acme/widgets': {
      failure: [run(1, { created_at: iso(5 * H) }), run(2, { head_branch: 'dev', created_at: iso(5 * H) })],
      success: [run(10, { created_at: iso(2 * H), conclusion: 'success' }), run(11, { head_branch: 'dev', created_at: iso(9 * H), conclusion: 'success' })],
    },
  })
  const { runs } = await failedRuns(c, ['acme/widgets'], 'me', NOW)
  assert.deepEqual(runs.map((r) => r.id), [2])
})

test('failedRuns: older than 7 days is out; one repo failing leaves the others', async () => {
  const warn = []
  const c = client({
    'acme/widgets': { failure: [run(1, { created_at: iso(8 * 24 * H) }), run(2)] },
    'acme/broken': Object.assign(new Error('Not Found'), { status: 404 }),
  })
  const { runs, errors } = await failedRuns(c, ['acme/broken', 'acme/widgets'], 'me', NOW, { warn: (m) => warn.push(m) })
  assert.deepEqual(runs.map((r) => r.id), [2])
  assert.deepEqual(errors, ['acme/broken'])
  assert.match(warn[0], /acme\/broken/)
})

test('failedRuns: a rate limit or sign-out stops the whole round', async () => {
  const c = client({ 'acme/widgets': Object.assign(new Error('limit'), { rateLimited: true }) })
  await assert.rejects(failedRuns(c, ['acme/widgets'], 'me', NOW), /limit/)
})

test('runItem: id, rev per attempt, title, preview, labels, place', () => {
  const it = runItem({ ...run(42, { run_attempt: 2 }), _repo: 'acme/widgets' })
  assert.equal(it.id, 'run:acme/widgets/42')
  assert.equal(it.rev, 'run:42.2')
  assert.equal(it.title, 'acme/widgets CI failed: CI on main')
  assert.equal(it.preview, 'Run #42 failed (push) · Fix the build')
  assert.deepEqual(it.labels, ['run', 'ci:failed', 'repo:acme/widgets', 'owner:acme'])
  assert.deepEqual(it.place, { kind: 'project', name: 'acme/widgets', status: 'failing' })
  assert.equal(it._.runId, 42)
  assert.deepEqual(it._.lanes, ['failedRuns'])
})

test('linkPrRuns: a failing own PR gets the newest failed run of its head sha in its repo', () => {
  const pr = { _: { kind: 'pr', sha: 'abc', repo: 'acme/widgets' }, labels: ['pr', 'my-pr', 'ci:failed'] }
  const other = { _: { kind: 'pr', sha: 'abc', repo: 'acme/widgets' }, labels: ['pr', 'review-requested', 'ci:failed'] }
  linkPrRuns(
    [pr, other],
    [
      { id: 1, head_sha: 'abc', _repo: 'acme/widgets', created_at: iso(3 * H), run_attempt: 1 },
      { id: 2, head_sha: 'abc', _repo: 'acme/widgets', created_at: iso(1 * H), run_attempt: 3, status: 'completed' },
      { id: 3, head_sha: 'abc', _repo: 'acme/other', created_at: iso(0) },
    ]
  )
  assert.equal(pr._.runId, 2)
  assert.equal(pr._.attempt, 3)
  assert.equal(other._.runId, undefined)
})

test('pushedRepos: archived repos left out', async () => {
  const c = { rest: async () => ({ data: [{ full_name: 'acme/a', archived: false }, { full_name: 'acme/b', archived: true }, null] }) }
  assert.deepEqual((await pushedRepos(c)).map((r) => r.full_name), ['acme/a'])
})
