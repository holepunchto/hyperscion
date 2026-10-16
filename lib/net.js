// Networking: hyperswarm replication on the repo's discovery key, plus blind peers for
// always-on availability (the scion-cache tier, minus the trust: they only hold encrypted
// blocks and every block is merkle-verified by the reader).
const ReadyResource = require('ready-resource')
const Hyperswarm = require('hyperswarm')
const HyperDHT = require('hyperdht')
const BlindPeering = require('blind-peering')
const b4a = require('b4a')
const process = require('bare-process')
const crypto = require('hypercore-crypto')

// a connection that hasn't started replicating main after this long is treated as dead
const DEAD_CONNECTION_MS = 5000
const ACK_DEBOUNCE_MS = 250
const MIRROR_STEP_MS = 10_000
const MIRROR_RETRY_MS = 2000
// a changeset that couldn't be fetched before (its author went offline) is retried briefly, so
// a few unreachable authors don't hold up mirroring the rest
const MIRROR_RETRY_STEP_MS = 2000
// changesets mirrored at once. Each worker takes the newest one waiting, so a land that just
// arrived (its author's `hs land` is waiting for a holder) doesn't queue behind a backlog: in
// an outage with a swarm, fetches take ~1 s each and a teammate's land waited ~14 s
const MIRROR_WORKERS = 4
// local writer core user data: how far the mirror held every changeset (only up to settled)
const MIRRORED = 'hs/mirrored'
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
      role = null,
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

    // Mesh shape (a star with a fallback mesh). The main topic is where holders (the hub,
    // blind peers) announce; a second "fallback" topic is where feeds announce.
    //   holder   server+client on main, client on fallback (finds feeds after a restart)
    //   feed     client on main (normally connects to the hub only, not to every other feed);
    //            server on fallback, and client on it too while it can't reach anyone, so
    //            feeds mesh only during an outage
    //   command  client on both: short-lived, it reaches the hub or, in an outage, the feeds
    // A full mesh of N long-lived agents costs N^2 connections, each carrying every writer's
    // oplog core: that, not storage, is what per-agent memory grew with (DESIGN.md §7).
    this.role = role || (server ? 'holder' : 'command')
    this.server = this.role === 'holder'

    // long-lived peers (seed, feeds) rejoin the swarm when they lose every connection, and
    // say so: 'offline' when the last peer goes, 'online' when one is back
    this.keepAlive = keepAlive
    this.offline = false
    this._rejoinTimer = null
    this._rejoinDelay = REJOIN_MIN_MS
    this._stateTimer = null

    this.mirror = mirror
    // every changeset up to here is held; past it, the ones held and the ones that couldn't be
    // fetched yet. Hashes of held changesets past settled, so a reorg is noticed
    this.mirrored = 0
    this._mirrorHeld = new Set()
    this._mirrorHashes = new Map()
    this._mirrorSkipped = new Set()
    this._mirrorPending = new Set() // past the watermark, not tried yet
    this._mirrorNext = 1
    this._mirrorSaved = 0
    this._mirrorLoaded = false
    this.mirroredProposals = new Set()
    this._oplogs = new Map() // writer key (hex) -> open session on its oplog (mirror)
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
    this.fallback = null
    this._onconnection = this._onconnection.bind(this)
  }

  async _open() {
    await this.repo.ready()
    // main's bootstrap core: having a replicating peer on it is what "connected" means
    this._boot = this.repo.store.get({ key: this.repo.key })
    await this._boot.ready()
    this._conns = new Set()

    this.swarm.on('connection', this._onconnection)
    this.discovery = this.swarm.join(this.repo.discoveryKey, this._mainTopic())
    this._fallbackKey = fallbackTopic(this.repo.discoveryKey)
    this.fallback = this.swarm.join(this._fallbackKey, this._fallbackTopic())

    if (this.blindPeerKeys.length) {
      this.blind = new BlindPeering(this.swarm.dht, this.repo.store, { keys: this.blindPeerKeys })
      this.blind.addAutobaseBackground(this.repo.main)
      for (const ws of this.repo.workspaces.values()) this.seed(ws)
    }

    await Promise.all([this.discovery.flushed(), this.fallback.flushed()])

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
    for (const core of this._oplogs.values()) await core.close().catch(noop)
    this._oplogs.clear()
    this.swarm.off('connection', this._onconnection)
    if (this.blind) await this.blind.close()
    await this.swarm.destroy()
    await this._boot.close()
  }

  _onconnection(conn, info) {
    // an outage link: a feed dialed another feed it found on the fallback topic only
    const outage = !!(
      info &&
      info.client &&
      this._fallbackKey &&
      info.topics.some((t) => b4a.equals(t, this._fallbackKey)) &&
      !info.topics.some((t) => b4a.equals(t, this.repo.discoveryKey))
    )
    const entry = { conn, info, outage, at: Date.now() }
    if (process.env.HS_DEBUG_NET) {
      console.error(
        `net[${this.role}]: connection client=${!!(info && info.client)} topics=${info ? info.topics.length : '-'} outage=${outage}`
      )
    }
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

  // whether a holder (the hub) is connected: commands and feeds only reach holders by dialing
  // the main topic (feeds meet each other on the fallback topic), so a connection we dialed
  // there is a holder
  holderConnected() {
    return [...this._conns].some(
      (e) =>
        e.info && e.info.client && e.info.topics.some((t) => b4a.equals(t, this.repo.discoveryKey))
    )
  }

  _mainTopic() {
    return { server: this.role === 'holder', client: true }
  }

  _fallbackTopic() {
    if (this.role === 'holder') return { server: false, client: true }
    if (this.role === 'feed') return { server: true, client: this.offline }
    return { server: false, client: true }
  }

  // a feed that lost everyone starts dialing other feeds; once peers are back it stops
  // dialing (connections it has stay)
  _reshape() {
    if (this.role !== 'feed' || !this.fallback || this.closing) return
    this.fallback.refresh(this._fallbackTopic()).catch(noop)
  }

  // Once the hub is back (settling resumes), close the links this feed dialed to other feeds
  // during the outage, so repeated outages don't leave a full mesh behind. Only links we
  // dialed (never a teammate's command that dialed us), and only while another connection
  // (the hub's) remains. Returns how many were closed.
  hasOutageLinks() {
    return [...this._conns].some((e) => e.outage)
  }

  dropOutageLinks() {
    if (this.role !== 'feed' || this.closing) return 0
    const outage = [...this._conns].filter((e) => e.outage)
    if (!outage.length || outage.length === this._conns.size) return 0
    for (const e of outage) {
      e.info.reconnect(false)
      e.conn.destroy()
    }
    return outage.length
  }

  // nobody found at start: same as losing everyone
  markOffline() {
    if (this.connections > 0 || this.closing) return
    if (!this.offline) {
      this.offline = true
      this._reshape()
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
        this._reshape()
        this.emit('offline')
      } else if (this.offline && this.connections > 0) {
        this.offline = false
        this._rejoinDelay = REJOIN_MIN_MS
        if (this._rejoinTimer) clearTimeout(this._rejoinTimer)
        this._rejoinTimer = null
        this._reshape()
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
      this.discovery.refresh(this._mainTopic()).catch(noop)
      this.fallback.refresh(this._fallbackTopic()).catch(noop)
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
      if (!this._mirrorAgain) mlog('update during pass: queued')
      this._mirrorAgain = true
      return
    }
    this._mirroring = this._mirrorLoop()
    let complete = false
    const started = Date.now()
    mlog('pass start')
    try {
      complete = await this._mirroring
      mlog(`pass end ${Date.now() - started}ms complete=${complete} again=${this._mirrorAgain}`)
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
    if (!this._mirrorLoaded) await this._loadMirrored()

    const meta = await this.repo.meta()
    await this._mirrorReorged(meta)

    // new changesets first, newest first, then the ones skipped before: an author who is
    // offline holds up only their own changesets, never everyone's after them
    const retries = [...this._mirrorSkipped].sort((a, b) => b - a)
    const refresh = async () => {
      const m = await this.repo.meta()
      for (let seq = Math.max(this._mirrorNext, this.mirrored + 1); seq <= m.seq; seq++) {
        this._mirrorPending.add(seq)
      }
      this._mirrorNext = Math.max(this._mirrorNext, m.seq + 1)
      return m
    }
    const worker = async () => {
      while (!this.closing) {
        const m = await refresh() // a land that arrived meanwhile goes next
        let seq = -1
        let timeout = MIRROR_STEP_MS
        for (const s of this._mirrorPending) if (s > seq) seq = s
        if (seq >= 0) {
          this._mirrorPending.delete(seq)
        } else if (retries.length) {
          seq = retries.shift()
          timeout = MIRROR_RETRY_STEP_MS
        } else {
          return
        }
        if (seq > m.seq) {
          this._mirrorSkipped.delete(seq) // reorged away
          continue
        }
        if (seq <= this.mirrored || this._mirrorHeld.has(seq)) continue
        const cs = await this.repo.changeset(seq)
        if (!cs) continue
        const t0 = Date.now()
        const ok = await this._mirrorWorkspace(cs.ws, cs.blobs, cs.blobsLength, timeout)
        if (MIRROR_LOG && (cs.author || Date.now() - t0 > 500 || !ok)) {
          mlog(`cs #${seq} ${cs.author || '-'} ok=${ok} ${Date.now() - t0}ms`)
        }
        if (!ok) {
          this._mirrorSkipped.add(seq)
          complete = false
          continue
        }
        this._mirrorSkipped.delete(seq)
        this._mirrorHeld.add(seq)
        if (seq > (m.settled || 0)) this._mirrorHashes.set(seq, cs.hash)
        while (this._mirrorHeld.has(this.mirrored + 1)) {
          this._mirrorHeld.delete(++this.mirrored)
        }
        this.emit('mirrored', cs)
      }
    }
    const workers = []
    for (let i = 0; i < MIRROR_WORKERS; i++) workers.push(worker())
    await Promise.all(workers)
    if (!this.closing) await this._saveMirrored()

    // main's tree spans every writer's view core (autobee shares subtrees across them), so a
    // mirror must hold all of them or main becomes unreadable when a writer goes offline
    let t0 = Date.now()
    if (!(await this._mirrorViews())) complete = false
    mlog(`views ${Date.now() - t0}ms`)
    t0 = Date.now()
    // and every writer's oplog: peers catch up through the view cores, so a hub that applied
    // a writer's lands may still lack the middle of its oplog (a writer that landed offline
    // and then pushed). `land`/`push` wait for a holder to have our oplog; it must be here
    if (!(await this._mirrorOplogs())) complete = false
    mlog(`oplogs ${Date.now() - t0}ms`)

    // open proposals too, so reviewers can read them after their author goes offline
    for (const p of await this.repo.proposals()) {
      if (this.closing) break
      if (p.statusName === 'landed') continue
      const id = p.id + ':' + p.revision
      if (this.mirroredProposals.has(id)) continue
      if (!(await this._mirrorWorkspace(p.ws, p.blobs, p.blobsLength, MIRROR_STEP_MS))) {
        complete = false
        continue
      }
      this.mirroredProposals.add(id)
      this.emit('mirrored-proposal', p)
    }

    return complete
  }

  // Provisional changesets can be reordered: anything mirrored past the settled point whose
  // changeset changed (or went away) is mirrored again.
  async _mirrorReorged(meta) {
    const settled = meta.settled || 0
    let lowest = Infinity
    for (const [seq, hash] of this._mirrorHashes) {
      if (seq <= settled) {
        this._mirrorHashes.delete(seq)
        continue
      }
      const cs = seq <= meta.seq ? await this.repo.changeset(seq) : null
      if (!cs || !b4a.equals(cs.hash, hash)) lowest = Math.min(lowest, seq)
    }
    if (lowest === Infinity) return
    // forget everything from the first changed changeset on and mirror it again
    if (this.mirrored >= lowest) this.mirrored = lowest - 1
    for (const seq of this._mirrorHeld) if (seq >= lowest) this._mirrorHeld.delete(seq)
    for (const seq of this._mirrorHashes.keys()) if (seq >= lowest) this._mirrorHashes.delete(seq)
    this._mirrorNext = Math.min(this._mirrorNext, lowest)
  }

  async _loadMirrored() {
    this._mirrorLoaded = true
    try {
      const buf = await this.repo.main.local.getUserData(MIRRORED)
      const n = buf ? Number(b4a.toString(buf)) : 0
      if (n > 0) {
        this.mirrored = this._mirrorSaved = n
        this._mirrorNext = n + 1
      }
    } catch {}
  }

  // only the settled part survives a restart: past it, changesets can still be reordered
  async _saveMirrored() {
    const meta = await this.repo.meta()
    const n = Math.min(this.mirrored, meta.settled || 0)
    if (n <= this._mirrorSaved) return
    this._mirrorSaved = n
    await this.repo.main.local.setUserData(MIRRORED, b4a.from(String(n))).catch(noop)
  }

  // hold a workspace's tree (up to the landed/proposed length) and its blobs (up to the length
  // the op recorded); bounded in time
  async _mirrorWorkspace(ws, blobsKey, blobsLength, timeout) {
    const store = this.repo.store
    const tree = store.get({ key: ws.key, encryption: this.repo.getEncryption() })
    const blobs = blobsKey
      ? store.get({ key: blobsKey, encryption: this.repo.getEncryption() })
      : null
    try {
      if (!(await fetchRange(tree, ws.length, timeout))) return false
      if (blobs) {
        // the op says how long the blobs core was (plus one); older ops don't, so fall back
        // to its current length, which moves with the author's later commits
        let length = blobsLength ? blobsLength - 1 : -1
        if (length < 0) {
          await withTimeout(blobs.update({ wait: true }), timeout).catch(noop)
          length = blobs.length
        }
        if (!(await fetchRange(blobs, length, timeout))) return false
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
      const t0 = Date.now()
      try {
        await withTimeout(core.update({ wait: true }), MIRROR_STEP_MS).catch(noop)
        const ok = await fetchRange(core, core.length)
        if (MIRROR_LOG && (Date.now() - t0 > 500 || !ok)) {
          mlog(
            `view ${b4a.toString(key, 'hex').slice(0, 6)} ok=${ok} ${Date.now() - t0}ms len=${core.length}`
          )
        }
        if (!ok) complete = false
        else if (this.blind) this.blind.addCoreBackground(core, { priority: PRIORITY_MAIN })
      } finally {
        await core.close()
      }
    }
    return complete
  }

  // Every writer's oplog, opened by key: autobee only opens the writers it is linearizing,
  // and a writer whose lands peers applied through the view cores (one land, then gone) is
  // never opened, so nothing replicated its oplog and its `land`/`push` waited for a holder
  // that never came (q2-hs-4). Sessions stay open, so the channel stays up for a pusher to
  // see what we hold.
  async _mirrorOplogs() {
    const own = this.repo.main.local.key
    const cores = []
    for (const key of await this.repo.writerKeys()) {
      if (b4a.equals(key, own)) continue
      const id = b4a.toString(key, 'hex')
      let core = this._oplogs.get(id)
      if (!core) {
        core = this.repo.store.get({ key, encryption: this.repo.getEncryption() })
        this._oplogs.set(id, core)
      }
      cores.push(core)
    }
    const done = await Promise.all(
      cores.map(async (core) => {
        await core.ready()
        await withTimeout(core.update({ wait: true }), MIRROR_RETRY_STEP_MS).catch(noop)
        return fetchRange(core, core.length, MIRROR_RETRY_STEP_MS)
      })
    )
    return done.every(Boolean)
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
  // and the view has stopped moving for `quiet` ms. On a busy main (a swarm landing every
  // second or so) that quiet moment never comes, so there is a second way out: each writer's
  // target is what its peers held the first time we heard from them, and once every target
  // is reached, lands arriving after that aren't chased past `busy` ms. (Reaching the targets
  // alone isn't enough: a peer's contiguous length arrives after its first sync message, so
  // an early target can be just our own length.)
  async settle({ quiet = 300, busy = 1500, timeout = 30_000 } = {}) {
    const deadline = Date.now() + timeout
    const targets = new Map() // writer core key (hex) -> length to reach
    let last = null
    let since = Date.now()
    let reached = null // when every writer first reached its target

    while (Date.now() < deadline) {
      const writers = remoteWriters(this.repo.main)
      const unknown = writers.filter((core) => !targets.has(b4a.toString(core.key, 'hex')))
      // ask connected peers for a writer's latest length until we have its target
      await Promise.all(
        unknown.map((core) => withTimeout(core.update({ wait: true }), 2000).catch(noop))
      )
      for (const core of unknown) {
        // a peer's lengths mean nothing until it has sent its first sync message
        const synced = core.peers.filter((p) => p.remoteSynced)
        if (synced.length === 0) continue
        targets.set(
          b4a.toString(core.key, 'hex'),
          Math.max(core.contiguousLength, ...synced.map((p) => p.remoteContiguousLength))
        )
      }
      await this.repo.main.update()

      if (
        reached === null &&
        writers.length > 0 &&
        writers.every((core) => {
          const target = targets.get(b4a.toString(core.key, 'hex'))
          return target !== undefined && core.contiguousLength >= target
        })
      ) {
        reached = Date.now()
      }

      const head = this.repo.head()
      const id = (head ? head.length : 0) + ':' + writerLengths(this.repo.main)
      if (id !== last) {
        last = id
        since = Date.now()
      } else if (caughtUp(this.repo.main) && Date.now() - since >= quiet) {
        return true
      }
      if (reached !== null && Date.now() - reached >= busy) {
        await this.repo.main.update() // apply what just arrived
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
    if (core.contiguousLength < servable(core)) return false
  }
  return true
}

// what connected peers can actually serve, not blocks they only know exist (e.g. the tail of
// a writer that went offline before anyone downloaded it)
function servable(core) {
  return Math.max(core.contiguousLength, ...core.peers.map((p) => p.remoteContiguousLength))
}

function hasRemoteCopy(core, length = core.length) {
  return core.peers.some((p) => p.remoteContiguousLength >= length)
}

function noop() {}

// HS_DEBUG_MIRROR=<file>: one line per mirror step, appended (to see where a feed's time
// goes in a run; off unless set)
const MIRROR_LOG = process.env.HS_DEBUG_MIRROR || null
function mlog(line) {
  if (!MIRROR_LOG) return
  try {
    require('bare-fs').appendFileSync(MIRROR_LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

// where feeds announce (see the mesh shape in the constructor)
function fallbackTopic(discoveryKey) {
  return crypto.hash([discoveryKey, b4a.from('hs/fallback')])
}

// download blocks [0, length); false if they couldn't all be fetched in time
async function fetchRange(core, length, timeout = MIRROR_STEP_MS) {
  if (length === 0 || core.contiguousLength >= length) return true
  const dl = core.download({ start: 0, end: length })
  try {
    await withTimeout(dl.done(), timeout)
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
