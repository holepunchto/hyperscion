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
const z32 = require('z32')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const Context = require('./context')
const Repo = require('./repo')
const Network = require('./net')
const rules = require('./rules')
const { createReplicator, closeReplicator, RepoSwarm } = require('./hubnet')

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
const REQUEST_POLL_MS = 500
const STATUS_MS = 1000

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

  // the invite teammates clone with
  static invite(entry) {
    return entry.encryptionKey ? entry.key + '.' + entry.encryptionKey : entry.key
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
      bootstrapWeight: 2
    })
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

  // `hs hubs new` while a server holds the store: ask it, and wait for its answer
  async request(name, opts, { timeout = 60_000 } = {}) {
    checkName(name)
    const dir = this.file('requests')
    await fs.mkdir(dir, { recursive: true })
    const done = path.join(dir, name + '.done')
    await fs.rm(done, { force: true })
    const tmp = path.join(dir, '.' + name + '.json')
    await fs.writeFile(tmp, JSON.stringify(opts) + '\n')
    await fs.rename(tmp, path.join(dir, name + '.json'))
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
  constructor(home, { bootstrap = null, log = noop } = {}) {
    this.home = home
    this.bootstrap = bootstrap
    this.log = log
    this.root = null
    this.rep = null
    this.repos = new Map() // name -> { repo, net, admitting }
    this.stopped = false
    this._loops = []
  }

  async start() {
    await fs.mkdir(this.home.dir, { recursive: true })
    this.root = this.home.openStore()
    await this.root.ready()
    await fs.writeFile(
      this.home.file('busy.json'),
      JSON.stringify({ pid: os.pid(), command: 'hubs serve', started: Date.now() }) + '\n'
    )
    this.rep = createReplicator(this.root, { bootstrap: this.bootstrap })
    await this.rep.ready()
    const { repos } = await this.home.config()
    for (const [name, entry] of Object.entries(repos)) await this.serve(name, entry)
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
    this.repos.set(name, { repo, net, signal, admitting })
    this.log(`serving ${name} ${HubHome.invite(entry)}`)
  }

  // repos made while serving: a request from `hs hubs new`, or an entry another process
  // added to hubs.json
  async _requestLoop() {
    const dir = this.home.file('requests')
    while (!this.stopped) {
      for (const file of await fs.readdir(dir).catch(() => [])) {
        if (!file.endsWith('.json') || file.startsWith('.')) continue
        const name = file.slice(0, -5)
        let answer
        try {
          const opts = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'))
          const { entry, hub } = await this.home.createRepo(this.root, name, opts)
          await this.serve(name, entry, hub)
          answer = { name, invite: HubHome.invite(entry), owner: this.home.file('owners', name) }
        } catch (err) {
          answer = { error: err.message }
        }
        await fs.rm(path.join(dir, file), { force: true })
        await fs.writeFile(path.join(dir, name + '.done'), JSON.stringify(answer) + '\n')
      }
      await sleep(REQUEST_POLL_MS)
    }
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
      connections: this.rep.connectionCount,
      updated: Date.now(),
      repos
    }
    await fs.writeFile(this.home.file('status.json'), JSON.stringify(status) + '\n')
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
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
