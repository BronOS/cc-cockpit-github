'use strict'
// The GitHub token, borrowed from the person's `gh` CLI login and kept in this closure only: never in settings,
// storage, logs, panel or overlay messages, feed events or error texts. `--hostname github.com` is fixed so a
// `GH_HOST` (or an Enterprise default) in the login shell can never hand us a token for another host, which we
// would then send to api.github.com.

const API = 'https://api.github.com'
const SIGNED_OUT_MESSAGE = 'Not signed in to GitHub. Run `gh auth login` in a terminal, then Refresh.'
const GH_TIMEOUT_MS = 10_000
// What gh prints: gho_/ghp_/github_pat_ tokens, all printable ASCII without spaces. Anything else (a
// prompt, an error on stdout) is not a token.
const TOKEN_SHAPE = /^[\x21-\x7e]{1,255}$/

class SignedOut extends Error {
  constructor() {
    super(SIGNED_OUT_MESSAGE)
    this.name = 'SignedOut'
    this.signedOut = true
  }
}

/**
 * `exec` is ctx.exec, `fetch` the global one (a fake in tests). `ghPath` from the settings. Returns
 * `{ token, refresh, signOut, login, state, reset }`:
 * - `token()`: the current token, running gh the first time; rejects `SignedOut`.
 * - `refresh()`: run gh again (after a 401); concurrent callers share one run; rejects `SignedOut`.
 * - `signOut()`: a second 401 after a refresh: forget the token, state `signedOut` until the next refresh.
 * - `login()`: the signed-in user's login (GET /user, cached); a 401 refreshes once.
 */
function createAuth({ exec, fetch, ghPath, log }) {
  let token = null
  let pending = null
  let me = null
  const st = { state: 'unknown', message: '' }

  async function runGh() {
    let r
    try {
      r = await exec([ghPath, 'auth', 'token', '--hostname', 'github.com'], { timeoutMs: GH_TIMEOUT_MS })
    } catch (e) {
      // gh missing or the exec refused; the reason is ours to log, never gh's output.
      log.warn(`github: could not run ${ghPath}: ${e && e.name ? e.name : 'error'}`)
      return null
    }
    if (!r || r.code !== 0) {
      log.warn(`github: ${ghPath} auth token exited ${r ? r.code : '?'} (signed out, or gh missing)`)
      return null
    }
    const t = String(r.stdout || '').trim()
    if (!TOKEN_SHAPE.test(t)) {
      log.warn(`github: ${ghPath} auth token printed something that is not a token`)
      return null
    }
    return t
  }

  function refresh() {
    if (!pending) {
      pending = runGh()
        .then((t) => {
          if (t !== token) me = null
          token = t
          if (!t) {
            st.state = 'signedOut'
            st.message = SIGNED_OUT_MESSAGE
            throw new SignedOut()
          }
          return t
        })
        .finally(() => {
          pending = null
        })
    }
    return pending
  }

  async function getToken() {
    if (token) return token
    return refresh()
  }

  function signOut() {
    token = null
    me = null
    st.state = 'signedOut'
    st.message = SIGNED_OUT_MESSAGE
  }

  async function userRequest(t) {
    return fetch(`${API}/user`, {
      headers: { Authorization: `Bearer ${t}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'cc-cockpit-github' },
      signal: AbortSignal.timeout(20_000),
    })
  }

  async function login() {
    if (me) return me
    let t = await getToken()
    let res = await userRequest(t)
    if (res.status === 401) {
      t = await refresh()
      res = await userRequest(t)
      if (res.status === 401) {
        signOut()
        throw new SignedOut()
      }
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for your user`)
    const body = await res.json()
    if (!body || typeof body.login !== 'string' || !body.login) throw new Error('GitHub sent no login for your user')
    me = body.login
    st.state = 'ok'
    st.message = ''
    return me
  }

  return {
    token: getToken,
    refresh,
    signOut,
    login,
    /** 'unknown' | 'ok' | 'signedOut', and the message for the panel and feed. */
    get state() {
      return st.state
    },
    get message() {
      return st.message
    },
    markOk() {
      st.state = 'ok'
      st.message = ''
    },
  }
}

module.exports = { createAuth, SignedOut, SIGNED_OUT_MESSAGE }
