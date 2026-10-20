const { command, flag, arg, rest, summary, description } = require('paparam')
const z32 = require('z32')
const path = require('bare-path')
const process = require('bare-process')
const Context = require('./context')
const Network = require('./net')
const importGit = require('./import-git')
const startUpdates = require('./updates')
const crypto = require('hypercore-crypto')

const out = (...a) => console.log(...a)
const short = (buf) => z32.encode(buf).slice(0, 10)

// HS_BOOTSTRAP=host:port,host:port selects a private DHT (tests, airgapped setups)
function bootstrap() {
  const env = process.env.HS_BOOTSTRAP
  if (!env) return null
  return env.split(',').map((s) => {
    const [host, port] = s.split(':')
    return { host, port: Number(port) }
  })
}

async function online(ctx, opts = {}) {
  const blindPeers = (ctx.config.blindPeers || []).map((k) => z32.decode(k))
  const net = new Network(ctx.repo, { bootstrap: bootstrap(), blindPeers, server: false, ...opts })
  await net.ready()
  return net
}

async function pullMain(ctx, net, { timeout = 15_000 } = {}) {
  if (!(await net.waitForPeers({ timeout }))) out('no peers found, using local state')
  else await net.settle()
}

// Write the workspace to disk. Content not held locally (e.g. landed by a peer that has
// since gone offline) is fetched by going online; anything still unavailable is reported.
async function materialize(ctx, ws, net = null) {
  const first = await ctx.worktree.checkout(ws)
  if (first.missing.length === 0) return first

  let stats = first
  const own = net === null
  if (own) net = await online(ctx)
  try {
    if (await net.waitForPeers({ timeout: 15_000 })) {
      const again = await ctx.worktree.checkout(ws, { wait: true, timeout: 15_000 })
      stats = { ...again, written: first.written + again.written }
    }
  } finally {
    if (own) await net.close()
  }

  if (stats.missing.length) {
    out(`warning: ${stats.missing.length} file(s) not available from any online peer:`)
    for (const p of stats.missing.slice(0, 10)) out('  ' + p)
    out('run `hs checkout` again once a seed, mirror or blind peer holding them is online')
    process.exitCode = 2
  }
  return stats
}

function withRepo(fn) {
  return async (cmd) => {
    const ctx = await Context.open(process.cwd())
    try {
      await fn(ctx, cmd)
    } finally {
      await ctx.close()
    }
  }
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
    if (last && last.status === 'accepted') out(`last land: accepted as #${last.seq} (provisional)`)
    else if (last) {
      out(
        `last land: flipped to ${last.status} by a concurrent land, run \`hs sync\` then land again`
      )
    }

    const pending = await ctx.worktree.status(ws)
    for (const ch of pending) out(`  ${ch.status.padEnd(9)} ${ch.path}`)

    const unlanded = await ws.changes()
    if (unlanded.length) out(`${unlanded.length} committed path(s) not landed`)
    for (const e of unlanded) out(`  ${(e.value ? 'commit' : 'commit-del').padEnd(9)} ${e.path}`)

    if (!pending.length && !unlanded.length) out('clean')
  })
)

const commit = command(
  'commit',
  summary('Commit working copy changes to the workspace'),
  withRepo(async (ctx) => {
    const ws = await ctx.workspace()
    const n = await ctx.worktree.commit(ws)
    out(
      n
        ? `committed ${n} path(s) @ ${short(ws.head().key)}:${ws.head().length}`
        : 'nothing to commit'
    )
  })
)

const land = command(
  'land',
  summary('Commit and land the workspace onto main'),
  flag('--message|-m <msg>', 'changeset message'),
  flag('--author|-a <name>', 'author'),
  flag('--online|-o', 'pull main first and push the land to peers afterwards'),
  withRepo(async (ctx, cmd) => {
    const ws = await ctx.workspace()
    await ctx.worktree.commit(ws)

    const net = cmd.flags.online ? await online(ctx) : null
    if (net) await pullMain(ctx, net)
    if (!ctx.repo.writable) {
      if (net) await net.close()
      throw new Error(
        'not a writer, ask a writer to run `hs add-writer ' + z32.encode(ctx.repo.writerKey) + '`'
      )
    }

    const { outcome } = await ws.land({
      message: cmd.flags.message || '',
      author: cmd.flags.author || process.env.USER || ''
    })

    if (outcome.status === 'accepted') {
      await materialize(ctx, ws, net)
      out(`landed #${outcome.seq} (provisional until all writers have seen it)`)
    } else if (outcome.status === 'conflict') {
      out(`conflict on ${outcome.conflicts.length} path(s), run \`hs sync\` and land again:`)
      for (const p of outcome.conflicts) out('  ' + p)
      process.exitCode = 2
    } else if (outcome.status === 'empty') {
      out('nothing to land')
    } else {
      out(`rejected: ${outcome.status}${outcome.reason ? ' (' + outcome.reason + ')' : ''}`)
      process.exitCode = 2
    }

    if (net) {
      if (outcome.status === 'accepted') {
        net.seed(ws)
        out((await net.uploaded()) ? 'pushed' : 'push timed out, run `hs push` later')
      }
      await net.close()
    }
  })
)

const sync = command(
  'sync',
  summary('Rebase the workspace onto main, 3-way merging overlapping files'),
  withRepo(async (ctx) => {
    const ws = await ctx.workspace()
    await ctx.worktree.commit(ws)
    const res = await ws.sync()
    await materialize(ctx, ws)

    if (res.upToDate) return out('up to date')
    out(`synced to #${ws.state.base.seq}: ${res.replayed} replayed, ${res.merged.length} merged`)
    for (const p of res.merged) out('  merged    ' + p)
    for (const p of res.conflicts) out('  CONFLICT  ' + p)
    if (res.conflicts.length) process.exitCode = 2
  })
)

const diff = command(
  'diff',
  summary('List paths changed relative to the fork point'),
  withRepo(async (ctx) => {
    const ws = await ctx.workspace()
    for (const e of await ws.changes()) out(`${e.value ? 'M' : 'D'} ${e.path}`)
  })
)

const log = command(
  'log',
  summary('Show landed changesets, optionally for one path'),
  arg('[path]', 'only changesets touching this path'),
  flag('--limit|-n <n>', 'max entries'),
  withRepo(async (ctx, cmd) => {
    const limit = cmd.flags.limit ? Number(cmd.flags.limit) : 20
    const p = cmd.args.path ? '/' + cmd.args.path.replace(/^\/+/, '') : null
    for await (const cs of ctx.repo.log({ path: p, limit })) {
      const when = cs.time ? new Date(cs.time).toISOString() : ''
      out(`#${cs.seq} ${short(cs.hash)} ${cs.author || '-'} ${when} ${cs.paths} path(s)`)
      if (cs.message) out('    ' + cs.message)
    }
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
      const buf = await drive.get(cmd.args.path)
      if (buf === null) throw new Error('no such file: ' + cmd.args.path)
      process.stdout.write(buf)
    } finally {
      if (!cmd.flags.ws) await drive.close()
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
      ctx.config.sparse = paths.map((p) => '/' + p.replace(/^\/+/, '').replace(/\/+$/, ''))
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
  async (cmd) => {
    const root = path.resolve(cmd.args.dir || cmd.args.invite.slice(0, 8))
    const sparse = (cmd.flags.sparse || ['/']).map(
      (p) => '/' + p.replace(/^\/+/, '').replace(/\/+$/, '')
    )
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
        const meta = await ctx.repo.meta()
        const stats = await materialize(ctx, ws, net)
        out(`cloned ${ctx.config.key} at #${meta.seq} into ${root}: ${stats.written} file(s)`)
        out('writer key (share with a writer to get access):', z32.encode(ctx.repo.writerKey))
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
  summary('Fetch main from peers (does not touch the workspace, see `hs sync`)'),
  withRepo(async (ctx) => {
    const before = await ctx.repo.meta()
    const net = await online(ctx)
    try {
      await pullMain(ctx, net)
    } finally {
      await net.close()
    }
    const after = await ctx.repo.meta()
    out(after.seq === before.seq ? `main at #${after.seq}` : `main #${before.seq} -> #${after.seq}`)
  })
)

const push = command(
  'push',
  summary('Wait until peers (or blind peers) hold our oplog'),
  withRepo(async (ctx) => {
    const net = await online(ctx)
    try {
      for (const name of await ctx.repo.listWorkspaces()) net.seed(await ctx.repo.workspace(name))
      if (!(await net.waitForPeers())) throw new Error('no peers found')
      out((await net.uploaded()) ? 'pushed' : 'push timed out')
    } finally {
      await net.close()
    }
  })
)

const seed = command(
  'seed',
  summary('Stay online and replicate; --mirror also holds every landed file'),
  flag('--mirror', 'eagerly download all landed content'),
  flag('--updates', 'apply peer-to-peer OTA updates of hs while seeding'),
  withRepo(async (ctx, cmd) => {
    const net = await online(ctx, { mirror: !!cmd.flags.mirror, server: true })
    out(`seeding ${ctx.config.key}${cmd.flags.mirror ? ' (mirror)' : ''}, ctrl+c to stop`)
    net.on('mirrored', (cs) => out(`mirrored #${cs.seq}`))
    const updater = cmd.flags.updates ? await startUpdates(out) : null
    await new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
    if (updater) await updater.close()
    await net.close()
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
    description('Workspaces fork main in O(1), commits cost O(change), lands are lock-free.'),
    init,
    clone,
    status,
    commit,
    land,
    sync,
    diff,
    log,
    ls,
    cat,
    checkout,
    ws,
    info,
    addWriter,
    pull,
    push,
    seed,
    blindPeer,
    importCmd,
    ...extra
  )
}

module.exports.short = short
