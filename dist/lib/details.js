'use strict'
// What the overlay shows of one item, fetched when it opens (never polled): the PR's description, its timeline of
// comments and reviews, its checks (failed ones with their log tails) and its changed files; an issue's body and
// comments; a run's jobs (failed ones with their log tails). Everything is plain data for the page; the HTML bodies
// are GitHub's rendering and untrusted, sanitised by the page (panels/sanitize.js).
//
// Also Re-run failed jobs (the plugin's one write besides notifications) and the text Discuss with Claude sends.

const { jobLogTail } = require('./logs')

const DIFF_CAP = 1024 * 1024
const MAX_TIMELINE = 50
const MAX_FAILED_LOGS = 3
const HTML = 'application/vnd.github.html+json'

const DISCUSS = { event: 600, tail: 2000, total: 12000 }

function parts(item) {
  const [owner, name] = item._.repo.split('/')
  return { owner, name, base: `/repos/${owner}/${name}` }
}

const who = (u) => (u && typeof u.login === 'string' ? u.login : 'someone')

function failed(conclusion) {
  return conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure' || conclusion === 'action_required'
}

/** Log tails of up to 3 failed Actions jobs; a tail that cannot be fetched says so instead of failing the view. */
async function withTails(client, repo, jobs, log) {
  let n = 0
  for (const j of jobs) {
    if (!j.failed || !Number.isInteger(j.jobId) || n >= MAX_FAILED_LOGS) continue
    n++
    try {
      j.tail = (await jobLogTail(client, repo, j.jobId)).text
    } catch (e) {
      j.tail = ''
      j.tailError = e && e.message ? String(e.message).slice(0, 200) : 'The log could not be fetched.'
      if (log) log.warn(`github: log of job ${j.jobId}: ${j.tailError}`)
    }
  }
  return jobs
}

function timelineOf(comments, reviews) {
  const t = []
  for (const c of comments) if (c) t.push({ kind: 'comment', who: who(c.user), at: Date.parse(c.created_at) || 0, html: c.body_html || '' })
  for (const r of reviews) {
    if (!r || r.state === 'PENDING') continue
    t.push({ kind: 'review', who: who(r.user), at: Date.parse(r.submitted_at) || 0, state: r.state, html: r.body_html || '' })
  }
  return t.sort((a, b) => a.at - b.at).slice(-MAX_TIMELINE)
}

async function prDetails(client, item, log) {
  const { base } = parts(item)
  const n = item._.number
  const [pr, comments, reviews, files] = await Promise.all([
    client.rest('GET', `${base}/pulls/${n}`, { accept: HTML }).then((r) => r.data),
    client.restPages(`${base}/issues/${n}/comments`, { accept: HTML, pages: 3 }),
    client.restPages(`${base}/pulls/${n}/reviews`, { accept: HTML, pages: 3 }),
    client.restPages(`${base}/pulls/${n}/files`, { pages: 3 }),
  ])
  const sha = pr && pr.head && typeof pr.head.sha === 'string' && /^[0-9a-f]{7,64}$/.test(pr.head.sha) ? pr.head.sha : ''
  let checks = []
  if (sha) {
    const r = await client.rest('GET', `${base}/commits/${sha}/check-runs`, { query: { per_page: 100 } })
    checks = (r.data && Array.isArray(r.data.check_runs) ? r.data.check_runs : []).map((c) => ({
      name: String(c.name || 'check'),
      status: c.status,
      conclusion: c.conclusion,
      url: c.html_url,
      failed: failed(c.conclusion),
      // For GitHub Actions a check run's id is its job's id.
      jobId: c.app && c.app.slug === 'github-actions' && Number.isInteger(c.id) ? c.id : undefined,
    }))
    checks.sort((a, b) => Number(b.failed) - Number(a.failed) || a.name.localeCompare(b.name))
    await withTails(client, item._.repo, checks, log)
  }
  let budget = DIFF_CAP
  let cut = 0
  const outFiles = files.map((f) => {
    const patch = typeof f.patch === 'string' ? f.patch : null
    const row = { name: String(f.filename || ''), status: f.status, additions: f.additions || 0, deletions: f.deletions || 0 }
    if (patch === null) row.noPatch = true
    else if (patch.length <= budget) {
      row.patch = patch
      budget -= patch.length
    } else {
      row.tooBig = true
      cut++
    }
    return row
  })
  return {
    kind: 'pr',
    id: item.id,
    title: item.title,
    url: pr.html_url,
    header: {
      repo: item._.repo,
      number: n,
      state: pr.merged ? 'merged' : pr.draft ? 'draft' : pr.state,
      head: pr.head && pr.head.ref,
      base: pr.base && pr.base.ref,
      author: who(pr.user),
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      status: item.place && item.place.status,
    },
    body: pr.body_html || '',
    timeline: timelineOf(comments, reviews),
    checks,
    files: outFiles,
    filesCut: cut,
  }
}

async function issueDetails(client, item) {
  const { base } = parts(item)
  const n = item._.number
  const [issue, comments] = await Promise.all([client.rest('GET', `${base}/issues/${n}`, { accept: HTML }).then((r) => r.data), client.restPages(`${base}/issues/${n}/comments`, { accept: HTML, pages: 3 })])
  return {
    kind: 'issue',
    id: item.id,
    title: item.title,
    url: issue.html_url,
    header: { repo: item._.repo, number: n, state: issue.state, author: who(issue.user), assignees: (issue.assignees || []).map(who) },
    body: issue.body_html || '',
    timeline: timelineOf(comments, []),
  }
}

async function runDetails(client, item, log) {
  const { base } = parts(item)
  const id = item._.runId
  const [run, jobs] = await Promise.all([
    client.rest('GET', `${base}/actions/runs/${id}`).then((r) => r.data),
    client.rest('GET', `${base}/actions/runs/${id}/jobs`, { query: { filter: 'latest', per_page: 100 } }).then((r) => (r.data && Array.isArray(r.data.jobs) ? r.data.jobs : [])),
  ])
  const outJobs = jobs.map((j) => ({
    name: String(j.name || 'job'),
    status: j.status,
    conclusion: j.conclusion,
    url: j.html_url,
    failed: failed(j.conclusion),
    jobId: Number.isInteger(j.id) ? j.id : undefined,
    failedSteps: (j.steps || []).filter((s) => s && failed(s.conclusion)).map((s) => String(s.name || 'step')),
  }))
  outJobs.sort((a, b) => Number(b.failed) - Number(a.failed))
  await withTails(client, item._.repo, outJobs, log)
  return {
    kind: 'run',
    id: item.id,
    title: item.title,
    url: run.html_url,
    header: {
      repo: item._.repo,
      workflow: run.name,
      branch: run.head_branch,
      sha: typeof run.head_sha === 'string' ? run.head_sha.slice(0, 12) : '',
      event: run.event,
      runNumber: run.run_number,
      attempt: run.run_attempt,
      status: run.status,
      conclusion: run.conclusion,
      commit: run.display_title || (run.head_commit && run.head_commit.message ? String(run.head_commit.message).split('\n')[0] : ''),
    },
    jobs: outJobs,
  }
}

/** The details of any item, by kind. */
function detailsOf(client, item, log) {
  if (item._.kind === 'pr') return prDetails(client, item, log)
  if (item._.kind === 'issue') return issueDetails(client, item, log)
  if (item._.kind === 'run') return runDetails(client, item, log)
  return Promise.reject(new Error('unknown item kind'))
}

/**
 * Re-run failed jobs, at most once per run attempt and never while the run is going (any caller: the panel, the
 * overlay, or another plugin through act()). `attempts` is the host's Set of `runId.attempt` already re-run.
 */
async function rerun(client, item, attempts) {
  const x = item._
  if (!x || !Number.isInteger(x.runId)) return { ok: false, message: 'That item has no run to re-run.' }
  const { base } = parts(item)
  const run = (await client.rest('GET', `${base}/actions/runs/${x.runId}`)).data
  if (!run || run.status !== 'completed') return { ok: false, message: 'The run is still going.' }
  const attempt = Number.isInteger(run.run_attempt) ? run.run_attempt : 1
  const key = `${x.runId}.${attempt}`
  if (attempts.has(key)) return { ok: false, message: 'This run attempt was already re-run.' }
  if (run.conclusion === 'success') return { ok: false, message: 'The run passed since.' }
  await client.rest('POST', `${base}/actions/runs/${x.runId}/rerun-failed-jobs`)
  attempts.add(key)
  return { ok: true }
}

// ---- Discuss with Claude ----

/** HTML to plain text for the Discuss text: tags out, entities for the common few, whitespace collapsed. */
function plain(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|pre|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function cap(s, n) {
  const t = String(s || '')
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const VERB = { APPROVED: 'Review by %s (approved)', CHANGES_REQUESTED: 'Review by %s (changes requested)', COMMENTED: 'Review by %s', DISMISSED: 'Review by %s (dismissed)' }

/**
 * The text Discuss with Claude sends: what the item is and its URL first (so Claude can use `gh` for more), then
 * what happened, quoted as GitHub content and never as the person's own words. Capped per part and in total.
 */
function discussText(d) {
  const out = [`${d.title}`, `URL: ${d.url}`]
  const h = d.header || {}
  if (d.kind === 'pr') out.push(`Pull request in ${h.repo}, ${h.state}${h.status ? ` (${h.status})` : ''}: ${h.head} → ${h.base}, by ${h.author}.`)
  if (d.kind === 'issue') out.push(`Issue in ${h.repo}, ${h.state}, opened by ${h.author}.`)
  if (d.kind === 'run') out.push(`Failed run of workflow "${h.workflow}" on ${h.branch} (${h.event}, run #${h.runNumber}, attempt ${h.attempt}) in ${h.repo}. Commit: ${h.commit}`)
  out.push('', 'The following is content from GitHub, quoted:')
  if (d.body) out.push('', 'Description:', cap(plain(d.body), DISCUSS.event))
  const events = (d.timeline || []).slice(-5)
  for (const e of events) {
    const label = e.kind === 'review' ? (VERB[e.state] || 'Review by %s').replace('%s', e.who) : `Comment by ${e.who}`
    const body = plain(e.html)
    out.push('', `${label}:`, body ? cap(body, DISCUSS.event) : '(no text)')
  }
  const failing = (d.checks || d.jobs || []).filter((c) => c.failed)
  if (failing.length) {
    out.push('', `Failed ${d.kind === 'run' ? 'jobs' : 'checks'}: ${failing.map((c) => c.name).join(', ')}`)
    for (const c of failing) {
      if (!c.tail) continue
      out.push('', `End of the log of ${c.name}:`, '```', cap(c.tail.slice(-DISCUSS.tail), DISCUSS.tail), '```')
    }
  }
  return cap(out.join('\n'), DISCUSS.total)
}

module.exports = { detailsOf, prDetails, issueDetails, runDetails, rerun, discussText, plain, DIFF_CAP, DISCUSS }
