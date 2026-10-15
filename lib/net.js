// Networking: hyperswarm replication on the repo's discovery key, plus blind peers for
// always-on availability (the scion-cache tier, minus the trust: they only hold encrypted
// blocks and every block is merkle-verified by the reader).
const ReadyResource = require('ready-resource')
const Hyperswarm = require('hyperswarm')
const HyperDHT = require('hyperdht')
const BlindPeering = require('blind-peering')
const b4a = require('b4a')

// a connection that hasn't started replicating main after this long is treated as dead
const DEAD_CONNECTION_MS = 5000

const PRIORITY_UNLANDED = 0
const PRIORITY_MAIN = 1

module.exports = class Network extends ReadyResource {
  constructor(
    repo,
    { bootstrap = null, blindPeers = [], swarm = null, mirror = false, server = true } = {}
  ) {
    super()

    // one-shot clients (clone, pull, push) do not announce: they only dial seeds, which
    // also avoids simultaneous-dial races between two short-lived peers
    this.server = server

    this.mirror = mirror
    this.mirrored = 0
    this.mirroredProposals = new Set()
    this._mirroring = null
    this._onupdate = () => this._mirror().catch(noop)
    this.repo = repo
    this.swarm = swarm || createSwarm(bootstrap)
    this.blindPeerKeys = blindPeers
    this.blind = null
    this.connections = 0
    this.discovery = null
    this._onconnection = this._onconnection.bind(this)
  }

  async _open() {
    await this.repo.ready()
    // main's bootstrap core: having a replicating peer on it is what "connected" means
    this._boot = this.repo.store.get({ key: this.repo.key })
    await this._boot.ready()
    this._conns = new Set()

    this.swarm.on('connection', this._onconnection)
    this.discovery = this.swarm.join(this.repo.discoveryKey, { server: this.server, client: true })

    if (this.blindPeerKeys.length) {
      this.blind = new BlindPeering(this.swarm.dht, this.repo.store, { keys: this.blindPeerKeys })
      this.blind.addAutobaseBackground(this.repo.main)
      for (const ws of this.repo.workspaces.values()) this.seed(ws)
    }

    await this.discovery.flushed()

    if (this.mirror) {
      this.repo.main.view.on('update', this._onupdate)
      this._onupdate()
    }
  }

  async _close() {
    this.repo.main.view.off('update', this._onupdate)
    if (this._mirroring) await this._mirroring
    this.swarm.off('connection', this._onconnection)
    if (this.blind) await this.blind.close()
    await this.swarm.destroy()
    await this._boot.close()
  }

  _onconnection(conn) {
    const entry = { conn, at: Date.now() }
    this._conns.add(entry)
    this.connections++
    conn.on('close', () => {
      this.connections--
      this._conns.delete(entry)
    })
    this.repo.replicate(conn)
  }

  // replication with someone (a swarm peer or a blind peer) is actually flowing
  get live() {
    return this._boot.peers.length > 0
  }

  // Mirror mode: eagerly hold every landed workspace's tree and blobs cores, so main stays
  // fully available while this peer is online (a self-hosted replica of the cache tier).
  async _mirror() {
    if (this._mirroring) return
    this._mirroring = this._mirrorLoop()
    try {
      await this._mirroring
    } finally {
      this._mirroring = null
    }
  }

  async _mirrorLoop() {
    while (!this.closing) {
      const meta = await this.repo.meta()
      if (meta.seq <= this.mirrored) break

      const cs = await this.repo.changeset(this.mirrored + 1)
      if (!cs) break

      await this._mirrorWorkspace(cs.ws, cs.blobs)
      this.mirrored = cs.seq
      this.emit('mirrored', cs)
    }

    // main's tree spans every writer's view core (autobee shares subtrees across them), so a
    // mirror must hold all of them or main becomes unreadable when a writer goes offline
    await this._mirrorViews()

    // open proposals too, so reviewers can read them after their author goes offline
    for (const p of await this.repo.proposals()) {
      if (this.closing) break
      if (p.statusName === 'landed') continue
      const id = p.id + ':' + p.revision
      if (this.mirroredProposals.has(id)) continue
      await this._mirrorWorkspace(p.ws, p.blobs)
      this.mirroredProposals.add(id)
      this.emit('mirrored-proposal', p)
    }
  }

  // hold a workspace's tree (up to the landed/proposed length) and its blobs
  async _mirrorWorkspace(ws, blobsKey) {
    const store = this.repo.store
    const tree = store.get({ key: ws.key, encryption: this.repo.getEncryption() })
    const blobs = blobsKey
      ? store.get({ key: blobsKey, encryption: this.repo.getEncryption() })
      : null
    try {
      await tree.download({ start: 0, end: ws.length }).done()
      if (blobs) {
        await blobs.update({ wait: true })
        await blobs.download({ start: 0, end: blobs.length }).done()
        if (this.blind) this.blind.addCoreBackground(blobs, { priority: PRIORITY_MAIN })
      }
      if (this.blind) this.blind.addCoreBackground(tree, { priority: PRIORITY_MAIN })
    } finally {
      await tree.close()
      if (blobs) await blobs.close()
    }
  }

  async _mirrorViews() {
    const view = this.repo.main.view
    for (const key of await view.cores({ local: false })) {
      const core = this.repo.store.get({ key, encryption: this.repo.getEncryption() })
      try {
        await core.update({ wait: true })
        await core.download({ start: 0, end: core.length }).done()
        if (this.blind) this.blind.addCoreBackground(core, { priority: PRIORITY_MAIN })
      } finally {
        await core.close()
      }
    }
  }

  // ask blind peers to hold a workspace's cores; landed content must outlive GC
  seed(ws) {
    if (!this.blind) return
    const priority = ws.state.landed ? PRIORITY_MAIN : PRIORITY_UNLANDED
    this.blind.addCoreBackground(ws.tree, { priority })
    this.blind.addCoreBackground(ws.blobs.core, { priority })
  }

  // Wait until replication is flowing, not just until a socket opened: a connection can look
  // open on our side while the other side never registered it (seen when dialing a peer that
  // has only just started). Such connections are dropped after a few seconds so the swarm
  // redials instead of waiting for them to time out.
  async waitForPeers({ timeout = 10_000 } = {}) {
    const deadline = Date.now() + timeout
    while (!this.live) {
      if (Date.now() > deadline) return false
      for (const entry of this._conns) {
        if (Date.now() - entry.at > DEAD_CONNECTION_MS) {
          this._conns.delete(entry)
          entry.conn.destroy()
        }
      }
      await sleep(50)
    }
    return true
  }

  // Pull main until we hold every remote writer's oplog as far as connected peers have it,
  // and the view has stopped moving for a quiet period.
  async settle({ quiet = 300, timeout = 30_000 } = {}) {
    const deadline = Date.now() + timeout
    let last = null
    let since = Date.now()

    while (Date.now() < deadline) {
      // ask connected peers for each writer's latest length instead of trusting cached state
      await Promise.all(
        remoteWriters(this.repo.main).map((core) =>
          withTimeout(core.update({ wait: true }), 2000).catch(noop)
        )
      )
      await this.repo.main.update()

      const head = this.repo.head()
      const id = (head ? head.length : 0) + ':' + writerLengths(this.repo.main)

      if (id !== last) {
        last = id
        since = Date.now()
      } else if (caughtUp(this.repo.main) && Date.now() - since >= quiet) {
        return true
      }
      await sleep(50)
    }
    return false
  }

  // Wait until some peer holds every block of the given cores. Defaults to our writer oplog,
  // which is all other peers replicate eagerly.
  // cores: hypercores, or [core, length] pairs to only require a prefix
  async uploaded(cores = [this.repo.main.local], { timeout = 30_000 } = {}) {
    const targets = cores.map((c) => (Array.isArray(c) ? c : [c, c.length]))
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (targets.every(([core, length]) => hasRemoteCopy(core, length))) return true
      await sleep(50)
    }
    return false
  }

  // Wait until a holder (mirror or blind peer) has a landed workspace's content as well as our
  // oplog, so the land stays readable after this (often short-lived) process exits.
  landed(ws, { timeout = 30_000 } = {}) {
    // the tree only up to the landed length: a merge after the land may append blocks that
    // the holder has no reason to mirror
    const tree = ws.state.landed ? ws.state.landed.length : ws.tree.length
    const targets = [
      [this.repo.main.local, this.repo.main.local.length],
      [ws.tree, tree],
      [ws.blobs.core, ws.blobs.core.length]
    ].filter(([, length]) => length > 0)
    return this.uploaded(targets, { timeout })
  }

  localCores() {
    const cores = [this.repo.main.local]
    for (const ws of this.repo.workspaces.values()) cores.push(ws.tree, ws.blobs.core)
    return cores.filter((c) => c.length > 0)
  }
}

// On a private loopback-only DHT (tests, local harnesses) every peer is reachable directly, so
// run as an unfirewalled node bound to loopback like the testnet's own nodes. Left to detect
// it themselves, short-lived processes on loopback think they are firewalled and their
// holepunched connections are unreliable. The public DHT path is unchanged.
function createSwarm(bootstrap) {
  if (!bootstrap) return new Hyperswarm()
  const loopback = bootstrap.every((b) => b.host === '127.0.0.1' || b.host === 'localhost')
  if (!loopback) return new Hyperswarm({ bootstrap })
  return new Hyperswarm({ dht: new HyperDHT({ bootstrap, host: '127.0.0.1', firewalled: false }) })
}

function remoteWriters(main) {
  const local = main.local.key
  const out = []
  if (!main.activeWriters) return out
  for (const w of main.activeWriters) if (!b4a.equals(w.core.key, local)) out.push(w.core)
  return out
}

function writerLengths(main) {
  return remoteWriters(main)
    .map((c) => c.length)
    .join(',')
}

function caughtUp(main) {
  const writers = remoteWriters(main)
  // a fresh clone knows of no writers until the first oplog block arrives
  if (writers.length === 0) return main.writable
  for (const core of writers) {
    if (core.peers.length === 0) return false
    // wait for what connected peers can actually serve, not for blocks they only know exist
    // (e.g. the tail of a writer that went offline before anyone downloaded it)
    const servable = Math.max(...core.peers.map((p) => p.remoteContiguousLength))
    if (core.contiguousLength < servable) return false
  }
  return true
}

function hasRemoteCopy(core, length = core.length) {
  return core.peers.some((p) => p.remoteContiguousLength >= length)
}

function noop() {}

function withTimeout(promise, ms) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
