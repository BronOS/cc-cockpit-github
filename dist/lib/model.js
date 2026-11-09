'use strict'
// Search nodes to items, by the shared convention (docs/item-convention.md). An item is the inbox-feed v2 item
// plus `_`, this plugin's own facts (kind, url, lanes, repo, number, head sha) that never leave the host except
// to its own panel and overlay; feed.js strips `_` before an item reaches Inbox.
//
// `rev` is what makes an item unread again, so it moves only when someone else did something: comments and
// reviews by the person are left out, and the check part moves only when a head goes into failure (a push going
// PENDING then SUCCESS would otherwise mark the person's own PR unread twice, and bring back an Inbox Done).

const { isExcluded } = require('./settings')

const CAP = { title: 300, preview: 1000, place: 120, status: 60, label: 40, from: 120 }

/** One line, whitespace runs as one space, at most `n` characters (with an ellipsis when cut). */
function line(s, n) {
  const t = String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f\s]+/g, ' ')
    .trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

function ms(iso) {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/** `@login` as a whole word: not part of an email (`x@me.com`) or a longer login (`@meow`). */
function mentions(body, me) {
  if (!body || !me) return false
  const esc = me.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_.-])@${esc}(?![A-Za-z0-9_-])`, 'i').test(body)
}

const login = (a) => (a && typeof a.login === 'string' ? a.login : '')
const nodes = (c) => (c && Array.isArray(c.nodes) ? c.nodes.filter(Boolean) : [])
const same = (a, b) => a.toLowerCase() === b.toLowerCase()

const REVIEW_VERB = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'reviewed', DISMISSED: 'had a review dismissed' }

/** What other people did on a PR or issue, newest first: `{ kind, who, at, text, state? }`. */
function othersEvents(node, me) {
  const ev = []
  for (const c of nodes(node.comments)) {
    const who = login(c.author)
    if (!who || same(who, me)) continue
    ev.push({ kind: 'comment', who, at: ms(c.createdAt), text: c.bodyText || '' })
  }
  for (const r of nodes(node.latestReviews)) {
    const who = login(r.author)
    if (!who || same(who, me) || r.state === 'PENDING') continue
    ev.push({ kind: 'review', who, at: ms(r.submittedAt), text: r.bodyText || '', state: r.state })
  }
  return ev.filter((e) => e.at > 0).sort((a, b) => b.at - a.at)
}

function eventText(e) {
  if (e.kind === 'review') {
    const verb = REVIEW_VERB[e.state] || 'reviewed'
    return e.text ? `${e.who} ${verb}: ${e.text}` : `${e.who} ${verb}`
  }
  return `${e.who} commented: ${e.text}`
}

function ci(node) {
  const c = nodes(node.commits)[0]
  const commit = c && c.commit
  const state = commit && commit.statusCheckRollup ? commit.statusCheckRollup.state : null
  return { sha: commit && typeof commit.oid === 'string' ? commit.oid : '', state }
}

function repoLabels(nwo) {
  const out = []
  const repo = `repo:${nwo.toLowerCase()}`
  // A label is at most 40 characters: a long owner/repo has no repo: label (rules can use owner: or the place).
  if (repo.length <= CAP.label) out.push(repo)
  const owner = `owner:${nwo.split('/')[0].toLowerCase()}`
  if (owner.length <= CAP.label) out.push(owner)
  return out
}

/**
 * A PR node to an item. `inLanes`: the lane keys whose search returned it (`reviewRequested`, `myPrs`). `me`: the
 * signed-in login.
 */
function prItem(node, inLanes, me) {
  const nwo = node.repository.nameWithOwner
  const { sha, state } = ci(node)
  const failing = state === 'FAILURE' || state === 'ERROR'
  const pending = state === 'PENDING' || state === 'EXPECTED'
  const conflict = node.mergeable === 'CONFLICTING'
  const ev = othersEvents(node, me)
  const newest = ev[0]
  const labels = ['pr']
  let to
  if (inLanes.includes('reviewRequested')) {
    const reqs = nodes(node.reviewRequests).map((r) => r.requestedReviewer).filter(Boolean)
    const direct = reqs.some((r) => r.__typename === 'User' && same(login(r), me))
    labels.push(direct ? 'review-requested' : 'team-review-requested')
    to = direct ? 'direct' : 'group'
  }
  if (inLanes.includes('myPrs')) labels.push('my-pr')
  if (node.isDraft) labels.push('draft')
  if (node.reviewDecision === 'CHANGES_REQUESTED') labels.push('changes-requested')
  if (node.reviewDecision === 'APPROVED') labels.push('approved')
  if (failing) labels.push('ci:failed')
  if (pending) labels.push('ci:pending')
  if (conflict) labels.push('conflict')
  labels.push(...repoLabels(nwo))
  const status = node.isDraft ? 'draft' : conflict ? 'conflict' : failing ? 'failing' : node.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested' : node.reviewDecision === 'APPROVED' ? 'approved' : 'open'
  const author = login(node.author)
  let preview
  if (newest) preview = eventText(newest)
  else if (inLanes.includes('reviewRequested') && !inLanes.includes('myPrs')) preview = `${author || 'Someone'} asked for your review`
  else preview = `Opened by ${author || 'you'}`
  if (failing && inLanes.includes('myPrs')) preview = `CI failed · ${preview}`
  const newestComment = ev.find((e) => e.kind === 'comment')
  const newestReview = ev.find((e) => e.kind === 'review')
  const rev = [`c:${newestComment ? newestComment.at : 0}`, `r:${newestReview ? newestReview.at : 0}`, `f:${failing ? sha : ''}`].join('|')
  const item = {
    id: `pr:${nwo}#${node.number}`,
    rev,
    title: line(`${nwo}#${node.number} ${node.title}`, CAP.title),
    preview: line(preview, CAP.preview),
    time: Math.max(newest ? newest.at : 0, ms(node.createdAt)) || ms(node.updatedAt) || 1,
    read: false,
    place: { kind: 'project', name: line(nwo, CAP.place), status },
    labels,
    actions: [],
    _: { kind: 'pr', url: node.url, lanes: inLanes.includes('reviewRequested') ? ['reviewRequested'].concat(inLanes.includes('myPrs') ? ['myPrs'] : []) : ['myPrs'], repo: nwo, number: node.number, sha, ci: state, author, head: node.headRefName, base: node.baseRefName },
  }
  const fromWho = newest ? newest.who : author
  if (fromWho) item.from = { name: line(fromWho, CAP.from) }
  if (to) item.to = to
  if (newest && mentions(newest.text, me)) item.mentionsMe = true
  return item
}

/** An issue node to an item. `inQueries`: `assigned` and/or `mentioned`. */
function issueItem(node, inQueries, me) {
  const nwo = node.repository.nameWithOwner
  const assigned = nodes(node.assignees).some((a) => same(login(a), me))
  const ev = othersEvents(node, me)
  const newest = ev[0]
  const labels = ['issue']
  if (assigned) labels.push('assigned')
  if (inQueries.includes('mentioned')) labels.push('mentioned')
  labels.push(...repoLabels(nwo))
  const author = login(node.author)
  const item = {
    id: `issue:${nwo}#${node.number}`,
    rev: `c:${newest ? newest.at : ms(node.createdAt)}`,
    title: line(`${nwo}#${node.number} ${node.title}`, CAP.title),
    preview: line(newest ? eventText(newest) : `Opened by ${author || 'someone'}`, CAP.preview),
    time: Math.max(newest ? newest.at : 0, ms(node.createdAt)) || ms(node.updatedAt) || 1,
    read: false,
    place: { kind: 'project', name: line(nwo, CAP.place), status: 'open' },
    labels,
    to: assigned ? 'direct' : 'cc',
    actions: [],
    _: { kind: 'issue', url: node.url, lanes: ['issues'], repo: nwo, number: node.number, author },
  }
  const fromWho = newest ? newest.who : author
  if (fromWho) item.from = { name: line(fromWho, CAP.from) }
  if (newest && mentions(newest.text, me)) item.mentionsMe = true
  return item
}

function valid(node) {
  return node && node.repository && typeof node.repository.nameWithOwner === 'string' && node.repository.nameWithOwner.includes('/') && Number.isInteger(node.number) && typeof node.url === 'string'
}

/**
 * Every item from one poll's search results (`{ reviewRequested, myPrs, assigned, mentioned }` node lists),
 * excluded repos left out, ids unique (a node in two queries is one item with both facts).
 */
function buildItems(results, me, settings) {
  const prLanes = new Map()
  const issueQs = new Map()
  const byId = new Map()
  const note = (map, node, key) => {
    const id = `${node.__typename === 'PullRequest' ? 'pr' : 'issue'}:${node.repository.nameWithOwner}#${node.number}`
    if (!map.has(id)) map.set(id, [])
    if (!map.get(id).includes(key)) map.get(id).push(key)
    byId.set(id, node)
  }
  for (const key of ['reviewRequested', 'myPrs']) {
    for (const n of results[key] || []) if (valid(n) && n.__typename === 'PullRequest' && !isExcluded(n.repository.nameWithOwner, settings)) note(prLanes, n, key)
  }
  for (const key of ['assigned', 'mentioned']) {
    for (const n of results[key] || []) if (valid(n) && n.__typename === 'Issue' && !isExcluded(n.repository.nameWithOwner, settings)) note(issueQs, n, key)
  }
  const items = []
  for (const [id, lanes] of prLanes) items.push(prItem(byId.get(id), lanes, me))
  for (const [id, qs] of issueQs) items.push(issueItem(byId.get(id), qs, me))
  return items
}

module.exports = { buildItems, prItem, issueItem, mentions, line, CAP }
