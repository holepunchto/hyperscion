const {
  command,
  flag,
  arg,
  rest,
  summary,
  description,
  hiddenFlag,
  hiddenCommand
} = require('paparam')
const z32 = require('z32')
const b4a = require('b4a')
const c = require('compact-encoding')
const fs = require('bare-fs/promises')
const path = require('bare-path')
const unixPathResolve = require('unix-path-resolve')
const process = require('bare-process')
const os = require('bare-os')
const crypto = require('hypercore-crypto')
const { spawn } = require('bare-subprocess')
const Corestore = require('corestore')
const driveEntry = require('hyperdrive/lib/encoding')
const Context = require('./context')
const Repo = require('./repo')
const Network = require('./net')
const Watcher = require('./watch')
const merge = require('./merge')
const importGit = require('./import-git')
const startUpdates = require('./updates')
const { isUnavailable } = require('./workspace')
const rules = require('./rules')
const keysMod = require('./keys')
const { TARGET_PROPOSAL, TARGET_CHANGESET } = keysMod

const out = (...a) => console.log(...a)
const warn = (...a) => console.error(...a)
const short = (buf) => z32.encode(buf).slice(0, 10)

const FETCH_TIMEOUT = 15_000
// agents must not start seeds of their own (it locks their worktree): point at the team's holder
const HOLDER_HINT =
  'no online peer holds it. It comes back when the team hub (`hs seed`, run by the team ' +
  "owner) or a teammate's running `hs watch` is online; `hs doctor` shows who is reachable"

// HS_BOOTSTRAP=host:port,host:port selects a private DHT (tests, airgapped setups)
function bootstrap() {
  const env = process.env.HS_BOOTSTRAP
  if (!env) return null
  return env.split(',').map((s) => {
    const [host, port] = s.split(':')
    return { host, port: Number(port) }
  })
}

function blindPeers(config) {
  return (config.blindPeers || []).map((k) => z32.decode(k))
}

async function online(ctx, opts = {}) {
  const net = new Network(ctx.repo, {
    bootstrap: bootstrap(),
    blindPeers: blindPeers(ctx.config),
    server: false,
    ...opts
  })
  await net.ready()
  return net
}

async function pullMain(net, { timeout = FETCH_TIMEOUT, quiet = false } = {}) {
  if (!(await net.waitForPeers({ timeout }))) {
    if (!quiet) warn('no peers found, using local state')
    return false
  }
  await net.settle()
  return true
}

// pull main and make everything the sparse set needs local (see Workspace.prefetch)
async function pullAndPrefetch(ctx, ws, net, { timeout = FETCH_TIMEOUT } = {}) {
  // callers say what being unreachable means for them (sync: local main; land: local only)
  const connected = await pullMain(net, { timeout, quiet: true })
  ws.io = { timeout: FETCH_TIMEOUT }
  if (!connected) return { connected, fetched: 0, missing: [] }
  const res = await ws.prefetch({ sparse: ctx.config.sparse, timeout: FETCH_TIMEOUT })
  return { connected, ...res }
}

// nobody reachable: say what this machine knows, and what the feed has seen beyond it
async function warnUnreachable(ctx, local) {
  const fed = await Context.readNumber(ctx.root, 'watch.last')
  const ahead = fed !== null && fed > local ? ` (your feed has seen #${fed})` : ''
  warn(`!! no peers reachable: showing local main #${local}${ahead}. Retry \`hs sync\` shortly`)
  process.exitCode = 2
}

function reportMissing(missing) {
  if (!missing.length) return
  warn(`!! ${missing.length} file(s) on main could not be fetched: ${HOLDER_HINT}`)
  for (const m of missing.slice(0, 10)) {
    warn(`     ${m.path}${m.core ? '  (blobs ' + short(m.core) + ')' : ''}`)
  }
  process.exitCode = 2
}

// loud, repeated until `hs sync` restores the land
async function flipBanner(ws) {
  const f = await ws.flipped()
  if (!f) return null
  warn(
    `!! your last land was undone by a concurrent land (${f.status}). Your changes are kept: ` +
      'run `hs sync && hs land`'
  )
  return f
}

// A land reported as #11 can end up as #14 when peers meet (an offline land, or a race
// resolved in someone else's favour). Nothing is lost, but the author was told a number:
// tell them the new one, once.
async function renumberNote(ctx, ws) {
  const reported = await Context.readNumber(ctx.root, 'land.reported')
  if (reported === null) return
  const last = await ws.lastLand()
  if (!last || last.status !== 'accepted' || last.seq === reported) return
  out(`your land #${reported} is now #${last.seq} (reordered when peers met; nothing lost)`)
  await Context.writeNumber(ctx.root, 'land.reported', last.seq)
}

// Write the workspace to disk. Content not held locally is fetched by going online; anything
// still unavailable is marked stale (never mistaken for an edit) and reported. Files with local
// edits are never overwritten.
async function materialize(ctx, ws, net = null) {
  const first = await ctx.worktree.checkout(ws)
  let stats = first

  if (first.missing.length) {
    const own = net === null
    if (own) net = await online(ctx)
    try {
      if (await net.waitForPeers({ timeout: FETCH_TIMEOUT })) {
        const again = await ctx.worktree.checkout(ws, { wait: true, timeout: FETCH_TIMEOUT })
        stats = { ...again, written: first.written + again.written }
      }
    } finally {
      if (own) await net.close()
    }
  }

  if (stats.missing.length) {
    warn(
      `!! ${stats.missing.length} file(s) are behind main (marked stale, not edits): ${HOLDER_HINT}`
    )
    for (const p of stats.missing.slice(0, 10)) warn('     ' + p)
    process.exitCode = 2
  }
  if (stats.unresolved.length) {
    warn(`!! ${stats.unresolved.length} file(s) changed on main but also edited here, left as is:`)
    for (const p of stats.unresolved.slice(0, 10)) warn('     ' + p)
    warn("   keep yours: `hs commit` then `hs sync`; take main's: `hs restore <path>`")
    process.exitCode = 2
  }
  return stats
}

function contentError(err) {
  return err && (err.code === 'CONTENT_UNAVAILABLE' || isUnavailable(err))
}

// run fn with local data first; if something isn't local, go online and retry once
async function withContent(ctx, fn) {
  try {
    return await fn({ wait: false })
  } catch (err) {
    if (!contentError(err)) throw err
  }
  const net = await online(ctx)
  try {
    if (!(await net.waitForPeers({ timeout: FETCH_TIMEOUT }))) {
      throw new Error('not local, and ' + HOLDER_HINT)
    }
    try {
      return await fn({ timeout: FETCH_TIMEOUT })
    } catch (err) {
      if (contentError(err)) throw new Error('content is not available: ' + HOLDER_HINT)
      throw err
    }
  } finally {
    await net.close()
  }
}

function withRepo(fn) {
  return async (cmd) => {
    const ctx = await Context.open(process.cwd())
    try {
      await fn(ctx, cmd)
    } catch (err) {
      if (err.code === 'CONTENT_UNAVAILABLE') {
        throw new Error(`${err.message}; nothing was changed. ${HOLDER_HINT}`)
      }
      throw err
    } finally {
      await ctx.saveBase().catch(() => {})
      await ctx.close()
    }
  }
}

const INCOMING_MAX = 25

// how long lands may stay unsettled before feeds and status call the hub out
const HUB_CHECK_MS = 5000
const hubStallMs = () => Number(process.env.HS_HUB_STALL_S || 20) * 1000

// one line per changeset that arrived between two bases, oldest first, skipping our own
async function printIncoming(ctx, from, to, { skipSeq = -1 } = {}) {
  const own = ctx.repo.writerKey
  const list = (await ctx.repo.changesetsBetween(from, to)).filter(
    (cs) => cs.seq !== skipSeq && !b4a.equals(cs.writer, own)
  )
  if (!list.length) return 0
  out(`incoming from teammates (${list.length}):`)
  for (const cs of list.slice(0, INCOMING_MAX)) {
    const files = (cs.files || []).slice(0, 4).join(' ') + (cs.paths > 4 ? ' ...' : '')
    out(`  #${cs.seq} ${await who(ctx.repo, cs)} ${files} :: ${oneLine(cs.message)}`)
  }
  if (list.length > INCOMING_MAX) {
    out(`  ... and ${list.length - INCOMING_MAX} later (hs log -n ${list.length})`)
  }
  return list.length
}

// who changed the paths a land collided on: "/NOTES.md (#5 a1)"
// A land that didn't happen: exit 1 (not done), and say where the work is and how to resume.
// `land` commits the worktree first, so the changes now sit in the workspace, not on main.
async function notLanded(ws, why, next) {
  warn(`!! not landed: ${why}`)
  const pending = (await ws.changes().catch(() => [])).map((e) => e.path)
  if (pending.length) {
    const shown =
      pending.slice(0, 6).join(' ') + (pending.length > 6 ? ` +${pending.length - 6} more` : '')
    warn(`   your ${pending.length} changed file(s) are kept, committed but not on main: ${shown}`)
  }
  warn(`   next: ${next}`)
  process.exitCode = 1
}

// merges hs did for you into files you had changed: worth a line, the result is yours to check
// (append-only files like NOTES.md are union-merged on nearly every land: not news)
async function reportMerged(ctx, merged) {
  if (!merged.length) return
  const attrs = merge.parseAttributes(await mainText(ctx, '/.hsattributes', { wait: false }))
  const shown = merged.filter((p) => merge.strategyFor(attrs, p) !== 'union')
  if (!shown.length) return
  out(`merged teammates' changes into your edits: ${await describeUpstream(ctx, shown)}`)
}

async function describeUpstream(ctx, paths) {
  const parts = []
  for (const p of paths.slice(0, 5)) {
    const cs = await ctx.repo.lastChange(p).catch(() => null)
    parts.push(cs ? `${p} (#${cs.seq} ${await who(ctx.repo, cs)})` : p)
  }
  return parts.join(', ') + (paths.length > 5 ? `, +${paths.length - 5} more` : '')
}

// --- review helpers -----------------------------------------------------------------------

const VERDICTS = { approve: 1, changes: 2, comment: 3 }
const VERDICT_NAMES = [null, 'approved', 'requested changes', 'commented']

// a changeset's verified author: the writer's handle, else the free-text author it claimed
async function who(repo, cs) {
  return (await repo.handleOf(cs.writer).catch(() => null)) || cs.author || '-'
}

function splitList(v) {
  if (!v) return []
  return []
    .concat(v)
    .join(',')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

// "P5" / "p5" -> { proposal: 5 }, "#27" / "27" -> { seq: 27 }
function parseTarget(s) {
  const p = String(s).match(/^[Pp](\d+)$/)
  if (p) return { proposal: Number(p[1]) }
  const n = String(s).match(/^#?(\d+)$/)
  if (n) return { seq: Number(n[1]) }
  throw new Error('expected a proposal (P5) or a changeset (#27), got ' + s)
}

async function namesOf(repo, list) {
  const out = []
  for (const k of list || []) out.push(await repo.nameOf(k))
  return out
}

function includesKey(list, key) {
  return (list || []).some((k) => b4a.equals(k, key))
}

// a small text file from main (e.g. /.hsowners), or '' if absent or not fetchable in time
async function mainText(ctx, file, io = { timeout: FETCH_TIMEOUT }) {
  const drive = ctx.repo.drive()
  try {
    const entry = await drive.entry(file, io)
    if (!entry) return ''
    return b4a.toString((await drive.get(file, io)) || b4a.alloc(0))
  } catch {
    return ''
  } finally {
    await drive.close()
  }
}

// owners (other than me) of the given paths, from /.hsowners: { handle: [paths] }
async function otherOwners(ctx, paths, io) {
  const ownerRules = rules.parseOwners(await mainText(ctx, '/.hsowners', io))
  if (!ownerRules.length) return {}
  const me = await ctx.repo.handleOf(ctx.repo.writerKey)
  const out = {}
  for (const p of paths) {
    const owners = rules.ownersOf(ownerRules, p)
    if (me && owners.includes(me)) continue
    for (const o of owners) (out[o] ||= []).push(p)
  }
  return out
}

function normalizePaths(list) {
  return list.map((p) => '/' + p.replace(/^\/+/, '').replace(/\/+$/, ''))
}

function oneLine(msg) {
  return (msg || '').split('\n')[0]
}

const init = command(
  'init',
  summary('Create a new repo in a directory'),
  arg('[dir]', 'directory, defaults to cwd'),
  flag('--encrypt', 'encrypt all repo data at rest (peers need the invite to read it)'),
  flag('--as <handle>', 'your handle in this repo (default: $USER)'),
  async (cmd) => {
    const root = path.resolve(cmd.args.dir || process.cwd())
    if (await Context.find(root)) throw new Error('already inside a hyperscion worktree')
    const encryptionKey = cmd.flags.encrypt ? crypto.randomBytes(32) : null
    const ctx = await Context.create(root, { encryptionKey })
    try {
      await ctx.workspace()
      const handle = cmd.flags.as || (process.env.USER || '').toLowerCase()
      if (rules.HANDLE.test(handle)) {
        await ctx.repo.addWriter(ctx.repo.writerKey, { indexer: true, handle })
      }
      await ctx.saveBase()
      out('initialized', root)
      out('repo', ctx.invite)
      if (rules.HANDLE.test(handle)) out('you are', handle)
    } finally {
      await ctx.close()
    }
  }
)

const status = command(
  'status',
  summary('Your edits, unlanded work, lands not yet final, and reviews waiting for you'),
  withRepo(async (ctx) => {
    const ws = await ctx.workspace()
    await catchUp(ctx)
    out(`workspace ${ws.name} (base #${ws.state.base.seq})`)
    await printAhead(ctx)

    const last = await ws.lastLand()
    if (last && last.status === 'accepted') {
      const st = await ctx.repo.landStatus(last.seq)
      if (st) out(`last land: #${last.seq} ${describeState(st)}`)
    }
    await flipBanner(ws)
    await renumberNote(ctx, ws)
    await warnHubStall(ctx)

    const pendingFinal = await notFinal(ctx, last && last.seq)
    if (pendingFinal.length) {
      out('your lands not final yet:')
      for (const l of pendingFinal) out(l)
    }

    const review = await reviewStatus(ctx)
    if (review.length) {
      out('review:')
      for (const l of review) out(l)
    }

    const pending = await ctx.worktree.status(ws)
    for (const ch of pending) out(`  ${ch.status.padEnd(9)} ${ch.path}`)
    for (const p of pending.stale) out(`  ${'stale'.padEnd(9)} ${p}  (behind main, run hs sync)`)

    const unlanded = await ws.changes()
    if (unlanded.length) out(`${unlanded.length} committed path(s) not landed`)
    for (const e of unlanded) out(`  ${(e.value ? 'commit' : 'commit-del').padEnd(9)} ${e.path}`)

    const marked = await withConflictMarkers(ctx, [
      ...pending.map((ch) => ch.path),
      ...unlanded.map((e) => e.path)
    ])
    for (const p of marked) out(`  ${'CONFLICT'.padEnd(9)} ${p}  (still has <<<<<<< markers)`)

    if (!pending.length && !unlanded.length && !pending.stale.length) out('clean')
  })
)

// lands that have waited a while to settle: the hub is down or behind
async function warnHubStall(ctx) {
  const meta = await ctx.repo.meta()
  const settled = meta.settled || 0
  if (meta.seq <= settled) return
  const first = await ctx.repo.changeset(settled + 1)
  const age = first && first.time ? Date.now() - first.time : 0
  if (age < hubStallMs()) return
  warn(
    `!! hub not settling: lands after #${settled} have been provisional for ${Math.round(age / 1000)}s ` +
      '(hub down or behind). They still reach teammates and settle when it is back'
  )
}

// files on disk that still carry merge conflict markers (a land would publish them)
async function withConflictMarkers(ctx, paths) {
  const found = []
  for (const p of new Set(paths)) {
    const buf = await fs.readFile(ctx.worktree._abs(p)).catch(() => null)
    if (buf && /^<{7} |^>{7} /m.test(b4a.toString(buf.subarray(0, 1 << 20)))) found.push(p)
  }
  return found
}

// what needs your attention in review: requests to you, your proposals, changes asked of you
async function reviewStatus(ctx) {
  const repo = ctx.repo
  const me = repo.writerKey
  const lines = []
  const mineBy = (list) => list.find((r) => b4a.equals(r.writer, me))

  for (const r of await repo.requests()) {
    const reviews = await repo.reviews(TARGET_CHANGESET, r.seq)
    if (includesKey(r.reviewers, me) && !mineBy(reviews)) {
      const cs = await repo.changeset(r.seq)
      lines.push(
        `  review requested: #${r.seq} by ${await repo.nameOf(r.author)} :: ${oneLine(cs && cs.message)}` +
          `  (hs show ${r.seq}, then hs review #${r.seq} approve|changes)`
      )
    }
    if (b4a.equals(r.author, me)) {
      for (const rv of reviews) {
        if (rv.verdict !== VERDICTS.changes) continue
        lines.push(
          `  changes requested on your #${r.seq} by ${await repo.nameOf(rv.writer)}: ${rv.comment || ''}`
        )
      }
    }
  }

  for (const p of await repo.proposals()) {
    if (p.statusName === 'landed') continue
    const reviews = await repo.reviews(TARGET_PROPOSAL, p.id)
    if (b4a.equals(p.author, me)) {
      lines.push(
        `  your proposal P${p.id} (revision ${p.revision}): ${p.statusName}, ${p.approvals}/${p.quorum} approvals`
      )
      for (const rv of reviews) {
        if (rv.verdict !== VERDICTS.changes || !rv.hash || !b4a.equals(rv.hash, p.hash)) continue
        lines.push(`    changes requested by ${await repo.nameOf(rv.writer)}: ${rv.comment || ''}`)
      }
      if (p.statusName === 'approved') lines.push('    approved: hs land')
    } else if (includesKey(p.reviewers, me)) {
      const mine = mineBy(reviews)
      const current =
        mine && mine.verdict !== VERDICTS.comment && mine.hash && b4a.equals(mine.hash, p.hash)
      if (!current) {
        lines.push(
          `  review requested: P${p.id} by ${await repo.nameOf(p.author)} :: ${oneLine(p.message)}` +
            `  (hs show P${p.id}, then hs review P${p.id} approve|changes)`
        )
      }
    }
  }
  return lines
}

function describeState(st) {
  if (st.final) return 'final'
  return `${st.state}, waiting for ${st.waiting.join('; ')}`
}

// my recent lands (other than `skip`) that aren't final yet
async function notFinal(ctx, skip, { scan = 50 } = {}) {
  const me = ctx.repo.writerKey
  const lines = []
  for await (const cs of ctx.repo.log({ limit: scan })) {
    if (cs.seq === skip || !b4a.equals(cs.writer, me)) continue
    const st = await ctx.repo.landStatus(cs.seq)
    if (st && !st.final) lines.push(`  #${cs.seq} ${describeState(st)} :: ${oneLine(cs.message)}`)
  }
  return lines
}

async function commitWorktree(ctx, ws) {
  const res = await ctx.worktree.commit(ws)
  if (res.blocked.length) {
    warn(`!! ${res.blocked.length} file(s) were edited on top of a stale copy and not committed:`)
    for (const p of res.blocked) warn('     ' + p)
    warn("   run `hs sync` to bring in main's version first")
  }
  return res
}

const commitCmd = command(
  'commit',
  summary('Checkpoint your edits in the workspace without landing (land does this for you)'),
  withRepo(async (ctx) => {
    const ws = await ctx.workspace()
    const res = await commitWorktree(ctx, ws)
    out(
      res.committed
        ? `committed ${res.committed} path(s) @ ${short(ws.head().key)}:${ws.head().length}`
        : 'nothing to commit'
    )
    if (res.blocked.length) process.exitCode = 2
  })
)

function printOutcome(outcome) {
  if (outcome.status === 'conflict') {
    out(`conflict on ${outcome.conflicts.length} path(s): ${outcome.conflicts.join(' ')}`)
  } else if (outcome.status !== 'accepted' && outcome.status !== 'empty') {
    out(`rejected: ${outcome.status}${outcome.reason ? ' (' + outcome.reason + ')' : ''}`)
  }
}

const land = command(
  'land',
  summary('Commit and land your work onto main (pulls, rebases and retries, then pushes)'),
  description(
    'Touching paths a teammate owns (/.hsowners) makes it a Show to them; --reviewers picks ' +
      'who to show; --ship skips review. Waits up to 10s for the hub to settle the land.'
  ),
  flag('--message|-m <msg>', 'changeset message (teammates read these)'),
  flag(
    '--reviewers|-r <handles>',
    'Show: land now, ask these teammates to review (comma-separated)'
  ),
  flag('--ship', "Ship: don't ask owners to review even when touching their paths"),
  flag('--proposal|-p <id>', "land this approved proposal (default: the workspace's own)"),
  flag('--wait-final', 'wait until final, including review of a Show (exit 2 if not by --timeout)'),
  flag('--timeout <seconds>', 'with --wait-final: give up after this long (default 60)'),
  flag('--no-wait', "don't wait for the land to settle"),
  flag('--offline', 'land locally only; teammates see it after your next online command'),
  flag(
    '--check|-c <cmd>',
    'run this (e.g. "npm test") on main + your changes first; land only if it passes'
  ),
  flag('--retries <n>', 'rebase-and-retry attempts when main moved (default 3)'),
  hiddenFlag('--online|-o', 'the default; kept so old habits still work'),
  withRepo(async (ctx, cmd) => {
    const ws = await ctx.workspace()
    const committed = await commitWorktree(ctx, ws)
    if (committed.blocked.length) {
      throw new Error('refusing to land while files are edited on top of stale copies (see above)')
    }

    // with no other writers (a fresh repo) there is nothing to pull, so don't wait long for peers
    const solo = (await ctx.repo.writerCount()) <= 1
    const net = cmd.flags.offline ? null : await online(ctx)
    let connected = false
    try {
      if (net) {
        const res = await pullAndPrefetch(ctx, ws, net, { timeout: solo ? 2000 : FETCH_TIMEOUT })
        connected = res.connected
        reportMissing(res.missing)
      } else {
        ws.io = { wait: false }
      }
      if (!ctx.repo.writable) {
        throw new Error(
          'not a writer, ask a writer to run `hs add-writer ' + z32.encode(ctx.repo.writerKey) + '`'
        )
      }
      await flipBanner(ws)
      await renumberNote(ctx, ws)

      const message = cmd.flags.message || ''
      const author = process.env.USER || ''
      const baseBefore = ws.state.base.seq

      // Ship / Show / Ask: touching paths other people own defaults to Show, to the owners
      let reviewers = splitList(cmd.flags.reviewers)
      if (!reviewers.length && !cmd.flags.ship) {
        const paths = (await ws.changes()).map((e) => e.path)
        const owners = await otherOwners(
          ctx,
          paths,
          net ? { timeout: FETCH_TIMEOUT } : { wait: false }
        )
        for (const [owner, owned] of Object.entries(owners)) {
          reviewers.push(owner)
          out(
            `showing to ${owner} (owner of ${owned.slice(0, 3).join(' ')}${owned.length > 3 ? ' ...' : ''})`
          )
        }
      }
      reviewers = [...new Set(reviewers)]
      const proposal = cmd.flags.proposal ? parseTarget(cmd.flags.proposal).proposal : null
      const landOpts = { message, author, reviewers, proposal }

      let retries = net ? Number(cmd.flags.retries ?? 3) : 0
      // --check: bring main in first and test exactly what will land
      const check = cmd.flags.check || null
      if (check && !(await checkMerged(ctx, ws, net, check, retries))) return
      let { outcome } = await ws.land(landOpts)

      // what a merge queue does server side, done by the lander: fetch what changed, rebase
      // (3-way / union merge) and try again, as long as the merge is clean
      while (retries-- > 0 && (outcome.status === 'conflict' || outcome.status === 'stale-base')) {
        if (outcome.status === 'conflict') {
          out(
            `main moved: ${await describeUpstream(ctx, outcome.conflicts)} changed since your last sync`
          )
        } else {
          out('main moved: the changeset your work was based on was replaced by a concurrent land')
        }
        out('rebasing onto main and retrying (this is normal)...')
        reportMissing((await pullAndPrefetch(ctx, ws, net)).missing)
        const res = await ws.sync()
        if (res.conflicts.length) {
          await materialize(ctx, ws, net)
          await notLanded(
            ws,
            `real conflicts in ${await describeUpstream(ctx, res.conflicts)}`,
            'fix the <<<<<<< markers (`hs status` lists them), then `hs land` again'
          )
          return
        }
        await reportMerged(ctx, res.merged)
        if (check) {
          await materialize(ctx, ws, net)
          if (!(await runCheckReport(ctx, ws, check))) return
        }
        ;({ outcome } = await ws.land(landOpts))
      }

      if (outcome.status === 'accepted') {
        // an indexer has seen its own land, so say so (a solo repo settles this way)
        if (await isIndexer(ctx.repo)) await ctx.repo.ack()
        await materialize(ctx, ws, net)
        // what your land now sits on, before the land itself, so the order reads right
        const incoming = await printIncoming(ctx, baseBefore, ws.state.base.seq, {
          skipSeq: outcome.seq
        })
        if (incoming && !check) {
          out('  (your land sits on these untested; `hs land --check "npm test"` tests first)')
        }
        const cs = await ctx.repo.changeset(outcome.seq)
        await Context.writeNumber(ctx.root, 'land.reported', outcome.seq)
        out(
          `landed ${cs && cs.proposal ? 'P' + cs.proposal + ' as ' : ''}#${outcome.seq}` +
            (net ? '' : ' (offline: local only until your next online command, e.g. hs push)')
        )
        const req = (await ctx.repo.requests()).find((r) => r.seq === outcome.seq)
        if (req) out(`review requested from ${(await namesOf(ctx.repo, req.reviewers)).join(', ')}`)
      } else if (outcome.status === 'empty') {
        out('nothing to land')
      } else if (outcome.status === 'needs-review') {
        await notLanded(
          ws,
          `needs review: ${outcome.reason}`,
          outcome.proposal
            ? `see \`hs show P${outcome.proposal}\`; land once it's approved`
            : '`hs propose -m "..." --reviewers <handles>`, then `hs land` once approved'
        )
      } else if (outcome.status === 'conflict') {
        await notLanded(
          ws,
          `${await describeUpstream(ctx, outcome.conflicts)} changed since your last sync`,
          '`hs sync` (merges them in), fix any conflict markers, then `hs land` again'
        )
      } else {
        printOutcome(outcome)
        await notLanded(ws, outcome.status, '`hs sync`, then `hs land` again')
      }

      // every op we appended (even a rejected land) must reach a peer before we exit, or
      // others wait for a block only this machine has
      if (net && !connected && outcome.status === 'accepted') {
        // nobody to push to: fine for a solo repo, worth a loud line in a team
        if (solo) out('no peers online: landed locally; it is shared once you seed or push')
        else {
          warn('!! no peers online: landed locally only. Run `hs push` once a holder is online')
          process.exitCode = 2
        }
        return
      }
      if (net && connected && outcome.status !== 'accepted' && outcome.status !== 'empty') {
        if (!(await net.uploaded())) {
          warn('!! push timed out: run `hs push` while a holder is online')
        }
      }
      if (net && outcome.status === 'accepted') {
        net.seed(ws)
        // don't exit before a holder has our content, or it is only on this machine
        if (await net.landed(ws)) out('pushed: a holder has the changes')
        else {
          warn(
            '!! push timed out: no holder has your changes yet. Run `hs push` while a holder is online'
          )
          process.exitCode = 2
        }
        if (cmd.flags.waitFinal) await waitFinal(ctx, outcome.seq, Number(cmd.flags.timeout || 60))
        else if (cmd.flags.wait !== false) await waitSettled(ctx, outcome.seq, SETTLE_WAIT_S)
      }
    } finally {
      if (net) await net.close()
    }
  })
)

const SETTLE_WAIT_S = 10

// Sync onto main and run the check on the result. If main moves while it runs, sync and run
// it again, so what lands is what was tested (up to the moment between the last pull and the
// land op, a few hundred ms).
async function checkMerged(ctx, ws, net, command, attempts) {
  for (let i = 0; ; i++) {
    if (net && i > 0) reportMissing((await pullAndPrefetch(ctx, ws, net)).missing)
    const res = await ws.sync()
    await materialize(ctx, ws, net)
    if (res.conflicts.length) {
      await notLanded(
        ws,
        `real conflicts in ${await describeUpstream(ctx, res.conflicts)}`,
        'fix the <<<<<<< markers (`hs status` lists them), then `hs land` again'
      )
      return false
    }
    await reportMerged(ctx, res.merged)
    if (!(await runCheckReport(ctx, ws, command))) return false
    if (!net) return true
    await pullMain(net)
    const head = (await ctx.repo.meta()).seq
    if (head === ws.state.base.seq) return true
    if (i >= attempts) {
      warn(`!! main moved to #${head} during every check; landing on the last checked state`)
      return true
    }
    out(`main moved to #${head} while checking; checking again`)
  }
}

async function runCheckReport(ctx, ws, command) {
  const at = ws.state.base.seq
  out(`checking main #${at} + your changes: ${command}`)
  const started = Date.now()
  const res = await runShell(command, ctx.root)
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  if (res.code === 0) {
    out(`check passed in ${secs}s`)
    return true
  }
  const lines = res.output.trimEnd().split('\n')
  for (const l of lines.slice(-CHECK_TAIL)) warn('  | ' + l)
  await notLanded(
    ws,
    `check failed (exit ${res.code}, ${secs}s) on main #${at} + your changes`,
    'your files now include main: fix, then `hs land --check ...` again'
  )
  return false
}

const CHECK_TAIL = 30

function runShell(command, cwd) {
  return new Promise((resolve) => {
    const proc =
      os.platform() === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd })
        : spawn('/bin/sh', ['-c', command], { cwd })
    const chunks = []
    proc.stdout.on('data', (d) => chunks.push(d))
    proc.stderr.on('data', (d) => chunks.push(d))
    proc.on('exit', (code) => resolve({ code, output: b4a.toString(b4a.concat(chunks)) }))
  })
}

async function isIndexer(repo) {
  return (await repo.indexers()).some((k) => b4a.equals(k, repo.writerKey))
}

// keep pulling until the land's status satisfies done(st), or time runs out
async function waitLand(ctx, seq, seconds, done) {
  const deadline = Date.now() + seconds * 1000
  let st = await ctx.repo.landStatus(seq)
  while (st && !done(st) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    await ctx.repo.update()
    st = await ctx.repo.landStatus(seq)
  }
  if (!st) {
    warn(`!! #${seq} is no longer on main: run hs sync && hs land`)
    process.exitCode = 2
  }
  return st
}

// the default after a land: a short wait for the hub's ack; not settling in time isn't an error
async function waitSettled(ctx, seq, seconds) {
  const st = await waitLand(ctx, seq, seconds, (st) => st.settled)
  if (!st) return
  if (st.final) out(`#${seq} final`)
  else if (st.settled) out(`#${seq} settled; not final until ${st.waiting.join('; ')}`)
  else out(`#${seq} provisional: waiting for ${st.waiting.join('; ')} (it settles on its own)`)
}

// --wait-final: wait for final, review included
async function waitFinal(ctx, seq, seconds) {
  const st = await waitLand(ctx, seq, seconds, (st) => st.final)
  if (!st) return
  if (st.final) return out(`#${seq} final`)
  warn(`!! #${seq} not final after ${seconds}s: ${describeState(st)}`)
  process.exitCode = 2
}

const sync = command(
  'sync',
  summary('Bring main into your files and rebase your work onto it (merges overlapping edits)'),
  flag('--offline', 'do not pull first (fails fast if needed content is not local)'),
  withRepo(async (ctx, cmd) => {
    const ws = await ctx.workspace()
    await commitWorktree(ctx, ws)

    const net = cmd.flags.offline ? null : await online(ctx)
    try {
      let connected = true
      if (net) {
        const pulled = await pullAndPrefetch(ctx, ws, net)
        connected = pulled.connected
        reportMissing(pulled.missing)
      } else ws.io = { wait: false }

      const baseBefore = ws.state.base.seq
      const res = await ws.sync()
      await materialize(ctx, ws, net)
      // without peers, "up to date" would only mean "up to date with what this machine has"
      if (!connected) await warnUnreachable(ctx, ws.state.base.seq)
      await renumberNote(ctx, ws)

      if (res.restored) {
        out(
          `restored your land that a concurrent land undid (${res.restored.status}); land it again`
        )
      }
      if (res.upToDate && connected) return out(`up to date with main #${ws.state.base.seq}`)
      if (res.upToDate) return
      out(`synced to main #${ws.state.base.seq}`)
      await printIncoming(ctx, Math.min(baseBefore, ws.state.base.seq), ws.state.base.seq)
      const kept = res.replayed + res.merged.length + res.conflicts.length
      if (kept) {
        out(
          `your unlanded changes: ${res.replayed} untouched by others, ` +
            `${res.merged.length} merged with theirs, ${res.conflicts.length} in conflict`
        )
      }
      for (const p of res.merged) out('  merged    ' + p)
      for (const p of res.conflicts) out('  CONFLICT  ' + p)
      if (res.conflicts.length) process.exitCode = 2
    } finally {
      if (net) await net.close()
    }
  })
)

const propose = command(
  'propose',
  summary('Ask: publish your changes for review without landing them (again = new revision)'),
  flag('--message|-m <msg>', 'what and why, for reviewers'),
  flag('--reviewers|-r <handles>', 'comma-separated reviewers (default: owners from /.hsowners)'),
  flag('--quorum|-q <n>', 'approvals needed (default 1)'),
  hiddenFlag('--online|-o', 'propose is always online; kept so old habits still work'),
  withRepo(async (ctx, cmd) => {
    const ws = await ctx.workspace()
    const committed = await commitWorktree(ctx, ws)
    if (committed.blocked.length) throw new Error('refusing to propose stale copies (see above)')

    const net = await online(ctx)
    try {
      reportMissing((await pullAndPrefetch(ctx, ws, net)).missing)
      let reviewers = splitList(cmd.flags.reviewers)
      if (!reviewers.length) {
        const owners = await otherOwners(
          ctx,
          (await ws.changes()).map((e) => e.path)
        )
        reviewers = Object.keys(owners)
      }
      const res = await ws.propose({
        message: cmd.flags.message || '',
        author: process.env.USER || '',
        reviewers,
        quorum: cmd.flags.quorum ? Number(cmd.flags.quorum) : 0
      })
      if (res.outcome.status === 'empty') return out('nothing to propose')
      if (res.outcome.status !== 'accepted') {
        printOutcome(res.outcome)
        process.exitCode = 2
        return
      }
      const prop = await ctx.repo.proposal(res.outcome.proposal)
      const who = (await namesOf(ctx.repo, prop.reviewers)).join(', ') || 'anyone'
      out(
        `proposed P${prop.id}${prop.revision ? ' (revision ' + prop.revision + ', earlier approvals reset)' : ''}: ` +
          `${prop.entries.length} path(s), needs ${prop.quorum} approval(s), asked ${who}`
      )
      // reviewers must be able to read it after we exit
      const held = await net.uploaded([
        ctx.repo.main.local,
        [ws.tree, ws.tree.length],
        [ws.blobs.core, ws.blobs.core.length]
      ])
      out(
        held
          ? 'pushed: a holder has it'
          : '!! push timed out: run `hs push` while a holder is online'
      )
      out(`once approved: hs land   (track it with hs watch --for-me, or hs show P${prop.id})`)
    } finally {
      await net.close()
    }
  })
)

const reviewCmd = command(
  'review',
  summary('Review a proposal (P5) or a landed changeset (#27): approve, changes or comment'),
  arg('<target>', 'P5 or #27'),
  arg('<verdict>', 'approve | changes | comment'),
  flag('--message|-m <text>', 'comment (start with path:line to point at a spot)'),
  withRepo(async (ctx, cmd) => {
    const target = parseTarget(cmd.args.target)
    const verdict = VERDICTS[cmd.args.verdict]
    if (!verdict) throw new Error('verdict must be approve, changes or comment')
    if (!ctx.repo.writable) throw new Error('not a writer')

    const net = await online(ctx)
    try {
      await pullMain(net)
      const op = { verdict, comment: cmd.flags.message || null, time: Date.now() }
      if (target.proposal) {
        const prop = await ctx.repo.proposal(target.proposal)
        if (!prop) throw new Error('no such proposal P' + target.proposal)
        op.proposal = prop.id
        op.hash = prop.hash // what we saw: if it changes before this lands, the review is stale
      } else {
        op.seq = target.seq
      }
      const { outcome } = await ctx.repo.review(op)
      if (outcome.status !== 'accepted') {
        printOutcome(outcome)
        process.exitCode = 2
        return
      }
      if (target.proposal) {
        const prop = await ctx.repo.proposal(target.proposal)
        out(
          `P${prop.id}: ${VERDICT_NAMES[verdict]}; ${prop.approvals}/${prop.quorum} approvals, ${prop.statusName}`
        )
      } else {
        out(`#${target.seq}: ${VERDICT_NAMES[verdict]}`)
      }
      out((await net.uploaded()) ? 'pushed' : '!! push timed out, run `hs push`')
    } finally {
      await net.close()
    }
  })
)

const proposalsCmd = command(
  'proposals',
  summary('List proposals: waiting for you, yours, or all'),
  flag('--all', 'include landed ones'),
  flag('--offline', "don't pull first"),
  withRepo(async (ctx, cmd) => {
    if (!cmd.flags.offline) {
      const net = await online(ctx)
      try {
        await pullMain(net)
      } finally {
        await net.close()
      }
    }
    const me = ctx.repo.writerKey
    let any = false
    for (const p of await ctx.repo.proposals()) {
      if (!cmd.flags.all && p.statusName === 'landed') continue
      any = true
      const role = b4a.equals(p.author, me)
        ? 'yours'
        : includesKey(p.reviewers, me)
          ? 'for you'
          : ''
      out(
        `P${p.id} ${p.statusName.padEnd(8)} ${p.approvals}/${p.quorum} by ${await ctx.repo.nameOf(p.author)}` +
          ` for ${(await namesOf(ctx.repo, p.reviewers)).join(',') || 'anyone'}` +
          `${role ? ' [' + role + ']' : ''} :: ${oneLine(p.message)}`
      )
    }
    if (!any) out('no open proposals')
  })
)

const diff = command(
  'diff',
  summary('Show what `land` would send: your edits and commits, as a unified diff'),
  flag('--stat', 'only list the paths (A added, M modified, D deleted)'),
  withRepo(async (ctx, cmd) => {
    const ws = await ctx.workspace()
    const text = await withContent(ctx, (io) => renderDiff(ctx, ws, io, { stat: cmd.flags.stat }))
    process.stdout.write(text)
  })
)

// committed changes since the fork point, overlaid with uncommitted edits in the worktree
async function renderDiff(ctx, ws, io, { stat = false } = {}) {
  ws.io = io
  const after = new Map()
  for (const e of await ws.changes()) after.set(e.path, { value: e.value })
  for (const ch of await ctx.worktree.status(ws)) {
    const content =
      ch.status === 'deleted' ? null : ch.content || (await fs.readFile(ctx.worktree._abs(ch.path)))
    after.set(ch.path, { content })
  }

  const fork = ws.bee.checkout({ ...ws.state.fork, ...io })
  let text = ''
  try {
    for (const p of [...after.keys()].sort()) {
      const node = await fork.get(keysMod.files.encode(p))
      const before = node ? await readEntry(ws.drive, node.value, io) : null
      const rec = after.get(p)
      const now = 'content' in rec ? rec.content : await readEntry(ws.drive, rec.value, io)
      if (before && now && b4a.equals(before, now)) continue
      if (!before && !now) continue
      if (stat) text += `${!before ? 'A' : now ? 'M' : 'D'} ${p}\n`
      else text += merge.unifiedDiff(p, before, now)
    }
  } finally {
    await fork.close()
  }
  return text
}

const LOG_FILES = 8

// local commands read local main; your feed may already know main is further ahead
async function printAhead(ctx) {
  const local = (await ctx.repo.meta()).seq
  const fed = await Context.readNumber(ctx.root, 'watch.last')
  if (fed !== null && fed > local) {
    warn(
      `main is at #${fed} or later (from your feed); this shows #${local}. \`hs sync\` to update`
    )
  }
}

// Local commands read this machine's copy of main, which can lag behind what the feed has
// seen (new lands, or lands that settled since). When it does, catch up first, so `status`,
// `log` and `cat` never contradict the feed.
async function catchUp(ctx) {
  const meta = await ctx.repo.meta()
  const fedSeq = await Context.readNumber(ctx.root, 'watch.last')
  const fedSettled = await Context.readNumber(ctx.root, 'watch.settled')
  const behind =
    (fedSeq !== null && fedSeq > meta.seq) ||
    (fedSettled !== null && fedSettled > (meta.settled || 0))
  if (!behind) return
  const net = await online(ctx)
  try {
    await pullMain(net, { quiet: true })
  } finally {
    await net.close()
  }
}

// a path equal to, or inside, one of the prefixes
function underAny(p, prefixes) {
  return prefixes.some((x) => x === '/' || p === x || p.startsWith(x.replace(/\/$/, '') + '/'))
}

async function printChangeset(repo, cs, { files = false, under = null, oneline = false } = {}) {
  const when = cs.time ? new Date(cs.time).toISOString() : ''
  const st = await repo.landStatus(cs.seq)
  const tag = st ? ` [${st.state}]` : ''
  if (oneline) {
    return out(`#${cs.seq} ${await who(repo, cs)}${tag} ${oneLine(cs.message)}`)
  }
  out(`#${cs.seq} ${short(cs.hash)} ${await who(repo, cs)} ${when} ${cs.paths} path(s)${tag}`)
  if (cs.message) out('    ' + cs.message.split('\n').join('\n    '))
  if (files) {
    // with a path filter, only the matching files; otherwise the first few
    const all = cs.files || []
    const shown = under ? all.filter((f) => f.replace(/^-/, '') === under) : all.slice(0, LOG_FILES)
    for (const f of shown) out('      ' + f)
    const more = (cs.paths || all.length) - shown.length
    if (more > 0) out(`      ... ${more} ${under ? 'other path(s)' : 'more'}`)
  }
}

const log = command(
  'log',
  summary('Landed changesets with their files and state, optionally for one path'),
  arg('[path]', 'only changesets touching this path'),
  flag('--limit|-n <n>', 'max entries (default 20)'),
  flag('--oneline', 'one line per changeset: number, author, state, message'),
  hiddenFlag('--files|-f', 'the default'),
  withRepo(async (ctx, cmd) => {
    const limit = cmd.flags.limit ? Number(cmd.flags.limit) : 20
    const p = cmd.args.path ? '/' + cmd.args.path.replace(/^\/+/, '') : null
    await catchUp(ctx)
    await printAhead(ctx)
    for await (const cs of ctx.repo.log({ path: p, limit })) {
      await printChangeset(ctx.repo, cs, {
        files: !cmd.flags.oneline,
        oneline: !!cmd.flags.oneline,
        under: p
      })
    }
  })
)

// read a hyperdrive entry buffer's content through the main drive (foreign blobs resolved)
async function readEntry(drive, value, io) {
  if (!value) return null
  const entry = c.decode(driveEntry, value)
  if (!entry.blob) return b4a.alloc(0)
  const blobs = await drive.getBlobsFor(entry.blob)
  const res = await blobs.get(entry.blob, io)
  if (res === null) {
    const err = new Error('block not available')
    err.code = 'BLOCK_NOT_AVAILABLE'
    throw err
  }
  return res
}

async function renderReviews(repo, kind, id, snap) {
  let text = ''
  for (const r of await repo.reviews(kind, id, snap)) {
    text += `  ${await repo.nameOf(r.writer, snap)} ${VERDICT_NAMES[r.verdict]}`
    text += r.comment ? `: ${r.comment}\n` : '\n'
  }
  return text
}

async function renderProposal(repo, id, io, { stat = false, paths = null } = {}) {
  const snap = repo.main.view.snapshot(io)
  const drive = repo.drive(snap.snapshot())
  try {
    const p = await repo.proposal(id, snap)
    if (!p) throw new Error('no proposal P' + id)
    let text = `proposal P${p.id} revision ${p.revision} by ${await repo.nameOf(p.author, snap)}: ${p.statusName}, `
    text += `${p.approvals}/${p.quorum} approvals, reviewers ${(await namesOf(repo, p.reviewers)).join(', ') || 'anyone'}\n`
    text += `based on main #${p.base.seq}${p.landed ? ', landed as #' + p.landed : ''}\n\n`
    if (p.message) text += '    ' + p.message.split('\n').join('\n    ') + '\n\n'
    const reviews = await renderReviews(repo, TARGET_PROPOSAL, p.id, snap)
    if (reviews) text += 'reviews:\n' + reviews + '\n'
    for (const e of p.entries || []) {
      if (paths && !underAny(e.path, paths)) continue
      // against main as the proposal saw it, so teammates' later lands don't show up as
      // deletions (landing merges those in)
      const before = await repo.entryAt(e.path, p.base.seq, snap)
      if (stat) {
        text += `  ${before ? (e.value ? 'M' : 'D') : 'A'} ${e.path}\n`
        continue
      }
      text += merge.unifiedDiff(
        e.path,
        await readEntry(drive, before, io),
        await readEntry(drive, e.value, io)
      )
    }
    return text
  } finally {
    await snap.close()
    await drive.close()
  }
}

async function renderShow(repo, seq, io, { stat = false, paths = null } = {}) {
  const snap = repo.main.view.snapshot(io)
  const drive = repo.drive()
  try {
    const res = await repo.show(seq, snap)
    if (!res) throw new Error('no changeset #' + seq)
    const { cs } = res
    let text = `changeset #${cs.seq} ${short(cs.hash)}\n`
    text += `author ${await who(repo, cs)}  ${cs.time ? new Date(cs.time).toISOString() : ''}  base #${cs.base.seq}\n\n`
    if (cs.message) text += '    ' + cs.message.split('\n').join('\n    ') + '\n\n'
    if (cs.proposal) text += `landed proposal P${cs.proposal}\n\n`
    const req = (await repo.requests(snap)).find((r) => r.seq === cs.seq)
    if (req) text += `review requested from ${(await namesOf(repo, req.reviewers)).join(', ')}\n`
    const reviews = await renderReviews(repo, TARGET_CHANGESET, cs.seq, snap)
    if (reviews) text += 'reviews:\n' + reviews
    if (req || reviews) text += '\n'
    const files = paths ? res.files.filter((f) => underAny(f.path, paths)) : res.files
    if (paths && files.length < res.files.length) {
      text += `(${res.files.length - files.length} other path(s) not shown, drop --path for all)\n`
    }
    for (const f of files) {
      if (f.prev === undefined && f.next === undefined) {
        text += `--- ${f.path} (no diff: landed before hs recorded history values)\n`
        continue
      }
      if (stat) {
        text += `  ${f.prev ? (f.next ? 'M' : 'D') : 'A'} ${f.path}\n`
        continue
      }
      const before = await readEntry(drive, f.prev, io)
      const after = await readEntry(drive, f.next, io)
      text += merge.unifiedDiff(f.path, before, after)
    }
    if (res.truncated) text += `... ${cs.paths - res.files.length} more path(s) not shown\n`
    return text
  } finally {
    await snap.close()
    await drive.close()
  }
}

const show = command(
  'show',
  summary('Show a changeset (#27) or proposal (P5): message, reviews and a unified diff'),
  arg('<target>', 'a changeset (27, #27) or a proposal (P5)'),
  flag('--stat', 'only list the files'),
  flag('--path|-p <prefix>', 'only these files or folders (repeatable)').multiple(),
  withRepo(async (ctx, cmd) => {
    const target = parseTarget(cmd.args.target)
    const paths = cmd.flags.path ? normalizePaths(cmd.flags.path) : null
    // a teammate's new proposal or changeset may not be pulled yet
    const known = target.proposal
      ? await ctx.repo.proposal(target.proposal)
      : await ctx.repo.changeset(target.seq)
    if (!known) {
      const net = await online(ctx)
      try {
        await pullMain(net)
      } finally {
        await net.close()
      }
    }
    const text = await withContent(ctx, (io) =>
      target.proposal
        ? renderProposal(ctx.repo, target.proposal, io, { stat: cmd.flags.stat, paths })
        : renderShow(ctx.repo, target.seq, io, { stat: cmd.flags.stat, paths })
    )
    process.stdout.write(text)
  })
)

const ls = command(
  'ls',
  summary('List files without a checkout (main, or the workspace with --ws)'),
  arg('[prefix]', 'folder'),
  flag('--ws', 'list the workspace instead of main'),
  withRepo(async (ctx, cmd) => {
    // "the latest landed version": catch up if the feed has seen more than this machine
    if (!cmd.flags.ws) {
      await catchUp(ctx)
      await printAhead(ctx)
    }
    const drive = cmd.flags.ws ? (await ctx.workspace()).drive : ctx.repo.drive()
    try {
      for await (const e of drive.list(cmd.args.prefix || '/')) {
        out(`${e.value.blob ? e.value.blob.byteLength : 0}`.padStart(10) + ' ' + e.key)
      }
    } finally {
      if (!cmd.flags.ws) await drive.close()
    }
  })
)

const cat = command(
  'cat',
  summary('Print a file without a checkout (main, or the workspace with --ws)'),
  arg('<path>', 'file'),
  flag('--ws', 'read from the workspace instead of main'),
  withRepo(async (ctx, cmd) => {
    const drive = cmd.flags.ws ? (await ctx.workspace()).drive : ctx.repo.drive()
    try {
      const buf = await withContent(ctx, async (io) => {
        const entry = await drive.entry(cmd.args.path, io)
        if (!entry) return null
        return drive.get(cmd.args.path, io)
      })
      if (buf === null) throw new Error('no such file: ' + cmd.args.path)
      process.stdout.write(buf)
    } finally {
      if (!cmd.flags.ws) await drive.close()
    }
  })
)

const exportCmd = command(
  'export',
  summary('Write main as it was at a changeset into a directory (like git archive)'),
  arg('<dir>', 'target directory, created if missing; must be empty'),
  flag('--at <seq>', 'the changeset to export (default: main now)'),
  withRepo(async (ctx, cmd) => {
    const dir = path.resolve(cmd.args.dir)
    const at = cmd.flags.at
      ? Number(String(cmd.flags.at).replace(/^#/, ''))
      : (await ctx.repo.meta()).seq
    if (!Number.isInteger(at) || at < 0) throw new Error('--at takes a changeset number')
    await fs.mkdir(dir, { recursive: true })
    if ((await fs.readdir(dir)).length) throw new Error(dir + ' is not empty')
    const n = await withContent(ctx, async (io) => {
      const snap = ctx.repo.main.view.snapshot(io)
      const drive = ctx.repo.drive(snap.snapshot())
      try {
        const tree = await ctx.repo.treeAt(at, snap)
        for (const { path: p, value } of tree) {
          const file = path.join(dir, p)
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.writeFile(file, await readEntry(drive, value, io))
        }
        return tree.length
      } finally {
        await drive.close()
        await snap.close()
      }
    })
    out(`exported #${at}: ${n} file(s) into ${dir}`)
  })
)

const restore = command(
  'restore',
  summary('Discard your unlanded changes to files (committed or not): back to main at your sync'),
  rest('[...paths]', 'files to restore'),
  withRepo(async (ctx, cmd) => {
    const paths = cmd.rest || []
    if (!paths.length) throw new Error('name the files to restore')
    const ws = await ctx.workspace()
    const net = await online(ctx)
    try {
      ws.io = { timeout: FETCH_TIMEOUT }
      // `land` commits your edits into the workspace before landing, so rewriting the file
      // from the workspace would bring the edit back: put the workspace entries back to main
      // at your last sync first, then the files
      const reset = await ws.revert(paths.map((p) => unixPathResolve('/', p)))
      for (const p of await ctx.worktree.restore(ws, paths)) out('restored ' + p)
      if (reset) out(`(also dropped ${reset} committed, unlanded change(s) to these files)`)
    } finally {
      await net.close()
    }
  })
)

const checkout = command(
  'checkout',
  summary('Materialize files on disk, optionally only some prefixes (sparse)'),
  rest('[...paths]', 'prefixes to materialize, defaults to the current sparse set'),
  withRepo(async (ctx, cmd) => {
    const paths = cmd.rest || []
    if (paths.length) {
      ctx.config.sparse = normalizePaths(paths)
      ctx.worktree.sparse = ctx.config.sparse
      await ctx.save()
    }
    const ws = await ctx.workspace()
    const stats = await materialize(ctx, ws)
    out(
      `checkout ${ctx.config.sparse.join(' ')}: ${stats.written} written, ${stats.skipped} unchanged, ${stats.removed} removed`
    )
  })
)

const wsNew = command(
  'new',
  summary('Fork a new workspace from main and switch to it'),
  arg('<name>', 'workspace name'),
  withRepo(async (ctx, cmd) => {
    const cur = await ctx.worktree.status(await ctx.workspace())
    if (cur.length) throw new Error('uncommitted changes, run `hs commit` first')
    const ws = await ctx.switch(cmd.args.name)
    await materialize(ctx, ws)
    out(`workspace ${ws.name} forked at #${ws.state.base.seq}`)
  })
)

const wsSwitch = command(
  'switch',
  summary('Switch to an existing workspace'),
  arg('<name>', 'workspace name'),
  withRepo(async (ctx, cmd) => {
    const cur = await ctx.worktree.status(await ctx.workspace())
    if (cur.length) throw new Error('uncommitted changes, run `hs commit` first')
    const ws = await ctx.repo.workspace(cmd.args.name, { create: false })
    if (!ws) throw new Error('no such workspace: ' + cmd.args.name)
    await ctx.switch(cmd.args.name)
    await materialize(ctx, ws)
    out('switched to ' + ws.name)
  })
)

const wsList = command(
  'list',
  summary('List workspaces'),
  withRepo(async (ctx) => {
    for (const name of await ctx.repo.listWorkspaces()) {
      out((name === ctx.config.workspace ? '* ' : '  ') + name)
    }
  })
)

const ws = command('ws', summary('Manage workspaces'), wsNew, wsSwitch, wsList)

const clone = command(
  'clone',
  summary('Join a repo and check out main (sparse with --sparse)'),
  arg('<invite>', 'repo invite from `hs info` (repo key, plus encryption key if encrypted)'),
  arg('[dir]', 'directory, defaults to the first 8 chars of the key'),
  flag('--sparse|-s <path>', 'only materialize this prefix (repeatable)').multiple(),
  flag('--as <handle>', 'your handle, asked for with --admit (default: the directory name)'),
  flag('--admit <dir>', "request write access: drop this peer's key into a seed's --admit dir"),
  async (cmd) => {
    const root = path.resolve(cmd.args.dir || cmd.args.invite.slice(0, 8))
    const sparse = normalizePaths(cmd.flags.sparse || ['/'])
    const { key, encryptionKey } = Context.parseInvite(cmd.args.invite)
    const ctx = await Context.create(root, { key, encryptionKey, sparse })
    try {
      const net = await online(ctx)
      try {
        if (!(await net.waitForPeers({ timeout: 30_000 }))) {
          throw new Error('no peers found for ' + ctx.config.key)
        }
        await net.settle()
        const ws = await ctx.workspace()
        ws.io = { timeout: FETCH_TIMEOUT }
        const meta = await ctx.repo.meta()
        const stats = await materialize(ctx, ws, net)
        await ctx.saveBase()
        out(`cloned ${ctx.config.key} at #${meta.seq} into ${root}: ${stats.written} file(s)`)
        const writer = z32.encode(ctx.repo.writerKey)
        if (cmd.flags.admit) {
          const handle = (cmd.flags.as || path.basename(root)).toLowerCase()
          if (!rules.HANDLE.test(handle)) {
            throw new Error('invalid handle ' + handle + ', pass --as')
          }
          const file = path.join(path.resolve(cmd.flags.admit), handle + '.key')
          await fs.writeFile(file, writer + '\n')
          out(`requested write access via ${file}; \`hs fetch\` once the seed has admitted it`)
        } else {
          out('writer key (share with a writer to get access):', writer)
        }
      } finally {
        await net.close()
      }
    } finally {
      await ctx.close()
    }
  }
)

const fetchCmd = command(
  'fetch',
  summary('Download main and everything your files need, without changing them (sync does that)'),
  withRepo(fetchMain)
)
// the old name: git's pull changes files, ours never did
const pull = hiddenCommand('pull', summary('old name for fetch'), withRepo(fetchMain))

async function fetchMain(ctx) {
  const ws = await ctx.workspace()
  const before = await ctx.repo.meta()
  const net = await online(ctx)
  let res = null
  try {
    res = await pullAndPrefetch(ctx, ws, net)
  } finally {
    await net.close()
  }
  const after = await ctx.repo.meta()
  out(
    (after.seq === before.seq ? `main at #${after.seq}` : `main #${before.seq} -> #${after.seq}`) +
      (res.fetched ? `, fetched ${res.fetched} file(s)` : '')
  )
  await flipBanner(ws)
  await renumberNote(ctx, ws)
  reportMissing(res.missing)
}

const push = command(
  'push',
  summary('Make sure a holder has everything you landed (after an offline land or a timeout)'),
  withRepo(async (ctx) => {
    const net = await online(ctx)
    try {
      const wss = []
      for (const name of await ctx.repo.listWorkspaces()) wss.push(await ctx.repo.workspace(name))
      for (const w of wss) net.seed(w)
      if (!(await net.waitForPeers())) {
        warn(
          '!! no peers reachable: nothing pushed. Your lands are safe on this machine; ' +
            '`hs push` again when the hub or a teammate (any running `hs watch`) is online'
        )
        process.exitCode = 2
        return
      }
      // our oplog, plus the content of every workspace that has landed something
      const cores = [ctx.repo.main.local]
      for (const w of wss) if (w.state.landed) cores.push(w.tree, w.blobs.core)
      const ok = await net.uploaded(cores.filter((core) => core.length > 0))
      out(ok ? 'pushed: a holder has everything we landed' : 'push timed out')
      if (!ok) process.exitCode = 2
    } finally {
      await net.close()
    }
  })
)

// writer keys dropped into dir (one z32 key per file) become add-writer ops
async function admitLoop(ctx, dir, signal) {
  const done = path.join(dir, 'admitted')
  await fs.mkdir(done, { recursive: true })
  while (!signal.stopped) {
    for (const name of await fs.readdir(dir)) {
      const file = path.join(dir, name)
      if (name === 'admitted' || name.startsWith('.')) continue
      try {
        const keyText = (await fs.readFile(file, 'utf8')).trim()
        const handle = name.replace(/\.key$/, '').toLowerCase()
        const { outcome } = await ctx.repo.addWriter(z32.decode(keyText), {
          handle: rules.HANDLE.test(handle) ? handle : null
        })
        out(
          `admitted ${name}: ${outcome.status}${outcome.reason ? ' (' + outcome.reason + ')' : ''}`
        )
      } catch (err) {
        out(`could not admit ${name}: ${err.message}`)
      }
      await fs.rename(file, path.join(done, name))
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

const seed = command(
  'seed',
  summary("Be the team's holder: stay online, hold every landed file, settle lands, admit writers"),
  flag('--no-mirror', "only replicate what peers ask for; don't download all landed content"),
  flag('--admit <dir>', 'admit writers whose keys are dropped into this directory'),
  flag('--updates', 'apply peer-to-peer OTA updates of hs while seeding'),
  withRepo(async (ctx, cmd) => {
    const mirror = cmd.flags.mirror !== false
    const net = await online(ctx, { mirror, server: true, ack: true, keepAlive: true })
    out(`seeding ${ctx.config.key}${mirror ? ' (mirror)' : ''}, ctrl+c to stop`)
    net.on('mirrored', (cs) => out(`mirrored #${cs.seq}`))
    net.on('mirrored-proposal', (p) => out(`mirrored P${p.id} revision ${p.revision}`))
    const updater = cmd.flags.updates ? await startUpdates(out) : null
    const signal = { stopped: false }
    let admitting = null
    if (cmd.flags.admit) {
      const dir = path.resolve(cmd.flags.admit)
      await fs.mkdir(dir, { recursive: true })
      admitting = admitLoop(ctx, dir, signal)
      out(`admitting writer keys dropped into ${dir}`)
    }
    await new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
    signal.stopped = true
    if (admitting) await admitting
    if (updater) await updater.close()
    await net.close()
  })
)

async function printWatchChangeset(repo, cs, json) {
  const author = await who(repo, cs)
  const files = (cs.files || []).concat(cs.paths > (cs.files || []).length ? ['...'] : [])
  if (json) {
    out(
      JSON.stringify({
        type: 'changeset',
        seq: cs.seq,
        hash: z32.encode(cs.hash),
        author,
        time: cs.time,
        message: cs.message,
        files
      })
    )
  } else {
    out(`#${cs.seq} ${author} ${files.join(' ')} :: ${oneLine(cs.message)}`)
  }
}

// does a review event concern this writer (as reviewer, author of the target, or requester)?
async function involves(repo, ev, me) {
  if (b4a.equals(ev.actor, me)) return false
  if (includesKey(ev.reviewers, me)) return true
  if (ev.proposal) {
    const p = await repo.proposal(ev.proposal)
    if (p && (b4a.equals(p.author, me) || includesKey(p.reviewers, me))) return true
  }
  if (ev.seq) {
    const cs = await repo.changeset(ev.seq)
    if (cs && b4a.equals(cs.writer, me)) return true
  }
  return false
}

async function printEvent(repo, ev, json) {
  const actor = await repo.nameOf(ev.actor)
  const target = ev.proposal ? 'P' + ev.proposal : '#' + ev.seq
  const reviewers = await namesOf(repo, ev.reviewers)
  const p = ev.proposal ? await repo.proposal(ev.proposal) : null
  let text = ''
  if (ev.type === 'proposal' || ev.type === 'proposal-updated') {
    const what = ev.type === 'proposal' ? 'proposed' : 'updated (approvals reset)'
    text = `@ ${target} ${what} by ${actor} for ${reviewers.join(',') || 'anyone'} :: ${oneLine(p && p.message)}`
  } else if (ev.type === 'review') {
    text =
      `@ ${target} ${VERDICT_NAMES[ev.verdict]} by ${actor}` +
      (ev.comment ? ` :: ${oneLine(ev.comment)}` : '')
    if (p) text += ` (${p.approvals}/${p.quorum})`
  } else if (ev.type === 'approved') {
    text = `@ ${target} approved (${p ? p.approvals + '/' + p.quorum : ''}): its author can land it`
  } else if (ev.type === 'landed') {
    text = `@ ${target} landed as #${ev.seq} by ${actor}`
  } else if (ev.type === 'request') {
    text = `@ #${ev.seq} by ${actor}: review requested from ${reviewers.join(',')}`
  } else {
    text = `@ ${ev.type} ${target} by ${actor}`
  }
  if (!json) return out(text)
  out(
    JSON.stringify({
      type: ev.type,
      n: ev.n,
      proposal: ev.proposal || null,
      seq: ev.seq || null,
      actor,
      verdict: ev.verdict ? VERDICT_NAMES[ev.verdict] : null,
      comment: ev.comment || null,
      reviewers,
      text
    })
  )
}

// one of your lands settled (seq), or, without --for-me, the settled point moved (through)
async function printSettled(repo, seq, through, json) {
  if (through !== null) {
    if (json) {
      return out(
        JSON.stringify({ type: 'settled', seq: through, text: `@ settled through #${through}` })
      )
    }
    return out(`@ settled through #${through}`)
  }
  const st = await repo.landStatus(seq)
  const text = st.final
    ? `@ #${seq} final`
    : `@ #${seq} settled; not final until ${st.waiting.join('; ')}`
  if (json) {
    return out(
      JSON.stringify({ type: st.final ? 'final' : 'settled', seq, waiting: st.waiting, text })
    )
  }
  out(text)
}

async function printReorg(repo, { seq, before, after }, json) {
  const wasBy = await who(repo, before)
  const nowBy = after ? await who(repo, after) : null
  if (json) {
    const brief = (cs, by) => (cs ? { author: by, message: cs.message } : null)
    out(JSON.stringify({ type: 'reorg', seq, was: brief(before, wasBy), now: brief(after, nowBy) }))
    return
  }
  const was = `${wasBy} "${oneLine(before.message)}"`
  const now = after ? `${nowBy} "${oneLine(after.message)}"` : 'nothing'
  out(`!! reorg: #${seq} was ${was}, now ${now}. If that was your land: hs sync && hs land`)
}

async function stopWatcher(root) {
  const pid = await Context.readNumber(root, 'watch.pid')
  if (!pid || !alive(pid)) {
    await fs.rm(Context.file(root, 'watch.pid'), { force: true })
    out('no background watcher running for this worktree')
    return
  }
  os.kill(pid, os.constants.signals.SIGTERM)
  for (let i = 0; i < 100 && alive(pid); i++) await sleep(100)
  await fs.rm(Context.file(root, 'watch.pid'), { force: true })
  out(`stopped watcher ${pid}`)
}

function alive(pid) {
  try {
    os.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const watch = command(
  'watch',
  summary('Stream lands, reviews and settlement as they happen (wait with --path/--count)'),
  flag('--path|-p <prefix>', 'only changesets touching this path (repeatable)').multiple(),
  flag(
    '--since <seq>',
    'start after this changeset (default: a feed resumes where it stopped; --count starts at your synced base)'
  ),
  flag('--count|-c <n>', 'exit after n changesets (with --for-me: n review events)'),
  flag('--new', 'with --count: only lands after the wait starts (default: since your last sync)'),
  flag('--author|-a <handle>', "only this teammate's changesets (repeatable)").multiple(),
  flag('--timeout <seconds>', 'give up after this long (exit code 2)'),
  flag('--json', 'one JSON object per line'),
  flag('--patch', 'include unified diffs'),
  flag('--stop', "stop this worktree's background feed"),
  flag('--for-me', 'only review activity that involves you (requests, reviews of your work)'),
  async (cmd) => {
    const { root, config } = await Context.load(process.cwd())
    if (cmd.flags.stop) return stopWatcher(root)

    // a feed (no --count) runs in the background and resumes where it stopped; a wait
    // (--count) starts from the base the worktree last synced to, so changes that already
    // landed but haven't been synced count too
    const waiting = cmd.flags.count !== undefined
    let since = null
    let sinceWhy = ''
    if (cmd.flags.since !== undefined) {
      since = Number(String(cmd.flags.since).replace(/^#/, ''))
    } else if (waiting && cmd.flags.new) {
      sinceWhy = ' (new lands only)'
    } else if (waiting) {
      since = await Context.readNumber(root, 'base')
      if (since !== null) sinceWhy = ' (your synced base)'
    } else {
      since = await Context.readNumber(root, 'watch.last')
      if (since !== null) sinceWhy = ' (resuming where the last feed stopped)'
    }

    // a separate observer store, so watch never holds the worktree's store lock; a second
    // concurrent watcher (e.g. a blocking --count 1 next to a background feed) gets a
    // throwaway store
    const opts = {
      key: z32.decode(config.key),
      encryptionKey: config.encryptionKey ? z32.decode(config.encryptionKey) : null
    }
    let dir = path.join(root, '.hs', 'watch')
    let temp = false
    let store = new Corestore(dir)
    let repo = new Repo(store, opts)
    try {
      await repo.ready()
    } catch (err) {
      if (!/could not be locked/i.test(err.message)) throw err
      await store.close().catch(() => {})
      dir = path.join(root, '.hs', 'watch-' + b4a.toString(crypto.randomBytes(4), 'hex'))
      temp = true
      store = new Corestore(dir)
      repo = new Repo(store, opts)
      await repo.ready()
    }
    // a feed is a long-lived peer: it announces, holds every landed file (so teammates can
    // still sync from it while the hub is down) and rejoins when it loses everyone. Waits
    // (--count) are short and stay client-only.
    const net = new Network(repo, {
      bootstrap: bootstrap(),
      blindPeers: blindPeers(config),
      server: !waiting,
      mirror: !waiting,
      keepAlive: !waiting
    })
    await net.ready()

    // feeds register themselves so `hs watch --stop` can stop exactly this worktree's feed
    let ownsPid = false
    if (!waiting) {
      const existing = await Context.readNumber(root, 'watch.pid')
      if (existing && alive(existing) && existing !== os.pid()) {
        warn(`watch: another feed (pid ${existing}) is already running for this worktree`)
      } else {
        await Context.writeNumber(root, 'watch.pid', os.pid())
        ownsPid = true
      }
    }

    // the review log resumes like the changeset feed: waits start from your last command,
    // feeds from where the last feed stopped
    const forMe = !!cmd.flags['for-me'] || !!cmd.flags.forMe
    const me = await Context.readWriter(root)
    if (forMe && !me) throw new Error('run any hs command in this worktree first (e.g. hs status)')
    // --for-me resumes from the last event it showed you: a sync can pull an approval in
    // without printing it, and starting from the sync's position would skip it forever
    const forMeSeen = forMe ? await Context.readNumber(root, 'forme.seen') : null
    const eventsSince =
      cmd.flags.since !== undefined
        ? 0
        : forMeSeen !== null
          ? forMeSeen
          : waiting
            ? await Context.readNumber(root, 'events')
            : await Context.readNumber(root, 'watch.events')
    const watcher = new Watcher(repo, {
      since,
      paths: cmd.flags.path || [],
      authors: cmd.flags.author || [],
      eventsSince
    })
    let lastSettled = 0
    let printedThrough = since || 0 // the last changeset this feed showed
    let pendingSettled = 0 // settlement reported before its changeset arrived
    const announced = new Set() // lands already reported final (status is read as of now)
    const limit = waiting ? Number(cmd.flags.count) : Infinity
    const json = !!cmd.flags.json
    let seen = 0
    let hubTimer = null
    let unsettledSince = null
    let lastSettledSeen = -1
    let hubStalled = false
    const checkHub = async () => {
      const m = await repo.meta()
      const settled = m.settled || 0
      await Context.writeNumber(root, 'watch.settled', settled).catch(() => {})
      if (settled !== lastSettledSeen) {
        const recovered = hubStalled && lastSettledSeen >= 0 && settled > lastSettledSeen
        lastSettledSeen = settled
        unsettledSince = m.seq > settled ? Date.now() : null
        if (recovered) {
          hubStalled = false
          if (json) out(JSON.stringify({ type: 'hub', state: 'settling', settled }))
          else warn(`watch: hub settling again: settled through #${settled}`)
        }
      }
      if (m.seq <= settled) {
        unsettledSince = null
        return
      }
      if (unsettledSince === null) unsettledSince = Date.now()
      if (!hubStalled && Date.now() - unsettledSince >= hubStallMs()) {
        hubStalled = true
        if (json) {
          out(
            JSON.stringify({
              type: 'hub',
              state: 'stalled',
              settled,
              head: m.seq,
              hint: 'keep working: lands still reach teammates and settle when the hub is back'
            })
          )
        } else {
          warn(
            `!! watch: hub not settling: lands after #${settled} stay provisional (hub down or ` +
              'behind). They still reach teammates and settle when it is back'
          )
        }
      }
    }
    let startHead = Infinity
    let notedOld = false
    let timedOut = false
    let queue = Promise.resolve()
    let timer = null

    const stop = new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
      if (cmd.flags.timeout) {
        timer = setTimeout(
          () => {
            timedOut = true
            resolve()
          },
          Number(cmd.flags.timeout) * 1000
        )
      }
      // --count counts changesets; review events count only for --for-me, which is about them
      const emitLine = async (fn, n) => {
        if (seen >= limit) return
        if (!forMe) return fn()
        seen++
        await fn()
        if (n) await Context.writeNumber(root, 'forme.seen', n).catch(() => {})
        if (seen >= limit) resolve()
      }
      watcher.on('event', (ev) => {
        queue = queue.then(async () => {
          if (seen >= limit) return
          if (!waiting) await Context.writeNumber(root, 'watch.events', ev.n).catch(() => {})
          // a path- or author-filtered watch is about those changesets only
          if (!forMe && (cmd.flags.path || cmd.flags.author)) return

          if (ev.type === 'settled') {
            const from = lastSettled
            lastSettled = Math.max(lastSettled, ev.seq)
            // a wait is for changesets; settlement lines would only be noise there
            if (!forMe) {
              if (waiting) return
              // never announce settlement of a changeset the feed hasn't shown yet
              if (ev.seq > printedThrough) pendingSettled = Math.max(pendingSettled, ev.seq)
              else await printSettled(repo, null, ev.seq, json)
              return
            }
            // your own lands that just settled (and maybe became final)
            for (let seq = from + 1; seq <= ev.seq; seq++) {
              const cs = await repo.changeset(seq)
              if (!cs || !b4a.equals(cs.writer, me) || announced.has(seq)) continue
              const st = await repo.landStatus(seq)
              if (st && st.final) announced.add(seq)
              await emitLine(() => printSettled(repo, seq, null, json), ev.n)
            }
            return
          }

          if (forMe && !(await involves(repo, ev, me))) return
          await emitLine(() => printEvent(repo, ev, json), ev.n)

          // an approval can be what makes your settled Show land final
          if (forMe && ev.type === 'review' && ev.seq) {
            const cs = await repo.changeset(ev.seq)
            const st = cs && b4a.equals(cs.writer, me) && (await repo.landStatus(ev.seq))
            if (st && st.final && !announced.has(ev.seq)) {
              announced.add(ev.seq)
              await emitLine(() => printSettled(repo, ev.seq, null, json), ev.n)
            }
          }
        })
      })
      watcher.on('changeset', (cs) => {
        queue = queue.then(async () => {
          if (seen >= limit || forMe) return
          seen++
          // a wait answered by something that landed before it started: say so, it's easy to
          // read as "it just landed" or as the wait not working
          if (waiting && cs.seq <= startHead && !notedOld) {
            notedOld = true
            warn(
              `watch: already on main before this wait (landed after your last sync); ` +
                '`hs sync` brings it in, `--new` waits only for new lands'
            )
          }
          await printWatchChangeset(repo, cs, json)
          if (cmd.flags.patch) {
            const text = await renderShow(repo, cs.seq, { timeout: FETCH_TIMEOUT }).catch(
              (err) => `(diff unavailable: ${err.message})\n`
            )
            out(text)
          }
          if (!waiting) await Context.writeNumber(root, 'watch.last', cs.seq).catch(() => {})
          printedThrough = Math.max(printedThrough, cs.seq)
          if (pendingSettled) {
            await printSettled(repo, null, Math.min(pendingSettled, printedThrough), json)
            if (pendingSettled <= printedThrough) pendingSettled = 0
          }
          if (seen >= limit) resolve()
        })
      })
      watcher.on('reorg', (ev) => {
        queue = queue.then(() => printReorg(repo, ev, json))
      })
      watcher.on('error', (err) => warn('watch: ' + err.message))
      // a feed says when it can't reach anyone, so silence never looks like "nothing landed"
      net.on('offline', () => {
        queue = queue.then(() => {
          if (json) out(JSON.stringify({ type: 'offline', at: new Date().toISOString() }))
          else warn('!! watch: no peers reachable (hub down or network lost); reconnecting...')
        })
      })
      // the hub (indexer) being down doesn't stop teammates reaching each other, so the feed
      // stays online; what shows it is lands staying provisional. Say so after a while.
      if (!waiting) {
        hubTimer = setInterval(() => {
          queue = queue.then(() => checkHub()).catch(() => {})
        }, HUB_CHECK_MS)
      }
      net.on('online', () => {
        queue = queue.then(() => {
          if (json) out(JSON.stringify({ type: 'online', at: new Date().toISOString() }))
          else warn('watch: peers reachable again')
        })
      })
    })

    try {
      if (!(await net.waitForPeers({ timeout: waiting ? 30_000 : 10_000 }))) {
        if (waiting) warn('watch: no peers yet, waiting...')
        else net.markOffline()
      }
      await net.settle({ timeout: 10_000 })
      // where settlement stood at the watch's starting point, so only newly settled lands show
      // (computed after settling, before any events are delivered)
      const startEvent = eventsSince === null ? await repo.eventCount() : eventsSince
      if (startEvent > 0) {
        for (const ev of await repo.events({ since: 0, limit: startEvent })) {
          if (ev.type === 'settled') lastSettled = Math.max(lastSettled, ev.seq)
        }
      }
      // main as the wait starts: a counted changeset at or below this was already there
      startHead = (await repo.meta()).seq
      await watcher.start()
      if (!json) {
        const what =
          (cmd.flags.path ? ' for ' + cmd.flags.path.join(' ') : '') +
          (cmd.flags.author ? ' by ' + cmd.flags.author.join(' ') : '')
        warn(`watching main after #${watcher.last}${sinceWhy}${what}`)
      }
      await stop
      await queue
      if (timedOut) {
        const what = forMe ? 'event(s) for you' : 'matching changeset(s)'
        warn(`watch: timed out after ${cmd.flags.timeout}s with ${seen} ${what}`)
        process.exitCode = 2
      }
    } finally {
      if (timer) clearTimeout(timer)
      if (hubTimer) clearInterval(hubTimer)
      if (!waiting) {
        await Context.writeNumber(root, 'watch.last', watcher.last).catch(() => {})
        await Context.writeNumber(root, 'watch.events', watcher.lastEvent).catch(() => {})
      }
      await watcher.close()
      await net.close()
      await repo.close()
      await store.close()
      if (temp) await fs.rm(dir, { recursive: true, force: true })
      if (ownsPid) await fs.rm(Context.file(root, 'watch.pid'), { force: true })
    }
  }
)

const doctor = command(
  'doctor',
  summary(
    'Check peers and whether a holder serves main (fetches your sparse set as a side effect)'
  ),
  withRepo(async (ctx) => {
    const ws = await ctx.workspace()
    const net = await online(ctx)
    try {
      const connected = await net.waitForPeers({ timeout: FETCH_TIMEOUT })
      out(`peers        ${net.connections}${connected ? '' : ' (none found)'}`)
      if (connected) await net.settle()
      const meta = await ctx.repo.meta()
      out(`main         #${meta.seq} ${short(meta.hash)}`)
      out(
        `settled      through #${meta.settled || 0}${(meta.settled || 0) < meta.seq ? ` (${meta.seq - (meta.settled || 0)} provisional)` : ''}`
      )
      for (const k of await ctx.repo.indexers()) {
        const seenSeq = await ctx.repo.seenBy(k)
        const lag =
          seenSeq < meta.seq ? `  !! behind: lands won't settle until it acks (is it online?)` : ''
        out(`indexer      ${await ctx.repo.nameOf(k)} has seen #${seenSeq}${lag}`)
      }
      out(`writer       ${ctx.repo.writable ? 'yes' : 'no (ask for hs add-writer)'}`)
      out(`blind peers  ${(ctx.config.blindPeers || []).length || 'none configured'}`)

      const views = await ctx.repo.main.view.cores({ local: false })
      let held = 0
      for (const key of views) {
        const core = ctx.repo.store.get({ key, encryption: ctx.repo.getEncryption() })
        await core.ready()
        if (core.length > 0 && core.peers.some((p) => p.remoteContiguousLength >= core.length)) {
          held++
        }
        await core.close()
      }
      out(
        `main tree    ${views.length ? `${held}/${views.length} remote view cores fully held by a connected peer` : 'all local'}`
      )

      if (connected) {
        const res = await ws.prefetch({ sparse: ctx.config.sparse, timeout: FETCH_TIMEOUT })
        if (res.missing.length) {
          out(`content      ${res.missing.length} file(s) unobtainable`)
          reportMissing(res.missing)
        } else {
          out('content      everything in your sparse set is obtainable')
          out('verdict      ok: a holder is online')
        }
      } else {
        out('verdict      offline: no peers. ' + HOLDER_HINT)
        process.exitCode = 2
      }
      await flipBanner(ws)
      await renumberNote(ctx, ws)
    } finally {
      await net.close()
    }
  })
)

const importCmd = command(
  'import-git',
  summary("Replay a git branch's first-parent history onto main"),
  arg('<gitdir>', 'path to a git repository'),
  flag('--branch|-b <ref>', 'branch or ref to import (default HEAD)'),
  flag('--limit|-n <n>', 'only the first n commits'),
  withRepo(async (ctx, cmd) => {
    if (!ctx.repo.writable) throw new Error('not a writer')
    const started = Date.now()
    const stats = await importGit(ctx.repo, path.resolve(cmd.args.gitdir), {
      branch: cmd.flags.branch || 'HEAD',
      limit: cmd.flags.limit ? Number(cmd.flags.limit) : Infinity,
      onprogress(s) {
        if (s.commits % 100 === 0) out(`  ${s.commits} commits, ${s.paths} paths`)
      }
    })
    const secs = (Date.now() - started) / 1000
    out(
      `imported ${stats.commits} commits as ${stats.changesets} changesets, ${stats.paths} path changes, ${(stats.bytes / 1e6).toFixed(1)} MB in ${secs.toFixed(1)}s`
    )
    if (stats.skipped) out(`skipped ${stats.skipped} symlinks/submodules`)
  })
)

const blindPeer = command(
  'blind-peer',
  summary('Add a blind peer to keep this repo available (encrypted at rest on the peer)'),
  arg('<key>', 'blind peer public key'),
  flag('--remove', 'remove instead of add'),
  withRepo(async (ctx, cmd) => {
    const set = new Set(ctx.config.blindPeers || [])
    if (cmd.flags.remove) set.delete(cmd.args.key)
    else set.add(cmd.args.key)
    ctx.config.blindPeers = [...set]
    await ctx.save()
    out('blind peers:', ctx.config.blindPeers.join(' ') || '(none)')
  })
)

const info = command(
  'info',
  summary('Show repo key, writer key and main head'),
  withRepo(async (ctx) => {
    const meta = await ctx.repo.meta()
    out('repo     ', ctx.config.key, ctx.config.encryptionKey ? '(encrypted)' : '')
    out('invite   ', ctx.invite)
    out(
      'writer   ',
      z32.encode(ctx.repo.writerKey),
      ctx.repo.writable ? '(writable)' : '(read-only)'
    )
    out('main     ', `#${meta.seq} ${short(meta.hash)}`)
    out('workspace', ctx.config.workspace)
    out('sparse   ', ctx.config.sparse.join(' '))
  })
)

const addWriter = command(
  'add-writer',
  summary('Allow another peer to land changes'),
  arg('<key>', 'writer key (from `hs info` on the other peer)'),
  flag('--as <handle>', "the writer's handle, how teammates name them as reviewers and owners"),
  flag('--indexer', 'make the writer an indexer (lands settle only once every indexer acks)'),
  flag('--offline', "don't wait for a peer to receive it"),
  withRepo(async (ctx, cmd) => {
    const key = z32.decode(cmd.args.key)
    if (!cmd.flags.as) warn('no --as <handle>: teammates cannot name this writer as a reviewer')
    const { outcome } = await ctx.repo.addWriter(key, {
      indexer: !!cmd.flags.indexer,
      handle: cmd.flags.as || null
    })
    out(`add-writer: ${outcome.status}${outcome.reason ? ' (' + outcome.reason + ')' : ''}`)
    if (outcome.status !== 'accepted' || cmd.flags.offline) return
    const net = await online(ctx)
    try {
      const ok = (await net.waitForPeers({ timeout: 5000 })) && (await net.uploaded())
      if (ok) out('pushed: a peer has it; the new writer can land once they pull')
      else out('no peers online yet: it reaches the new writer when you next go online (hs push)')
    } finally {
      await net.close()
    }
  })
)

module.exports = function createCli(extra = []) {
  return command(
    'hs',
    summary('hyperscion: peer-to-peer source control for agent-scale change volume'),
    description(
      'Workspaces fork main in O(1), commits cost O(change), lands are lock-free. ' +
        'For agents: see docs/AGENTS.md.'
    ),
    // daily loop
    status,
    diff,
    land,
    sync,
    log,
    show,
    watch,
    // review
    propose,
    reviewCmd,
    proposalsCmd,
    // files and workspaces
    ls,
    cat,
    exportCmd,
    restore,
    commitCmd,
    checkout,
    ws,
    // setup and network
    init,
    clone,
    addWriter,
    info,
    doctor,
    fetchCmd,
    pull,
    push,
    seed,
    blindPeer,
    importCmd,
    ...extra
  )
}

module.exports.short = short
