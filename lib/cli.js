const { command, flag, arg, rest, summary, description } = require('paparam')
const z32 = require('z32')
const b4a = require('b4a')
const c = require('compact-encoding')
const fs = require('bare-fs/promises')
const path = require('bare-path')
const process = require('bare-process')
const crypto = require('hypercore-crypto')
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

const out = (...a) => console.log(...a)
const warn = (...a) => console.error(...a)
const short = (buf) => z32.encode(buf).slice(0, 10)

const FETCH_TIMEOUT = 15_000
const HOLDER_HINT =
  'no online peer holds it. Every team needs a holder: run `hs seed --mirror` on an always-on ' +
  'hub worktree, or add a blind peer with `hs blind-peer <key>`'

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

async function pullMain(net, { timeout = FETCH_TIMEOUT } = {}) {
  if (!(await net.waitForPeers({ timeout }))) {
    warn('no peers found, using local state')
    return false
  }
  await net.settle()
  return true
}

// pull main and make everything the sparse set needs local (see Workspace.prefetch)
async function pullAndPrefetch(ctx, ws, net) {
  const connected = await pullMain(net)
  ws.io = { timeout: FETCH_TIMEOUT }
  if (!connected) return { connected, fetched: 0, missing: [] }
  const res = await ws.prefetch({ sparse: ctx.config.sparse, timeout: FETCH_TIMEOUT })
  return { connected, ...res }
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
      'run `hs sync && hs land -o`'
  )
  return f
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
      await ctx.close()
    }
  }
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
  async (cmd) => {
    const root = path.resolve(cmd.args.dir || process.cwd())
    if (await Context.find(root)) throw new Error('already inside a hyperscion worktree')
    const encryptionKey = cmd.flags.encrypt ? crypto.randomBytes(32) : null
    const ctx = await Context.create(root, { encryptionKey })
    try {
      await ctx.workspace()
      out('initialized', root)
      out('repo', ctx.invite)
    } finally {
      await ctx.close()
    }
  }
)

const status = command(
  'status',
  summary('Show uncommitted and unlanded changes'),
  withRepo(async (ctx) => {
    const ws = await ctx.workspace()
    out(`workspace ${ws.name} (base #${ws.state.base.seq})`)

    const last = await ws.lastLand()
    if (last && last.status === 'accepted') out(`last land: #${last.seq} (provisional)`)
    await flipBanner(ws)

    const pending = await ctx.worktree.status(ws)
    for (const ch of pending) out(`  ${ch.status.padEnd(9)} ${ch.path}`)
    for (const p of pending.stale) out(`  ${'stale'.padEnd(9)} ${p}  (behind main, run hs pull)`)

    const unlanded = await ws.changes()
    if (unlanded.length) out(`${unlanded.length} committed path(s) not landed`)
    for (const e of unlanded) out(`  ${(e.value ? 'commit' : 'commit-del').padEnd(9)} ${e.path}`)

    if (!pending.length && !unlanded.length && !pending.stale.length) out('clean')
  })
)

async function commitWorktree(ctx, ws) {
  const res = await ctx.worktree.commit(ws)
  if (res.blocked.length) {
    warn(`!! ${res.blocked.length} file(s) were edited on top of a stale copy and not committed:`)
    for (const p of res.blocked) warn('     ' + p)
    warn("   run `hs pull && hs sync` to fetch main's version first")
  }
  return res
}

const commitCmd = command(
  'commit',
  summary('Commit working copy changes to the workspace'),
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
  summary('Commit and land the workspace onto main'),
  flag('--message|-m <msg>', 'changeset message (teammates read these)'),
  flag('--author|-a <name>', 'author'),
  flag('--online|-o', 'pull first, rebase and retry on conflict, push afterwards'),
  flag('--rebase <n>', 'with --online: rebase-and-retry attempts on conflict (default 3)'),
  withRepo(async (ctx, cmd) => {
    const ws = await ctx.workspace()
    const committed = await commitWorktree(ctx, ws)
    if (committed.blocked.length) {
      throw new Error('refusing to land while files are edited on top of stale copies (see above)')
    }

    const net = cmd.flags.online ? await online(ctx) : null
    try {
      if (net) reportMissing((await pullAndPrefetch(ctx, ws, net)).missing)
      if (!ctx.repo.writable) {
        throw new Error(
          'not a writer, ask a writer to run `hs add-writer ' + z32.encode(ctx.repo.writerKey) + '`'
        )
      }
      await flipBanner(ws)

      const message = cmd.flags.message || ''
      const author = cmd.flags.author || process.env.USER || ''
      let retries = net ? Number(cmd.flags.rebase ?? 3) : 0
      let { outcome } = await ws.land({ message, author })

      // what a merge queue does server side, done by the lander: fetch what changed, rebase
      // (3-way / union merge) and try again, as long as the merge is clean
      while (retries-- > 0 && (outcome.status === 'conflict' || outcome.status === 'stale-base')) {
        printOutcome(outcome)
        out('rebasing onto main and retrying...')
        reportMissing((await pullAndPrefetch(ctx, ws, net)).missing)
        const res = await ws.sync()
        if (res.conflicts.length) {
          await materialize(ctx, ws, net)
          out(`real conflicts in ${res.conflicts.join(' ')}: fix the markers, then land again`)
          process.exitCode = 2
          return
        }
        ;({ outcome } = await ws.land({ message, author }))
      }

      if (outcome.status === 'accepted') {
        await materialize(ctx, ws, net)
        out(`landed #${outcome.seq} (provisional until all writers have seen it)`)
      } else if (outcome.status === 'empty') {
        out('nothing to land')
      } else {
        printOutcome(outcome)
        out('run `hs sync`, fix any conflict markers, then land again')
        process.exitCode = 2
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
      }
    } finally {
      if (net) await net.close()
    }
  })
)

const sync = command(
  'sync',
  summary('Pull main and rebase the workspace onto it, merging overlapping files'),
  flag('--offline', 'do not pull first (fails fast if needed content is not local)'),
  withRepo(async (ctx, cmd) => {
    const ws = await ctx.workspace()
    await commitWorktree(ctx, ws)

    const net = cmd.flags.offline ? null : await online(ctx)
    try {
      if (net) reportMissing((await pullAndPrefetch(ctx, ws, net)).missing)
      else ws.io = { wait: false }

      const res = await ws.sync()
      await materialize(ctx, ws, net)

      if (res.restored) {
        out(
          `restored your land that a concurrent land undid (${res.restored.status}); land it again`
        )
      }
      if (res.upToDate) return out('up to date')
      out(`synced to #${ws.state.base.seq}: ${res.replayed} replayed, ${res.merged.length} merged`)
      for (const p of res.merged) out('  merged    ' + p)
      for (const p of res.conflicts) out('  CONFLICT  ' + p)
      if (res.conflicts.length) process.exitCode = 2
    } finally {
      if (net) await net.close()
    }
  })
)

const diff = command(
  'diff',
  summary('List paths changed relative to the fork point (what `land` will send)'),
  withRepo(async (ctx) => {
    const ws = await ctx.workspace()
    for (const e of await ws.changes()) out(`${e.value ? 'M' : 'D'} ${e.path}`)
  })
)

function printChangeset(cs, { files = false } = {}) {
  const when = cs.time ? new Date(cs.time).toISOString() : ''
  out(`#${cs.seq} ${short(cs.hash)} ${cs.author || '-'} ${when} ${cs.paths} path(s)`)
  if (cs.message) out('    ' + cs.message.split('\n').join('\n    '))
  if (files) {
    for (const f of cs.files || []) out('      ' + f)
    if (cs.files && cs.paths > cs.files.length) {
      out(`      ... ${cs.paths - cs.files.length} more`)
    }
  }
}

const log = command(
  'log',
  summary('Show landed changesets, optionally for one path'),
  arg('[path]', 'only changesets touching this path'),
  flag('--limit|-n <n>', 'max entries'),
  flag('--files|-f', 'list the paths each changeset touched (- = deleted)'),
  withRepo(async (ctx, cmd) => {
    const limit = cmd.flags.limit ? Number(cmd.flags.limit) : 20
    const p = cmd.args.path ? '/' + cmd.args.path.replace(/^\/+/, '') : null
    for await (const cs of ctx.repo.log({ path: p, limit })) {
      printChangeset(cs, { files: cmd.flags.files })
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

async function renderShow(repo, seq, io, { stat = false } = {}) {
  const snap = repo.main.view.snapshot(io)
  const drive = repo.drive()
  try {
    const res = await repo.show(seq, snap)
    if (!res) throw new Error('no changeset #' + seq)
    const { cs } = res
    let text = `changeset #${cs.seq} ${short(cs.hash)}\n`
    text += `author ${cs.author || '-'}  ${cs.time ? new Date(cs.time).toISOString() : ''}  base #${cs.base.seq}\n\n`
    if (cs.message) text += '    ' + cs.message.split('\n').join('\n    ') + '\n\n'
    for (const f of res.files) {
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
  summary("Show a changeset: message and a unified diff of every file (a teammate's work)"),
  arg('<seq>', 'changeset number, e.g. 27 or #27'),
  flag('--stat', 'only list the files'),
  withRepo(async (ctx, cmd) => {
    const seq = Number(cmd.args.seq.replace(/^#/, ''))
    const text = await withContent(ctx, (io) =>
      renderShow(ctx.repo, seq, io, { stat: cmd.flags.stat })
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

const restore = command(
  'restore',
  summary('Discard local edits: rewrite files from the workspace version'),
  rest('[...paths]', 'files to restore'),
  withRepo(async (ctx, cmd) => {
    const paths = cmd.rest || []
    if (!paths.length) throw new Error('name the files to restore')
    const ws = await ctx.workspace()
    const net = await online(ctx)
    try {
      ws.io = { timeout: FETCH_TIMEOUT }
      for (const p of await ctx.worktree.restore(ws, paths)) out('restored ' + p)
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
        out(`cloned ${ctx.config.key} at #${meta.seq} into ${root}: ${stats.written} file(s)`)
        const writer = z32.encode(ctx.repo.writerKey)
        if (cmd.flags.admit) {
          const file = path.join(path.resolve(cmd.flags.admit), path.basename(root) + '.key')
          await fs.writeFile(file, writer + '\n')
          out(`requested write access via ${file}; \`hs pull\` once the seed has admitted it`)
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

const pull = command(
  'pull',
  summary("Fetch main and everything your sparse set needs (doesn't change files, see sync)"),
  withRepo(async (ctx) => {
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
      (after.seq === before.seq
        ? `main at #${after.seq}`
        : `main #${before.seq} -> #${after.seq}`) +
        (res.fetched ? `, fetched ${res.fetched} file(s)` : '')
    )
    await flipBanner(ws)
    reportMissing(res.missing)
  })
)

const push = command(
  'push',
  summary('Wait until peers (or blind peers) hold our oplog'),
  withRepo(async (ctx) => {
    const net = await online(ctx)
    try {
      const wss = []
      for (const name of await ctx.repo.listWorkspaces()) wss.push(await ctx.repo.workspace(name))
      for (const w of wss) net.seed(w)
      if (!(await net.waitForPeers())) throw new Error('no peers found')
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
        const { outcome } = await ctx.repo.addWriter(z32.decode(keyText))
        out(`admitted ${name}: ${outcome.status}`)
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
  summary('Stay online and replicate; --mirror also holds every landed file (be the holder)'),
  flag('--mirror', 'eagerly download all landed content'),
  flag('--admit <dir>', 'admit writers whose keys are dropped into this directory'),
  flag('--updates', 'apply peer-to-peer OTA updates of hs while seeding'),
  withRepo(async (ctx, cmd) => {
    const net = await online(ctx, { mirror: !!cmd.flags.mirror, server: true })
    out(`seeding ${ctx.config.key}${cmd.flags.mirror ? ' (mirror)' : ''}, ctrl+c to stop`)
    net.on('mirrored', (cs) => out(`mirrored #${cs.seq}`))
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

function printWatchChangeset(cs, json) {
  const files = (cs.files || []).concat(cs.paths > (cs.files || []).length ? ['...'] : [])
  if (json) {
    out(
      JSON.stringify({
        type: 'changeset',
        seq: cs.seq,
        hash: z32.encode(cs.hash),
        author: cs.author,
        time: cs.time,
        message: cs.message,
        files
      })
    )
  } else {
    out(`#${cs.seq} ${cs.author || '-'} ${files.join(' ')} :: ${oneLine(cs.message)}`)
  }
}

function printReorg({ seq, before, after }, json) {
  if (json) {
    const brief = (cs) => (cs ? { author: cs.author, message: cs.message } : null)
    out(JSON.stringify({ type: 'reorg', seq, was: brief(before), now: brief(after) }))
    return
  }
  const was = `${before.author} "${oneLine(before.message)}"`
  const now = after ? `${after.author} "${oneLine(after.message)}"` : 'nothing'
  out(`!! reorg: #${seq} was ${was}, now ${now}. If that was your land: hs sync && hs land -o`)
}

const watch = command(
  'watch',
  summary('Stream changesets as teammates land them (run in the background instead of polling)'),
  flag('--path|-p <prefix>', 'only changesets touching this path (repeatable)').multiple(),
  flag('--since <seq>', 'replay from after this changeset first (default: only new ones)'),
  flag('--count|-c <n>', 'exit after n matching changesets (e.g. wait for a dependency)'),
  flag('--json', 'one JSON object per line'),
  flag('--patch', 'include unified diffs'),
  async (cmd) => {
    // a separate observer store, so watch never holds the worktree's store lock; a second
    // concurrent watcher (e.g. a blocking --count 1 next to a background feed) gets a
    // throwaway store
    const { root, config } = await Context.load(process.cwd())
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
    const net = new Network(repo, {
      bootstrap: bootstrap(),
      blindPeers: blindPeers(config),
      server: false
    })
    await net.ready()

    const since = cmd.flags.since
    const watcher = new Watcher(repo, {
      since: since !== undefined ? Number(String(since).replace(/^#/, '')) : null,
      paths: cmd.flags.path || []
    })
    const limit = cmd.flags.count ? Number(cmd.flags.count) : Infinity
    const json = !!cmd.flags.json
    let seen = 0
    let queue = Promise.resolve()

    const stop = new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
      watcher.on('changeset', (cs) => {
        queue = queue.then(async () => {
          if (seen >= limit) return
          seen++
          printWatchChangeset(cs, json)
          if (cmd.flags.patch) {
            const text = await renderShow(repo, cs.seq, { timeout: FETCH_TIMEOUT }).catch(
              (err) => `(diff unavailable: ${err.message})\n`
            )
            out(text)
          }
          if (seen >= limit) resolve()
        })
      })
      watcher.on('reorg', (ev) => printReorg(ev, json))
      watcher.on('error', (err) => warn('watch: ' + err.message))
    })

    try {
      if (!(await net.waitForPeers({ timeout: 30_000 }))) warn('watch: no peers yet, waiting...')
      await net.settle({ timeout: 10_000 })
      await watcher.start()
      if (!json) {
        const what = cmd.flags.path ? ' for ' + cmd.flags.path.join(' ') : ''
        warn(`watching main from #${watcher.last}${what}`)
      }
      await stop
      await queue
    } finally {
      await watcher.close()
      await net.close()
      await repo.close()
      await store.close()
      if (temp) await fs.rm(dir, { recursive: true, force: true })
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
  flag('--indexer', 'make the writer an indexer'),
  withRepo(async (ctx, cmd) => {
    const key = z32.decode(cmd.args.key)
    const { outcome } = await ctx.repo.addWriter(key, { indexer: !!cmd.flags.indexer })
    out(`add-writer: ${outcome.status}`)
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
    init,
    clone,
    status,
    commitCmd,
    land,
    sync,
    diff,
    log,
    show,
    watch,
    ls,
    cat,
    restore,
    checkout,
    ws,
    info,
    addWriter,
    pull,
    push,
    seed,
    doctor,
    blindPeer,
    importCmd,
    ...extra
  )
}

module.exports.short = short
