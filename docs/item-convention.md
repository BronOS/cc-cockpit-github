# Code-host item convention

How a code-host plugin (GitHub, Forgejo, Gitea, GitLab...) shapes its `inbox-feed` v2 items, so the person's Inbox and
Autopilot rules work the same whichever host an item comes from. The feed contract itself (fields, caps, events) is
the Inbox's: `cc-cockpit-inbox/docs/design-v2.md`, "The feed contract" and "The item". This page only fixes the
values. `bronos.github` and `bronos.gitea` (Gitea and Forgejo, [cc-cockpit-gitea](https://github.com/BronOS/cc-cockpit-gitea))
follow it; on Gitea and Forgejo a failed run's `<runId>` is the run's number in its repo (`run_number`).

## What is an item

| Kind | When it is the person's business | Gone when |
|---|---|---|
| Pull request | their review is asked (directly or through a team), or they opened it | closed or merged; the review request withdrawn |
| Issue | assigned to them, or it mentions them | closed |
| Failed run | a CI run they started failed (newest per workflow and branch) | a later run of the same workflow on the same branch passed, or 7 days |

## Ids

| Kind | `id` | Example |
|---|---|---|
| Pull request | `pr:<owner>/<repo>#<number>` | `pr:acme/widgets#12` |
| Issue | `issue:<owner>/<repo>#<number>` | `issue:acme/widgets#5` |
| Failed run | `run:<owner>/<repo>/<runId>` | `run:acme/widgets/4711` |

Ids are relative to the host: Inbox keeps each source's items apart by plugin id, so a GitHub and a Forgejo
`pr:acme/widgets#12` never clash.

## Fields

- `title`: `<owner>/<repo>#<number> <title>`; a run: `<owner>/<repo> CI failed: <workflow> on <branch>`.
- `preview`: the newest thing someone else did, in words: `alice requested changes: Please add a test`,
  `bob commented: …`, `carol approved`; nothing yet: `carol asked for your review` / `Opened by bob`; a failing own PR
  starts with `CI failed · `; a run: `Run #5 failed (push) · <commit title>`.
- `from`: who did that newest thing (else the author). `time`: when (else when it was opened).
- `to`: `direct` (a review asked of the person, or assigned to them), `group` (a review asked of a team they are on),
  `cc` (only mentioned). Absent on the person's own PRs and runs.
- `mentionsMe`: the newest comment or review @-mentions the person (a whole `@login`).
- `rev`: changes only when someone else did something: their comment or review, or a head going into failure (a new
  failing commit, a new run attempt). The person's own comments, reviews and green pushes never change it, so they
  never make their own item unread again.
- `place`: `{ kind: 'project', name: '<owner>/<repo>', status }`, `status` the most pressing of
  `draft`, `conflict`, `failing`, `changes requested`, `approved`, `open` (a run: `failing`).

## Labels

Rules match labels case-insensitively. A source sets every one that applies.

| Label | Meaning |
|---|---|
| `pr`, `issue`, `run` | the kind |
| `review-requested` | a review asked of the person directly |
| `team-review-requested` | a review asked of a team the person is on |
| `my-pr` | the person opened the PR |
| `assigned` | the issue is assigned to the person |
| `mentioned` | the issue mentions the person |
| `changes-requested` | the PR's review decision asks for changes |
| `approved` | the PR is approved |
| `ci:failed` | the head commit's checks failed (always on a run) |
| `ci:pending` | the head commit's checks are still running |
| `conflict` | the PR cannot merge cleanly |
| `draft` | the PR is a draft |
| `repo:<owner>/<repo>` | the repository, lower case (left out when longer than 40 characters, the feed's label cap) |
| `owner:<owner>` | the owner (user or organisation), lower case |

## Actions

| id | Label | On | Does |
|---|---|---|---|
| `open` | Open | every item | the item's overlay (the row click) |
| `markRead` / `markUnread` | Mark read / Mark unread | every item | the source's read mark; Mark read also marks the host's notification read |
| `done` | Done on GitHub (the host's name) | every item | hides it until something new happens, and marks the host's notification done; not Inbox's own "Done (Inbox)" |
| `rerun` | Re-run failed jobs | a run, and an own PR whose head run failed | re-runs the failed jobs once per attempt, never while the run is going |
| `openWeb` | Open on GitHub (the host's name) | every item | the item's page in the system browser |

## Overlay

The item opens in an overlay typed `inbox-item { source: <plugin id>, id }`, with the source's toolbar buttons for the
item's actions (not `open`) on overlays the source itself opened.

## Rule hints

A starting point for the person's Inbox rules (Inbox rule format, `cc-cockpit-inbox/docs/design-v2.md` "Rules"; set
them with `ccc inbox rules` or its `inbox-rules` skill). `now` and `later` stand for the person's own group ids.

| Group | Conditions (all must hold) |
|---|---|
| now | `labels has review-requested` |
| now | `labels has my-pr`, `labels has ci:failed` |
| now | `labels has my-pr`, `labels has changes-requested` |
| later | `labels has team-review-requested` |
| later | `labels has mentioned` |

As rules:

```json
[
  { "id": "gh-review", "enabled": true, "group": "now", "when": [{ "field": "labels", "op": "has", "value": "review-requested" }] },
  { "id": "gh-ci", "enabled": true, "group": "now", "when": [{ "field": "labels", "op": "has", "value": "my-pr" }, { "field": "labels", "op": "has", "value": "ci:failed" }] },
  { "id": "gh-changes", "enabled": true, "group": "now", "when": [{ "field": "labels", "op": "has", "value": "my-pr" }, { "field": "labels", "op": "has", "value": "changes-requested" }] },
  { "id": "gh-team", "enabled": true, "group": "later", "when": [{ "field": "labels", "op": "has", "value": "team-review-requested" }] },
  { "id": "gh-mention", "enabled": true, "group": "later", "when": [{ "field": "labels", "op": "has", "value": "mentioned" }] }
]
```

To limit a rule to one host, add `{ "field": "source", "op": "is", "value": "bronos.github" }`.
