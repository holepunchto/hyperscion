// hs ui's reads, as data: the same views status, diff, log and show print. They open the
// worktree as `hs status` does (writable when it's free, read-only while another command holds
// it), briefly, and never go online: what isn't here yet waits for `hs sync`. Not read-only
// always: autobee writes its boot record after any drain, so a read-only open that finds
// something to apply throws.
const Context = require('../context')
const { internals } = require('../cli')

const LOCAL = { wait: false }

async function withCtx(cwd, fn) {
  const ctx = await Context.open(cwd, { allowReadOnly: true })
  // a land typed meanwhile is told it's `hs ui` holding the worktree (close clears it)
  if (!ctx.readOnly) await ctx.markBusy('ui').catch(() => {})
  try {
    return await fn(ctx)
  } finally {
    await ctx.close()
  }
}

// lines console.log and console.error print while fn runs (status's header prints)
async function captured(fn) {
  const lines = []
  const { log, error } = console
  console.log = console.error = (...a) => lines.push(...a.join(' ').split('\n'))
  try {
    await fn()
  } finally {
    console.log = log
    console.error = error
  }
  return lines
}

// { root, workspace, base, header: [lines], files: [{ path, status, note, kind, diff }] }
function snapshot(cwd) {
  return withCtx(cwd, async (ctx) => {
    const ws = await ctx.workspace()
    const header = await captured(() => internals.printStatusHeader(ctx, ws, { renumber: false }))
    if (ctx.readOnly) {
      const busy = await Context.busy(ctx.root)
      const what = busy ? `\`hs ${busy.command}\` (pid ${busy.pid})` : 'another hs process'
      header.push(`(${what} is using this worktree: showing local data; actions wait for it)`)
    }
    const { rows } = await internals.statusRows(ctx, ws)
    const diffs = new Map()
    try {
      for (const f of await internals.diffFiles(ctx, ws, LOCAL)) diffs.set(f.path, f)
    } catch (err) {
      header.push('diffs unavailable: ' + err.message)
    }
    const files = []
    for (const r of rows) {
      if (r.heading) continue
      const d = diffs.get(r.path)
      files.push({
        path: r.path,
        status: r.status,
        note: r.note || null,
        kind: d ? d.kind : null,
        diff: d ? d.diff : null
      })
    }
    return { root: ctx.root, workspace: ws.name, base: ws.state.base.seq, header, files }
  })
}

// newest first: [{ seq, who, state, message, files }]
function log(cwd, { limit = 100 } = {}) {
  return withCtx(cwd, async (ctx) => {
    const list = []
    for await (const cs of ctx.repo.log({ limit })) {
      const st = await ctx.repo.landStatus(cs.seq)
      list.push({
        seq: cs.seq,
        who: await internals.who(ctx.repo, cs),
        state: st ? st.state : null,
        message: cs.message || '',
        time: cs.time || null,
        files: (cs.files || []).slice()
      })
    }
    return list
  })
}

// `hs show <seq>` as text
function show(cwd, { seq }) {
  return withCtx(cwd, (ctx) => internals.renderShow(ctx.repo, seq, LOCAL))
}

module.exports = { snapshot, log, show }
