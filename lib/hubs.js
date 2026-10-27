// A hub home: one directory, one process and one store hubbing many repos (README "Hosting
// many repos"). Each repo's hub writer lives in its own namespace of the shared store, so
// every repo still has its own hub key, replaceable on its own; the network is one
// @holepunchto/replicator (lib/hubnet.js).
//
//   <home>/hubs.json        { repos: { <name>: { key, encryptionKey, ns, owner, created } } }
//   <home>/store/           the shared corestore
//   <home>/admit/<name>/    drop directory for `hs clone --admit` (as `hs seed --admit`)
//   <home>/owners/<name>/   the owner's worktree, made with the repo
//   <home>/requests/        `hs hubs new` while the home is served: the server holds the
//                           store lock, so it makes the repo and answers in <name>.done
//   <home>/status.json      written by the server: pid, connections, per-repo seq/settled
const fs = require('bare-fs/promises')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
const z32 = require('z32')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const Context = require('./context')
const Repo = require('./repo')
const Network = require('./net')
const rules = require('./rules')
const pkg = require('../package.json')
const settle = require('./settle')
const EventEmitter = require('bare-events')
const { createReplicator, closeReplicator, RepoSwarm } = require('./hubnet')

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
const REQUEST_POLL_MS = 500
const STATUS_MS = 1000
// repos brought up at once when a server starts
const START_PARALLEL = 16
// a restart waits for this long without a land, every repo settled
const QUIET_MS = 60_000
// ...but no longer than this
const RESTART_MAX_MS = 30 * 60_000

// The genesis handover of a team repo (docs/FINALITY.md): a throwaway writer of weight 2
// grants the hub weight 2 (the indexer), names the owner (a plain writer who may mark people
// human) and steps down. owner and hub are { store, repo } on any store or namespace; the
// caller made the genesis and closes everything.
async function handover(genesis, owner, hub, handle) {
  const streams = []
  const link = (a, b) => {
    const s1 = a.store.replicate(true)
    const s2 = b.store.replicate(false)
    s1.pipe(s2).pipe(s1)
    streams.push(s1, s2)
  }
  const pump = async (until, tries = 400) => {
    for (let i = 0; i < tries && !(await until()); i++) {
      for (const x of [genesis, owner, hub]) await x.repo.update()
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return until()
  }
  try {
    link(genesis, owner)
    link(genesis, hub)
    link(owner, hub)
    await genesis.repo.addWriter(hub.repo.writerKey, { indexer: true, handle: 'hub' })
    await genesis.repo.addWriter(owner.repo.writerKey, { handle, owner: true })
    if (!(await pump(() => owner.repo.writable && hub.repo.writable))) {
      throw new Error('the hub and owner did not become writers')
    }
    await genesis.repo.removeWriter(genesis.repo.writerKey)
    const handedOver = async () => {
      for (const x of [owner, hub]) {
        const settlers = await x.repo.settlers()
        if (settlers.length !== 1 || !b4a.equals(settlers[0], hub.repo.writerKey)) return false
      }
      return true
    }
    if (!(await pump(handedOver))) {
      throw new Error('the genesis writer did not hand over to the hub')
    }
    // the hub acks once, so it is known to have seen main
    await hub.repo.ack()
    await pump(() => false, 20)
  } finally {
    for (const st of streams) st.destroy()
  }
}

// a throwaway weight-2 writer that creates a repo; its key goes with its directory
async function createGenesis(encryptionKey) {
  const dir = path.join(os.tmpdir(), 'hs-genesis-' + b4a.toString(crypto.randomBytes(8), 'hex'))
  const ctx = await Context.create(dir, { encryptionKey, bootstrapWeight: 2 })
  return {
    ctx,
    async close() {
      await ctx.close()
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
}

class HubHome {
  constructor(dir) {
    this.dir = path.resolve(dir)
  }

  file(...parts) {
    return path.join(this.dir, ...parts)
  }

  async exists() {
    return !!(await fs.stat(this.file('hubs.json')).catch(() => null))
  }

  async config() {
    try {
      return JSON.parse(await fs.readFile(this.file('hubs.json'), 'utf8'))
    } catch {
      return { repos: {} }
    }
  }

  async saveConfig(config) {
    await fs.mkdir(this.dir, { recursive: true })
    const tmp = this.file('hubs.json.tmp')
    await fs.writeFile(tmp, JSON.stringify(config, null, 2) + '\n')
    await fs.rename(tmp, this.file('hubs.json'))
  }

  // the invite teammates clone with ("~1": a repo whose bootstrap writer is light, as
  // Context#invite)
  static invite(entry) {
    const base = entry.encryptionKey ? entry.key + '.' + entry.encryptionKey : entry.key
    return entry.bootstrapWeight === 1 ? base + '~1' : base
  }

  async entry(name) {
    const { repos } = await this.config()
    if (!repos[name]) throw new Error(`no repo named ${name} is hubbed here (hs hubs list)`)
    return repos[name]
  }

  // which process serves this home, if one does
  async server() {
    try {
      const busy = JSON.parse(await fs.readFile(this.file('busy.json'), 'utf8'))
      return alive(busy.pid) ? busy : null
    } catch {
      return null
    }
  }

  openStore(opts = {}) {
    return new Corestore(this.file('store'), opts)
  }

  repoOf(root, entry) {
    return new Repo(root.namespace(entry.ns), {
      key: z32.decode(entry.key),
      encryptionKey: entry.encryptionKey ? z32.decode(entry.encryptionKey) : null,
      bootstrapWeight: entry.bootstrapWeight || 2
    })
  }

  // An existing repo's hub moved into this home, by the replacement procedure (README
  // "Replacing a hub"): the old hub (its `hs seed` stopped) grants a new hub writer in a fresh
  // namespace weight 2, the new hub copies everything the old one held, then removes it. The
  // repo, its history and its teammates don't change; only who hubs it does.
  async adoptRepo(root, name, fromDir, { log = noop, timeout = 120_000 } = {}) {
    checkName(name)
    const config = await this.config()
    if (config.repos[name]) throw new Error(`a repo named ${name} is already hubbed here`)
    const from = path.resolve(fromDir)
    let old
    try {
      old = await Context.open(from)
    } catch (err) {
      if (err.code === 'WORKTREE_BUSY') {
        throw new Error(`${from} is in use: stop its \`hs seed\` first, then adopt it`)
      }
      throw err
    }
    const ns = 'repo-' + b4a.toString(crypto.randomBytes(8), 'hex')
    let hub = null
    let net = null
    const streams = []
    try {
      if (old.root !== from) throw new Error(`${from} is inside a worktree, not a hub's root`)
      const oldKey = old.repo.writerKey
      const record = await old.repo.writer(oldKey)
      const settlers = await old.repo.settlers()
      if (
        !record ||
        !record.indexer ||
        settle.weightOf(record, old.repo.lightBootstrap) < 2 ||
        !settlers.some((k) => b4a.equals(k, oldKey))
      ) {
        throw new Error(
          `${from} is not a hub that settles its repo alone (an indexer of weight 2); ` +
            '`hs doctor` there says which rule the repo is on'
        )
      }
      const bootstrapWeight = Context.bootstrapWeightOf(old.config)
      const encryptionKey = old.encryptionKey
      hub = new Repo(root.namespace(ns), { key: old.repo.key, encryptionKey, bootstrapWeight })
      await hub.ready()

      const s1 = old.store.replicate(true)
      const s2 = hub.store.replicate(false)
      s1.pipe(s2).pipe(s1)
      streams.push(s1, s2)
      const pump = async (until, ms) => {
        const deadline = Date.now() + ms
        while (!(await until())) {
          if (Date.now() > deadline) return false
          await old.repo.update()
          await hub.update()
          await sleep(25)
        }
        return true
      }

      // a fresh handle: a removed writer keeps its handle taken
      let handle = null
      for (let n = 2; !handle; n++) {
        if (!(await old.repo.keyOf('hub' + n))) handle = 'hub' + n
      }
      const granted = await old.repo.addWriter(hub.writerKey, { indexer: true, handle })
      if (!accepted(granted.outcome)) {
        throw new Error('the old hub could not add the new one: ' + reason(granted.outcome))
      }
      const settlesToo = async (repo) =>
        (await repo.settlers()).some((k) => b4a.equals(k, hub.writerKey))
      if (!(await pump(async () => hub.writable && (await settlesToo(hub)), timeout))) {
        throw new Error('the new hub did not become an indexer')
      }
      log(`${name}: the old hub added this home's hub as ${handle}`)

      // hold everything the old hub held: some of it may exist nowhere else
      net = new Network(hub, {
        swarm: new LinkSwarm(),
        replicate: false,
        passiveSignals: true,
        role: 'holder',
        mirror: true
      })
      await net.ready()
      net.swarm.emit('connection', s2.noiseStream, { client: false, topics: [] })
      const target = (await hub.meta()).seq || 0
      const copied = await pump(() => net.mirrored >= target, timeout)
      log(
        `${name}: copied ${copied ? 'everything' : 'up to #' + net.mirrored} of main #${target}` +
          (copied ? '' : ' (the rest is fetched from teammates once served)')
      )

      const removed = await hub.removeWriter(oldKey)
      if (!accepted(removed.outcome)) {
        throw new Error('could not remove the old hub: ' + reason(removed.outcome))
      }
      const alone = async (repo) => {
        const s = await repo.settlers()
        return s.length === 1 && b4a.equals(s[0], hub.writerKey)
      }
      if (!(await pump(async () => (await alone(hub)) && (await alone(old.repo)), timeout))) {
        throw new Error('the old hub was not removed')
      }
      await hub.ack()
      await pump(() => false, 500)
      log(`${name}: the old hub is removed; ${from} is retired (never \`hs seed\` it again)`)
    } catch (err) {
      if (hub) await hub.close().catch(noop)
      hub = null
      throw err
    } finally {
      if (net) await net.close().catch(noop)
      for (const st of streams) st.destroy()
      await old.close()
    }

    const entry = {
      key: z32.encode(hub.key),
      encryptionKey: old.config.encryptionKey || null,
      bootstrapWeight: Context.bootstrapWeightOf(old.config),
      ns,
      owner: null,
      adopted: from,
      created: new Date().toISOString()
    }
    config.repos[name] = entry
    await this.saveConfig(config)
    await fs.mkdir(this.file('admit', name), { recursive: true })
    return { entry, hub }
  }

  // add a writer to a repo hubbed here, as the repo's hub (a replacement hub elsewhere, with
  // indexer: true, is how a repo moves out of a home)
  async addWriter(root, name, key, { handle = null, indexer = false } = {}) {
    const entry = await this.entry(name)
    const repo = this.repoOf(root, entry)
    await repo.ready()
    try {
      const { outcome } = await repo.addWriter(z32.decode(key), { handle, indexer })
      if (!accepted(outcome)) {
        throw new Error('not added: ' + reason(outcome))
      }
      return { name, handle, indexer }
    } finally {
      await repo.close()
    }
  }

  // A new repo hubbed here: the genesis hands over to a hub writer in a fresh namespace of
  // `root` and to an owner worktree in owners/<name>. Returns the hubs.json entry, and the
  // hub's Repo, still open, so a server can start serving it.
  async createRepo(root, name, { encrypt = false, handle = null } = {}) {
    checkName(name)
    const config = await this.config()
    if (config.repos[name]) throw new Error(`a repo named ${name} is already hubbed here`)
    const ownerDir = this.file('owners', name)
    if (await Context.find(ownerDir)) throw new Error(ownerDir + ' is already a worktree')

    const encryptionKey = encrypt ? crypto.randomBytes(32) : null
    const ns = 'repo-' + b4a.toString(crypto.randomBytes(8), 'hex')
    const genesis = await createGenesis(encryptionKey)
    const opts = { key: genesis.ctx.repo.key, encryptionKey, bootstrapWeight: 2 }
    let owner = null
    let hub = null
    try {
      owner = await Context.create(ownerDir, opts)
      await owner.workspace()
      hub = new Repo(root.namespace(ns), opts)
      await hub.ready()
      await handover(genesis.ctx, owner, { store: hub.store, repo: hub }, handle)
      await owner.saveBase()
    } catch (err) {
      if (hub) await hub.close().catch(noop)
      throw err
    } finally {
      if (owner) await owner.close()
      await genesis.close()
    }

    const entry = {
      key: z32.encode(hub.key),
      encryptionKey: encryptionKey ? z32.encode(encryptionKey) : null,
      ns,
      owner: handle,
      created: new Date().toISOString()
    }
    config.repos[name] = entry
    await this.saveConfig(config)
    await fs.mkdir(this.file('admit', name), { recursive: true })
    return { entry, hub }
  }

  // a `hs hubs` command while a server holds the store: ask it ({ op, name, ...}), and wait
  // for its answer
  async request(payload, { timeout = 180_000 } = {}) {
    checkName(payload.name)
    const dir = this.file('requests')
    await fs.mkdir(dir, { recursive: true })
    const id = payload.op + '-' + payload.name
    const done = path.join(dir, id + '.done')
    await fs.rm(done, { force: true })
    const tmp = path.join(dir, '.' + id + '.json')
    await fs.writeFile(tmp, JSON.stringify(payload) + '\n')
    await fs.rename(tmp, path.join(dir, id + '.json'))
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const answer = await fs.readFile(done, 'utf8').catch(() => null)
      if (answer) {
        await fs.rm(done, { force: true })
        const res = JSON.parse(answer)
        if (res.error) throw new Error(res.error)
        return res
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error('the hub server did not answer; is `hs hubs serve` still running?')
  }
}

// One process serving every repo of a hub home: one store, one replicator, a Network per
// repo for mirroring, acks and signals, and an admit loop per repo. New repos (hubs.json,
// or a request while serving) are picked up without a restart.
class HubServer {
  constructor(
    home,
    {
      bootstrap = null,
      log = noop,
      restartOnUpdate = false,
      quietMs = QUIET_MS,
      restartMaxMs = RESTART_MAX_MS
    } = {}
  ) {
    this.home = home
    this.bootstrap = bootstrap
    this.log = log
    this.root = null
    this.rep = null
    this.repos = new Map() // name -> { repo, net, admitting }
    this.stopped = false
    this._loops = []
    this.started = Date.now()
    // restarts (an applied update, or `hs hubs restart`): wait for a quiet moment, then
    // `exiting` resolves and the command stops the server; a service manager starts it again
    this.restartOnUpdate = restartOnUpdate
    this.quietMs = quietMs
    this.restartMaxMs = restartMaxMs
    this.update = null // { applied } once an update replaced the binary
    this.restarting = null // { reason, since }
    this.lastActivity = Date.now() // the last time any repo's main moved
    this.exiting = new Promise((resolve) => {
      this._exit = resolve
    })
  }

  async start() {
    await fs.mkdir(this.home.dir, { recursive: true })
    // passive: a core is attached to a connection only when the peer opens it. An active store
    // attaches every open core (every repo's) to every connection, and a peer only wants its
    // repo's: at 100 repos that cost ~4.4 MB per connection, 1 GB at 200 (bench/hubs.js).
    // Peers are active, so they still open every core of their repo, the hub's included
    this.root = this.home.openStore({ active: false })
    await this.root.ready()
    await fs.writeFile(
      this.home.file('busy.json'),
      JSON.stringify({ pid: os.pid(), command: 'hubs serve', started: Date.now() }) + '\n'
    )
    this.rep = createReplicator(this.root, { bootstrap: this.bootstrap })
    await this.rep.ready()
    // in parallel: each repo's start waits on its DHT announce (about 2 s), so one at a time
    // a 100-repo home took minutes to come up (bench/hubs.js)
    const { repos } = await this.home.config()
    const queue = Object.entries(repos)
    const worker = async () => {
      while (queue.length) {
        const [name, entry] = queue.shift()
        await this.serve(name, entry)
      }
    }
    await Promise.all(Array.from({ length: START_PARALLEL }, worker))
    this._loops.push(this._requestLoop(), this._statusLoop())
  }

  async serve(name, entry, hub = null) {
    if (this.repos.has(name)) return
    const repo = hub || this.home.repoOf(this.root, entry)
    await repo.ready()
    const net = new Network(repo, {
      swarm: new RepoSwarm(this.rep, repo.store),
      replicate: false,
      passiveSignals: true,
      role: 'holder',
      mirror: true,
      ack: true,
      keepAlive: true
    })
    await net.ready()
    net.on('mirrored', (cs) => this.log(`${name}: mirrored #${cs.seq}`))
    net.on('mirrored-proposal', (p) =>
      this.log(`${name}: mirrored A${p.id} revision ${p.revision}`)
    )
    const admitDir = this.home.file('admit', name)
    await fs.mkdir(admitDir, { recursive: true })
    const signal = { stopped: false }
    const admitting = admitLoop(repo, admitDir, signal, (line) => this.log(`${name}: ${line}`))
    repo.main.view.on('update', () => {
      this.lastActivity = Date.now()
    })
    this.repos.set(name, { repo, net, signal, admitting })
    this.log(`serving ${name} ${HubHome.invite(entry)}`)
  }

  // `hs hubs` commands while serving: the server holds the store, so it does the work and
  // answers in requests/<op>-<name>.done
  async _requestLoop() {
    const dir = this.home.file('requests')
    while (!this.stopped) {
      for (const file of await fs.readdir(dir).catch(() => [])) {
        if (!file.endsWith('.json') || file.startsWith('.')) continue
        const id = file.slice(0, -5)
        let answer
        try {
          const payload = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'))
          answer = await this.handle(payload)
        } catch (err) {
          answer = { error: err.message }
        }
        await fs.rm(path.join(dir, file), { force: true })
        await fs.writeFile(path.join(dir, id + '.done'), JSON.stringify(answer) + '\n')
      }
      await sleep(REQUEST_POLL_MS)
    }
  }

  async handle({ op, name, ...opts }) {
    if (op === 'new') {
      const { entry, hub } = await this.home.createRepo(this.root, name, opts)
      await this.serve(name, entry, hub)
      return { name, invite: HubHome.invite(entry), owner: this.home.file('owners', name) }
    }
    if (op === 'adopt') {
      const { entry, hub } = await this.home.adoptRepo(this.root, name, opts.from, {
        log: this.log
      })
      await this.serve(name, entry, hub)
      return { name, invite: HubHome.invite(entry) }
    }
    if (op === 'add-writer') return this.addWriter(name, opts.key, opts)
    if (op === 'remove') return this.removeRepo(name, opts)
    if (op === 'restart') return this.restartWhenQuiet(opts.reason || 'asked', { now: opts.now })
    throw new Error('unknown request ' + op)
  }

  // An update replaced the binary: run it at the next quiet moment, if a service manager will
  // start the hub again (--restart-on-update); else say so, and `hs hubs list` shows it
  updateApplied() {
    this.update = { applied: Date.now() }
    if (this.restartOnUpdate) return this.restartWhenQuiet('update')
    this.log('[updater] update applied: restart the hub to run it (`hs hubs restart`)')
  }

  // Stop at the next quiet moment: every repo settled through main and no land for quietMs,
  // or after restartMaxMs whatever happens. A restart is safe at any time (lands stay
  // provisional for a few seconds and feeds reconnect); waiting just keeps it out of the way
  restartWhenQuiet(reason, { now = false } = {}) {
    if (this.restarting) return { ...this.restarting, already: true }
    this.restarting = { reason, since: Date.now() }
    this.log(`restart (${reason}): ${now ? 'now' : 'at the next quiet moment'}`)
    const deadline = Date.now() + this.restartMaxMs
    const wait = async () => {
      while (!this.stopped && !now && Date.now() < deadline && !(await this.quiet())) {
        await sleep(1000)
      }
      if (this.stopped) return
      this.log(`restarting (${reason})`)
      this._exit({ restart: true, reason })
    }
    wait().catch(noop)
    return { ...this.restarting }
  }

  async quiet() {
    if (Date.now() - this.lastActivity < this.quietMs) return false
    for (const { repo } of this.repos.values()) {
      const meta = await repo.meta()
      if ((meta.settled || 0) < (meta.seq || 0)) return false
    }
    return true
  }

  async addWriter(name, key, { handle = null, indexer = false } = {}) {
    const served = this.repos.get(name)
    if (!served) throw new Error(`no repo named ${name} is served here`)
    const { outcome } = await served.repo.addWriter(z32.decode(key), { handle, indexer })
    if (!accepted(outcome)) {
      throw new Error('not added: ' + reason(outcome))
    }
    // the add only counts once a teammate has it: this hub may be on its way out
    const shared = await served.net.uploaded(undefined, { timeout: 30_000 })
    return { name, handle, indexer, shared }
  }

  // Stop hubbing a repo. This home's hub writer is removed from the repo first, so nothing
  // waits for its acks: if another hub settles the repo (it moved out), it settles alone; if
  // none does, that's only with `force`, and the repo falls back to every writer's acks.
  // A teammate must receive the removal before the repo stops being served (else they wait
  // for this hub forever), so a remove that found nobody online can simply be run again.
  async removeRepo(name, { force = false } = {}) {
    const served = this.repos.get(name)
    if (!served) throw new Error(`no repo named ${name} is served here`)
    const { repo, net, signal, admitting } = served
    const others = (await repo.indexers()).filter((k) => !b4a.equals(k, repo.writerKey))
    const fallback = !others.length
    if (fallback && !force) {
      throw new Error(
        `this home is the only hub of ${name}: removing it leaves the repo settling on every ` +
          "writer's acks for good. Add its next hub first (`hs hubs add-writer " +
          `${name} <key> --as <handle> --indexer\`), or pass --force`
      )
    }
    const me = await repo.writer(repo.writerKey)
    if (!me || !me.removed) {
      const { outcome } = await repo.removeWriter(repo.writerKey)
      if (!accepted(outcome)) {
        throw new Error('could not remove this hub: ' + reason(outcome))
      }
    }
    const shared = await net.uploaded(undefined, { timeout: force ? 10_000 : 30_000 })
    if (!shared && !force) {
      throw new Error(
        `this hub stepped down from ${name}, but no teammate has heard yet, so it stays served ` +
          'until one does: run `hs hubs remove` again while one is online (or --force)'
      )
    }
    signal.stopped = true
    await admitting
    await net.close()
    await repo.close()
    this.repos.delete(name)
    const config = await this.home.config()
    delete config.repos[name]
    await this.home.saveConfig(config)
    this.log(`removed ${name}` + (fallback ? " (it now settles on every writer's acks)" : ''))
    return { name, fallback, shared }
  }

  async _statusLoop() {
    while (!this.stopped) {
      await this.writeStatus().catch(noop)
      await sleep(STATUS_MS)
    }
  }

  async writeStatus() {
    const repos = {}
    for (const [name, { repo }] of this.repos) {
      const meta = await repo.meta()
      repos[name] = { seq: meta.seq || 0, settled: meta.settled || 0 }
    }
    const status = {
      pid: os.pid(),
      version: pkg.version,
      started: this.started,
      connections: this.rep.connectionCount,
      rss: process.memoryUsage().rss,
      update: this.update,
      restarting: this.restarting,
      updated: Date.now(),
      repos
    }
    await fs.writeFile(this.home.file('status.json'), JSON.stringify(status) + '\n')
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    this._exit({ restart: false })
    for (const { signal } of this.repos.values()) signal.stopped = true
    await Promise.all(this._loops)
    for (const { repo, net, admitting } of this.repos.values()) {
      await admitting
      await net.close()
      await repo.close()
    }
    this.repos.clear()
    await closeReplicator(this.rep)
    await this.root.close()
    await fs.rm(this.home.file('busy.json'), { force: true })
    await fs.rm(this.home.file('status.json'), { force: true })
  }
}

// `hs seed --admit` and the hub server: admit writers whose keys `hs clone --admit` dropped
// into dir, and move each key to dir/admitted
async function admitLoop(repo, dir, signal, log = noop) {
  const done = path.join(dir, 'admitted')
  await fs.mkdir(done, { recursive: true })
  while (!signal.stopped) {
    for (const name of await fs.readdir(dir)) {
      const file = path.join(dir, name)
      if (name === 'admitted' || name.startsWith('.')) continue
      try {
        const keyText = (await fs.readFile(file, 'utf8')).trim()
        const handle = name.replace(/\.key$/, '').toLowerCase()
        const { outcome } = await repo.addWriter(z32.decode(keyText), {
          handle: rules.HANDLE.test(handle) ? handle : null
        })
        log(
          `admitted ${name}: ${outcome.status}${outcome.reason ? ' (' + outcome.reason + ')' : ''}`
        )
      } catch (err) {
        log(`could not admit ${name}: ${err.message}`)
      }
      await fs.rename(file, path.join(done, name))
    }
    await sleep(1000)
  }
}

// the in-process link `adoptRepo` mirrors over, as the slice of hyperswarm Network uses
class LinkSwarm extends EventEmitter {
  constructor() {
    super()
    this.dht = null
  }

  join() {
    const done = () => Promise.resolve()
    return { flushed: done, refresh: done }
  }

  destroy() {
    return Promise.resolve()
  }
}

function accepted(outcome) {
  return !!outcome && outcome.status === 'accepted'
}

function reason(outcome) {
  return outcome ? outcome.reason || outcome.status : 'not applied'
}

function checkName(name) {
  if (!NAME.test(name)) {
    throw new Error(`bad repo name ${name}: lowercase letters, digits, '.', '_' and '-'`)
  }
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

function noop() {}

module.exports = { HubHome, HubServer, handover, createGenesis, admitLoop }
