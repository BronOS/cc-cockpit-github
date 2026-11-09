'use strict'
// Doc drift: every label and action id the code produces is in docs/item-convention.md (and the README's label list),
// so the convention other code-host plugins follow stays true.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LABELS } = require('../dist/lib/feed')

const root = path.join(__dirname, '..')
const doc = fs.readFileSync(path.join(root, 'docs/item-convention.md'), 'utf8')
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')

/** The fixed labels a source file pushes: string literals in `labels.push(...)` / `labels = [...]`. */
function labelsIn(file) {
  const src = fs.readFileSync(path.join(root, 'dist/lib', file), 'utf8')
  const out = new Set()
  for (const m of src.matchAll(/labels(?:\.push\(|\s*=\s*\[)([^)\]]*)/g)) for (const s of m[1].matchAll(/'([a-z:-]+)'/g)) out.add(s[1])
  for (const m of src.matchAll(/labels\.push\(([^)]*)\?\s*'([a-z:-]+)'\s*:\s*'([a-z:-]+)'/g)) {
    out.add(m[2])
    out.add(m[3])
  }
  return out
}

test('every fixed label in model.js and runs.js is in the convention and the README', () => {
  const labels = new Set([...labelsIn('model.js'), ...labelsIn('runs.js')])
  assert.ok(labels.size >= 12, [...labels].join(' '))
  for (const l of labels) {
    assert.ok(doc.includes(`\`${l}\``), `convention lacks ${l}`)
    assert.ok(readme.includes(`\`${l}\``), `README lacks ${l}`)
  }
  for (const prefix of ['repo:', 'owner:']) assert.ok(doc.includes(`\`${prefix}`))
})

test('every action id is in the convention', () => {
  for (const id of Object.keys(LABELS)) assert.ok(doc.includes(`\`${id}\``), `convention lacks action ${id}`)
})
