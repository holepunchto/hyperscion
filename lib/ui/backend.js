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

// who an ask can name: every teammate with a handle (not you, not removed, not an indexer: those
// are hubs), the ones `review ask` asks by default for these paths first:
// [{ handle, human, default }]
function team(cwd, { paths = [] } = {}) {
  return withCtx(cwd, async (ctx) => {
    const repo = ctx.repo
    const defaults = await internals.askDefaults(ctx, paths, LOCAL).catch(() => [])
    const people = []
    for (const k of await repo.writerKeys()) {
      if (b4a.equals(k, repo.writerKey)) continue
      const w = await repo.writer(k)
      const handle = w ? w.handle : await repo.handleOf(k)
      if (!handle || (w && (w.removed || w.indexer))) continue
      if (people.some((p) => p.handle === handle)) continue
      people.push({ handle, human: !!(w && w.human), default: defaults.includes(handle) })
    }
    return people.sort((a, b) => b.default - a.default || a.handle.localeCompare(b.handle))
  })
}

// the task board, as `hs task` prints it offline: what main recorded plus your own recent
// starts (a teammate's start shows once they push it). Open tasks, oldest first:
// [{ id, title, kind, by, mine, parent, lead, onIt, text }]; lead is a handle, 'you' or null,
// onIt says you're on it (leading or not), text is the main panel's
function tasks(cwd) {
  return withCtx(cwd, async (ctx) => {
    const repo = ctx.repo
    const me = repo.writerKey
    const board = new claims.Board()
    await board.load(repo)
    await internals.loadOwnSignals(ctx.root, board).catch(() => {})
    const now = Date.now()
    const name = async (k) => (b4a.equals(k, me) ? 'you' : await repo.nameOf(k))
    const list = []
    const open = [...board.items.values()]
      .filter((it) => !it.done && !it.dropped)
      .sort((a, b) => (a.time || 0) - (b.time || 0))
    for (const it of open) {
      const l = board.lead(it.id, now)
      const onIt = board
        .claimsOn(it.id, now)
        .some((cl) => cl.state === 'live' && b4a.equals(cl.payload.writer, me))
      const lines = []
      if (!l) lines.push('nobody on it: s starts it, and you lead')
      else {
        const p = l.lead
        lines.push(
          `lead ${await name(p.writer)} (started ${internals.ago(p.time)}, active ${internals.ago(p.at || p.time)})` +
            (p.note ? ' :: ' + internals.oneLine(p.note) : '')
        )
        for (const c of l.coLeads) lines.push(`co-lead ${await name(c.writer)}`)
        for (const o of l.others) lines.push(`also on it: ${await name(o.writer)}`)
      }
      for (const cl of board.claimsOn(it.id, now)) {
        if (cl.state !== 'stale') continue
        const p = cl.payload
        lines.push(`gone quiet: ${await name(p.writer)} (active ${internals.ago(p.at || p.time)})`)
      }
      if (it.lead) lines.push(`suggested lead: ${await name(it.lead)}`)
      if (it.parent) lines.push(`subtask of ${claims.shortId(it.parent)}`)
      list.push({
        id: claims.shortId(it.id),
        title: internals.oneLine(it.title || ''),
        kind: it.kind || '',
        by: it.author ? await name(it.author) : '?',
        mine: !!(it.author && b4a.equals(it.author, me)),
        parent: it.parent ? claims.shortId(it.parent) : null,
        lead: l ? await name(l.lead.writer) : null,
        onIt,
        text: lines.join('\n') + '\n\n' + (await internals.renderTask(repo, it))
      })
    }
    return list
  })
}

module.exports = { snapshot, log, show, review, detail, team, tasks }
