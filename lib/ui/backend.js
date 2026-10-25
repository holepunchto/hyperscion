// hs ui's reads, as data: the same views status, diff, log and show print. They open the
// worktree as `hs status` does (writable when it's free, read-only while another command holds
// it), briefly: not read-only always, because autobee writes its boot record after any drain,
// and a read-only open that finds something to apply throws. Only a changeset or ask whose
// files aren't here goes online for them, as `hs show` does; the rest is this machine's copy.
const Context = require('../context')
const b4a = require('b4a')
const claims = require('../claims')
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

// `hs show <seq>` as text (a teammate's files may need fetching, as hs show does)
function show(cwd, { seq }) {
  return withCtx(cwd, (ctx) =>
    internals.withContent(ctx, (io) => internals.renderShow(ctx.repo, seq, io))
  )
}

// what waits on you, then your own open asks: [{ kind, id, title, by, state, mine, unassigned }]
// kind is task, ask or change; id is what hs review takes (T1a2b3c, A5, 27)
function review(cwd) {
  return withCtx(cwd, async (ctx) => {
    const repo = ctx.repo
    const me = repo.writerKey
    const { items, proposals } = await internals.inboxEntries(ctx)
    const list = []
    for (const it of items) {
      list.push({
        kind: 'task',
        id: claims.shortId(it.id),
        title: internals.oneLine(it.title),
        by: await repo.nameOf(it.author),
        state: await internals.approvalText(repo, it),
        mine: false
      })
    }
    for (const p of proposals) {
      list.push({
        kind: 'ask',
        id: 'A' + p.id,
        title: internals.oneLine(p.message),
        by: await repo.nameOf(p.author),
        state: `${p.approvals}/${p.quorum} approvals${p.forAnyone ? ', unassigned' : ''}`,
        mine: false,
        unassigned: !!p.forAnyone
      })
    }
    for (const r of await internals.requestsForMe(ctx)) {
      list.push({
        kind: 'change',
        id: String(r.seq),
        title: internals.oneLine(r.changeset && r.changeset.message),
        by: await repo.nameOf(r.author),
        state: 'landed, review requested',
        mine: false
      })
    }
    for (const p of await repo.proposals()) {
      if (!b4a.equals(p.author, me) || p.statusName === 'landed' || p.statusName === 'closed') {
        continue
      }
      list.push({
        kind: 'ask',
        id: 'A' + p.id,
        title: internals.oneLine(p.message),
        by: 'you',
        state: `${p.statusName}, ${p.approvals}/${p.quorum} approvals`,
        mine: true
      })
    }
    return list
  })
}

// one review entry in full: an ask or a landed change with its diff and reviews, or a task
function detail(cwd, { id }) {
  return withCtx(cwd, async (ctx) => {
    const ask = /^A(\d+)$/i.exec(id)
    if (ask) {
      return internals.withContent(ctx, (io) =>
        internals.renderProposal(ctx.repo, Number(ask[1]), io)
      )
    }
    if (/^\d+$/.test(id)) {
      return internals.withContent(ctx, (io) => internals.renderShow(ctx.repo, Number(id), io))
    }
    const it = await ctx.repo.itemByPrefix(id)
    if (!it) throw new Error('no task ' + id)
    return internals.renderTask(ctx.repo, it)
  })
}

module.exports = { snapshot, log, show, review, detail }
