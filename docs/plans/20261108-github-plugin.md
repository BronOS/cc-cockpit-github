# GitHub plugin (bronos.github) 0.1.0

External review: sol / high

## Overview

- A cc-cockpit plugin that brings the person's GitHub work into the app: PRs where their review is requested, events
  on their own open PRs, issues assigned to or mentioning them, and their failed CI runs.
- It is an Inbox source (`inbox-feed` v2) and also has its own GitHub panel (four lanes) and an item overlay (PR, issue,
  run) with Discuss with Claude.
- Signs in through the person's `gh` CLI login: no token is stored by the plugin.
- Light writes only: re-run failed jobs, and clear the matching GitHub notification on Mark read / Done. Reviews,
  comments and merges stay with the person (or with Claude through `gh` in a tab).
- Defines a shared item convention (`docs/item-convention.md`) that Oleg's Forgejo plugin follows too, so Inbox and
  Autopilot rules work across both hosts.

## Context (from discovery)

- Model plugin: `~/Projects/cc-cockpit-jira` (bronos.jira 0.7.3): plain JS, no build; `plugin.json`, `dist/host.js`,
  `dist/lib/*.js` (client, http, poll, feed, seen, store, settings, model, lanes), `panels/` (main + issue page),
  `test/*.test.js` with `test/fakes.js` and `test/fixtures`, `package.json` `"test": "node --test test/"`.
- Feed contract: `~/Projects/cc-cockpit-inbox/docs/design-v2.md`, sections "The feed contract", "The item",
  "The item in an overlay". Jira's `dist/lib/feed.js` is the closest implementation.
- App API (`ccc guide api`, `ccc guide style`): `ctx.exec(argv, { timeoutMs })` (argv only, login-shell PATH, no
  permission declaration), plain Node `fetch` in the host, `ctx.overlay.start/open` (`html` kind, `ready: 'manual'`,
  `type`, `onDiscuss`, at most 3 open and 10 a minute), `ctx.overlay.buttons(type, provider)`, `ctx.openExternal(url)`,
  `ctx.services` provide/emit, `ctx.panels.post/onMessage`, settings schema rules (no regexes; global default plus
  project override).
- Safe HTML: Jira builds HTML from ADF with an allow-list (`dist/lib/adfhtml.js`); here GitHub's REST `body_html`
  (overlay details only; the poll never fetches bodies) is untrusted and goes through an allow-list sanitiser in the
  overlay page (DOMParser, tags/attributes kept by list, http(s) links only, no remote images), written for this plugin
  and tested with hostile fixtures under a real HTML parser. The panel CSP (no inline script, no network,
  `ccc guide panels`) is the backstop, not the defence.
- Patterns reused from Jira: `trustedOpener` for overlay buttons (`dist/host.js` ~479-493), seen seeding on the first
  poll (`dist/lib/seen.js` ~66-73), a persisted last list so a restart's `snapshot()` is not empty (`dist/host.js`
  ~115-124), account-keyed seen state in `ctx.appStorage` (`loadSeen(site, accountId)`).

## Development Approach

- **testing approach**: Regular (code first, then tests in the same task)
- complete each task fully before moving to the next
- make small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for code changes in that task
  - tests are not optional - they are a required part of the checklist
  - write unit tests for new functions/methods
  - write unit tests for modified functions/methods
  - add new test cases for new code paths
  - update existing test cases if behavior changes
  - tests cover both success and error scenarios
- **CRITICAL: all tests must pass before starting next task** - no exceptions
- **CRITICAL: update this plan file when scope changes during implementation**
- run tests after each change (`npm test` in the plugin repo)
- public repo: no work data anywhere. Fixtures use made-up owners, repos and people (`acme/widgets`, `alice`, `bob`)

## Testing Strategy

- **unit tests**: `node:test`, required for every task. A fake `fetch` (records requests, answers from fixtures shaped
  like GitHub's REST and GraphQL replies), a fake `ctx` (exec, services, panels, overlay, openExternal, storage),
  a fake clock.
- **page logic**: the panel's and overlay's pure parts (row building, sanitiser, tab content) live in separate
  `.js` files testable under node with a small fake DOM, as Jira's `rowlogic.js` / reviewer `html-lines` tests do.
- **e2e**: the plugin has none; manual verification in the dev app (Post-Completion).

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix
- update plan if implementation deviates from original scope
- keep plan in sync with actual work done

## Solution Overview

- **Host** (`dist/host.js`) wires: settings → auth (gh token, login) → client (REST + GraphQL, rate limits) → poller
  (search every 2-15 min, runs every 5 min) → model (items per lane) → seen store (read/done) → feed (inbox-feed v2
  events) and panel (posted lanes). Item details for the overlay are fetched on open, never polled.
- **Data**: GraphQL `search` (type ISSUE, first 100) per lane query, each node with the fields the item needs, so one
  poll is about 4 GraphQL requests. Failed runs from REST `actions/runs` on a small repo set.
- **Read state** is local (seen revs in `ctx.appStorage` keyed by login, so every window agrees, like Jira's
  `seen.js`), seeded as read on the first poll; GitHub notification threads are cleared best-effort on Mark read / Done
  on GitHub.
- **Last list persisted** (`ctx.appStorage`, keyed by login): `snapshot()` after a restart answers the stored list with
  its old `asOf` (and `state: 'error'`, "Not refreshed yet" until the first poll succeeds), never an empty `ok`.
- **Security**: the token lives in host memory only and is sent only to `https://api.github.com` (never on a
  redirect); pages get plain data; all GitHub text is untrusted; links open only from the host's own list; the only
  exec is `[ghPath, 'auth', 'token', '--hostname', 'github.com']`.

## Technical Details

**Settings** (project, with global default): `lanes { reviewRequested, myPrs, issues, failedRuns }` (all true),
`rowsPerLane` (1-300, 10), `markReadOnOpen` (true), `exclude` (array of strings, `owner` or `owner/repo`, max 100,
each max 140, checked in code since schemas take no regex), `pollMinutes` (2-15, 2), `ghPath` (string, default `gh`;
accepted when it is a bare name of `[A-Za-z0-9._-]` or an absolute path with no NUL; anything else falls back to `gh`
with a logged warning).

**Lane queries** (GraphQL search, `archived:false`):
- reviewRequested: `is:open is:pr review-requested:@me`
- myPrs: `is:open is:pr author:@me`
- issues: `is:open is:issue assignee:@me` and `is:open is:issue mentions:@me` (merged by id; assignee wins for `to`)

PR node fields: number, title, url, isDraft, updatedAt, author.login, repository.nameWithOwner, headRefName,
baseRefName, reviewDecision, mergeable, reviewRequests(first 20){requestedReviewer{... on User{login} ... on Team{name}}},
latestReviews(last 5){author.login, state, submittedAt, body}, comments(last 3){author.login, createdAt, body},
commits(last 1){commit{oid, statusCheckRollup{state}}}. Issue node: number, title, url, createdAt, updatedAt, author,
repository, assignees(first 10).login, comments(last 3).

**Item** (per `docs/item-convention.md`):
- `id`: `pr:o/r#n`, `issue:o/r#n`, `run:o/r/<runId>`
- `rev`: not `updatedAt` (it moves on label and read-irrelevant edits), and never moved by the person's own actions:
  comments and reviews by `me` are left out, and the check part changes only on a move into failure (`ci:<sha>` of the
  newest failing head), so a push going PENDING → SUCCESS does not mark the PR unread and does not bring back an
  Inbox Done. PR: newest other-person comment time, newest other-person review time, newest failing head sha (a new
  review request is also a rev change for reviewRequested); issue: newest other-person comment time, else createdAt;
  run: run id. Built as a string such as `c:2026-11-08T10:00Z|s:abc123:FAILURE`
- `title`, `preview` (the newest event in words: "alice requested changes: …", "CI failed", "bob commented: …"),
  `time`, `from`, `to`, `mentionsMe` (newest comment contains `@<login>` as a word), `read`, `place`, `labels`, `actions`
- labels: `pr|issue|run`, `review-requested|team-review-requested|my-pr|assigned|mentioned`,
  `changes-requested|approved|ci:failed|ci:pending|conflict|draft`, `repo:o/r`, `owner:o`
- actions: `open`, `markRead|markUnread`, `done` (label "Done on GitHub": hides here until something new happens and
  marks the GitHub notification done; distinct from Inbox's own "Done (Inbox)"), `rerun` (run, and PR with `ci:failed`
  and a known failed run id), `openWeb`

**Failed runs**: repos = repos of open PRs (myPrs) ∪ `GET /user/repos?sort=pushed&per_page=20` filtered to pushed in
the last 7 days, capped at 10 total. Per repo `GET /repos/{o}/{r}/actions/runs?actor=<login>&status=failure&created=>=<7d>&per_page=10`
and, for supersession, `?actor=<login>&status=success&created=>=<7d>&per_page=20`. Per `workflow_id` + `head_branch`
only the newest failure is kept (one row per workflow and branch, not one per failed push); it is kept while no success
of the same pair was created after it, and it is younger than 7 days.

**Notifications**: on Mark read / Done on GitHub, `GET /repos/{o}/{r}/notifications?all=false&per_page=50` for the
item's repo (cached per repo for 60 s, following `Link: next` up to 5 pages), match by subject url (PR or issue API
url), then `PATCH /notifications/threads/{id}` (read) or `DELETE` (done). Failures logged only.

**Rate limits and errors**: 401 → re-run `gh auth token` once, retry; still 401 → state `signedOut`. 403/429 with
`x-ratelimit-remaining: 0` or `retry-after` → no requests until reset, keep last list, `sync` with `state: 'error'`,
message "GitHub rate limit, back at HH:MM". GraphQL answers its own rate limit as HTTP 200 with
`errors[].type: 'RATE_LIMITED'`: treated as the same block until `x-ratelimit-reset`. Other GraphQL `errors` with
`data` → keep data, log. Network error → `error`
state, exponential backoff capped at 15 min.

**Overlay details** (fetched on open): PR → REST `pulls/{n}` (body_html via `application/vnd.github.html+json`),
`issues/{n}/comments`, `pulls/{n}/reviews`, `commits/{sha}/check-runs`, failed jobs' logs
(`actions/jobs/{id}/logs` answers 302 to blob storage: fetched with `redirect: 'manual'`, the `Location` checked to be
https and then fetched **without** the token, tail read with `Range: bytes=-65536`; last 200 lines of the failed step), `pulls/{n}/files` (patches, 1 MB total
cap, then a link). Issue → `issues/{n}` (html) + comments. Run → `actions/runs/{id}`, `/jobs`, failed jobs' log tails;
Re-run → `POST actions/runs/{id}/rerun-failed-jobs`, at most once per run attempt (`run_attempt`) and refused while
the run is queued or in progress (any caller: panel, overlay or another plugin's `act`).

**Discuss text**: starts with the item title and URL; then state, the latest 5 comments/reviews (each cut at 600
characters), failed check names and log tails (each cut at 2000); total cut at 12000 characters (core caps further).
GitHub text is quoted as such ("Comment by alice:" blocks), never as instructions from the person.

## What Goes Where

- **Implementation Steps**: everything in the new repo `~/Projects/cc-cockpit-github`, plus one line in the Inbox's
  `inbox-source` skill (`~/Projects/cc-cockpit-inbox`).
- **Post-Completion**: public repo creation (Oleg), manual testing in the dev app, release, marketplace listing.

## Implementation Steps

### Task 1: Scaffold the plugin and test fakes [model: sonnet]

**Files:**
- Create: `plugin.json`, `package.json`, `LICENSE`, `.gitignore`, `icons/github.svg`
- Create: `dist/host.js` (skeleton: activate/deactivate, logs "started")
- Create: `test/fakes.js`, `test/fixtures/` (empty README stating fixtures are made up)
- Create: `test/manifest.test.js`

- [x] `plugin.json`: id `bronos.github`, version 0.1.0, api 1, main `dist/host.js`, panel `main` (right zone,
      `panels/main.html`), `services.provides { "inbox-feed": 2 }`, settings schema per Technical Details (no regex,
      no secret field), description saying it uses the `gh` login and what it writes
- [x] `package.json` (`"test": "node --test test/"`, private; the only devDependency comes in Task 11), MIT LICENSE (Oleg Bronzov), monochrome GitHub-like
      octocat-free icon (a generic branch/merge glyph, no GitHub logo)
- [x] `test/fakes.js`: fake ctx (exec, services emit/provide, panels post/onMessage, overlay start/buttons,
      openExternal, storage, log), fake fetch with route table and request log, fake clock
- [x] write tests: manifest is valid JSON with the required fields, settings defaults, no `pattern` keyword anywhere
- [x] run tests - must pass before next task

### Task 2: Settings normalisation [model: sonnet]

**Files:**
- Create: `dist/lib/settings.js`
- Create: `test/settings.test.js`

- [x] `normalize(raw)` → `{ lanes, rowsPerLane, markReadOnOpen, exclude, pollMinutes, ghPath }` with clamping and defaults
- [x] `exclude` parsing: `owner` or `owner/repo`, lower-cased, invalid entries dropped and reported
- [x] `ghPath` check: bare name `[A-Za-z0-9._-]+` or absolute path; otherwise `gh` plus a warning
- [x] `isExcluded(nameWithOwner, settings)`
- [x] write tests for defaults, clamps, exclude parsing, ghPath accept/refuse (`gh;rm`, relative `./gh`, `/opt/gh`)
- [x] run tests - must pass before next task

### Task 3: Sign-in through gh [model: opus]

**Files:**
- Create: `dist/lib/auth.js`
- Create: `test/auth.test.js`

- [x] `createAuth({ exec, fetch, ghPath, log })`: `token()` runs `[ghPath, 'auth', 'token', '--hostname', 'github.com']`
      (10 s; the fixed host keeps a `GH_HOST` / Enterprise token from ever being sent to api.github.com), trims, checks the
      shape (printable, no whitespace, ≤ 255), keeps it in a closure; `login()` via `GET /user`
- [x] `refresh()` re-runs gh once per 401 burst (concurrent callers share one promise)
- [x] states: `ok`, `signedOut` (no gh: ENOENT / non-zero exit / empty output; or 401 after refresh) with the message
      "Run `gh auth login` in a terminal, then Refresh", never the token or gh's stderr verbatim in messages
- [x] the token is never logged, posted, emitted or put in an error message (a test greps every recorded log/post/emit)
- [x] write tests: success, argv exactly as above, gh missing, gh exits 1, empty token, 401 then refresh ok, 401 twice →
      signedOut, token leak check
- [x] run tests - must pass before next task

### Task 4: GitHub client: REST, GraphQL, rate limits [model: opus]

**Files:**
- Create: `dist/lib/client.js`
- Create: `test/client.test.js`

- [x] `createClient({ fetch, auth, now, log })`: `rest(method, path, { query, accept, body })` and `graphql(query, vars)`;
      base `https://api.github.com` only (a path is checked to start with `/` and contain no `//` or scheme), headers
      `Authorization: Bearer`, `Accept`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: cc-cockpit-github`
- [x] 401 → `auth.refresh()` and one retry; rate limit (403/429 with `x-ratelimit-remaining: 0` or `retry-after`) →
      `blockedUntil`, later calls reject at once with a `RateLimited` error carrying the time
- [x] GraphQL: `errors[].type === 'RATE_LIMITED'` (HTTP 200) → same block as a REST rate limit; other `errors` with
      `data` → return data plus `partialErrors`; `errors` without data → reject
- [x] `restRedirect(path)`: `redirect: 'manual'`, returns the `Location` only when it is an absolute https URL; `fetchBlob(url,
      { tailBytes })` fetches it with no `Authorization` header and a `Range: bytes=-N` (a 200 without range support is read
      to the end with only the last N bytes kept)
- [x] response size caps (text read with a byte limit: 5 MB JSON, 64 KB per log, 1 MB diff total enforced by caller)
- [x] timeouts with AbortController (20 s), network errors → `NetworkError`
- [x] write tests for each path: headers, base url refusal, 401 retry, rate limit block and release, GraphQL
      `RATE_LIMITED` in a 200, GraphQL partial, timeout, redirect: http Location refused, the token is not sent to the
      blob URL, Range tail
- [x] run tests - must pass before next task

### Task 5: Search queries and the item model [model: opus]

**Files:**
- Create: `dist/lib/search.js` (GraphQL query text per lane, pagination to 100)
- Create: `dist/lib/model.js` (nodes → items per the convention)
- Create: `test/fixtures/search-*.json`, `test/model.test.js`, `test/search.test.js`

- [x] query builder per lane (only enabled lanes), `archived:false`, results mapped by lane; issues assignee+mentions merged
- [x] `prItem(node, lane, me)`, `issueItem(node, lanes, me)`: id, rev, title, preview, time, from, to, mentionsMe,
      place (status: draft / conflict / failing / changes requested / approved / open, in that priority), labels, actions
- [x] team review request → `to: 'group'`, `team-review-requested`; own review request → `direct`
- [x] `rev` per Technical Details: the person's own comments/reviews left out, the check part moves only into failure
- [x] excluded owners/repos dropped; a PR in both reviewRequested and myPrs cannot happen (author vs reviewer) but ids are deduped anyway
- [x] all strings capped to the feed's limits (title 300, preview 1000, place 120, labels 40)
- [x] write tests per field with fixtures: draft PR, CI failure, changes requested, conflict, team request, mention detection
      (`@alice` vs `@alicex` vs email), issue in both queries, long title cut; rev unchanged by my own comment, my own
      review and a PENDING → SUCCESS push, changed by another person's comment and by a new failure
- [x] run tests - must pass before next task

### Task 6: Failed-run discovery [model: sonnet]

**Files:**
- Create: `dist/lib/runs.js`
- Create: `test/runs.test.js`, `test/fixtures/runs-*.json`

- [x] `repoSet(myPrRepos, pushedRepos, now)`: union, pushed within 7 days, excluded dropped, max 10
- [x] `failedRuns(client, repos, login, now)`: per repo failure and success lists, newest failure per workflow_id +
      head_branch only, supersession by a later success of the same pair, 7-day age limit; one repo's error does not
      drop the others (logged)
- [x] `runItem(run, me)`: id `run:o/r/<id>`, title `o/r CI failed: <workflow> on <branch>`, labels `run`, `ci:failed`,
      `repo:`, `owner:`, actions incl. `rerun`
- [x] link failed runs to PRs: a myPrs PR with `ci:failed` gets the run id of its head SHA (for `rerun` on the PR)
- [x] write tests: dedupe (three failures of one workflow+branch → one item, the newest), supersession, age cut, repo
      cap, per-repo error isolation, PR linking
- [x] run tests - must pass before next task

### Task 7: Read state, done and notification threads [model: sonnet]

**Files:**
- Create: `dist/lib/seen.js`
- Create: `dist/lib/notifications.js`
- Create: `test/seen.test.js`, `test/notifications.test.js`

- [x] `seen.js`: per item id the read rev and the done rev in `ctx.appStorage` under a key per login (account-wide, so
      every window agrees; main serialises the writes), pruned to known ids plus 30 days; `read(item)`, `markRead`,
      `markUnread`, `done` (hidden while rev equals done rev); seeded on the first poll for a login: every current item
      is recorded as read, so a fresh install does not start with everything unread (as Jira's `seen.js` does)
- [x] `notifications.js`: thread lookup by subject API url through the item repo's notifications (60 s cache per repo,
      up to 5 pages), `markThreadRead`, `markThreadDone`; only ids from the fetched list; errors logged, never thrown
- [x] write tests: first-poll seeding, unread on rev change, done hides until a new rev, prune, appStorage key per
      login (a second login starts seeded, not mixed), thread matching across pages, failure isolation
- [x] run tests - must pass before next task

### Task 8: inbox-feed v2 provider [model: sonnet]

**Files:**
- Create: `dist/lib/feed.js`
- Create: `test/feed.test.js`

- [ ] `describe()` → label `GitHub`, badge `GH`, color `violet`, kind `issues`, scope from settings ("Review requests,
      your PRs, issues, failed runs; excludes 2 owners")
- [ ] `features()` → `[]`; `snapshot()` from the cache, which is loaded from `ctx.appStorage` at start (the last list
      and its `asOf`, keyed by login) and answered as `state: 'error'`, "Not refreshed yet" until the first poll
      succeeds; `sync` with `state`/`message`/`asOf`; the list is persisted after each successful poll
- [ ] item/gone diff per poll (any field change → `item`; missing id → `gone` in chunks of 500); done items count as gone
- [ ] `act(id, action)`: id must be a current item and action in its actions; runs markRead/markUnread/done/openWeb
      itself and `open` / `rerun` through injected callbacks (`onOpen`, `onRerun`, wired in Tasks 10-11; stubs in tests),
      the same functions the panel and overlay use; returns `{ ok, message }` (≤ 300)
- [ ] write tests modelled on Jira's `feed.test.js`: diff, chunking, refusal of unknown id/action, signedOut/error sync,
      snapshot after a restart answers the stored list (not empty `ok`), callbacks called for open/rerun
- [ ] run tests - must pass before next task

### Task 9: Poller and host wiring [model: opus]

**Files:**
- Create: `dist/lib/poll.js`
- Modify: `dist/host.js`
- Create: `test/poll.test.js`, `test/host.test.js`

- [ ] poller: search every `pollMinutes`, runs every 5 min, refresh on demand (panel button, coalesced), stops on deactivate;
      lanes off → not queried and not fed; backoff on network error (×2, max 15 min) and on rate limit (until reset)
- [ ] host: settings change → re-normalise, re-poll; state for panel (`login`, `asOf`, lanes, state, message)
- [ ] provide `inbox-feed` (Task 8) and post lane data to the panel; panel messages: `refresh`, `open`, `act`
- [ ] write tests: schedule with fake clock, lane switch off emits gone, rate limit pauses both loops, deactivate clears timers
- [ ] run tests - must pass before next task

### Task 10: Item details, log tails and re-run [model: opus]

**Files:**
- Create: `dist/lib/details.js`, `dist/lib/logs.js`
- Create: `test/details.test.js`, `test/logs.test.js`

- [ ] `prDetails`, `issueDetails`, `runDetails` per Technical Details; plain data for the page (html bodies passed as
      untrusted strings for the page's sanitiser)
- [ ] `logs.js`: job log through `client.restRedirect` + `fetchBlob` (token never sent to blob storage), tail of 64 KB;
      last 200 lines of the failed step (step boundaries by `##[group]` markers; fallback the tail's last 200 lines),
      ANSI escapes stripped
- [ ] diff cap: per-file patches until 1 MB total, the rest listed with "too large, open on GitHub"
- [ ] `rerun(item)`: run id must come from the current item; refused while the run is queued or in progress and when
      this `run_attempt` was already re-run by us (kept in memory); `POST rerun-failed-jobs`; on success re-poll runs
- [ ] `discussText(details)`: per Technical Details, with caps; tests check caps and that no token or header text appears
- [ ] write tests for each, including a log without group markers, a 2 MB diff, rerun refused for an unknown id, a
      second rerun of the same attempt, and a run in progress
- [ ] run tests - must pass before next task

### Task 11: Item overlay page [model: opus]

**Files:**
- Create: `panels/item.html`, `panels/item.js`, `panels/sanitize.js`, `panels/itemview.js`
- Modify: `dist/host.js` (open overlay, `ctx.overlay.buttons('inbox-item', ...)`, `onDiscuss`)
- Create: `test/sanitize.test.js`, `test/itemview.test.js`

- [ ] host opens `html` overlay `panels/item.html` with `type: { name: 'inbox-item', data: { source: 'bronos.github', id } }`,
      `ready: 'manual'`, size `large`; posts details when fetched; markRead on open when the setting is on; a refused open
      (3 open, 10 a minute) is reported to the caller (`act` → `{ ok: false, message }`, panel → its message line)
- [ ] `sanitize.js`: DOMParser allow-list (tags as the reviewer's list, attributes `href` on `a` only when http(s), no
      `img src` remote: replaced by a link, no style/class/id/on*), tested under a real HTML parser (a dev-only DOM library
      in `devDependencies`, e.g. linkedom or happy-dom; the plugin itself ships no dependency) with hostile fixtures
      (script, svg onload, javascript: link, `<img src=x onerror>`, nested forms, data: urls, mXSS-style nesting)
- [ ] `itemview.js`: PR tabs Conversation / Checks / Files, issue view, run view; logs and diffs as text in `<pre>`
- [ ] links: the host extracts the http(s) hrefs from the HTML it posts (and the item/check/run URLs it built) into a
      per-overlay set; the page sends only an index or the href back, and the host opens it with `ctx.openExternal` only
      when it is in that set (never a URL from the page as is), after the page's in-page confirm
- [ ] overlay buttons for the item's current actions (not `open`) only when `info.opener` is trusted (this plugin, as
      Jira's `trustedOpener`), `data.source` is ours and the id is current; `run` calls the same code as `act`
- [ ] style per `ccc guide style` (component classes, theme tokens; no own colours)
- [ ] write tests: sanitiser cases, view builders produce expected structure for PR/issue/run fixtures, buttons provider
      answers only for a trusted opener and our own current ids, link opening refused for a URL not in the host's set,
      overlay refusal reported
- [ ] run tests - must pass before next task

### Task 12: GitHub panel [model: sonnet]

**Files:**
- Create: `panels/main.html`, `panels/main.js`, `panels/rowlogic.js`
- Create: `test/rowlogic.test.js`

- [ ] lanes Review requested, My PRs, Issues, Failed runs (only enabled ones), `rowsPerLane` rows + Show all / Hide
- [ ] row: unread dot, title, meta (`repo · who did what · when`), state chips; click → open; right-click / context-menu key
      → actions menu (component menu classes)
- [ ] header via `ctx.panels.header` if available: login, "updated N min ago", a refresh action handled with
      `ctx.panels.onAction`; signed-out and error states with the message
- [ ] handshake: the page posts `hello` on load and the host answers with the full state (`ctx.panels.post` drops messages
      sent before the page is there)
- [ ] style per `ccc guide style`
- [ ] write tests for row building (chips, meta text, unread), lane folding, empty and signed-out states, state sent on
      `hello`, refresh through `onAction`
- [ ] run tests - must pass before next task

### Task 13: Item convention doc, README and the Inbox skill line [model: sonnet]

**Files:**
- Create: `docs/item-convention.md`, `README.md`, `preview.png` (logo card per the marketplace preview recipe)
- (The Inbox skill line is a change in another repo: Post-Completion)

- [ ] `docs/item-convention.md`: ids, title, preview, from/time/to, mentionsMe, place + statuses, labels, actions, overlay
      type, default rule hints; written host-neutral (GitHub and Forgejo examples)
- [ ] README: what it shows, `gh auth login` requirement, what it writes, settings, labels and rule examples for Inbox
      (`review-requested` → Now, `ci:failed` + `my-pr` → Now, `mentioned` / `team-review-requested` → Later), privacy (token
      in memory only)
- [ ] test: a doc-drift test checks every label and action id used in `model.js` / `runs.js` is listed in the convention
- [ ] run tests - must pass before next task

### Task 14: Verify acceptance criteria [model: sonnet]

- [ ] verify all requirements from Overview are implemented
- [ ] verify edge cases are handled (signed out, rate limit, empty lanes, excluded repos, huge diff/log)
- [ ] run full test suite: `npm test`
- [ ] grep the repo for any work data (employer names, real private repos, emails other than the author's)
- [ ] verify the token never appears in logs/posts/emits (test from Task 3 still green)

### Task 15: [Final] Update documentation [model: sonnet]

- [ ] update README.md if needed
- [ ] add a short CLAUDE.md for the repo (layout, test command, the convention doc is shared with Forgejo)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

**Manual verification**:
- link the plugin in the dev app (`ccc plugin link`), sign in through `gh`, check the four lanes against github.com
- open a PR, an issue and a failed run in the overlay; Discuss with Claude; Re-run failed jobs on a throwaway run
- Inbox: items arrive under GitHub, rules on `review-requested` and `ci:failed` work; Mark read clears the github.com bell

**External system updates**:
- Oleg creates the public repo `BronOS/cc-cockpit-github` and pushes
- release 0.1.0 (tag), marketplace listing PR (a new listing needs Oleg's merge)
- the Forgejo plugin adopts `docs/item-convention.md`
- Inbox repo (`~/Projects/cc-cockpit-inbox`): one line in the `inbox-source` skill pointing at
  `docs/item-convention.md`, its own commit and the next Inbox patch release
