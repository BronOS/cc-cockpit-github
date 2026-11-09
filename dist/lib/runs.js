'use strict'
// Failed CI runs the person started. GitHub has no account-wide "my failed runs", so a small repo set is asked:
// the repos of the person's open PRs and the repos they pushed to in the last 7 days, at most 10. Per workflow and
// branch only the newest failure is an item (five red pushes of one branch are one row), and it goes once a later
// run of the same workflow on the same branch succeeded, or after 7 days.

const { isExcluded } = require('./settings')
const { line, CAP } = require('./model')

const DAY = 864e5
const WINDOW = 7 * DAY
const MAX_REPOS = 10

function ms(iso) {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/** The repos to ask: PR repos first, then recently pushed ones; excluded ones out; at most 10, no duplicates. */
function repoSet(prRepos, pushed, now, settings) {
  const out = []
  const seen = new Set()
  const add = (nwo) => {
    if (typeof nwo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(nwo) || isExcluded(nwo, settings)) return
    const k = nwo.toLowerCase()
    if (seen.has(k) || out.length >= MAX_REPOS) return
    seen.add(k)
    out.push(nwo)
  }
  for (const r of prRepos) add(r)
  for (const r of pushed || []) if (r && now - ms(r.pushed_at) <= WINDOW) add(r.full_name)
  return out
}

/** Repos the person pushed to lately (owner, collaborator or member), newest first. */
async function pushedRepos(client) {
  const { data } = await client.rest('GET', '/user/repos', { query: { sort: 'pushed', direction: 'desc', per_page: 20, affiliation: 'owner,collaborator,organization_member' } })
  return Array.isArray(data) ? data.filter((r) => r && !r.archived) : []
}

function day(t) {
  return new Date(t).toISOString().slice(0, 10)
}

/**
 * Failed runs by `login` in `repos`, deduped and superseded as above. `{ runs, failures, errors }`: `runs` the kept
 * ones (newest per workflow+branch), `failures` every failed run seen (to link a PR's head sha to its run),
 * `errors` the repos that failed (logged, the others still count).
 */
async function failedRuns(client, repos, login, now, log) {
  const since = `>=${day(now - WINDOW)}`
  const kept = []
  const all = []
  const errors = []
  for (const nwo of repos) {
    const [owner, repo] = nwo.split('/')
    let failed
    let succeeded
    try {
      const path = `/repos/${owner}/${repo}/actions/runs`
      failed = (await client.rest('GET', path, { query: { actor: login, status: 'failure', created: since, per_page: 30 } })).data
      succeeded = (await client.rest('GET', path, { query: { actor: login, status: 'success', created: since, per_page: 50 } })).data
    } catch (e) {
      if (e && (e.rateLimited || e.signedOut)) throw e
      errors.push(nwo)
      if (log) log.warn(`github: failed runs of ${nwo}: ${e && e.message ? e.message : e}`)
      continue
    }
    const fails = (failed && Array.isArray(failed.workflow_runs) ? failed.workflow_runs : []).filter((r) => r && Number.isInteger(r.id) && now - ms(r.created_at) <= WINDOW)
    const oks = succeeded && Array.isArray(succeeded.workflow_runs) ? succeeded.workflow_runs.filter(Boolean) : []
    all.push(...fails.map((r) => ({ ...r, _repo: nwo })))
    const newest = new Map()
    for (const r of fails) {
      const k = `${r.workflow_id}\u0000${r.head_branch}`
      const cur = newest.get(k)
      if (!cur || ms(r.created_at) > ms(cur.created_at) || (ms(r.created_at) === ms(cur.created_at) && r.id > cur.id)) newest.set(k, r)
    }
    for (const r of newest.values()) {
      const fixed = oks.some((s) => s.workflow_id === r.workflow_id && s.head_branch === r.head_branch && ms(s.created_at) > ms(r.created_at))
      if (!fixed) kept.push({ ...r, _repo: nwo })
    }
  }
  return { runs: kept, failures: all, errors }
}

/** A failed run to an item. */
function runItem(run) {
  const nwo = run._repo
  const workflow = run.name || 'workflow'
  const branch = run.head_branch || 'unknown branch'
  const attempt = Number.isInteger(run.run_attempt) ? run.run_attempt : 1
  const labels = ['run', 'ci:failed']
  const repo = `repo:${nwo.toLowerCase()}`
  if (repo.length <= CAP.label) labels.push(repo)
  const owner = `owner:${nwo.split('/')[0].toLowerCase()}`
  if (owner.length <= CAP.label) labels.push(owner)
  const what = run.display_title ? ` · ${run.display_title}` : ''
  return {
    id: `run:${nwo}/${run.id}`,
    rev: `run:${run.id}.${attempt}`,
    title: line(`${nwo} CI failed: ${workflow} on ${branch}`, CAP.title),
    preview: line(`Run #${run.run_number || '?'} failed${run.event ? ` (${run.event})` : ''}${what}`, CAP.preview),
    time: ms(run.updated_at) || ms(run.created_at) || 1,
    read: false,
    place: { kind: 'project', name: line(nwo, CAP.place), status: 'failing' },
    labels,
    actions: [],
    _: { kind: 'run', url: run.html_url, lanes: ['failedRuns'], repo: nwo, runId: run.id, attempt, workflowId: run.workflow_id, branch, sha: run.head_sha || '', status: run.status || 'completed', workflow },
  }
}

/** Give each failing own PR the id of the failed run of its head commit, so Re-run works from the PR. */
function linkPrRuns(items, failures) {
  for (const it of items) {
    if (it._.kind !== 'pr' || !it.labels.includes('ci:failed') || !it.labels.includes('my-pr') || !it._.sha) continue
    const run = failures
      .filter((r) => r.head_sha === it._.sha && r._repo.toLowerCase() === it._.repo.toLowerCase())
      .sort((a, b) => ms(b.created_at) - ms(a.created_at))[0]
    if (run) {
      it._.runId = run.id
      it._.attempt = Number.isInteger(run.run_attempt) ? run.run_attempt : 1
      it._.runStatus = run.status || 'completed'
    }
  }
}

module.exports = { repoSet, pushedRepos, failedRuns, runItem, linkPrRuns, MAX_REPOS }
