'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { buildItems, prItem, issueItem, mentions } = require('../dist/lib/model')
const { normalize } = require('../dist/lib/settings')
const { fixture } = require('./fakes')

const S = normalize({})
const T = (h) => `2026-11-08T${String(h).padStart(2, '0')}:00:00Z`

function pr(over = {}) {
  return {
    __typename: 'PullRequest',
    number: 12,
    title: 'Fix the login redirect',
    url: 'https://github.com/acme/widgets/pull/12',
    isDraft: false,
    createdAt: T(1),
    updatedAt: T(9),
    author: { login: 'me' },
    repository: { nameWithOwner: 'acme/widgets' },
    headRefName: 'fix-login',
    baseRefName: 'main',
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    comments: { nodes: [] },
    commits: { nodes: [{ commit: { oid: 'sha1', statusCheckRollup: { state: 'SUCCESS' } } }] },
    ...over,
  }
}

function issue(over = {}) {
  return {
    __typename: 'Issue',
    number: 5,
    title: 'Crash on empty config',
    url: 'https://github.com/acme/widgets/issues/5',
    createdAt: T(2),
    updatedAt: T(3),
    author: { login: 'bob' },
    repository: { nameWithOwner: 'acme/widgets' },
    assignees: { nodes: [{ login: 'me' }] },
    comments: { nodes: [] },
    ...over,
  }
}

const comment = (who, h, body = 'looks good') => ({ author: { login: who }, createdAt: T(h), bodyText: body })
const review = (who, h, state, body = '') => ({ author: { login: who }, submittedAt: T(h), state, bodyText: body })
const ci = (state, oid = 'sha1') => ({ nodes: [{ commit: { oid, statusCheckRollup: state ? { state } : null } }] })

test('a review request (fixture): id, title, preview, from, to, mention, labels, place', () => {
  const nodes = fixture('search-review-requested.json').data.search.nodes
  const items = buildItems({ reviewRequested: nodes }, 'me', S)
  const [a, b] = items
  assert.equal(a.id, 'pr:acme/widgets#41')
  assert.equal(a.title, 'acme/widgets#41 Add retry to the uploader')
  assert.equal(a.preview, 'bob commented: @me could you look at the backoff?')
  assert.deepEqual(a.from, { name: 'bob' })
  assert.equal(a.to, 'direct')
  assert.equal(a.mentionsMe, true)
  assert.deepEqual(a.labels, ['pr', 'review-requested', 'repo:acme/widgets', 'owner:acme'])
  assert.deepEqual(a.place, { kind: 'project', name: 'acme/widgets', status: 'open' })
  assert.equal(a.time, Date.parse('2026-11-08T09:30:00Z'))
  assert.equal(a._.url, 'https://github.com/acme/widgets/pull/41')
  assert.deepEqual(a._.lanes, ['reviewRequested'])
  // A team request: group, its own label, and the author asking.
  assert.equal(b.to, 'group')
  assert.ok(b.labels.includes('team-review-requested'))
  assert.equal(b.preview, 'carol asked for your review')
  assert.deepEqual(b.from, { name: 'carol' })
})

test('my PR: state labels and the place status by priority', () => {
  const cases = [
    [{ isDraft: true, mergeable: 'CONFLICTING' }, 'draft', ['draft', 'conflict']],
    [{ mergeable: 'CONFLICTING', commits: ci('FAILURE') }, 'conflict', ['ci:failed', 'conflict']],
    [{ commits: ci('ERROR'), reviewDecision: 'APPROVED' }, 'failing', ['approved', 'ci:failed']],
    [{ reviewDecision: 'CHANGES_REQUESTED' }, 'changes requested', ['changes-requested']],
    [{ reviewDecision: 'APPROVED', commits: ci('PENDING') }, 'approved', ['approved', 'ci:pending']],
    [{}, 'open', []],
  ]
  for (const [over, status, extra] of cases) {
    const it = prItem(pr(over), ['myPrs'], 'me')
    assert.equal(it.place.status, status, JSON.stringify(over))
    assert.deepEqual(it.labels, ['pr', 'my-pr', ...extra, 'repo:acme/widgets', 'owner:acme'], JSON.stringify(over))
    assert.equal(it.to, undefined)
  }
})

test('my PR with failing CI says so first in the preview', () => {
  const it = prItem(pr({ commits: ci('FAILURE'), comments: { nodes: [comment('alice', 5, 'nit: rename')] } }), ['myPrs'], 'me')
  assert.equal(it.preview, 'CI failed · alice commented: nit: rename')
  assert.equal(prItem(pr({}), ['myPrs'], 'me').preview, 'Opened by me')
})

test('reviews: verbs, the newest event wins, pending reviews ignored', () => {
  const it = prItem(
    pr({
      latestReviews: { nodes: [review('alice', 6, 'CHANGES_REQUESTED', 'Please add a test'), review('carol', 8, 'PENDING', 'draft')] },
      comments: { nodes: [comment('bob', 4)] },
    }),
    ['myPrs'],
    'me'
  )
  assert.equal(it.preview, 'alice requested changes: Please add a test')
  assert.equal(prItem(pr({ latestReviews: { nodes: [review('alice', 6, 'APPROVED')] } }), ['myPrs'], 'me').preview, 'alice approved')
})

test('rev: unchanged by my own comment, my own review and a pending-then-green push', () => {
  const base = prItem(pr({ comments: { nodes: [comment('alice', 3)] } }), ['myPrs'], 'me').rev
  const mine = prItem(pr({ comments: { nodes: [comment('alice', 3), comment('me', 7)] }, latestReviews: { nodes: [review('me', 8, 'COMMENTED')] } }), ['myPrs'], 'me').rev
  assert.equal(mine, base)
  const pushedPending = prItem(pr({ comments: { nodes: [comment('alice', 3)] }, commits: ci('PENDING', 'sha2') }), ['myPrs'], 'me').rev
  const pushedGreen = prItem(pr({ comments: { nodes: [comment('alice', 3)] }, commits: ci('SUCCESS', 'sha2') }), ['myPrs'], 'me').rev
  assert.equal(pushedPending, base)
  assert.equal(pushedGreen, base)
})

test('rev: changed by another person comment or review, and by each new failure', () => {
  const base = prItem(pr({}), ['myPrs'], 'me').rev
  assert.notEqual(prItem(pr({ comments: { nodes: [comment('alice', 3)] } }), ['myPrs'], 'me').rev, base)
  assert.notEqual(prItem(pr({ latestReviews: { nodes: [review('bob', 3, 'APPROVED')] } }), ['myPrs'], 'me').rev, base)
  const fail1 = prItem(pr({ commits: ci('FAILURE', 'sha2') }), ['myPrs'], 'me').rev
  const fail2 = prItem(pr({ commits: ci('FAILURE', 'sha3') }), ['myPrs'], 'me').rev
  assert.notEqual(fail1, base)
  assert.notEqual(fail2, fail1)
})

test('mentions: a whole @login, not an email or a longer login', () => {
  assert.equal(mentions('@me please', 'me'), true)
  assert.equal(mentions('thanks @Me.', 'me'), true)
  assert.equal(mentions('(cc @me)', 'me'), true)
  assert.equal(mentions('write to x@me.com', 'me'), false)
  assert.equal(mentions('@meow', 'me'), false)
  assert.equal(mentions('@me-too', 'me'), false)
  assert.equal(mentions('', 'me'), false)
  assert.equal(mentions('@a.b', 'a.b'), true)
})

test('issues: assigned is direct, a mention only is cc; one item for both queries', () => {
  const assigned = issue()
  const mentionedOnly = issue({ number: 6, assignees: { nodes: [{ login: 'bob' }] }, comments: { nodes: [comment('bob', 4, 'ping @me')] } })
  const items = buildItems({ assigned: [assigned], mentioned: [assigned, mentionedOnly] }, 'me', S)
  assert.equal(items.length, 2)
  const [a, m] = items
  assert.equal(a.id, 'issue:acme/widgets#5')
  assert.equal(a.to, 'direct')
  assert.deepEqual(a.labels, ['issue', 'assigned', 'mentioned', 'repo:acme/widgets', 'owner:acme'])
  assert.equal(a.preview, 'Opened by bob')
  assert.equal(a.rev, `c:${Date.parse(T(2))}`)
  assert.equal(m.to, 'cc')
  assert.equal(m.mentionsMe, true)
  assert.equal(m.preview, 'bob commented: ping @me')
  assert.deepEqual(m.labels, ['issue', 'mentioned', 'repo:acme/widgets', 'owner:acme'])
})

test('excluded owners and repos are left out; broken nodes too', () => {
  const s = normalize({ exclude: ['globex', 'acme/secret'] })
  const items = buildItems(
    {
      myPrs: [pr(), pr({ number: 1, repository: { nameWithOwner: 'globex/core' } }), pr({ number: 2, repository: { nameWithOwner: 'acme/secret' } }), { __typename: 'PullRequest' }, null],
    },
    'me',
    s
  )
  assert.deepEqual(items.map((i) => i.id), ['pr:acme/widgets#12'])
})

test('caps: a long title is cut to 300 with an ellipsis, whitespace collapsed; a long repo has no repo: label', () => {
  const it = prItem(pr({ title: 'x'.repeat(400) + '\n\tend', repository: { nameWithOwner: 'acme/' + 'r'.repeat(60) } }), ['myPrs'], 'me')
  assert.equal(it.title.length, 300)
  assert.ok(it.title.endsWith('…'))
  assert.ok(!it.labels.some((l) => l.startsWith('repo:')))
  assert.ok(it.labels.includes('owner:acme'))
  for (const l of it.labels) assert.ok(l.length <= 40)
  const p = prItem(pr({ comments: { nodes: [comment('bob', 3, 'line one\n\nline two  ' + 'y'.repeat(2000))] } }), ['myPrs'], 'me')
  assert.ok(p.preview.length <= 1000)
  assert.ok(p.preview.startsWith('bob commented: line one line two'))
})

test('a PR in both PR lanes is one item with both facts', () => {
  const n = pr({ reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'me' } }] } })
  const items = buildItems({ reviewRequested: [n], myPrs: [n] }, 'me', S)
  assert.equal(items.length, 1)
  assert.ok(items[0].labels.includes('review-requested') && items[0].labels.includes('my-pr'))
  assert.deepEqual(items[0]._.lanes, ['reviewRequested', 'myPrs'])
})
