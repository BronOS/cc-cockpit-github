'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { queries, searchAll } = require('../dist/lib/search')
const { normalize } = require('../dist/lib/settings')

test('queries: only the enabled lanes; issues as two queries', () => {
  assert.deepEqual(
    queries(normalize({}).lanes).map((q) => q.key),
    ['reviewRequested', 'myPrs', 'assigned', 'mentioned']
  )
  assert.deepEqual(
    queries(normalize({ lanes: { reviewRequested: false, issues: false } }).lanes).map((q) => q.key),
    ['myPrs']
  )
  for (const q of queries(normalize({}).lanes)) assert.match(q.q, /^is:open is:(pr|issue) archived:false /)
})

function fakeClient(pages) {
  const calls = []
  return {
    calls,
    async graphql(query, vars) {
      calls.push(vars)
      const list = pages[vars.q] || []
      const i = vars.after ? Number(vars.after) : 0
      const page = list[i] || { nodes: [] }
      return { data: { search: { nodes: page.nodes, pageInfo: { hasNextPage: i + 1 < list.length, endCursor: String(i + 1) } } }, partialErrors: page.errors || [] }
    },
  }
}

test('searchAll: pages up to 2 per query, keeps only PRs and issues, gathers partial errors', async () => {
  const lanes = normalize({ lanes: { issues: false } }).lanes
  const [rr, mine] = queries(lanes)
  const c = fakeClient({
    [rr.q]: [{ nodes: [{ __typename: 'PullRequest', number: 1 }, { __typename: 'Commit' }, null] }, { nodes: [{ __typename: 'PullRequest', number: 2 }] }, { nodes: [{ __typename: 'PullRequest', number: 3 }] }],
    [mine.q]: [{ nodes: [], errors: ['SAML'] }],
  })
  const r = await searchAll(c, lanes)
  assert.deepEqual(r.results.reviewRequested.map((n) => n.number), [1, 2])
  assert.deepEqual(r.results.myPrs, [])
  assert.deepEqual(r.partialErrors, ['SAML'])
  assert.equal(c.calls.length, 3)
  assert.equal(c.calls[1].after, '1')
})

test('searchAll: a failing query rejects the whole poll', async () => {
  const c = { graphql: async () => Promise.reject(new Error('boom')) }
  await assert.rejects(searchAll(c, normalize({}).lanes), /boom/)
})
