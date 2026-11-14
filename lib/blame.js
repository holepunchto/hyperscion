// Line attribution (`hs blame`), derived on the client from path history (hs-hist): no apply
// work, no protocol change. History on main is linear and every land is rebased before it
// lands, so a changeset's diff against the version before it holds only its own lines; there
// are no merge parents to follow.
//
// The walk goes newest to oldest and stops once every line asked about is attributed, so a
// recently rewritten file never needs old content (which P2P may mean fetching from the hub).
const { diffComm } = require('node-diff3')

// states: newest first, each the file's content right after a change:
//   { seq, origin, load: async () => string[] | null, unknown? }
// origin is 'landed' (a changeset on main) or 'worktree' (not landed: seq is null). load
// returns the lines, or null when the file was absent. `unknown` marks content no record
// holds (changesets landed before hs recorded history values).
// Beyond the oldest state the file was absent: the first record of a path is its creation.
//
// opts.from/to: 1-based inclusive line range (default all).
// opts.tolerate(err): true when a load error means "content not available": the walk stops
// there and the lines still pending become a boundary (^#seq), as git marks a shallow edge.
// Errors it doesn't tolerate are thrown. The newest state's load is never tolerated.
//
// Returns { lines: [{ line, text, seq, origin, boundary? }], boundary: null | { seq, reason } }
async function blame(states, { from = 1, to = Infinity, tolerate = () => false } = {}) {
  if (!states.length) return { lines: [], boundary: null }
  const target = await states[0].load()
  if (target === null) return null

  const last = Math.min(to, target.length)
  const out = []
  // pending: line index in the current state -> index into out
  let pending = new Map()
  for (let i = Math.max(1, from) - 1; i < last; i++) {
    pending.set(i, out.length)
    out.push({ line: i + 1, text: target[i], seq: null, origin: null })
  }

  const attribute = (st, extra) => {
    for (const k of pending.values()) {
      out[k].seq = st.seq
      out[k].origin = st.origin
      if (extra) Object.assign(out[k], extra)
    }
    pending = new Map()
  }

  let cur = target
  let boundary = null
  for (let i = 0; pending.size; i++) {
    const st = states[i]
    const older = states[i + 1]
    if (!older) {
      attribute(st) // created here
      break
    }
    let prev
    if (older.unknown) {
      boundary = { seq: st.seq, reason: 'no history recorded before this changeset' }
    } else {
      try {
        prev = await older.load()
      } catch (err) {
        if (!tolerate(err)) throw err
        boundary = { seq: st.seq, reason: 'content not held by any online peer' }
      }
    }
    if (boundary) {
      attribute(st, { boundary: true })
      break
    }
    if (prev === null) {
      attribute(st) // absent before: created (or recreated) here
      break
    }

    const next = new Map()
    let a = 0 // index in prev
    let b = 0 // index in cur
    for (const part of diffComm(prev, cur)) {
      if (part.common) {
        for (let n = 0; n < part.common.length; n++, a++, b++) {
          if (pending.has(b)) next.set(a, pending.get(b))
        }
        continue
      }
      a += part.buffer1.length
      for (let n = 0; n < part.buffer2.length; n++, b++) {
        if (!pending.has(b)) continue
        const k = pending.get(b)
        out[k].seq = st.seq
        out[k].origin = st.origin
      }
    }
    pending = next
    cur = prev
  }

  return { lines: out, boundary }
}

// main's path history (repo.pathHistory: newest first, { seq, prev, next } entry buffers) as
// states: the content right after each changeset is its own record's `next`, or the
// next-newer record's `prev` when this record predates hist values. read(entry, i) loads one
function fromHistory(hist, read) {
  return hist.map((r, i) => {
    let entry = r.next
    if (entry === undefined && i > 0) entry = hist[i - 1].prev
    if (entry === undefined) return { seq: r.seq, origin: 'landed', unknown: true }
    return { seq: r.seq, origin: 'landed', load: () => read(entry, i) }
  })
}

module.exports = blame
module.exports.fromHistory = fromHistory
