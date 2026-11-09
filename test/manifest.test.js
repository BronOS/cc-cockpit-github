'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'))

test('manifest: id, entry points and the inbox-feed v2 it provides', () => {
  assert.equal(manifest.id, 'bronos.github')
  assert.equal(manifest.api, 1)
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.ok(fs.existsSync(path.join(root, manifest.main)))
  assert.deepEqual(manifest.services.provides, { 'inbox-feed': 2 })
  const panel = manifest.contributes.panels[0]
  assert.equal(panel.id, 'main')
  assert.ok(fs.existsSync(path.join(root, panel.icon)))
  assert.ok(manifest.description.length <= 600)
})

test('settings: defaults as the plan says, every field has a default', () => {
  const props = manifest.contributes.settings.project.properties
  assert.deepEqual(props.lanes.default, { reviewRequested: true, myPrs: true, issues: true, failedRuns: true })
  assert.equal(props.rowsPerLane.default, 10)
  assert.equal(props.markReadOnOpen.default, true)
  assert.deepEqual(props.exclude.default, [])
  assert.equal(props.pollMinutes.default, 2)
  assert.equal(props.pollMinutes.minimum, 2)
  assert.equal(props.pollMinutes.maximum, 15)
  assert.equal(props.ghPath.default, 'gh')
  for (const [k, v] of Object.entries(props)) assert.ok('default' in v, `${k} has a default`)
})

test('settings: no regex keyword and no secret field anywhere (the app refuses both or the plan rules them out)', () => {
  const walk = (node, at) => {
    if (!node || typeof node !== 'object') return
    for (const [k, v] of Object.entries(node)) {
      assert.ok(!['pattern', 'patternProperties'].includes(k), `regex keyword at ${at}.${k}`)
      assert.notEqual(v, 'secret', `secret format at ${at}.${k}`)
      walk(v, `${at}.${k}`)
    }
  }
  walk(manifest.contributes.settings, 'settings')
})
