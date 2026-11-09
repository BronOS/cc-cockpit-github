'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { lanesView, banner, badgesOf, ago } = require('../panels/rowlogic')
const { NOW } = require('./fakes')

const row = (id, lanes, over = {}) => ({ id, lanes, title: `t ${id}`, repo: 'acme/widgets', from: 'bob', time: NOW - 5 * 60_000, read: true, labels: [], actions: [{ id: 'markRead', label: 'Mark read' }], ...over })
const state = (rows, over = {}) => ({ type: 'state', state: 'ok', lanes: { reviewRequested: true, myPrs: true, issues: true, failedRuns: true }, rowsPerLane: 2, rows, ...over })

test('lanes: enabled ones only, newest first, a row in two PR lanes in both', () => {
  const rows = [row('a', ['reviewRequested', 'myPrs'], { time: NOW - 1000 }), row('b', ['myPrs'], { time: NOW - 5000 }), row('c', ['issues'])]
  const v = lanesView(state(rows, { lanes: { reviewRequested: true, myPrs: true, issues: false, failedRuns: true } }), NOW, new Set())
  assert.deepEqual(v.map((l) => [l.id, l.rows.map((r) => r.id)]), [['reviewRequested', ['a']], ['myPrs', ['a', 'b']], ['failedRuns', []]])
})

test('rows per lane, Show all count, expanded lanes show everything', () => {
  const rows = [1, 2, 3, 4].map((n) => row(`p${n}`, ['myPrs'], { time: NOW - n }))
  const [, mine] = lanesView(state(rows), NOW, new Set())
  assert.equal(mine.rows.length, 2)
  assert.equal(mine.hidden, 2)
  assert.equal(mine.total, 4)
  const [, open] = lanesView(state(rows), NOW, new Set(['myPrs']))
  assert.equal(open.rows.length, 4)
  assert.equal(open.hidden, 0)
  assert.equal(open.expanded, true)
})

test('row: meta line, unread, badges in order', () => {
  const [lane] = lanesView(state([row('a', ['reviewRequested'], { read: false, labels: ['pr', 'approved', 'ci:failed', 'draft', 'repo:acme/widgets'] })]), NOW, new Set())
  const r = lane.rows[0]
  assert.equal(r.meta, 'acme/widgets · bob · 5 min')
  assert.equal(r.unread, true)
  assert.deepEqual(r.badges, [
    { text: 'CI failed', color: 'red' },
    { text: 'approved', color: 'green' },
    { text: 'draft', color: 'grey' },
  ])
  assert.deepEqual(badgesOf(undefined), [])
})

test('ago', () => {
  assert.equal(ago(NOW - 10_000, NOW), 'just now')
  assert.equal(ago(NOW - 3 * 3600_000, NOW), '3 h')
  assert.equal(ago(NOW - 3 * 86400_000, NOW), '3 d')
  assert.equal(ago(NOW - 30 * 86400_000, NOW), '2026-10-09')
  assert.equal(ago(0, NOW), '')
})

test('banner: loading, signed out with the gh hint, error with its message, none when ok', () => {
  assert.equal(banner(null).kind, 'loading')
  assert.deepEqual(banner(state([], { state: 'signedOut', message: 'Run `gh auth login`' })), { kind: 'signedOut', text: 'Run `gh auth login`' })
  assert.deepEqual(banner(state([], { state: 'error', message: 'GitHub rate limit, back at 14:05' })), { kind: 'error', text: 'GitHub rate limit, back at 14:05' })
  assert.equal(banner(state([])), null)
  assert.deepEqual(lanesView(null, NOW, new Set()), [])
})
