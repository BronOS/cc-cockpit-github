'use strict'
// The project's settings, normalised: the app validates against the schema, but a value can still be absent
// (an older save) or odd (a list entry with spaces), and the schema takes no regexes, so the shape checks
// (owner names, the gh path) live here.

const LANES = ['reviewRequested', 'myPrs', 'issues', 'failedRuns']

// GitHub owner names: letters, digits, hyphens; repo names add `.` and `_`. Lenient on purpose (an entry
// that matches nothing just excludes nothing), strict enough that the list stays a list of names.
const OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/
const REPO = /^[a-z0-9._-]{1,100}$/

// A bare program name looked up on the login shell's PATH, or an absolute path. No spaces games: exec is argv
// only, so a value can never become a shell command, but a relative path would resolve against whatever the
// host's cwd is, so it is refused too.
const BARE = /^[A-Za-z0-9._-]{1,100}$/

function int(v, min, max, dflt) {
  return Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : dflt
}

/** `owner` or `owner/repo`, lower-cased, or null when it is neither. */
function parseExclude(entry) {
  if (typeof entry !== 'string') return null
  const e = entry.trim().toLowerCase()
  const parts = e.split('/')
  if (parts.length === 1 && OWNER.test(parts[0])) return parts[0]
  if (parts.length === 2 && OWNER.test(parts[0]) && REPO.test(parts[1]) && parts[1] !== '.' && parts[1] !== '..') return e
  return null
}

/** The gh program to run, and a warning when the setting was refused. */
function parseGhPath(v) {
  if (v === undefined || v === null || v === '') return { ghPath: 'gh' }
  if (typeof v === 'string' && !v.includes('\0')) {
    const t = v.trim()
    if (BARE.test(t) && t !== '.' && t !== '..') return { ghPath: t }
    if (t.startsWith('/') && t.length > 1) return { ghPath: t }
  }
  return { ghPath: 'gh', warning: 'the "gh program" setting is neither a program name nor an absolute path; using gh' }
}

/**
 * `{ lanes, rowsPerLane, markReadOnOpen, exclude, pollMinutes, ghPath, warnings }` from `ctx.settings.project`.
 * `warnings` lists what was dropped, for the log (never shown as an error: the rest still works).
 */
function normalize(raw) {
  const p = raw && typeof raw === 'object' ? raw : {}
  const warnings = []
  const lanes = {}
  const rawLanes = p.lanes && typeof p.lanes === 'object' ? p.lanes : {}
  for (const l of LANES) lanes[l] = typeof rawLanes[l] === 'boolean' ? rawLanes[l] : true
  const exclude = []
  for (const e of Array.isArray(p.exclude) ? p.exclude.slice(0, 100) : []) {
    const x = parseExclude(e)
    if (x === null) warnings.push(`"Leave out" entry ignored: ${JSON.stringify(String(e)).slice(0, 80)}`)
    else if (!exclude.includes(x)) exclude.push(x)
  }
  const gh = parseGhPath(p.ghPath)
  if (gh.warning) warnings.push(gh.warning)
  return {
    lanes,
    rowsPerLane: int(p.rowsPerLane, 1, 300, 10),
    markReadOnOpen: typeof p.markReadOnOpen === 'boolean' ? p.markReadOnOpen : true,
    exclude,
    pollMinutes: int(p.pollMinutes, 2, 15, 2),
    ghPath: gh.ghPath,
    warnings,
  }
}

/** Whether `owner/repo` is left out by the settings (owner or exact repo, any case). */
function isExcluded(nameWithOwner, settings) {
  if (typeof nameWithOwner !== 'string' || !settings.exclude.length) return false
  const full = nameWithOwner.toLowerCase()
  const owner = full.split('/')[0]
  return settings.exclude.includes(owner) || settings.exclude.includes(full)
}

module.exports = { normalize, isExcluded, parseExclude, parseGhPath, LANES }
