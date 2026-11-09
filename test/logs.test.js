'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { failedStepTail, clean, MAX_LINES } = require('../dist/lib/logs')

const stamp = (s) => `2026-11-08T10:00:00.1234567Z ${s}`

test('clean: timestamps, colour codes and control characters out; tabs kept', () => {
  assert.equal(clean(stamp('\x1b[31mFAIL\x1b[0m\ttest/a.js')), 'FAIL\ttest/a.js')
  assert.equal(clean('\x1b]8;;https://x\x07link\x1b]8;;\x07 \x07bell'), 'link bell')
})

test('the failed step: from its ##[group] to the last ##[error]', () => {
  const log = [
    stamp('##[group]Run actions/checkout'),
    stamp('checked out'),
    stamp('##[endgroup]'),
    stamp('##[group]Run npm test'),
    stamp('> jest'),
    stamp('FAIL src/a.test.js'),
    stamp('##[endgroup]'),
    stamp('##[error]Process completed with exit code 1.'),
    stamp('##[group]Post job cleanup'),
    stamp('cleanup'),
    '',
  ].join('\n')
  assert.deepEqual(failedStepTail(log).text.split('\n'), ['##[group]Run npm test', '> jest', 'FAIL src/a.test.js', '##[endgroup]', '##[error]Process completed with exit code 1.'])
})

test('no ##[error]: the last 200 lines; a long step is cut to its last 200 lines', () => {
  const lines = Array.from({ length: 500 }, (_, i) => stamp(`line ${i}`))
  const r = failedStepTail(lines.join('\n'))
  assert.equal(r.lines, MAX_LINES)
  assert.equal(r.text.split('\n')[0], 'line 300')
  const step = [stamp('##[group]Run build'), ...lines, stamp('##[error]boom')].join('\n')
  const s = failedStepTail(step)
  assert.equal(s.lines, MAX_LINES)
  assert.ok(s.text.endsWith('##[error]boom'))
})

test('a range read drops its first, possibly cut, line', () => {
  assert.equal(failedStepTail('tial line\nfull line\nlast', { partial: true }).text, 'full line\nlast')
  assert.equal(failedStepTail('only', { partial: true }).text, 'only')
  assert.equal(failedStepTail('').text, '')
})
