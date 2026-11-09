'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { normalize, isExcluded, parseGhPath } = require('../dist/lib/settings')

test('defaults for an empty or missing project', () => {
  for (const raw of [undefined, null, {}, 'x']) {
    assert.deepEqual(normalize(raw), {
      lanes: { reviewRequested: true, myPrs: true, issues: true, failedRuns: true },
      rowsPerLane: 10,
      markReadOnOpen: true,
      exclude: [],
      pollMinutes: 2,
      ghPath: 'gh',
      warnings: [],
    })
  }
})

test('lanes, numbers and the flag: kept when valid, clamped or defaulted otherwise', () => {
  const s = normalize({ lanes: { issues: false, failedRuns: 'no' }, rowsPerLane: 999, pollMinutes: 1, markReadOnOpen: false })
  assert.deepEqual(s.lanes, { reviewRequested: true, myPrs: true, issues: false, failedRuns: true })
  assert.equal(s.rowsPerLane, 300)
  assert.equal(s.pollMinutes, 2)
  assert.equal(s.markReadOnOpen, false)
  assert.equal(normalize({ pollMinutes: 99 }).pollMinutes, 15)
  assert.equal(normalize({ rowsPerLane: 2.5 }).rowsPerLane, 10)
})

test('exclude: owners and repos lower-cased and deduped, junk dropped with a warning', () => {
  const s = normalize({ exclude: ['Acme', ' acme/Widgets ', 'acme', 'a/b/c', '-bad', 'acme/..', '', 'globex/x.y_z', 42] })
  assert.deepEqual(s.exclude, ['acme', 'acme/widgets', 'globex/x.y_z'])
  assert.equal(s.warnings.length, 5)
  assert.match(s.warnings[0], /a\/b\/c/)
})

test('isExcluded: by owner or by exact repo, any case', () => {
  const s = normalize({ exclude: ['acme', 'globex/secret'] })
  assert.equal(isExcluded('ACME/widgets', s), true)
  assert.equal(isExcluded('globex/secret', s), true)
  assert.equal(isExcluded('globex/public', s), false)
  assert.equal(isExcluded('acmeco/x', s), false)
  assert.equal(isExcluded(undefined, s), false)
  assert.equal(isExcluded('acme/x', normalize({})), false)
})

test('ghPath: a bare name or an absolute path; anything else is gh with a warning', () => {
  assert.deepEqual(parseGhPath('gh'), { ghPath: 'gh' })
  assert.deepEqual(parseGhPath(''), { ghPath: 'gh' })
  assert.deepEqual(parseGhPath('/opt/homebrew/bin/gh'), { ghPath: '/opt/homebrew/bin/gh' })
  assert.deepEqual(parseGhPath(' gh-2 '), { ghPath: 'gh-2' })
  for (const bad of ['gh;rm -rf /', './gh', 'bin/gh', 'gh auth', '..', '/', 'gh\0x', 7]) {
    const r = parseGhPath(bad)
    assert.equal(r.ghPath, 'gh', JSON.stringify(bad))
    assert.ok(r.warning, JSON.stringify(bad))
  }
  assert.equal(normalize({ ghPath: './gh' }).warnings.length, 1)
})
