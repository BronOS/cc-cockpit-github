'use strict'
// The end of a failed job's log: what a person (or Claude) needs to see why it failed. GitHub serves a job's log
// through a redirect to blob storage (client.restRedirect + fetchBlob, the token never sent there); only the last
// 64 KB is read. From that, the failed step is the `##[group]` section holding the last `##[error]`, and at most its
// last 200 lines are kept, timestamps and terminal colour codes stripped.

const TAIL_BYTES = 64 * 1024
const MAX_LINES = 200

// GitHub prefixes each line with an ISO timestamp.
const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/
// CSI and OSC escape sequences, then any other control character but tab.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

function clean(line) {
  return line.replace(STAMP, '').replace(ANSI, '').replace(CONTROL, '')
}

/**
 * `{ text, lines }` of the failed step's tail. `partial`: the text starts mid-log (a range read), so its first line
 * may be cut and is dropped.
 */
function failedStepTail(raw, { partial = false } = {}) {
  let lines = String(raw || '').split(/\r?\n/)
  if (partial && lines.length > 1) lines = lines.slice(1)
  lines = lines.map(clean)
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  let lastError = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('##[error]')) {
      lastError = i
      break
    }
  }
  let section = lines
  if (lastError >= 0) {
    let start = 0
    for (let i = lastError; i >= 0; i--) {
      if (lines[i].startsWith('##[group]')) {
        start = i
        break
      }
    }
    section = lines.slice(start, lastError + 1)
  }
  const tail = section.slice(-MAX_LINES)
  return { text: tail.join('\n'), lines: tail.length }
}

/** The failed step's tail of one job's log. `{ text, lines }`; rejects as the client does. */
async function jobLogTail(client, repo, jobId) {
  if (!Number.isInteger(jobId)) throw new Error('not a job id')
  const [owner, name] = repo.split('/')
  const url = await client.restRedirect(`/repos/${owner}/${name}/actions/jobs/${jobId}/logs`)
  const { text, truncated } = await client.fetchBlob(url, { tailBytes: TAIL_BYTES })
  return failedStepTail(text, { partial: truncated })
}

module.exports = { failedStepTail, jobLogTail, clean, TAIL_BYTES, MAX_LINES }
