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
const ACK_DEBOUNCE_MS = 250
const MIRROR_STEP_MS = 10_000
const MIRROR_RETRY_MS = 2000
// a long-lived peer that lost everyone looks for peers again, backing off up to this
const REJOIN_MIN_MS = 1000
const REJOIN_MAX_MS = 15_000
// offline/online are about lasting changes: short commands (a teammate's sync) connect for a
// few seconds, which is not "peers are back"
const OFFLINE_GRACE_MS = 3000
const ONLINE_STABLE_MS = 8000

const PRIORITY_UNLANDED = 0
const PRIORITY_MAIN = 1

module.exports = class Network extends ReadyResource {
  constructor(
    repo,
    {
      bootstrap = null,
      blindPeers = [],
      swarm = null,
      mirror = false,
      server = true,
      ack = false,
      keepAlive = false
    } = {}
  ) {
    super()

    // an online indexer acks what it has seen, which is what settles everyone's lands
    this.ack = ack
    this._acking = null
    this._ackTimer = null
    this._onackupdate = () => this._scheduleAck()

    // one-shot clients (clone, pull, push) do not announce: they only dial seeds, which
    // also avoids simultaneous-dial races between two short-lived peers
    this.server = server

    // long-lived peers (seed, feeds) rejoin the swarm when they lose every connection, and
    // say so: 'offline' when the last peer goes, 'online' when one is back
    this.keepAlive = keepAlive
    this.offline = false
    this._rejoinTimer = null
    this._rejoinDelay = REJOIN_MIN_MS
    this._stateTimer = null

    this.mirror = mirror
    this.mirrored = 0
    this.mirroredProposals = new Set()
    this._mirrorAgain = false
    this._mirrorRetry = null
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

    if (this.ack) {
      this.repo.main.view.on('update', this._onackupdate)
      this._scheduleAck()
    }
  }

  async _close() {
    this.repo.main.view.off('update', this._onupdate)
    this.repo.main.view.off('update', this._onackupdate)
    if (this._mirrorRetry) clearTimeout(this._mirrorRetry)
    if (this._ackTimer) clearTimeout(this._ackTimer)
    if (this._rejoinTimer) clearTimeout(this._rejoinTimer)
    if (this._stateTimer) clearTimeout(this._stateTimer)
    if (this._acking) await this._acking.catch(noop)
    if (this._mirroring) await this._mirroring.catch(noop)
    this.swarm.off('connection', this._onconnection)
    if (this.blind) await this.blind.close()
    await this.swarm.destroy()
    await this._boot.close()
  }

  _onconnection(conn) {
    const entry = { conn, at: Date.now() }
    this._conns.add(entry)
    this.connections++
    if (this.offline) this._settleState()
    conn.on('close', () => {
      this.connections--
      this._conns.delete(entry)
      if (this.connections === 0 && this.keepAlive && !this.closing) {
        this._rejoinLater()
        if (!this.offline) this._settleState()
      }
    })
    this.repo.replicate(conn)
  }

  // nobody found at start: same as losing everyone
  markOffline() {
    if (this.connections > 0 || this.closing) return
    if (!this.offline) {
      this.offline = true
      this.emit('offline')
    }
    if (this.keepAlive) this._rejoinLater()
  }

  // report offline after a short grace, online only once connections have lasted a while
  _settleState() {
    if (this._stateTimer) clearTimeout(this._stateTimer)
    const wait = this.offline ? ONLINE_STABLE_MS : OFFLINE_GRACE_MS
    this._stateTimer = setTimeout(() => {
      this._stateTimer = null
      if (this.closing) return
      if (!this.offline && this.connections === 0) {
        this.offline = true
        this.emit('offline')
      } else if (this.offline && this.connections > 0) {
        this.offline = false
        this._rejoinDelay = REJOIN_MIN_MS
        if (this._rejoinTimer) clearTimeout(this._rejoinTimer)
        this._rejoinTimer = null
        this.emit('online')
      }
    }, wait)
  }

  // look the topic up again until someone connects (peers that restarted, or that only
  // announce, are not found by a lookup made before they came back)
  _rejoinLater() {
    if (this._rejoinTimer || this.closing) return
    this._rejoinTimer = setTimeout(() => {
      this._rejoinTimer = null
      if (this.closing || this.connections > 0) return
      this.discovery.refresh({ server: this.server, client: true }).catch(noop)
      this._rejoinDelay = Math.min(this._rejoinDelay * 2, REJOIN_MAX_MS)
      this._rejoinLater()
    }, this._rejoinDelay)
  }

  // replication with someone (a swarm peer or a blind peer) is actually flowing
  get live() {
    return this._boot.peers.length > 0
  }

  _scheduleAck() {
    if (this._ackTimer || this.closing) return
    this._ackTimer = setTimeout(() => {
      this._ackTimer = null
      if (this._acking) return this._scheduleAck()
      this._acking = this._maybeAck()
        .catch(noop)
        .finally(() => {
          this._acking = null
        })
    }, ACK_DEBOUNCE_MS)
  }

  // append an ack when main has moved past what we're recorded as having seen
  async _maybeAck() {
    if (this.closing || !this.repo.writable) return
    const meta = await this.repo.meta()
    if (meta.seq <= (await this.repo.seenBy(this.repo.writerKey))) return
    await this.repo.ack()
    this.emit('acked', meta.seq)
  }

  // Mirror mode: eagerly hold every landed workspace's tree and blobs cores, so main stays
  // fully available while this peer is online (a self-hosted replica of the cache tier).
  // Runs one mirror pass at a time; updates that arrive meanwhile queue exactly one more pass,
  // and anything that couldn't be fetched yet (its author is offline) is retried on a timer.
  async _mirror() {
    if (this._mirroring) {
      this._mirrorAgain = true
      return
    }
    this._mirroring = this._mirrorLoop()
    let complete = false
    try {
      complete = await this._mirroring
    } finally {
      this._mirroring = null
    }
    if (this.closing) return
    if (this._mirrorAgain) {
      this._mirrorAgain = false
      return this._mirror()
    }
    if (!complete && !this._mirrorRetry) {
      this._mirrorRetry = setTimeout(() => {
        this._mirrorRetry = null
        this._mirror().catch(noop)
      }, MIRROR_RETRY_MS)
    }
  }

  // returns false if something wasn't fetchable yet
  async _mirrorLoop() {
    let complete = true

    while (!this.closing) {
      const meta = await this.repo.meta()
      if (meta.seq <= this.mirrored) break

      const cs = await this.repo.changeset(this.mirrored + 1)
      if (!cs) break

      // changesets are mirrored in order; stop at the first one we can't fetch yet
      if (!(await this._mirrorWorkspace(cs.ws, cs.blobs))) {
        complete = false
        break
      }
      this.mirrored = cs.seq
      this.emit('mirrored', cs)
    }

    // main's tree spans every writer's view core (autobee shares subtrees across them), so a
    // mirror must hold all of them or main becomes unreadable when a writer goes offline
    if (!(await this._mirrorViews())) complete = false

    // open proposals too, so reviewers can read them after their author goes offline
    for (const p of await this.repo.proposals()) {
      if (this.closing) break
      if (p.statusName === 'landed') continue
      const id = p.id + ':' + p.revision
      if (this.mirroredProposals.has(id)) continue
      if (!(await this._mirrorWorkspace(p.ws, p.blobs))) {
        complete = false
        continue
      }
      this.mirroredProposals.add(id)
      this.emit('mirrored-proposal', p)
    }

    return complete
  }

  // hold a workspace's tree (up to the landed/proposed length) and its blobs; bounded in time
  async _mirrorWorkspace(ws, blobsKey) {
    const store = this.repo.store
    const tree = store.get({ key: ws.key, encryption: this.repo.getEncryption() })
    const blobs = blobsKey
      ? store.get({ key: blobsKey, encryption: this.repo.getEncryption() })
      : null
    try {
      if (!(await fetchRange(tree, ws.length))) return false
      if (blobs) {
        await withTimeout(blobs.update({ wait: true }), MIRROR_STEP_MS).catch(noop)
        if (!(await fetchRange(blobs, blobs.length))) return false
        if (this.blind) this.blind.addCoreBackground(blobs, { priority: PRIORITY_MAIN })
      }
      if (this.blind) this.blind.addCoreBackground(tree, { priority: PRIORITY_MAIN })
      return true
    } finally {
      await tree.close()
      if (blobs) await blobs.close()
    }
  }

  async _mirrorViews() {
    let complete = true
    const view = this.repo.main.view
    for (const key of await view.cores({ local: false })) {
      if (this.closing) break
      const core = this.repo.store.get({ key, encryption: this.repo.getEncryption() })
      try {
        await withTimeout(core.update({ wait: true }), MIRROR_STEP_MS).catch(noop)
        if (!(await fetchRange(core, core.length))) complete = false
        else if (this.blind) this.blind.addCoreBackground(core, { priority: PRIORITY_MAIN })
      } finally {
        await core.close()
      }
    }
    return complete
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

// download blocks [0, length); false if they couldn't all be fetched in time
async function fetchRange(core, length) {
  if (length === 0 || core.contiguousLength >= length) return true
  const dl = core.download({ start: 0, end: length })
  try {
    await withTimeout(dl.done(), MIRROR_STEP_MS)
  } catch {
    // fall through to the check below
  }
  if (core.contiguousLength >= length) return true
  dl.destroy()
  return false
}

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
