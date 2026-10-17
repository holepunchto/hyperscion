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
const claims = require('./claims')
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
  // the command already holds a connection (mainLocal): share it; withRepo closes it
  if (ctx.net && !ctx.net.closing && !Object.keys(opts).length) return shared(ctx.net)
  if (ctx.readOnly) {
    const busy = await Context.busy(ctx.root)
    const err = new Error(
      `this needs the network, and ${busy ? '`hs ' + busy.command + '`' : 'another hs process'} ` +
        'is using this worktree; run it again when that finishes'
    )
    err.code = 'WORKTREE_BUSY'
    throw err
  }
  const net = new Network(ctx.repo, {
    bootstrap: bootstrap(),
    blindPeers: blindPeers(ctx.config),
    server: false,
    ...opts
  })
  await net.ready()
  return net
}

function shared(net) {
  return new Proxy(net, {
    get(target, prop) {
      if (prop === 'close') return () => Promise.resolve()
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
}

async function pullMain(net, { timeout = FETCH_TIMEOUT, quiet = false } = {}) {
  if (!(await net.waitForPeers({ timeout }))) {
    dlog('pull: no peers')
    if (!quiet) warn('no peers found, using local state')
    return false
  }
  dlog(`pull: peers ${net.connections} holder=${net.holderConnected()}`)
  const settled = await net.settle()
  dlog(`pull: settled=${settled}`)
  // hold the view blocks of what was just applied, while peers are here to serve them
  const gaps = await net.fetchViews().catch(() => -1)
  dlog(`pull: view gaps ${gaps}`)
  return true
}

// pull main and make everything the sparse set needs local (see Workspace.prefetch)
async function pullAndPrefetch(ctx, ws, net, { timeout = FETCH_TIMEOUT } = {}) {
  // callers say what being unreachable means for them (sync: local main; land: local only)
  const connected = await pullMain(net, { timeout, quiet: true })
  ws.io = { timeout: FETCH_TIMEOUT }
  if (!connected) return { connected, fetched: 0, missing: [] }
  const res = await ws.prefetch({ sparse: ctx.config.sparse, timeout: FETCH_TIMEOUT })
  dlog(`prefetch: fetched ${res.fetched} missing ${res.missing.length}`)
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
      '`hs sync` brings them back and lands them again'
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
  dlog(`checkout: written ${first.written} missing ${first.missing.length}`)
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

// HS_DEBUG_LAND=<file>: phase timings of land/sync (pull, settle, prefetch, check rounds,
// land op, push), appended one line each; the experiment wrappers set it, agents never see it
const DLOG = process.env.HS_DEBUG_LAND || null
const DLOG_T0 = Date.now()
let dlogCmd = '-'
function dlog(what) {
  if (!DLOG) return
  try {
    require('bare-fs').appendFileSync(
      DLOG,
      `${new Date().toISOString()} ${process.pid} ${dlogCmd} +${Date.now() - DLOG_T0}ms ${what}\n`
    )
  } catch {}
}

// readOnly: a command that only reads (status, log, show, ...) still runs while another hs
// command (a land) holds the worktree: on the local data, offline, and it says so
function withRepo(fn, { readOnly = false, checkMain = true } = {}) {
  return async (cmd) => {
    dlogCmd = (cmd && cmd.command && cmd.command.name) || '-'
    dlog('start')
    const ctx = await Context.open(process.cwd(), { allowReadOnly: readOnly })
    try {
      if (checkMain) await mainLocal(ctx)
    } catch (err) {
      await ctx.close().catch(() => {})
      throw err
    }
    if (ctx.readOnly) {
      const busy = await Context.busy(ctx.root)
      const what = busy ? `\`hs ${busy.command}\` (pid ${busy.pid})` : 'another hs process'
      warn(`(${what} is using this worktree: showing local data, offline)`)
    } else {
      await ctx.markBusy((cmd && cmd.command && cmd.command.name) || 'command').catch(() => {})
    }
    try {
      await fn(ctx, cmd)
    } catch (err) {
      if (err.code === 'CONTENT_UNAVAILABLE') {
        throw new Error(`${err.message}; nothing was changed. ${HOLDER_HINT}`)
      }
      // read-only (another command holds the worktree): what this needs isn't local yet, and
      // fetching it would write (q2s-claims-3: `cat` printed "Batch was not applied")
      if (ctx.readOnly && /Batch was not applied|read.?only/i.test(err.message)) {
        const busy = await Context.busy(ctx.root)
        throw new Error(
          `this needs data that isn't local yet, and ${busy ? '`hs ' + busy.command + '`' : 'another hs process'} ` +
            'is using this worktree; run it again when that finishes'
        )
      }
      throw err
    } finally {
      if (ctx.net) await ctx.net.close().catch(() => {})
      if (!ctx.readOnly) await ctx.saveBase().catch(() => {})
      await ctx.close()
    }
  }
}

const withRepoRead = (fn) => withRepo(fn, { readOnly: true })
// holders (seed, blind-peer) fetch and serve main themselves, and doctor and push are what you
// run when things are wrong: none of them should be stopped by missing view blocks
const withRepoAsIs = (fn) => withRepo(fn, { checkMain: false })

// which surface agents see (the q0 experiment's arms): 'full' (default), 'minimal' (land,
// sync, look, claims and claim; the rest hidden), 'plain' (no hs coordination at all)
function surface() {
  const s = process.env.HS_SURFACE
  return s === 'minimal' || s === 'plain' ? s : 'full'
}

// Main's index must be local before a command reads it. A fast-forward moves the view cores
// ahead of what's downloaded, and if the command that did it ends early (q2h-1: a land killed
// while the hub was down), every later read of main waited for blocks before going online, so
// the event loop drained and each command said "stalled" (a2 lost the run). Fill the gaps from
// peers first, bounded, or say plainly what's missing.
async function mainLocal(ctx) {
  const missing = ctx.repo.viewCoreGap()
  // the listing reads the view: if it can't finish, treat it as missing too
  const gaps = missing ? 1 : ((await withTimeout(ctx.repo.viewGaps(), 3000)) ?? 1)
  // read-only (another command holds the worktree) can't go online; it shows local data
  if (!gaps || ctx.readOnly) return
  dlog(`main: ${gaps} view core(s) not fully local`)
  // never refuse: most commands read only blocks that are here (q2h-2: refusing when any view
  // core had a gap stopped every land through the outage). Fill what peers can serve, and
  // keep this connection for the whole command, so a read of a missing block is served
  // instead of draining the event loop ("stalled")
  const net = await online(ctx)
  ctx.net = net
  let left = gaps
  if (await net.waitForPeers({ timeout: 5000 })) {
    await net.fetchViews(5000)
    left = ctx.repo.viewCoreGap() ? 1 : ((await withTimeout(ctx.repo.viewGaps(), 3000)) ?? 1)
  }
  dlog(
    `main: view gaps ${gaps} -> ${left}, peers ${net.connections} holder=${net.holderConnected()}`
  )
}

function withTimeout(promise, ms) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const INCOMING_MAX = 25

// how long lands may stay unsettled before feeds and status call the hub out
const HUB_CHECK_MS = 5000
const hubStallMs = () => Number(process.env.HS_HUB_STALL_S || 20) * 1000

// One line per changeset that arrived between two bases, oldest first, skipping our own.
// When there are more than fit, the busiest top-level directories (a swarm's /swarm/, say)
// fold into one summary line each, largest first, until the rest fit: teammates' changesets
// to the code you share are listed instead of hidden behind "... and 220 later". Root files
// (NOTES.md, CONTRACTS.md) and changesets spanning several directories never fold.
async function printIncoming(ctx, from, to, { skipSeq = -1 } = {}) {
  const own = ctx.repo.writerKey
  const all = (await ctx.repo.changesetsBetween(from, to)).filter(
    (cs) => cs.seq !== skipSeq && !b4a.equals(cs.writer, own)
  )
  if (!all.length) return 0
  // changesets only under paths /.hsattributes marks quiet (a swarm's) are a count, not lines
  const attrs = merge.parseAttributes(await mainText(ctx, '/.hsattributes', { wait: false }))
  const list = all.filter((cs) => !merge.quietChangeset(attrs, cs))
  const quiet = all.length - list.length
  if (!list.length) {
    out(`incoming: ${quiet} changeset(s) under quiet paths only (hs log -n ${all.length})`)
    return all.length
  }

  const groups = new Map() // top-level dir -> changesets entirely under it
  for (const cs of list) {
    const dir = topDir(cs)
    if (!dir) continue
    if (!groups.has(dir)) groups.set(dir, [])
    groups.get(dir).push(cs)
  }
  const folded = []
  let shown = list
  for (const [dir, group] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    if (shown.length <= INCOMING_MAX || group.length < 2) break
    folded.push([dir, group])
    shown = shown.filter((cs) => topDir(cs) !== dir)
  }

  out(`incoming from teammates (${list.length})${quiet ? `, +${quiet} under quiet paths` : ''}:`)
  for (const cs of shown.slice(0, INCOMING_MAX)) {
    const files = (cs.files || []).slice(0, 4).join(' ') + (cs.paths > 4 ? ' ...' : '')
    out(`  #${cs.seq} ${await who(ctx.repo, cs)} ${files} :: ${oneLine(cs.message)}`)
  }
  if (shown.length > INCOMING_MAX) {
    out(`  ... and ${shown.length - INCOMING_MAX} later (hs log -n ${all.length})`)
  }
  for (const [dir, group] of folded) {
    const writers = new Set(group.map((cs) => b4a.toString(cs.writer, 'hex'))).size
    out(
      `  ${dir}/: ${group.length} changeset(s) by ${writers} writer(s), ` +
        `#${group[0].seq}..#${group[group.length - 1].seq}, only under ${dir}/ (hs log -n ${all.length})`
    )
  }
  return list.length
}

// the top-level directory every file of a changeset is under ('/src'), or null (root files,
// several directories, or a changeset too big to list all its files)
function topDir(cs) {
  const files = cs.files || []
  if (!files.length || files.length < (cs.paths || 0)) return null
  let dir = null
  for (const f of files) {
    const m = f.replace(/^-/, '').match(/^(\/[^/]+)\//)
    if (!m || (dir && m[1] !== dir)) return null
    dir = m[1]
  }
  return dir
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
  summary('Create a new repo in a directory (with --hub, also the team hub that settles lands)'),
  arg('[dir]', 'directory, defaults to cwd'),
  flag('--encrypt', 'encrypt all repo data at rest (peers need the invite to read it)'),
  flag('--as <handle>', 'your handle in this repo (default: $USER)'),
  flag('--hub <dir>', "create the team's hub worktree there: an indexer that settles lands"),
  async (cmd) => {
    const root = path.resolve(cmd.args.dir || process.cwd())
    if (await Context.find(root)) throw new Error('already inside a hyperscion worktree')
    const encryptionKey = cmd.flags.encrypt ? crypto.randomBytes(32) : null
    // new repos have a light bootstrap writer: it is a plain writer, and the hub is a
    // separate indexer, so a hub that dies for good can be removed and replaced
    const ctx = await Context.create(root, { encryptionKey, bootstrapWeight: 1 })
    try {
      await ctx.workspace()
      const handle = cmd.flags.as || (process.env.USER || '').toLowerCase()
      if (rules.HANDLE.test(handle)) await ctx.repo.addWriter(ctx.repo.writerKey, { handle })
      let hub = null
      if (cmd.flags.hub) hub = await createHub(ctx, path.resolve(cmd.flags.hub), encryptionKey)
      await ctx.saveBase()
      out('initialized', root)
      out('repo', ctx.invite)
      if (rules.HANDLE.test(handle)) out('you are', handle)
      if (hub) out(`hub ${hub}: an indexer; run \`hs seed\` there and keep it online`)
      else out('for a team, a hub settles lands: `hs init --hub <dir>` next time, or see README')
    } finally {
      await ctx.close()
    }
  }
)

// The hub as its own worktree and writer, added as the repo's indexer. Both stores are local,
// so they replicate in-process until the hub sees itself writable.
async function createHub(ctx, dir, encryptionKey) {
  if (await Context.find(dir)) throw new Error(dir + ' is already inside a hyperscion worktree')
  const hub = await Context.create(dir, { key: ctx.repo.key, encryptionKey, bootstrapWeight: 1 })
  try {
    await hub.workspace()
    await ctx.repo.addWriter(hub.repo.writerKey, { indexer: true, handle: 'hub' })
    const s1 = ctx.store.replicate(true)
    const s2 = hub.store.replicate(false)
    s1.pipe(s2).pipe(s1)
    try {
      for (let i = 0; i < 400 && !hub.repo.writable; i++) {
        await ctx.repo.update()
        await hub.repo.update()
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if (!hub.repo.writable) throw new Error('the hub did not become a writer')
      // the hub acks once, so it is known to have seen main
      await hub.repo.ack()
      for (let i = 0; i < 20; i++) {
        await hub.repo.update()
        await ctx.repo.update()
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    } finally {
      s1.destroy()
      s2.destroy()
    }
    await hub.saveBase()
    return dir
  } finally {
    await hub.close()
  }
}

const status = command(
  'status',
  summary('Your edits, unlanded work, lands not yet final, and reviews waiting for you'),
  withRepoRead(async (ctx) => {
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
  const behind = await indexersBehind(ctx.repo, settled + 1)
  if (behind.length) warn(`   waiting for: ${behind.join(', ')}. ${replaceHint(ctx)}`)
}

// Replacing a dead hub is the team owner's call (the repo's bootstrap writer): an agent told
// to `hs add-writer --indexer` during a two-minute outage found it alarming (q2-hs-6)
function isOwner(ctx) {
  return b4a.equals(ctx.repo.writerKey, ctx.repo.main.key)
}

function replaceHint(ctx, name = '<old>') {
  return isOwner(ctx)
    ? 'If it is gone for good, replace it: `hs add-writer <new key> --indexer`, then ' +
        `\`hs remove-writer ${name}\``
    : 'Nothing to do: keep working. If it stays down for long, tell the team owner.'
}

// indexers that haven't seen #seq yet
async function indexersBehind(repo, seq) {
  const out = []
  for (const k of await repo.settlers()) {
    if ((await repo.seenBy(k)) < seq) out.push(await repo.nameOf(k))
  }
  return out
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
  // the minimal surface hides these: a land links itself to its item (TO-FIVE #6)
  (surface() === 'full' ? flag : hiddenFlag)(
    '--item <id>',
    'the item(s) this land completes (docs/CLAIMS.md; repeatable)'
  ).multiple(),
  (surface() === 'full' ? flag : hiddenFlag)(
    '--under <id>',
    'an approved item this land is part of, without closing it (protected paths; repeatable)'
  ).multiple(),
  hiddenFlag('--online|-o', 'the default; kept so old habits still work'),
  flag(
    '--no-split',
    'when some files need approval (/.hsreview), land nothing instead of the rest (the default lands the rest and proposes them)'
  ),
  withRepo(landWithSplit)
)

// --split (TO-FIVE #14: every agent in q2h-3 split by hand): set the protected files aside,
// land the rest, put them back and propose them to whoever /.hsreview names
async function landWithSplit(ctx, cmd) {
  const ws = await ctx.workspace()
  const committed = await commitWorktree(ctx, ws)
  if (committed.blocked.length) {
    throw new Error('refusing to land while files are edited on top of stale copies (see above)')
  }
  for (let attempt = 0; ; attempt++) {
    ctx.aside = null
    ctx.splitItems = null
    ctx.asideProp = null
    ctx.detach = false
    try {
      await landMain(ctx, cmd, ws)
    } finally {
      // landMain set protected files aside (ctx.aside): always put them back
      if (ctx.aside) await putBack(ctx, ws, ctx.aside)
    }
    // TO-FIVE #1: undone by a concurrent land that came first (an outage): bring it back on
    // top of main and land it again, with the same message and --check
    if (ctx.landOutcome !== 'flipped' || attempt >= 2) break
    if (!(await restoreUndone(ctx, ws))) return
    out(`landing #${ctx.undoneSeq} again on top of main`)
    ctx.relanded = ctx.relanded || ctx.undoneSeq
  }
  if (ctx.landOutcome === 'accepted' && ctx.relanded) {
    out(`#${ctx.relanded} re-landed as #${ctx.landedSeq}`)
  }
  if (ctx.aside && ctx.landOutcome === 'accepted') {
    // an approved proposal that already holds exactly these files: land it next, as is (#22)
    // an approved proposal of protected files that this work went beyond (#24; q2h-7: a2's new
    // contract line re-proposed its approved P1 and reset ann's approval): land what was
    // approved first, then propose only the new lines
    const files = ctx.aside
    const items = ctx.splitItems || []
    if (ctx.asideProp && (await landApprovedFirst(ctx, ws, ctx.asideProp, files))) {
      await proposeProtected(ctx, ws, files, cmd.flags.message || '', items)
      return
    }
    if (!ctx.aside) return // landApprovedFirst tried and put the files back; it said why
    const held = ctx.asideProp && (await proposalHolds(ctx, ws, ctx.asideProp, ctx.aside))
    if (held) {
      const files = ctx.aside.map((f) => f.path).join(' ')
      out(
        held === 'approved'
          ? `P${ctx.asideProp.id} (approved) holds ${files}: \`hs land\` lands it`
          : `P${ctx.asideProp.id} holds ${files}, waiting for review: \`hs land\` once it's approved`
      )
      return
    }
    await proposeProtected(ctx, ws, ctx.aside, cmd.flags.message || '', ctx.splitItems || [])
  }
}

// lands an approved proposal's own content when the current files went beyond it; afterwards
// the files are as they were (the new lines left for a fresh proposal). False when it doesn't
// apply: not approved, not only protected files, or unchanged
async function landApprovedFirst(ctx, ws, prop, files) {
  const now = await ctx.repo.proposal(prop.id)
  if (!now || now.statusName !== 'approved') return false
  const paths = new Set(files.map((f) => f.path))
  const entries = now.entries || []
  if (!entries.length || !entries.every((e) => paths.has(e.path))) return false
  if (await proposalHolds(ctx, ws, now, files)) return false
  // the approved text, written over the new one for one land
  for (const e of entries) {
    const abs = ctx.worktree._abs(e.path)
    if (!e.value) await fs.rm(abs, { force: true })
    else await fs.writeFile(abs, await ws._read(e.value, e.path))
  }
  await commitWorktree(ctx, ws)
  out(`P${now.id} is approved: landing it as approved first, then proposing your new lines`)
  ctx.aside = null
  try {
    await landMain(ctx, { flags: { message: now.message || `P${now.id}` } }, ws)
  } finally {
    await putBack(ctx, ws, files)
  }
  return ctx.landOutcome === 'accepted'
}

// the one open item a land belongs to, when it names none (TO-FIVE #6): an item whose paths
// cover what the land changes, or, for items without paths (a change request), one this
// writer holds a live claim on. Exactly one candidate or nothing; it links as `under`, so a
// piece never closes a whole item (TO-FIVE #26): the lead closes it with `claim --done`
async function autoLink(ctx, net, ws) {
  const board = net.board
  await withTimeout(board.load(ctx.repo), 3000).catch(() => {})
  const changed = (await ws.changes()).map((e) => e.path)
  // a land that only posts to the team's notes isn't part of an item (q0bo-min: a note
  // saying "I step back" was linked to the item its author had lost)
  if (!changed.length || changed.every((p) => p === '/NOTES.md' || p === '/TASKS.md')) return null
  // items I lead or share, not every item I once claimed
  const me = ctx.repo.writerKey
  const mine = new Set()
  for (const it of board.items.values()) {
    const l = it.id && board.lead(it.id)
    if (!l) continue
    if (b4a.equals(l.lead.writer, me) || l.coLeads.some((p) => b4a.equals(p.writer, me))) {
      mine.add(b4a.toString(it.id, 'hex'))
    }
  }
  const hits = []
  for (const it of board.items.values()) {
    if (!it.id || it.done || it.dropped) continue
    const paths = it.paths || []
    const covers = paths.length && changed.some((p) => rules.covers(paths, p))
    const claimed = !paths.length && mine.has(b4a.toString(it.id, 'hex'))
    if (covers || claimed) hits.push(it)
  }
  return hits.length === 1 ? hits[0] : null
}

async function printOpenItems(ctx, net) {
  const board = net ? net.board : new claims.Board()
  await withTimeout(board.load(ctx.repo), 3000).catch(() => {})
  const open = [...board.items.values()]
    .filter((it) => it.id && it.author && !it.done && !it.dropped && !it.parent)
    .sort((a, b) => (a.time || 0) - (b.time || 0))
  for (const it of open.slice(0, 3)) {
    const l = board.lead(it.id)
    const me = ctx.repo.writerKey
    const who = !l
      ? 'nobody on it'
      : b4a.equals(l.lead.writer, me)
        ? 'you lead'
        : `${await ctx.repo.nameOf(l.lead.writer)} leads`
    out(`open item ${claims.shortId(it.id)} "${oneLine(it.title || '')}": ${who}`)
  }
  if (open.length > 3) out(`  and ${open.length - 3} more (hs claims)`)
}

// sync the workspace so an undone land's changes are back on top of main; false on conflict
async function restoreUndone(ctx, ws) {
  const res = await ws.sync()
  if (!res.conflicts.length) return true
  await materialize(ctx, ws, null)
  warn(
    `!! your undone land conflicts with what came first: ${res.conflicts.join(' ')}. ` +
      'Fix the <<<<<<< markers, then `hs land` again'
  )
  process.exitCode = 2
  return false
}

// an open proposal that is exactly these files as they are now: its status, or null
async function proposalHolds(ctx, ws, prop, files) {
  const now = await ctx.repo.proposal(prop.id)
  if (!now || now.statusName === 'landed') return null
  // compare content hashes: the same text rewritten is a new blob (a new entry), same hash
  const hashOf = (value) => (value ? c.decode(driveEntry, value).hash : null)
  const want = new Map((now.entries || []).map((e) => [e.path, hashOf(e.value)]))
  const have = new Map((await ws.changes()).map((e) => [e.path, hashOf(e.value)]))
  if (want.size !== files.length) return null
  const same = files.every((f) => {
    const a = want.get(f.path)
    const b = have.get(f.path)
    return a && b && b4a.equals(a, b)
  })
  return same ? now.statusName : null
}

// what a land into /.hsreview-protected paths needs (TO-FIVE #14, #16, #18), decided after the
// pull (the policy can arrive in it) and before --check runs the tests: protected paths an
// approved item this land names covers go through; with no proposal attached, the rest are
// set aside and proposed after the land (split, the default) or, when nothing else would
// land, refused here. Returns false when the land is refused
async function splitProtected(ctx, cmd, ws, { proposal, items, under }) {
  const changed = (await ws.changes()).map((e) => e.path)
  const policy = rules.parseReview((await ctx.repo.policyText()) || '')
  const protectedPaths = changed.filter((p) => rules.requirement(policy, [p]))
  if (!protectedPaths.length) {
    // nothing protected: an open proposal doesn't go with it (#22; q2h-6: a2's code-only land
    // was refused twice because its proposal for CONTRACTS.md was attached)
    // only a proposal made for protected files: an ordinary Ask (owners' review) still goes
    // with every land of its workspace
    const open = proposal === null ? await openProposal(ctx, ws) : null
    if (open && (open.entries || []).some((e) => rules.requirement(policy, [e.path]))) {
      ctx.detach = true
    }
    return true
  }
  // an open proposal of this workspace (#22): it goes with the land only when the land is
  // exactly its files (the Ask route); other files land without it, and the protected ones
  // stay for it
  const prop = proposal
    ? await ctx.repo.proposal(proposal)
    : proposal === null
      ? await openProposal(ctx, ws)
      : null
  if (prop) {
    const propPaths = new Set((prop.entries || []).map((e) => e.path))
    if (changed.every((p) => propPaths.has(p))) return true
    ctx.aside = await setAside(ctx, ws, protectedPaths)
    ctx.asideProp = prop
    return true
  }
  const uncovered = []
  for (const p of protectedPaths) {
    if (!(await approvedItemFor(ctx, [...items, ...under], p))) uncovered.push(p)
  }
  if (!uncovered.length) return true
  if (uncovered.length === changed.length || cmd.flags.split === false) {
    ctx.landOutcome = 'needs-review'
    await notLanded(
      ws,
      `needs review: ${uncovered.join(' ')} need${uncovered.length === 1 ? 's' : ''} approval (/.hsreview)`,
      await planHint(ctx, changed)
    )
    return false
  }
  ctx.aside = await setAside(ctx, ws, uncovered)
  // part of the item waits for review: this land doesn't complete it (q2h-4)
  if (items.length) {
    ctx.splitItems = items.splice(0)
    under.push(...ctx.splitItems)
  }
  return true
}

async function openProposal(ctx, ws) {
  if (!ws.state.proposal) return null
  const p = await ctx.repo.proposal(ws.state.proposal)
  return p && p.statusName !== 'landed' ? p : null
}

// an approved item (of these, or of any of mine when ids is null) that lets me land into p:
// I'm its author or named lead, its approvals meet what it needs, and its paths cover p
async function approvedItemFor(ctx, ids, p) {
  const me = ctx.repo.writerKey
  for (const id of ids) {
    const it = await ctx.repo.item(id)
    if (!it || it.done || it.dropped || !it.needs || (it.approvals || 0) < it.needs) continue
    if (!(b4a.equals(it.author, me) || (it.lead && b4a.equals(it.lead, me)))) continue
    if (rules.covers(it.paths || [], p)) return it
  }
  return null
}

// protected files set aside for a split land: their edited contents kept in memory, and the
// workspace and files put back to main
async function setAside(ctx, ws, paths) {
  const files = []
  for (const p of paths) {
    files.push({ path: p, content: await fs.readFile(ctx.worktree._abs(p)).catch(() => null) })
  }
  ws.io = { timeout: FETCH_TIMEOUT }
  await ws.revert(paths)
  await ctx.worktree.restore(
    ws,
    paths.map((p) => p.slice(1))
  )
  out(
    `split: ${paths.join(' ')} need${paths.length === 1 ? 's' : ''} approval (/.hsreview): landing the rest now, proposing ${paths.length === 1 ? 'it' : 'them'} after (--no-split to land nothing)`
  )
  return files
}

async function putBack(ctx, ws, files) {
  for (const f of files) {
    const abs = ctx.worktree._abs(f.path)
    if (f.content === null) await fs.rm(abs, { force: true })
    else {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, f.content)
    }
  }
  await commitWorktree(ctx, ws)
}

async function proposeProtected(ctx, ws, files, message, items = []) {
  const paths = files.map((f) => f.path)
  const open = await openProposal(ctx, ws)
  if (open && open.statusName === 'approved') {
    warn(`!! P${open.id} was approved; this new revision needs approval again`)
  }
  const net = await online(ctx)
  try {
    const reviewers = await policyReviewers(ctx, paths)
    const res = await ws.propose({
      message: message ? message + ' (protected part)' : 'protected part of a split land',
      author: process.env.USER || '',
      reviewers,
      quorum: 0
    })
    if (res.outcome.status !== 'accepted') {
      warn(
        `!! --split: proposing ${paths.join(' ')}: ${res.outcome.reason || res.outcome.status}; they are kept in your worktree: \`hs propose\``
      )
      process.exitCode = 2
      return
    }
    const prop = await ctx.repo.proposal(res.outcome.proposal)
    const who = (await namesOf(ctx.repo, prop.reviewers)).join(', ') || 'anyone'
    out(
      `proposed P${prop.id}${prop.revision ? ' (revision ' + prop.revision + ')' : ''} for ${paths.join(' ')}, asked ${who}`
    )
    const held = await net.uploaded([
      ctx.repo.main.local,
      [ws.tree, ws.tree.length],
      [ws.blobs.core, ws.blobs.core.length]
    ])
    if (!held) warn('!! push timed out: run `hs push` while a holder is online')
    const close = items.length
      ? ' ' + items.map((i) => '--item ' + claims.shortId(i)).join(' ')
      : ''
    out(
      `once approved: hs land${close}   (track it with hs watch --for-me, or hs show P${prop.id})`
    )
  } finally {
    await net.close()
  }
}

// returns true when the land was accepted
async function landMain(ctx, cmd, ws) {
  {
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
      let proposal = cmd.flags.proposal ? parseTarget(cmd.flags.proposal).proposal : null
      // items this land completes: resolved on the board (signals + records)
      const items = []
      const under = []
      for (const [list, refs] of [
        [items, cmd.flags.item || []],
        [under, cmd.flags.under || []]
      ]) {
        for (const ref of refs) {
          if (net) await net.board.load(ctx.repo)
          const it = net ? resolveItem(net.board, ref) : await ctx.repo.itemByPrefix(ref)
          if (!it) throw new Error(`no item ${ref} (hs claims lists them)`)
          list.push(it.id)
        }
      }
      if (net && surface() !== 'plain') {
        await claimNotes(
          ctx,
          net,
          (await ws.changes()).map((e) => e.path)
        )
        renewClaims(ctx, net)
      }
      // TO-FIVE #6: a land that names no item links itself to the one it's part of
      if (net && !items.length && !under.length && surface() !== 'plain') {
        const linked = await autoLink(ctx, net, ws)
        if (linked) {
          under.push(linked.id)
          out(`linked to ${claims.shortId(linked.id)} "${oneLine(linked.title || '')}"`)
        }
      }
      if (!(await splitProtected(ctx, cmd, ws, { proposal, items, under }))) return
      // a split land carries only unprotected files: the workspace's proposal doesn't go with it
      if (ctx.aside || ctx.detach) proposal = 0
      const landOpts = { message, author, reviewers, proposal, items, under }
      // what a re-land after an undo repeats (TO-FIVE #1)
      await fs
        .writeFile(
          Context.file(ctx.root, 'land.json'),
          JSON.stringify({ message, check: cmd.flags.check || null }) + '\n'
        )
        .catch(() => {})

      let retries = net ? Number(cmd.flags.retries ?? 3) : 0
      // --check: bring main in first and test exactly what will land
      const check = cmd.flags.check || null
      if (check && !(await checkMerged(ctx, ws, net, check, retries))) return
      dlog('land op')
      let { outcome } = await ws.land(landOpts)
      dlog(`land op: ${outcome.status} #${outcome.seq || '-'}`)

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

      ctx.landOutcome = outcome.status
      if (outcome.status === 'accepted') ctx.landedSeq = outcome.seq
      if (outcome.status === 'accepted') {
        // an indexer has seen its own land, so say so (a solo repo settles this way)
        if (await isSettler(ctx.repo)) await ctx.repo.ack()
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
        if (cs && cs.proposal) await approvalKept(ctx, cs)
        const req = (await ctx.repo.requests()).find((r) => r.seq === outcome.seq)
        if (req) out(`review requested from ${(await namesOf(ctx.repo, req.reviewers)).join(', ')}`)
        if (items.length) {
          out(`completes ${items.map(claims.shortId).join(' ')}`)
          // the record is the land op; the signal tells the board at once
          if (net) {
            for (const item of items) {
              net.signal(signed(ctx, { item, action: claims.DONE, time: Date.now() }))
            }
          }
        }
      } else if (outcome.status === 'empty') {
        out('nothing to land')
        // --wait-final with nothing new: wait for the last land instead (q2s-hs-3: an agent
        // waiting for its land to go final after an outage had to poll `hs status`)
        const last = cmd.flags.waitFinal ? await ws.lastLand() : null
        if (last && last.status === 'accepted' && last.seq) {
          out(`waiting for your last land #${last.seq} to be final`)
          await waitFinal(ctx, last.seq, Number(cmd.flags.timeout || 60))
        }
      } else if (outcome.status === 'needs-review') {
        await notLanded(
          ws,
          `needs review: ${outcome.reason}`,
          outcome.proposal
            ? `see \`hs show P${outcome.proposal}\`; land once it's approved`
            : await planHint(
                ctx,
                (await ws.changes()).map((e) => e.path)
              )
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
        const held = await net.landed(ws)
        dlog(`push: held=${held}`)
        if (held) out('pushed: a holder has the changes')
        else {
          // nobody took it: in an outage that is often because a concurrent land on the same
          // files won the order, and this one was already undone. Look before saying anything
          // that reads like success (q2s-claims-4: "landed" + "push timed out" did)
          await ctx.repo.update().catch(() => {})
          const flip = await ws.flipped().catch(() => null)
          if (flip) {
            warn(
              `!! your land #${outcome.seq} was undone: a concurrent land on the same files came ` +
                'first. Your changes are safe here'
            )
            ctx.landOutcome = 'flipped'
            ctx.undoneSeq = outcome.seq
            return
          }
          warn(
            `!! push timed out: nobody has confirmed holding #${outcome.seq} yet. Until someone does, it ` +
              'is only on this machine and may still be undone by a concurrent land: check `hs status` ' +
              'before building on it, and `hs push` once a holder is online'
          )
          process.exitCode = 2
        }
        if (cmd.flags.waitFinal) await waitFinal(ctx, outcome.seq, Number(cmd.flags.timeout || 60))
        else if (cmd.flags.wait !== false) {
          // no hub reachable (an outage): it can't settle now, so don't wait for it
          if (!net.holderConnected() && (await ctx.repo.indexers()).length > 0) {
            out(
              `#${outcome.seq} provisional: the hub is not reachable, so it settles once the ` +
                'hub is back (on its own; `hs wait-final` blocks until it is final)'
            )
          } else {
            await waitSettled(ctx, outcome.seq, SETTLE_WAIT_S)
          }
        }
      }
    } finally {
      if (net) await net.close()
    }
  }
  return ctx.landOutcome === 'accepted'
}

const SETTLE_WAIT_S = 10

// Sync onto main and run the check on the result. If main moves while it runs in a way the
// check could see, sync and run it again, so what lands is what was tested (up to the moment
// between the last pull and the land op, a few hundred ms). Main moving only in paths the
// check can't read (outside the sparse checkout, or marked `-check` in /.hsattributes, e.g. a
// swarm's own directory) lands on the checked state: the land's own paths are still
// concurrency-checked by every peer.
async function checkMerged(ctx, ws, net, command, attempts) {
  let reruns = 0
  // where your files were before the check brought main in: a failure names what came since
  const from = ws.state.base.seq
  for (let i = 0; ; i++) {
    if (net && i > 0) reportMissing((await pullAndPrefetch(ctx, ws, net)).missing)
    const res = await ws.sync()
    dlog(`check round ${i}: synced to #${ws.state.base.seq}`)
    await materialize(ctx, ws, net)
    dlog(`check round ${i}: materialized`)
    if (res.conflicts.length) {
      await notLanded(
        ws,
        `real conflicts in ${await describeUpstream(ctx, res.conflicts)}`,
        'fix the <<<<<<< markers (`hs status` lists them), then `hs land` again'
      )
      return false
    }
    await reportMerged(ctx, res.merged)
    if (!(await runCheckReport(ctx, ws, command, from))) return false
    dlog(`check round ${i}: check ran`)
    // nobody to pull from (offline, or a solo repo): main can't have moved under us
    if (!net || net.connections === 0) return true
    await pullMain(net)
    const checked = ws.state.base.seq
    const head = (await ctx.repo.meta()).seq
    if (head === checked) return true
    const seen = await checkSees(ctx, ws, checked, head)
    if (!seen.length) {
      out(`main moved to #${head} outside what the check reads; landing on the checked state`)
      return true
    }
    if (reruns++ >= attempts) {
      warn(`!! main moved to #${head} during every check; landing on the last checked state`)
      return true
    }
    out(`main moved to #${head} while checking (${seen.slice(0, 3).join(', ')}); checking again`)
  }
}

// changes on main after #from up to #to that a check of this worktree could see: the land's
// own paths, and anything in the sparse checkout not marked `-check`. ["/src/a.js #12 a1", ...]
async function checkSees(ctx, ws, from, to) {
  const attrs = merge.parseAttributes(await mainText(ctx, '/.hsattributes', { wait: false }))
  const mine = new Set((await ws.changes().catch(() => [])).map((e) => e.path))
  const sparse = ctx.config.sparse && ctx.config.sparse.length ? ctx.config.sparse : ['/']
  const inCheckout = (p) => sparse.some((s) => s === '/' || p === s || p.startsWith(s + '/'))
  const seen = []
  for (const cs of await ctx.repo.changesetsBetween(from, to)) {
    const files = (cs.files || []).map((f) => f.replace(/^-/, ''))
    const listed = files.length >= (cs.paths || 0)
    const hit = files.find((p) => mine.has(p) || (inCheckout(p) && merge.checkReads(attrs, p)))
    // a changeset too big to list every path could touch anything
    if (hit || !listed) seen.push(`${hit || 'many paths'} #${cs.seq} ${await who(ctx.repo, cs)}`)
  }
  return seen
}

async function runCheckReport(ctx, ws, command, from = null) {
  const at = ws.state.base.seq
  out(`checking main #${at} + your changes: ${command}`)
  const started = Date.now()
  const res = await runShell(command, ctx.root)
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  if (res.code === 0) {
    out(`check passed in ${secs}s`)
    return true
  }
  // TO-FIVE #25 (q2h-7: a raw stack trace, no hint which change broke it): the lines that say
  // what failed, a short tail without stack frames, and what came in from teammates
  const lines = res.output.trimEnd().split('\n')
  const noise = (l) => /^\s+at |<Buffer |^\s*\|?\s*$/.test(l)
  const key = lines.filter((l) => !noise(l) && CHECK_FAILURE.test(l)).slice(0, 8)
  for (const l of key) warn('  ! ' + l.trim())
  const tail = lines.filter((l) => !noise(l)).slice(-CHECK_TAIL)
  for (const l of tail) if (!key.includes(l)) warn('  | ' + l)
  if (from !== null && from < at) {
    const seen = await checkSees(ctx, ws, from, at).catch(() => [])
    if (seen.length) {
      warn(
        `  new from teammates since your last sync, read by this check: ${seen.slice(0, 5).join(', ')}` +
          (seen.length > 5 ? ` and ${seen.length - 5} more` : '')
      )
    }
  }
  await notLanded(
    ws,
    `check failed (exit ${res.code}, ${secs}s) on main #${at} + your changes`,
    'your files now include main: fix, then `hs land --check ...` again'
  )
  return false
}

const CHECK_TAIL = 12
// lines in a test run's output that usually say what failed
const CHECK_FAILURE = /not ok|✖|✗|\bfail(ed|ing|ure)?\b|Error\b|expected|actual|assert/i

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

// settlement waits for my acks (an indexer, or any writer in a repo with no indexer)
async function isSettler(repo) {
  return (await repo.settlers()).some((k) => b4a.equals(k, repo.writerKey))
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

// TO-FIVE #19: block until a land is final (default: your last), as `land --wait-final` does
const waitFinalCmd = command(
  'wait-final',
  summary('Wait until your last land (or #n) is final: exit 0 when it is, 2 on timeout'),
  arg('[seq]', 'a changeset (#27); default: your last land'),
  flag('--timeout <seconds>', 'give up after this long (default 120)'),
  withRepo(async (ctx, cmd) => {
    let seq = cmd.args.seq ? parseTarget(cmd.args.seq).seq : null
    if (!seq) {
      const last = await (await ctx.workspace()).lastLand()
      if (!last || last.status !== 'accepted' || !last.seq) {
        throw new Error('no land of yours to wait for (name one: hs wait-final #27)')
      }
      seq = last.seq
    }
    const net = await online(ctx)
    try {
      await pullMain(net, { quiet: true })
      out(`waiting for #${seq} to be final`)
      await waitFinal(ctx, seq, Number(cmd.flags.timeout || 120))
    } finally {
      await net.close()
    }
  })
)

const sync = command(
  'sync',
  summary('Bring main into your files and rebase your work onto it (merges overlapping edits)'),
  flag('--offline', 'do not pull first (fails fast if needed content is not local)'),
  withRepo((ctx, cmd) => syncMain(ctx, cmd))
)

async function syncMain(ctx, cmd) {
  let relandAfter = false
  {
    const ws = await ctx.workspace()
    await commitWorktree(ctx, ws)

    const net = cmd.flags.offline ? null : await online(ctx)
    try {
      let connected = true
      if (net) {
        const pulled = await pullAndPrefetch(ctx, ws, net)
        connected = pulled.connected
        reportMissing(pulled.missing)
        renewClaims(ctx, net)
      } else ws.io = { wait: false }

      const baseBefore = ws.state.base.seq
      const res = await ws.sync()
      await materialize(ctx, ws, net)
      // without peers, "up to date" would only mean "up to date with what this machine has"
      if (!connected) await warnUnreachable(ctx, ws.state.base.seq)
      await renumberNote(ctx, ws)

      if (res.restored) {
        out(`restored your land that a concurrent land undid (${res.restored.status})`)
        // TO-FIVE #1: land it again, as `land` would have (after this connection closes)
        if (connected && ctx.repo.writable && !res.conflicts.length) relandAfter = true
        else out('land it again: `hs land`')
      }
      if (res.upToDate && connected) out(`up to date with main #${ws.state.base.seq}`)
      if (!res.upToDate) {
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
      }
      // the open items and who leads them, so starting work needs no separate `hs claims`
      // (q0, q0b: agents called it 3-4 times before their first land)
      if (surface() !== 'plain') await printOpenItems(ctx, net)
    } finally {
      if (net) await net.close()
    }
  }
  if (relandAfter) {
    let last = {}
    try {
      last = JSON.parse(await fs.readFile(Context.file(ctx.root, 'land.json'), 'utf8'))
    } catch {}
    out('landing it again')
    // the number it was reported as, for "#51 re-landed as #N"
    ctx.relanded = (await Context.readNumber(ctx.root, 'land.reported')) || '?'
    await landWithSplit(ctx, {
      flags: { message: last.message || '', check: last.check || undefined }
    })
  }
}

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
        const paths = (await ws.changes()).map((e) => e.path)
        const owners = await otherOwners(ctx, paths)
        reviewers = Object.keys(owners)
        // whoever /.hsreview says must approve these paths (@humans: each person)
        for (const h of await policyReviewers(ctx, paths)) {
          if (!reviewers.includes(h)) reviewers.push(h)
        }
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
  summary(
    'Review a proposal (P5), a landed changeset (#27) or an item (C1a2b3c): approve, changes or comment'
  ),
  arg('<target>', 'P5, #27 or C1a2b3c'),
  arg('<verdict>', 'approve | changes | comment'),
  flag('--message|-m <text>', 'comment (start with path:line to point at a spot)'),
  withRepo(async (ctx, cmd) => {
    const verdict = VERDICTS[cmd.args.verdict]
    if (!verdict) throw new Error('verdict must be approve, changes or comment')
    if (!ctx.repo.writable) throw new Error('not a writer')
    if (isItemRef(cmd.args.target)) {
      return reviewItems(ctx, [cmd.args.target], verdict, cmd.flags.message || null)
    }
    const target = parseTarget(cmd.args.target)

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

// TO-FIVE #20: a proposal landed with teammates' changes merged into a protected file it
// approved: say the approval was kept because the author's lines are the ones approved
async function approvalKept(ctx, cs) {
  const prop = await ctx.repo.proposal(cs.proposal)
  if (!prop) return
  const policy = rules.parseReview((await ctx.repo.policyText()) || '')
  for (const e of prop.entries || []) {
    if (!e.value || !rules.requirement(policy, [e.path])) continue
    const now = await ctx.repo.main.view.get(keysMod.files.encode(e.path)).catch(() => null)
    if (!now || b4a.equals(now.value, e.value)) continue
    const by = []
    for (const other of await ctx.repo.changesetsBetween(prop.base.seq, cs.seq - 1)) {
      if ((other.files || []).includes(e.path)) by.push('#' + other.seq)
    }
    out(
      `approval of P${prop.id} kept for ${e.path}: your lines are the ones approved; ` +
        `teammates' changes merged in${by.length ? ' (' + by.join(' ') + ')' : ''}`
    )
  }
}

// for a one-change wait from your synced base on exact paths: the newest earlier change to one
// of them, if any ("#58 pm /CHANGE-REQUEST.md")
async function alreadyHere(repo, cmd, waiting, since, me) {
  if (!waiting || since === null || !cmd.flags.path) return null
  for (const raw of cmd.flags.path) {
    const p = unixPathResolve('/', raw)
    const cs = await repo.lastChange(p).catch(() => null)
    if (!cs || cs.seq > since || (me && b4a.equals(cs.writer, me))) continue
    return `#${cs.seq} ${await repo.nameOf(cs.writer)} ${p}`
  }
  return null
}

// what to do about a land refused by /.hsreview: an item of yours (author or named lead) that
// names the paths lands it once approved; otherwise propose, to whoever the rule names
async function planHint(ctx, paths) {
  const me = ctx.repo.writerKey
  const policy = rules.parseReview((await ctx.repo.policyText()) || '')
  const req = rules.requirement(policy, paths)
  // some changes aren't protected: they can land now, the rest goes to review (#14)
  const free = paths.filter((p) => !rules.requirement(policy, [p])).length
  const split = free
    ? `; or \`hs land\` without --no-split lands your ${free} other file(s) now and proposes the protected one(s)`
    : ''
  for (const it of await ctx.repo.items()) {
    if (it.done || it.dropped || !it.needs) continue
    if (!(b4a.equals(it.author, me) || (it.lead && b4a.equals(it.lead, me)))) continue
    if (req && !req.paths.every((p) => rules.covers(it.paths || [], p))) continue
    const id = claims.shortId(it.id)
    if ((it.approvals || 0) >= it.needs) {
      return `\`hs land --item ${id}\` (or --under ${id}): ${id} is approved`
    }
    return (
      `${id} "${oneLine(it.title)}" ${await approvalText(ctx.repo, it)}: keep working; ` +
      `the feed says when it's approved, then \`hs land --item ${id}\` (or --under ${id})` +
      split
    )
  }
  if (free) {
    return `\`hs land\` without --no-split: lands your ${free} other file(s) now and proposes the protected one(s) to their reviewers`
  }
  const who = (await policyReviewers(ctx, paths)).join(',') || '<handles>'
  return `\`hs propose -m "..." --reviewers ${who}\`, then \`hs land\` once approved`
}

// the handles a /.hsreview rule names for these paths, with @humans expanded
async function policyReviewers(ctx, paths) {
  const req = rules.requirement(rules.parseReview((await ctx.repo.policyText()) || ''), paths)
  if (!req) return []
  const out = []
  for (const r of req.reviewers) {
    if (r === '@humans') {
      for (const k of await ctx.repo.humans()) out.push(await ctx.repo.nameOf(k))
    } else out.push(r.replace(/^@/, ''))
  }
  return out
}

// "C1a2b3c": an item (docs/CLAIMS.md)
function isItemRef(s) {
  return /^[Cc][0-9a-fA-F]{2,64}$/.test(String(s))
}

// review items (phase 2): the op pins the item's current hash, so an approval is of what the
// approver saw; approvals count once they come from the item's reviewers
async function reviewItems(ctx, refs, verdict, comment) {
  const net = await online(ctx)
  try {
    await pullMain(net)
    for (const ref of refs) {
      const it = await ctx.repo.itemByPrefix(ref)
      if (!it) {
        warn(`no item ${ref} in main yet (hs claims lists them; it may still be on its way)`)
        process.exitCode = 2
        continue
      }
      const short = claims.shortId(it.id)
      const me = ctx.repo.writerKey
      if (verdict === VERDICTS.approve && b4a.equals(it.author, me)) {
        warn(`${short}: your own item, your approval doesn't count`)
      } else if (verdict === VERDICTS.approve && !mayApprove(it, me)) {
        warn(
          `${short}: only ${(await namesOf(ctx.repo, it.reviewers)).join(', ')} can approve it; recorded as a comment-weight review`
        )
      }
      const op = { item: it.id, hash: it.hash, verdict, comment, time: Date.now() }
      const { outcome } = await ctx.repo.review(op)
      if (outcome.status !== 'accepted') {
        warn(`${short}: ${outcome.reason || outcome.status}`)
        process.exitCode = 2
        continue
      }
      const now = await ctx.repo.item(it.id)
      out(
        `${short} "${oneLine(now.title)}": ${VERDICT_NAMES[verdict]} by you${now.needs ? '; ' + (await approvalText(ctx.repo, now)) : ''}`
      )
    }
    out((await net.uploaded()) ? 'pushed' : '!! push timed out, run `hs push`')
  } finally {
    await net.close()
  }
}

// can this writer's approval count for the item?
function mayApprove(it, me) {
  if (it.author && b4a.equals(it.author, me)) return false
  return !(it.reviewers || []).length || includesKey(it.reviewers, me)
}

// "needs 1 approval (0/1, from @ann)" / "approved (1/1)", or '' for items with no requirement
async function approvalText(repo, it) {
  if (!it || !it.needs) return ''
  const have = it.approvals || 0
  if (have >= it.needs) return `approved (${have}/${it.needs})`
  const from = (it.reviewers || []).length
    ? `, from ${(await namesOf(repo, it.reviewers)).join(', ')}`
    : ''
  return `needs ${it.needs} approval${it.needs === 1 ? '' : 's'} (${have}/${it.needs}${from})`
}

const inbox = command(
  'inbox',
  summary('What is waiting on you: items to approve, then proposals to review'),
  description(
    'Items whose /.hsreview rule needs approvals you can give, oldest first, then open ' +
      'proposals that name you. Approve with `hs review C1a2b3c approve` or --approve-all.'
  ),
  flag('--json', 'one JSON object per line'),
  flag('--approve-all', 'approve every item listed (not proposals: read those first)'),
  flag('--offline', "don't pull first"),
  withRepoRead(async (ctx, cmd) => {
    if (!cmd.flags.offline && !ctx.readOnly) {
      const net = await online(ctx)
      try {
        await pullMain(net)
      } finally {
        await net.close()
      }
    }
    const me = ctx.repo.writerKey
    const items = (await ctx.repo.items())
      .filter((it) => it.needs && (it.approvals || 0) < it.needs && !it.done && !it.dropped)
      .filter((it) => mayApprove(it, me))
      .sort((a, b) => (a.time || 0) - (b.time || 0))
    const proposals = []
    for (const p of await ctx.repo.proposals()) {
      if (p.statusName !== 'open' || b4a.equals(p.author, me)) continue
      if (!includesKey(p.reviewers, me)) continue
      const mine = (await ctx.repo.reviews(TARGET_PROPOSAL, p.id)).find((r) =>
        b4a.equals(r.writer, me)
      )
      if (
        mine &&
        mine.verdict === VERDICTS.approve &&
        mine.hash &&
        p.hash &&
        b4a.equals(mine.hash, p.hash)
      ) {
        continue
      }
      proposals.push(p)
    }
    for (const it of items) {
      const short = claims.shortId(it.id)
      const by = await ctx.repo.nameOf(it.author)
      const kind = it.kind ? ` [${it.kind}]` : ''
      const paths = (it.paths || []).length ? ` paths ${it.paths.join(' ')}` : ''
      const text = `${short}${kind} "${oneLine(it.title)}" by ${by}, ${ago(it.time)}: ${await approvalText(ctx.repo, it)}${paths}`
      if (cmd.flags.json) {
        out(
          JSON.stringify({
            type: 'item',
            item: short,
            kind: it.kind || '',
            title: it.title,
            author: by,
            paths: it.paths || [],
            needs: it.needs,
            approvals: it.approvals || 0,
            text
          })
        )
      } else out(text)
    }
    for (const p of proposals) {
      const by = await ctx.repo.nameOf(p.author)
      const text = `P${p.id} ${p.approvals}/${p.quorum} by ${by} :: ${oneLine(p.message)}`
      if (cmd.flags.json) {
        out(JSON.stringify({ type: 'proposal', proposal: p.id, author: by, text }))
      } else out(text)
    }
    if (!items.length && !proposals.length) {
      if (!cmd.flags.json) out('nothing waiting on you')
      return
    }
    if (!cmd.flags.json && !(cmd.flags['approve-all'] || cmd.flags.approveAll)) {
      const first = items[0] && claims.shortId(items[0].id)
      const prop = proposals[0] && proposals[0].id
      if (first) out(`approve: hs review ${first} approve (or hs inbox --approve-all)`)
      if (prop) out(`review: hs show P${prop}, then hs review P${prop} approve|changes`)
    }
    if ((cmd.flags['approve-all'] || cmd.flags.approveAll) && items.length) {
      if (ctx.readOnly) throw new Error('read-only: cannot approve')
      await reviewItems(
        ctx,
        items.map((it) => claims.shortId(it.id)),
        VERDICTS.approve,
        null
      )
    }
  })
)

const proposalsCmd = command(
  'proposals',
  summary('List proposals: waiting for you, yours, or all'),
  flag('--all', 'include landed ones'),
  flag('--offline', "don't pull first"),
  withRepoRead(async (ctx, cmd) => {
    if (!cmd.flags.offline && !ctx.readOnly) {
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
  withRepoRead(async (ctx, cmd) => {
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
  if (ctx.readOnly) return // the command holding the worktree is the one pulling
  const meta = await ctx.repo.meta()
  const fedSeq = await Context.readNumber(ctx.root, 'watch.last')
  const fedSettled = await Context.readNumber(ctx.root, 'watch.settled')
  const behind =
    (fedSeq !== null && fedSeq > meta.seq) ||
    (fedSettled !== null && fedSettled > (meta.settled || 0)) ||
    (await Promise.race([ctx.repo.viewGaps(), sleep(2000).then(() => 1)]).catch(() => 0)) > 0 // reads of main would need the network
  if (!behind) return
  // the network stays up until the command ends (withRepo closes it): what it reads next may
  // still need a block a peer has to serve
  if (!ctx.net) ctx.net = await online(ctx)
  await pullMain(ctx.net, { quiet: true })
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
  withRepoRead(async (ctx, cmd) => {
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
  withRepoRead(async (ctx, cmd) => {
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
  withRepoRead(async (ctx, cmd) => {
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
  withRepoRead(async (ctx, cmd) => {
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
  withRepoRead(async (ctx, cmd) => {
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
  withRepoRead(async (ctx) => {
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
    const { key, encryptionKey, bootstrapWeight } = Context.parseInvite(cmd.args.invite)
    const ctx = await Context.create(root, { key, encryptionKey, sparse, bootstrapWeight })
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
  withRepoAsIs(async (ctx) => {
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
  withRepoAsIs(async (ctx, cmd) => {
    const mirror = cmd.flags.mirror !== false
    const net = await online(ctx, { mirror, role: 'holder', ack: true, keepAlive: true })
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

async function quietRules(repo) {
  return merge.parseAttributes(await mainText({ repo }, '/.hsattributes', { wait: false }))
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
  if (ev.item && (ev.type === 'item-review' || ev.type === 'item-approved')) {
    const it = await repo.item(ev.item)
    if (it && (b4a.equals(it.author, me) || (it.lead && b4a.equals(it.lead, me)))) return true
  }
  if (ev.type === 'item-request' && !(ev.reviewers || []).length) return true
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
    // no count: this line is history, and a later revision may have reset the approvals
    text = `@ ${target} approved: its author can land it (\`hs show ${target}\` for its state now)`
  } else if (ev.type === 'landed') {
    text = `@ ${target} landed as #${ev.seq} by ${actor}`
  } else if (ev.type === 'request') {
    text = `@ #${ev.seq} by ${actor}: review requested from ${reviewers.join(',')}`
  } else if (ev.item) {
    text = await itemEventText(repo, ev, actor)
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
      item: ev.item ? claims.shortId(ev.item) : null,
      text
    })
  )
}

// claims (docs/CLAIMS.md): items, claims, releases and completions as feed lines
async function itemEventText(repo, ev, actor) {
  const id = claims.shortId(ev.item)
  const it = await repo.item(ev.item)
  const title = it && it.title ? ` "${oneLine(it.title)}"` : ''
  if (ev.type === 'item' && it && it.parent) {
    // a part: say whose item it splits, so the lead sees it in the feed
    const board = new claims.Board()
    await board.load(repo)
    const l = board.lead(it.parent)
    const lead = l ? `, led by ${await repo.nameOf(l.lead.writer)}` : ''
    return `@ part ${id}${title} of ${claims.shortId(it.parent)}${lead}, split off by ${actor}: \`hs claim ${id}\``
  }
  if (ev.type === 'item') return `@ item ${id}${title} by ${actor}: \`hs claim ${id}\``
  if (ev.type === 'claim') {
    // with who leads now, so nobody needs `hs claims` to find out (q0-min, q0bo)
    const board = new claims.Board()
    await board.load(repo)
    const l = board.lead(ev.item)
    const lead = l ? await repo.nameOf(l.lead.writer) : null
    return `@ ${id}${title} claimed by ${actor}${lead ? `; ${lead === actor ? 'they lead' : lead + ' leads'}` : ''}`
  }
  if (ev.type === 'take') return `@ ${id}${title} taken over by ${actor}`
  if (ev.type === 'release') {
    const board = new claims.Board()
    await board.load(repo)
    const l = board.lead(ev.item)
    return `@ ${id}${title} released by ${actor}${l ? `; ${await repo.nameOf(l.lead.writer)} leads it` : ': open again'}`
  }
  if (ev.type === 'drop') return `@ ${id}${title} dropped by ${actor}`
  if (ev.type === 'done') return `@ ${id}${title} done by ${actor} in #${ev.seq}`
  if (ev.type === 'item-request') {
    const who = (await namesOf(repo, ev.reviewers)).join(', ') || 'a teammate'
    return `@ ${id}${title} by ${actor} needs approval from ${who}: \`hs review ${id} approve\` (hs inbox)`
  }
  if (ev.type === 'item-review') {
    const n = it && it.needs ? ` (${it.approvals || 0}/${it.needs})` : ''
    return `@ ${id}${title} ${VERDICT_NAMES[ev.verdict]} by ${actor}${ev.comment ? ' :: ' + oneLine(ev.comment) : ''}${n}`
  }
  if (ev.type === 'item-approved') {
    return `@ ${id}${title} approved: its author or lead can land it (--item ${id}, or --under ${id} for a piece)`
  }
  if (ev.type === 'parts-done') {
    return `@ all parts of ${id}${title} are done: its lead closes it with \`hs claim ${id} --done\` (or a land with --item ${id})`
  }
  return `@ ${ev.type} ${id} by ${actor}`
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
  // the same land (writer and oplog node) still on main under another number: peers met and
  // ordered concurrent lands, nothing was undone (q2s-hs-3: this read like an undo)
  const found = await repo.changesetAt(before.writer, before.node)
  const moved = found && found.seq !== seq ? found.seq : null
  if (moved) {
    const by = await who(repo, before)
    if (json) {
      out(
        JSON.stringify({ type: 'renumbered', seq, now: moved, author: by, message: before.message })
      )
    } else {
      out(
        `#${seq} ${by} "${oneLine(before.message)}" is now #${moved} (renumbered when peers met; nothing lost)`
      )
    }
    return
  }
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
  flag('--all', 'include changesets under paths /.hsattributes marks quiet (left out by default)'),
  flag('--patch', 'include unified diffs'),
  flag('--stop', "stop this worktree's background feed"),
  flag('--for-me', 'only review activity that involves you (requests, reviews of your work)'),
  flag('--sync', 'with --count: when the wait ends, sync what arrived into your files'),
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
      encryptionKey: config.encryptionKey ? z32.decode(config.encryptionKey) : null,
      bootstrapWeight: Context.bootstrapWeightOf(config)
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
      role: waiting ? 'command' : 'feed',
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
      eventsSince,
      exclude: waiting && !forMe ? me : null
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
    let outageSettled = null // settled point when this feed's outage links appeared
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
      // the outage mesh did its job: once the hub settles again (settlement moved past where
      // it stood when the outage links appeared), back to the star. Retried each check, since
      // the hub may reconnect to this feed after settling news arrives. Not "while the hub
      // isn't flagged stalled": that is also the first HS_HUB_STALL_S of every outage, and
      // dropping the links then cut teammates' lands off from every feed (q2-hs-3)
      if (net.hasOutageLinks()) {
        if (outageSettled === null) outageSettled = settled
        if (settled > outageSettled) {
          const closed = net.dropOutageLinks()
          if (closed && !json) warn(`watch: closed ${closed} outage link(s) to teammates' feeds`)
          if (!net.hasOutageLinks()) outageSettled = null
        }
      } else {
        outageSettled = null
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
    let have = null
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
      // quiet paths (/.hsattributes, e.g. a swarm's /swarm/) stay out of the feed unless asked
      // for by --path or --all; re-read when a changeset touches /.hsattributes
      const showQuiet = !!cmd.flags.all || (cmd.flags.path || []).length > 0
      let attrs = null
      watcher.on('changeset', (cs) => {
        queue = queue.then(async () => {
          if (seen >= limit || forMe) return
          if (attrs === null) attrs = showQuiet ? [] : await quietRules(repo)
          if (!showQuiet && (cs.files || []).includes('/.hsattributes')) {
            attrs = await quietRules(repo)
          }
          if (!showQuiet && merge.quietChangeset(attrs, cs)) {
            if (!waiting) await Context.writeNumber(root, 'watch.last', cs.seq).catch(() => {})
            printedThrough = Math.max(printedThrough, cs.seq)
            return
          }
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
      // TO-FIVE #21: the newest teammate change to the path you already have, named if the
      // wait times out (returning early on it misfired in q2-hs-7: it can't tell an old
      // version from the one you're waiting for)
      have = await alreadyHere(repo, cmd, waiting, since, me)
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
        if (have && !seen) warn(`  (already in your files: ${have}, from before your last sync)`)
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
    // --sync (TO-FIVE #11): waiting for a teammate and taking their work in, one command
    if (cmd.flags.sync && waiting && !process.exitCode) {
      await withRepo(syncMain)({ flags: {}, command: { name: 'sync' } })
    }
  }
)

const doctor = command(
  'doctor',
  summary(
    'Check peers and whether a holder serves main (fetches your sparse set as a side effect)'
  ),
  withRepoAsIs(async (ctx) => {
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
      for (const k of await ctx.repo.settlers()) {
        const seenSeq = await ctx.repo.seenBy(k)
        const lag =
          seenSeq < meta.seq ? `  !! behind: lands won't settle until it acks (is it online?)` : ''
        out(`indexer      ${await ctx.repo.nameOf(k)} has seen #${seenSeq}${lag}`)
        if (lag) out('             ' + replaceHint(ctx, await ctx.repo.nameOf(k)))
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
  withRepoAsIs(async (ctx, cmd) => {
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
  withRepoRead(async (ctx) => {
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

// handle or z32 key -> writer key
async function writerKeyArg(repo, arg) {
  const byHandle = await repo.keyOf(arg)
  if (byHandle) return byHandle
  try {
    return z32.decode(arg)
  } catch {
    throw new Error(`no writer named ${arg}`)
  }
}

const removeWriter = command(
  'remove-writer',
  summary('Take a writer out: a hub that is gone for good, a lost key (settlement stops waiting)'),
  arg('<writer>', 'handle or writer key'),
  flag('--offline', "don't wait for a peer to receive it"),
  withRepo(async (ctx, cmd) => {
    const key = await writerKeyArg(ctx.repo, cmd.args.writer)
    const name = await ctx.repo.nameOf(key)
    warn(
      `removing ${name}: its future ops are ignored. Only remove a writer that is gone for ` +
        'good; if it was a hub, add its replacement first (hs add-writer <key> --indexer)'
    )
    const { outcome } = await ctx.repo.removeWriter(key)
    out(
      `remove-writer ${name}: ${outcome.status}${outcome.reason ? ' (' + outcome.reason + ')' : ''}`
    )
    if (outcome.status !== 'accepted') {
      process.exitCode = 1
      return
    }
    if (cmd.flags.offline) return
    const net = await online(ctx)
    try {
      const ok = (await net.waitForPeers({ timeout: 5000 })) && (await net.uploaded())
      if (ok) out('pushed: a peer has it')
      else out('no peers online yet: it is shared when you next go online (hs push)')
    } finally {
      await net.close()
    }
  })
)

const addWriter = command(
  'add-writer',
  summary('Allow another peer to land changes'),
  arg('<key>', 'writer key (from `hs info` on the other peer)'),
  flag('--as <handle>', "the writer's handle, how teammates name them as reviewers and owners"),
  flag('--indexer', 'make the writer an indexer (lands settle only once every indexer acks)'),
  flag('--human', 'a person, not an agent: counts for @humans in /.hsreview (team owner only)'),
  flag('--offline', "don't wait for a peer to receive it"),
  withRepo(async (ctx, cmd) => {
    const key = z32.decode(cmd.args.key)
    if (!cmd.flags.as) warn('no --as <handle>: teammates cannot name this writer as a reviewer')
    const { outcome } = await ctx.repo.addWriter(key, {
      indexer: !!cmd.flags.indexer,
      handle: cmd.flags.as || null,
      human: !!cmd.flags.human
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

// --- claims (docs/CLAIMS.md) ------------------------------------------------------------

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  return s < 90 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}

// go online, catch up, load what main recorded, and wait for the signal channel (whose
// snapshot brings the live board)
async function claimBoard(ctx) {
  const net = await online(ctx)
  if (await net.waitForPeers({ timeout: FETCH_TIMEOUT })) {
    await net.settle()
    await net.signalsReady()
    await sleep(300) // the snapshot is one round trip behind the channel opening
  }
  await net.board.load(ctx.repo)
  return net
}

// an item by a unique id prefix (`C1a2b3c` or hex), from the board: signals and records, so
// an item announced during an outage can be claimed before its record reaches us
function resolveItem(board, prefix) {
  const p = String(prefix).replace(/^C/i, '').toLowerCase()
  if (!/^[0-9a-f]{2,64}$/.test(p)) return null
  const hits = [...board.items.values()].filter((it) => b4a.toString(it.id, 'hex').startsWith(p))
  return hits.length === 1 ? hits[0] : null
}

function signed(ctx, payload) {
  return claims.sign(
    { ...payload, writer: ctx.repo.writerKey, at: payload.at || Date.now() },
    ctx.repo.main.local.keyPair
  )
}

// announce (signal) and record (op) one item payload
async function announce(ctx, net, payload) {
  const p = signed(ctx, payload)
  net.signal(p)
  const { outcome } = await ctx.repo.itemOp(p)
  if (outcome.status !== 'accepted') {
    warn(`!! recording ${claims.shortId(p.item)}: ${outcome.reason || outcome.status}`)
  }
  return p
}

async function newItem(ctx, net, { title, parent = null, kind = '', paths = [], lead = null }) {
  const time = Date.now()
  const item = claims.itemId({ writer: ctx.repo.writerKey, time, title, parent })
  await announce(ctx, net, {
    item,
    action: claims.NEW,
    time,
    at: time,
    title,
    parent,
    kind,
    paths,
    lead
  })
  net.board.add({
    item,
    action: claims.NEW,
    writer: ctx.repo.writerKey,
    time,
    title,
    parent,
    kind,
    paths,
    lead
  })
  return item
}

// a land into paths a teammate's live claim names: a note, never a refusal
async function claimNotes(ctx, net, paths) {
  if (!paths.length) return
  for (const { payload, item, path: p } of net.board.claimsTouching(paths, ctx.repo.writerKey)) {
    const title = item && item.title ? ` "${oneLine(item.title)}"` : ''
    out(
      `note: ${p} is in ${await ctx.repo.nameOf(payload.writer)}'s claim ${claims.shortId(payload.item)}${title} ` +
        `(active ${ago(payload.at || payload.time)})`
    )
  }
}

// renew this writer's live claims (land and sync do it, so an active agent stays live)
function renewClaims(ctx, net) {
  if (!ctx.repo.writable || ctx.readOnly) return
  const now = Date.now()
  for (const p of net.board.liveClaimsOf(ctx.repo.writerKey, now)) {
    if (now - (p.at || 0) < 60_000) continue
    net.signal(
      signed(ctx, {
        item: p.item,
        action: claims.HEARTBEAT,
        time: p.time,
        at: now,
        ttl: claims.TTL_MS,
        note: p.note,
        with: p.with,
        paths: p.paths
      })
    )
  }
}

// items and claims are recorded in our oplog too: wait (briefly) until a holder has it, so a
// teammate who wasn't online for the signal, or a person approving, finds it in main
async function closeBoard(net) {
  try {
    if (!(await net.uploaded(undefined, { timeout: 5000 }))) {
      warn('!! not pushed yet: teammates online have the signal; run `hs push` to record it')
    }
  } finally {
    await net.close()
  }
}

function partsOf(board, id) {
  return [...board.items.values()].filter(
    (x) => x.parent && b4a.equals(x.parent, id) && !x.done && !x.dropped
  )
}

// open items whose titles share at least two significant words with this one
function similarItems(board, title) {
  const words = (t) =>
    new Set(
      String(t)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3)
    )
  const mine = words(title)
  return [...board.items.values()].filter((it) => {
    if (it.done || it.dropped) return false
    let n = 0
    for (const w of words(it.title || '')) if (mine.has(w)) n++
    return n >= 2
  })
}

async function printLead(ctx, board, id) {
  const it = board.item(id)
  const short = claims.shortId(id)
  const l = board.lead(id)
  if (!l) return out(`${short}: nobody on it`)
  const me = ctx.repo.writerKey
  const name = async (p) => (b4a.equals(p.writer, me) ? 'you' : await ctx.repo.nameOf(p.writer))
  if (b4a.equals(l.lead.writer, me)) {
    out(`you lead ${short}${it && it.title ? ` "${oneLine(it.title)}"` : ''}`)
    if (it && it.lead && !b4a.equals(it.lead, me)) {
      out(
        `  the item names ${await ctx.repo.nameOf(it.lead)} as lead: you lead until they claim it`
      )
    }
    // parts teammates hold: reuse them, or tell them you've got that piece (q2s-claims-1: the
    // lead built flight minutes itself while two parts built them too)
    for (const part of partsOf(board, id)) {
      const pl = board.lead(part.id)
      const by = pl ? await name(pl.lead) : 'nobody yet'
      out(`  part ${claims.shortId(part.id)} "${oneLine(part.title)}": ${by}`)
    }
    out(
      surface() === 'full'
        ? `  split it for teammates: hs item part ${short} "<piece>" (they see it in their feed)`
        : '  build it and land as usual: the land links itself to it'
    )
  } else if (l.coLeads.some((p) => b4a.equals(p.writer, me))) {
    // shared: agree with the lead who does which piece (it can split parts for you)
    out(`you share ${short} with ${await name(l.lead)} (co-lead): agree who does which piece`)
  } else {
    const mine = l.others.find((p) => b4a.equals(p.writer, me))
    const margin = mine
      ? ` (claimed ${((mine.time - l.lead.time) / 1000).toFixed(1)} s before you)`
      : ''
    out(`${await name(l.lead)} leads ${short}${margin}`)
  }
  for (const p of l.coLeads) {
    if (!b4a.equals(p.writer, me)) out(`  co-lead: ${await name(p)}`)
  }
  for (const p of l.others) {
    if (!b4a.equals(p.writer, me)) out(`  also on it: ${await name(p)} (${ago(p.time)})`)
  }
  if (!b4a.equals(l.lead.writer, me) && !l.coLeads.some((p) => b4a.equals(p.writer, me))) {
    // what to do instead: a part the lead split off, sharing, or reviewing; never building
    // the same thing alongside
    const lead = await name(l.lead)
    const open = partsOf(board, id).filter((x) => !board.lead(x.id))
    for (const part of open.slice(0, 5)) {
      out(
        `  open part: ${claims.shortId(part.id)} "${oneLine(part.title)}" (hs claim ${claims.shortId(part.id)})`
      )
    }
    out(
      surface() === 'full'
        ? `  don't build it too. ${open.length ? 'Take an open part, or ' : ''}ask ${lead} for a piece ` +
            `(${lead} splits it: hs item part ${short} "..."), share it: hs claim ${short} --with ${lead}, ` +
            `or review ${lead}'s land when it comes`
        : `  don't build it too: ask ${lead} for a piece in NOTES.md, or review ${lead}'s land when it comes`
    )
  }
}

const itemCmd = command(
  'item',
  summary('Work items to claim: a change request, a suggestion, or a part of one (docs/CLAIMS.md)'),
  arg('<what>', 'new | part'),
  arg('[a]', 'the title (new), or the parent item (part)'),
  arg('[b]', 'the part title (part)'),
  flag('--kind <kind>', 'implement | fix | contract | refactor | idea'),
  flag('--paths <p>', 'paths it will likely touch (repeatable)').multiple(),
  flag('--from <file>', 'title from the first line of this file (e.g. CHANGE-REQUEST.md)'),
  flag('--lead <handle>', 'who should lead it: once they claim it, they lead'),
  withRepo(async (ctx, cmd) => {
    const what = cmd.args.what
    const net = await claimBoard(ctx)
    try {
      let title = what === 'part' ? cmd.args.b : cmd.args.a
      let parent = null
      if (what === 'part') {
        const p = resolveItem(net.board, cmd.args.a || '')
        if (!p) throw new Error(`no item ${cmd.args.a || ''} (hs claims lists them)`)
        parent = p.id
        // parts are the lead's to hand out: claim the whole first, or ask whoever leads it
        // (q2s-claims-1: two agents split off their own overlapping parts of an unclaimed
        // change request, and the lead built the same thing again)
        const me = ctx.repo.writerKey
        const short = claims.shortId(p.id)
        const l = net.board.lead(p.id)
        const mineToSplit =
          (p.author && b4a.equals(p.author, me)) ||
          (l && (b4a.equals(l.lead.writer, me) || l.coLeads.some((x) => b4a.equals(x.writer, me))))
        if (!mineToSplit) {
          if (!l) {
            throw new Error(
              `nobody leads ${short} yet: claim it first (hs claim ${short}), then split it`
            )
          }
          const lead = await ctx.repo.nameOf(l.lead.writer)
          throw new Error(
            `${lead} leads ${short}, so the parts are ${lead}'s to hand out: ask ${lead} for a piece, ` +
              `share it (hs claim ${short} --with ${lead}), or review ${lead}'s land`
          )
        }
      } else if (what !== 'new') {
        throw new Error('hs item new "<title>" | hs item part <item> "<title>"')
      }
      if (!title && cmd.flags.from) {
        const text = await fs.readFile(path.resolve(cmd.flags.from), 'utf8')
        title = (text.split('\n').find((l) => l.trim()) || '').replace(/^#+\s*/, '').trim()
      }
      if (!title) throw new Error('an item needs a title')
      const paths = normalizePaths(cmd.flags.paths || [])
      let lead = null
      if (cmd.flags.lead) {
        lead = await ctx.repo.keyOf(cmd.flags.lead)
        if (!lead) throw new Error(`no teammate ${cmd.flags.lead}`)
      }
      const id = await newItem(ctx, net, { title, parent, kind: cmd.flags.kind || '', paths, lead })
      out(
        `item ${claims.shortId(id)} "${oneLine(title)}"${parent ? ` (part of ${claims.shortId(parent)})` : ''}`
      )
      out(`claim it: hs claim ${claims.shortId(id)}`)
    } finally {
      await closeBoard(net)
    }
  })
)

const suggest = command(
  'suggest',
  summary('Suggest an idea: an item of kind idea, for teammates (or a person) to approve or claim'),
  arg('<idea>', 'one line'),
  flag('--paths <p>', 'paths it would touch (repeatable)').multiple(),
  withRepo(async (ctx, cmd) => {
    const net = await claimBoard(ctx)
    try {
      const title = cmd.args.idea
      const paths = normalizePaths(cmd.flags.paths || [])
      const id = await newItem(ctx, net, { title, kind: 'idea', paths })
      const it = await ctx.repo.item(id)
      const short = claims.shortId(id)
      out(
        `idea ${short} "${oneLine(title)}"${it && it.needs ? ': ' + (await approvalText(ctx.repo, it)) : ''}`
      )
      out(
        it && it.needs
          ? `it waits in reviewers' hs inbox; keep working meanwhile (hs claims shows when it's approved)`
          : `claim it to build it: hs claim ${short}`
      )
    } finally {
      await closeBoard(net)
    }
  })
)

const claimCmd = command(
  'claim',
  summary("Say you're on an item, so teammates don't build it too (never blocks anyone)"),
  description(
    'Signals the claim to everyone online at once and records it in main. Waits ~1.5 s for ' +
      'competing claims, then says who leads: the earliest claim. If someone else leads, take a ' +
      'part, review their land, or share it with --with.'
  ),
  arg('[item]', 'the item (C1a2b3c); omit with --new'),
  flag('--new <title>', 'create an item and claim it'),
  (surface() === 'full' ? flag : hiddenFlag)(
    '--with <handle>',
    'claim it together with a teammate (co-leads; repeatable)'
  ).multiple(),
  (surface() === 'full' ? flag : hiddenFlag)('--note <text>', 'what you are doing on it'),
  (surface() === 'full' ? flag : hiddenFlag)(
    '--paths <p>',
    'paths you will touch (repeatable)'
  ).multiple(),
  flag('--release', 'let it go (it stays with whoever else is on it)'),
  flag('--done', 'mark it done without a land (e.g. a parent whose parts have all landed)'),
  (surface() === 'full' ? flag : hiddenFlag)(
    '--take',
    'take over (e.g. a stale claim): visible to everyone'
  ),
  withRepo(async (ctx, cmd) => {
    if (!ctx.repo.writable) throw new Error('not a writer yet')
    const net = await claimBoard(ctx)
    try {
      const board = net.board
      const me = ctx.repo.writerKey
      let id
      if (cmd.flags.new) {
        for (const it of similarItems(board, cmd.flags.new)) {
          const l = board.lead(it.id)
          const who = l ? `led by ${await ctx.repo.nameOf(l.lead.writer)}` : 'nobody on it yet'
          warn(
            `!! looks like ${claims.shortId(it.id)} "${oneLine(it.title)}" (${who}): claim that instead?`
          )
        }
        id = await newItem(ctx, net, {
          title: cmd.flags.new,
          paths: normalizePaths(cmd.flags.paths || [])
        })
      } else {
        const it = resolveItem(board, cmd.args.item || '')
        if (!it) {
          throw new Error(
            `no item ${cmd.args.item || ''} (hs claims lists them; hs claim --new "<title>" makes one)`
          )
        }
        id = it.id
      }
      const short = claims.shortId(id)
      const it = board.item(id)
      if (it && (it.done || it.dropped)) {
        out(`${short} is ${it.dropped ? 'dropped' : 'done'}; nothing to claim`)
        return
      }
      const now = Date.now()
      const mine = board.claimsOn(id, now).find((cl) => b4a.equals(cl.payload.writer, me))

      if (cmd.flags.done) {
        await announce(ctx, net, { item: id, action: claims.DONE, time: now, at: now })
        return out(`${short} done`)
      }

      if (cmd.flags.release) {
        if (!mine || mine.state === 'released') return out(`you don't hold ${short}`)
        const released = await announce(ctx, net, {
          item: id,
          action: claims.RELEASE,
          time: mine.payload.time,
          at: now
        })
        board.add(released)
        // someone else may still lead it (q0-min, q0b-min: "open again" read as if nobody did)
        const still = board.lead(id, now + 1)
        return out(
          still
            ? `released ${short}; ${await ctx.repo.nameOf(still.lead.writer)} still leads it`
            : `released ${short}: open again, nobody on it`
        )
      }

      const live = board.liveClaimsOf(me, now).filter((p) => !b4a.equals(p.item, id))
      if (live.length >= claims.MAX_LIVE) {
        throw new Error(
          `you already hold ${live.length} claims (${live.map((p) => claims.shortId(p.item)).join(', ')}); ` +
            'land or release one first (hs claim <item> --release)'
        )
      }
      const withKeys = []
      for (const h of cmd.flags.with || []) {
        const k = await ctx.repo.keyOf(h)
        if (!k) throw new Error(`no teammate ${h}`)
        withKeys.push(k)
      }
      const lead = board.lead(id, now)
      if (cmd.flags.take && lead && !b4a.equals(lead.lead.writer, me)) {
        warn(
          `!! ${await ctx.repo.nameOf(lead.lead.writer)} is still active on ${short} (${ago(lead.lead.at)}); taking it anyway`
        )
      }
      // a renewal keeps the original time: renewing never moves the lead
      const time = mine && mine.state === 'live' ? mine.payload.time : now
      await announce(ctx, net, {
        item: id,
        action: cmd.flags.take ? claims.TAKE : claims.CLAIM,
        time,
        at: now,
        ttl: claims.TTL_MS,
        note: cmd.flags.note || '',
        with: withKeys,
        paths: normalizePaths(cmd.flags.paths || [])
      })
      await sleep(claims.SETTLE_MS) // competing claims made in the same instant arrive now
      await printLead(ctx, board, id)
      // someone else leads: exit 2, so a script (or an agent) reads the verdict from the code
      // (q0b: "hs claim exits 0 even when you lose the claim")
      const verdict = board.lead(id)
      const self = ctx.repo.writerKey
      if (
        verdict &&
        !b4a.equals(verdict.lead.writer, self) &&
        !verdict.coLeads.some((p) => b4a.equals(p.writer, self))
      ) {
        process.exitCode = 2
      }
    } finally {
      await closeBoard(net)
    }
  })
)

const claimsCmd = command(
  'claims',
  summary('Open items and who is on them (the live board)'),
  flag('--all', 'include done and dropped items'),
  withRepoRead(async (ctx, cmd) => {
    let board
    let net = null
    if (ctx.readOnly) {
      board = new claims.Board()
      await board.load(ctx.repo)
    } else {
      net = await claimBoard(ctx)
      board = net.board
    }
    try {
      const now = Date.now()
      const items = [...board.items.values()]
        .filter((it) => cmd.flags.all || !(it.done || it.dropped))
        .sort((a, b) => (a.time || 0) - (b.time || 0))
      if (!items.length) {
        return out('no open items (hs item new "<title>", or hs claim --new "<title>")')
      }
      for (const it of items) {
        const by = it.author ? await ctx.repo.nameOf(it.author) : '?'
        const state = it.dropped
          ? ' [dropped]'
          : it.done
            ? ` [done${it.done > 0 ? ' #' + it.done : ''}]`
            : ''
        const part = it.parent ? ` (part of ${claims.shortId(it.parent)})` : ''
        out(
          `${claims.shortId(it.id)} "${oneLine(it.title || '')}"${part} by ${by}${it.time ? ', ' + ago(it.time) : ''}${state}`
        )
        if (it.done || it.dropped) continue
        const l = board.lead(it.id, now)
        if (it.lead) out(`  suggested lead: ${await ctx.repo.nameOf(it.lead)}`)
        if (it.needs) out(`  ${await approvalText(ctx.repo, it)}`)
        if (!l) out('  open: nobody on it')
        else {
          const name = (p) => ctx.repo.nameOf(p.writer)
          out(
            `  lead ${await name(l.lead)} (claimed ${ago(l.lead.time)}, active ${ago(l.lead.at || l.lead.time)})${l.lead.note ? ' :: ' + oneLine(l.lead.note) : ''}`
          )
          for (const p of l.coLeads) out(`  co-lead ${await name(p)}`)
          for (const p of l.others) {
            out(
              `  also ${await name(p)} (claimed ${((p.time - l.lead.time) / 1000).toFixed(1)} s later)`
            )
          }
        }
        for (const cl of board.claimsOn(it.id, now)) {
          if (cl.state === 'stale') {
            out(
              `  stale: ${await ctx.repo.nameOf(cl.payload.writer)} (active ${ago(cl.payload.at || cl.payload.time)}): hs claim ${claims.shortId(it.id)} --take`
            )
          }
        }
      }
    } finally {
      if (net) await net.close()
    }
  })
)

// commands an arm of the q0 experiment leaves out (HS_SURFACE; pm and people keep them all)
const HIDDEN = {
  full: new Set(),
  minimal: new Set(['item', 'suggest', 'inbox', 'propose', 'proposals', 'review']),
  plain: new Set(['item', 'suggest', 'inbox', 'propose', 'proposals', 'review', 'claims', 'claim'])
}

module.exports = function createCli(extra = []) {
  const hidden = HIDDEN[surface()]
  const keep = (...cmds) => cmds.filter((c) => !hidden.has(c.name))
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
    waitFinalCmd,
    log,
    show,
    watch,
    ...keep(
      // claims
      claimCmd,
      claimsCmd,
      itemCmd,
      // review
      propose,
      reviewCmd,
      proposalsCmd,
      inbox,
      suggest
    ),
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
    removeWriter,
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
