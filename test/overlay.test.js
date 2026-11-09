'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createOverlays, linksOf, hrefsIn } = require('../dist/lib/overlay')
const { fakeCtx } = require('./fakes')

const item = { id: 'pr:acme/widgets#12', title: 'acme/widgets#12 Fix login', read: false, labels: ['pr'], _: { kind: 'pr', url: 'https://github.com/acme/widgets/pull/12' } }
const details = {
  kind: 'pr',
  title: item.title,
  url: 'https://github.com/acme/widgets/pull/12',
  header: { repo: 'acme/widgets', state: 'open', head: 'fix', base: 'main', author: 'me' },
  body: '<p>See <a href="https://github.com/acme/widgets/issues/5">#5</a> and <a href="javascript:x">y</a> <img src="https://img.example/a.png?x=1&amp;y=2"></p>',
  timeline: [{ kind: 'comment', who: 'bob', html: '<a href="https://example.com/doc">doc</a>' }],
  checks: [{ name: 'test', failed: true, url: 'https://github.com/acme/widgets/runs/1' }],
}

const flush = () => new Promise((r) => setImmediate(r))

function setup(opts = {}) {
  const ctx = fakeCtx(opts)
  const acted = []
  const opened = []
  const o = createOverlays({
    ctx,
    getItem: (id) => (id === item.id ? item : null),
    fetchDetails: opts.fetchDetails || (async () => details),
    onOpened: async (i) => opened.push(i.id),
    act: async (id, a) => (acted.push([id, a]), opts.actResult || { ok: true }),
    log: ctx.log,
  })
  return { ctx, o, acted, opened }
}

test('opens typed inbox-item at once with the loader, then posts the details', async () => {
  const { ctx, o, opened } = setup()
  const r = await o.open(item)
  assert.deepEqual(r, { ok: true })
  const spec = ctx.overlays[0].spec
  assert.equal(spec.kind, 'html')
  assert.equal(spec.file, 'panels/item.html')
  assert.equal(spec.ready, 'manual')
  assert.deepEqual(spec.type, { name: 'inbox-item', data: { source: 'bronos.github', id: item.id } })
  await flush()
  assert.deepEqual(ctx.overlays[0].posts, [{ type: 'details', details }])
  assert.deepEqual(opened, [item.id])
})

test('a refused open (3 open, 10 a minute) comes back as a message', async () => {
  const { o } = setup({ overlayRefuse: 'too many overlays open' })
  assert.deepEqual(await o.open(item), { ok: false, message: 'Cannot open the item: too many overlays open' })
})

test('a failed fetch shows an error the page can retry', async () => {
  let n = 0
  const { ctx, o } = setup({ fetchDetails: async () => (n++ ? details : Promise.reject(new Error('GitHub answered 502'))) })
  await o.open(item)
  await flush()
  assert.deepEqual(ctx.overlays[0].posts, [{ type: 'error', message: 'GitHub answered 502' }])
  await ctx.overlays[0].send({ type: 'retry' })
  await flush()
  assert.equal(ctx.overlays[0].posts[1].type, 'details')
})

test('links: only what the host found in the details opens; anything else is refused and logged', async () => {
  const { ctx, o } = setup()
  await o.open(item)
  await flush()
  const ov = ctx.overlays[0]
  await ov.send({ open: 'https://github.com/acme/widgets/issues/5' })
  await ov.send({ open: 'https://img.example/a.png?x=1&y=2' })
  await ov.send({ open: 'https://github.com/acme/widgets/runs/1' })
  await ov.send({ open: 'https://evil.example/phish' })
  await ov.send({ open: 'javascript:alert(1)' })
  assert.deepEqual(ctx.externals, ['https://github.com/acme/widgets/issues/5', 'https://img.example/a.png?x=1&y=2', 'https://github.com/acme/widgets/runs/1'])
  assert.ok(ctx.logs.some(([, m]) => /not in the item; refused/.test(m)))
})

test('Discuss: the details text once loaded, the title and URL before', async () => {
  const { ctx, o } = setup({ fetchDetails: () => new Promise(() => {}) })
  await o.open(item)
  assert.deepEqual(ctx.overlays[0].discuss(), { text: 'acme/widgets#12 Fix login\nURL: https://github.com/acme/widgets/pull/12' })
  const done = setup()
  await done.o.open(item)
  await flush()
  assert.match(done.ctx.overlays[0].discuss().text, /^acme\/widgets#12 Fix login\nURL: https:\/\/github.com\/acme\/widgets\/pull\/12\nPull request/)
})

test('buttons: only on overlays we opened, for our own current items; run goes through act; Done closes', async () => {
  const { ctx, o, acted } = setup()
  o.register()
  const provider = ctx.buttonProviders[0].provider
  assert.equal(ctx.buttonProviders[0].name, 'inbox-item')
  const info = (over) => ({ type: { name: 'inbox-item', data: { source: 'bronos.github', id: item.id } }, opener: 'bronos.github', ...over })
  assert.deepEqual(provider(info({ opener: 'evil.plugin' })), [])
  assert.deepEqual(provider(info({ type: { name: 'inbox-item', data: { source: 'bronos.jira', id: item.id } } })), [])
  assert.deepEqual(provider(info({ type: { name: 'inbox-item', data: { source: 'bronos.github', id: 'pr:acme/gone#1' } } })), [])
  assert.deepEqual(provider(null), [])
  const buttons = provider(info())
  assert.deepEqual(buttons.map((b) => b.id), ['markRead', 'done', 'openWeb'])
  assert.equal(await buttons[0].run(), undefined)
  assert.deepEqual(await buttons[1].run(), { close: true })
  assert.deepEqual(acted, [[item.id, 'markRead'], [item.id, 'done']])
})

test('buttons: a refused action shows its message (the app shows a throw)', async () => {
  const { ctx, o } = setup({ actResult: { ok: false, message: 'The run is still going.' } })
  o.register()
  const [b] = ctx.buttonProviders[0].provider({ type: { name: 'inbox-item', data: { source: 'bronos.github', id: item.id } }, opener: 'bronos.github' })
  await assert.rejects(b.run(), /still going/)
})

test('hrefsIn and linksOf: http(s) only, entities decoded', () => {
  assert.deepEqual(hrefsIn('<a href="https://a.example/?a=1&amp;b=2">x</a><a href="javascript:x">y</a><img src="http://b.example/i.png">'), ['https://a.example/?a=1&b=2', 'http://b.example/i.png'])
  const l = linksOf(details)
  assert.ok(l.has('https://github.com/acme/widgets/pull/12'))
  assert.ok(l.has('https://example.com/doc'))
  assert.ok(!l.has('javascript:x'))
})
