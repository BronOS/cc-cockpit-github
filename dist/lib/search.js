'use strict'
// The lane queries: one GraphQL search per lane query, each node carrying every field the item needs, so a poll is
// a handful of requests and never one per PR. `review-requested:@me` also matches a review asked of a team the
// person is on; the node's reviewRequests tell the two apart (model.js).

const PR_FIELDS = `
  id number title url isDraft createdAt updatedAt
  author { login }
  repository { nameWithOwner }
  headRefName baseRefName reviewDecision mergeable
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name slug } } } }
  latestReviews(last: 10) { nodes { author { login } state submittedAt bodyText } }
  comments(last: 5) { nodes { author { login } createdAt bodyText } }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }`

const ISSUE_FIELDS = `
  id number title url createdAt updatedAt
  author { login }
  repository { nameWithOwner }
  assignees(first: 10) { nodes { login } }
  comments(last: 5) { nodes { author { login } createdAt bodyText } }`

const SEARCH = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { __typename ... on PullRequest { ${PR_FIELDS} } ... on Issue { ${ISSUE_FIELDS} } }
  }
}`

const PAGES = 2 // 100 results per query: more is not a list a person works through

/** The queries for the enabled lanes: `[{ lane, key, q }]` (`key` tells the two issue queries apart). */
function queries(lanes) {
  const out = []
  if (lanes.reviewRequested) out.push({ lane: 'reviewRequested', key: 'reviewRequested', q: 'is:open is:pr archived:false review-requested:@me' })
  if (lanes.myPrs) out.push({ lane: 'myPrs', key: 'myPrs', q: 'is:open is:pr archived:false author:@me' })
  if (lanes.issues) {
    out.push({ lane: 'issues', key: 'assigned', q: 'is:open is:issue archived:false assignee:@me' })
    out.push({ lane: 'issues', key: 'mentioned', q: 'is:open is:issue archived:false mentions:@me' })
  }
  return out
}

/**
 * Run every enabled lane's search. `{ results: { [key]: node[] }, partialErrors }`. A failing query rejects the
 * whole poll (the caller keeps its last list): half a list would read as items gone.
 */
async function searchAll(client, lanes) {
  const results = {}
  const partialErrors = []
  for (const { key, q } of queries(lanes)) {
    const nodes = []
    let after = null
    for (let page = 0; page < PAGES; page++) {
      const { data, partialErrors: pe } = await client.graphql(SEARCH, { q, after })
      partialErrors.push(...pe)
      const s = data && data.search
      if (!s || !Array.isArray(s.nodes)) break
      for (const n of s.nodes) if (n && (n.__typename === 'PullRequest' || n.__typename === 'Issue')) nodes.push(n)
      if (!s.pageInfo || !s.pageInfo.hasNextPage || !s.pageInfo.endCursor) break
      after = s.pageInfo.endCursor
    }
    results[key] = nodes
  }
  return { results, partialErrors }
}

module.exports = { queries, searchAll, SEARCH }
