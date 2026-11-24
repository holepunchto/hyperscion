// Settling in-process repos that replicate over piped streams: update every repo until nothing
// has changed for a quiet period, by the clock rather than by a count of polls. Counts broke on
// slow CI runners: three equal polls 25 ms apart passed while add-writer ops were still in
// flight (review.js "team ready" on darwin-x64).
const b4a = require('b4a')

const QUIET_MS = 300
const TIMEOUT_MS = 20_000

// what changes as ops arrive: main's length, settled point and hash, the events, writability
async function fingerprint(repos) {
  const parts = []
  for (const r of repos) {
    const m = await r.meta()
    const events = typeof r.eventCount === 'function' ? await r.eventCount() : 0
    parts.push(
      [m.seq, m.settled || 0, b4a.toString(m.hash, 'hex'), events, r.writable ? 1 : 0].join(':')
    )
  }
  return parts
}

// update `repos` until their state is unchanged for `quietMs`, and (converge) every repo
// agrees on main's hash, or `until()` holds. Gives up quietly after `timeout`: the test's own
// assertions say what was wrong
async function settle(
  repos,
  { quietMs = QUIET_MS, timeout = TIMEOUT_MS, converge = false, until = null } = {}
) {
  const deadline = Date.now() + timeout
  let last = null
  let since = Date.now()
  while (Date.now() < deadline) {
    for (const r of repos) await r.update()
    if (until && (await until())) return true
    const now = await fingerprint(repos)
    const id = now.join(',')
    if (id !== last) {
      last = id
      since = Date.now()
    } else if (!until && Date.now() - since >= quietMs) {
      const hashes = now.map((p) => p.split(':')[2])
      if (!converge || hashes.every((h) => h === hashes[0])) return true
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

module.exports = { settle }
