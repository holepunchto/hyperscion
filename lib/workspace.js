// A workspace is a cheap fork of main: its own hyperbee2 tree core (whose first batch is
// rooted in main's view core) and its own blobs core. Commits are tree flushes and only
// write the dirty root-to-leaf paths. Landing ships the diff against the fork point.
const ReadyResource = require('ready-resource')
const Hyperbee = require('hyperbee2')
const Hyperblobs = require('hyperblobs')
const Hyperdrive = require('hyperdrive')
const c = require('compact-encoding')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const unixPathResolve = require('unix-path-resolve')
const driveEntry = require('hyperdrive/lib/encoding')
const keys = require('./keys')
const merge = require('./merge')

const MANIFEST_VERSION = 3

module.exports = class Workspace extends ReadyResource {
  constructor(repo, name, state = null) {
    super()

    this.repo = repo
    this.name = name
    this.state = state
    this.session = null
    // our own tree core; note bee.core is the core holding the current root, which is
    // main's view core until the first local commit
    this.tree = null
    this.bee = null
    this.blobs = null
    this.drive = null
  }

  async _open() {
    const repo = this.repo
    const encryption = repo.getEncryption()

    this.session = repo.store.session()

    let tree = null
    let blobs = null

    if (this.state) {
      tree = this.session.get({ key: this.state.tree, encryption })
      blobs = this.session.get({ key: this.state.blobs, encryption })
    } else {
      const ns = this.session.namespace(
        'ws/' + this.name + '/' + b4a.toString(crypto.randomBytes(8), 'hex')
      )
      // v3 manifests like autobee's own cores, required by its per-core view encryption
      tree = ns.get({ name: 'tree', encryption, manifestVersion: MANIFEST_VERSION })
      blobs = ns.get({ name: 'blobs', encryption, manifestVersion: MANIFEST_VERSION })
    }

    await Promise.all([tree.ready(), blobs.ready()])
    this.tree = tree

    this.bee = new Hyperbee(this.session, {
      core: tree,
      getEncryptionProvider: () => encryption
    })
    await this.bee.ready()

    this.blobs = new Hyperblobs(blobs)

    if (!this.state) {
      await repo.update()
      this.state = {
        name: this.name,
        tree: tree.key,
        blobs: blobs.key,
        base: await repo.meta(),
        fork: repo.head(),
        landed: null,
        head: null,
        landNode: null,
        preLandHead: null,
        preLandFork: null,
        preLandBase: null
      }
    }

    // O(1) fork: the root starts in main's view core, local commits move it into ours
    const head = this.state.head || this.state.fork
    if (head.length > 0 || tree.length === 0) this.bee.move(head)

    this.drive = new Hyperdrive(this.session, {
      _db: this.bee,
      blobs: this.blobs,
      encryption: repo.getEncryption()
    })
    await this.drive.ready()
  }

  async _close() {
    await this.drive.close()
  }

  get key() {
    return this.state.tree
  }

  head() {
    return this.bee.head()
  }

  // Apply a set of changes as one commit. Each change is {path, content|null, executable}.
  // Content already on main (by hash) is referenced, not re-uploaded.
  async commit(changes) {
    if (!this.opened) await this.ready()

    const drive = this.drive
    let changed = 0

    drive.batch()

    try {
      for (const ch of changes) {
        const path = normalize(ch.path)

        if (ch.content === null || ch.content === undefined) {
          if (await drive.entry(path)) {
            await drive.del(path)
            changed++
          }
          continue
        }

        const hash = crypto.hash(ch.content)
        const executable = !!ch.executable
        const existing = await drive.entry(path)

        if (existing && sameContent(existing.value, hash, executable)) continue

        const known = await this._knownBlob(hash)
        if (known) {
          await drive.putEntry(path, { executable, blob: known.blob, hash })
        } else {
          await drive.put(path, ch.content, { executable, hash })
        }
        changed++
      }

      await drive.flush()
    } catch (err) {
      drive._batch = null
      throw err
    }

    if (changed) await this._saveHead()
    return changed
  }

  async _knownBlob(hash) {
    const buf = await this.repo.lookupHash(hash)
    if (!buf) return null
    const entry = c.decode(driveEntry, buf)
    return entry.blob && entry.blob.core ? entry : null
  }

  // diff of this workspace against its fork point, as land entries
  async changes() {
    if (!this.opened) await this.ready()

    const fork = this.bee.checkout(this.state.fork)
    const entries = []

    try {
      for await (const { left, right } of fork.createDiffStream(this.bee, filesRange())) {
        const key = (right || left).key
        entries.push({ path: keys.files.decode(key), value: right ? right.value : null })
      }
    } finally {
      await fork.close()
    }

    return entries
  }

  // rebase: on conflict or stale base, sync and retry up to this many times as long as the
  // 3-way merge is clean (what a merge queue would do server side, done by the lander)
  async land({ message = '', author = '', time = Date.now(), rebase = 0 } = {}) {
    let res = await this._land({ message, author, time })
    let attempts = 1

    while (
      rebase-- > 0 &&
      res.outcome &&
      (res.outcome.status === 'conflict' || res.outcome.status === 'stale-base')
    ) {
      const sync = await this.sync()
      if (sync.conflicts.length) break
      res = await this._land({ message, author, time })
      attempts++
    }

    res.attempts = attempts
    return res
  }

  async _land({ message, author, time }) {
    const entries = await this.changes()
    if (entries.length === 0) return { node: null, outcome: { status: 'empty' } }

    const head = { key: this.tree.key, length: this.tree.length }

    const pre = { head: this.bee.head(), fork: this.state.fork, base: this.state.base }

    const res = await this.repo.land({
      ws: head,
      base: this.state.base,
      entries,
      message,
      author,
      time,
      blobs: this.blobs.core.key
    })

    if (res.outcome && res.outcome.status === 'accepted') {
      this.state.landed = head
      this.state.landNode = res.node
      this.state.preLandHead = pre.head
      this.state.preLandFork = pre.fork
      this.state.preLandBase = pre.base
      // main now contains our changes; move the fork point up so they are not re-landed
      await this.sync()
    }

    return res
  }

  // Rebase onto main's current head. Disjoint changes replay directly, overlapping text
  // files are 3-way merged, anything else is reported as a conflict (with markers for text).
  async sync() {
    if (!this.opened) await this.ready()

    const repo = this.repo
    await repo.update()

    const snap = repo.snapshot()
    const meta = await repo.meta(snap)
    const head = snap.head()

    const result = { merged: [], conflicts: [], replayed: 0, upToDate: false, restored: null }

    // Outcomes are provisional: a reorg can flip an accepted land to conflict after we
    // already moved onto main. Restore the pre-land tree so the rebase below replays it.
    const restored = await this._restoreFlippedLand(snap)
    if (restored) result.restored = restored

    try {
      if (meta.seq === this.state.base.seq && b4a.equals(meta.hash, this.state.base.hash)) {
        result.upToDate = true
        return result
      }

      const ours = await this.changes()
      const fork = this.bee.checkout(this.state.fork)
      const theirs = new Map()

      try {
        // only paths we touched matter, so look them up instead of diffing all of main
        for (const e of ours) {
          const k = keys.files.encode(e.path)
          const [b, t] = await Promise.all([fork.get(k), snap.get(k)])
          const bv = b ? b.value : null
          const tv = t ? t.value : null
          if (!eqBuf(bv, tv)) theirs.set(e.path, { base: bv, theirs: tv })
        }
      } finally {
        await fork.close()
      }

      this.bee.move(head)
      this.drive.batch()

      for (const e of ours) {
        const t = theirs.get(e.path)
        const key = keys.files.encode(e.path)

        if (!t) {
          writeRaw(this.drive, key, e.value)
          result.replayed++
          continue
        }

        if (eqBuf(e.value, t.theirs)) continue // both sides made the same change

        const merged = await this._merge(e.path, t.base, e.value, t.theirs)
        if (merged.clean) result.merged.push(e.path)
        else result.conflicts.push(e.path)
      }

      await this.drive.flush()
    } finally {
      await snap.close()
    }

    this.state.base = meta
    this.state.fork = head
    await this._saveHead()

    return result
  }

  lastLand() {
    if (!this.state.landNode) return null
    return this.repo.outcome(this.state.landNode)
  }

  async _restoreFlippedLand(snap) {
    if (!this.state.landNode) return null

    const outcome = await this.repo.outcome(this.state.landNode, snap)
    if (!outcome || outcome.status === 'accepted') return null

    // keep the current root (it may hold commits made after the land) and only move the fork
    // point back: the rebase below then replays the flipped land and any later commits
    this.state.fork = this.state.preLandFork
    this.state.base = this.state.preLandBase
    this.state.landNode = null
    this.state.landed = null
    await this._saveHead()

    return outcome
  }

  async _saveHead() {
    this.state.head = this.bee.head()
    await this.repo._saveWorkspace(this)
  }

  async _merge(path, base, ours, theirs) {
    const [b, o, t] = await Promise.all([this._read(base), this._read(ours), this._read(theirs)])
    const oe = ours ? c.decode(driveEntry, ours) : null
    const executable = oe ? oe.executable : false

    if (
      o !== null &&
      t !== null &&
      merge.isText(o) &&
      merge.isText(t) &&
      (b === null || merge.isText(b))
    ) {
      const res = merge.diff3(b || b4a.alloc(0), o, t)
      await this._put(path, res.content, executable)
      return { clean: res.clean }
    }

    // binary or delete/modify: keep ours, report conflict
    if (ours) writeRaw(this.drive, keys.files.encode(path), ours)
    else await this.drive.del(path)
    return { clean: false }
  }

  async _put(path, content, executable) {
    const hash = crypto.hash(content)
    const known = await this._knownBlob(hash)
    if (known) await this.drive.putEntry(path, { executable, blob: known.blob, hash })
    else await this.drive.put(path, content, { executable, hash })
  }

  async _read(value) {
    if (!value) return null
    const entry = c.decode(driveEntry, value)
    if (!entry.blob) return b4a.alloc(0)
    const blobs = await this.drive.getBlobsFor(entry.blob)
    return blobs.get(entry.blob)
  }
}

function writeRaw(drive, key, value) {
  if (value) drive._batch.tryPut(key, value)
  else drive._batch.tryDelete(key)
}

function filesRange() {
  return keys.files.encodeRange({})
}

function sameContent(value, hash, executable) {
  return !!value.hash && b4a.equals(value.hash, hash) && value.executable === executable
}

function eqBuf(a, b) {
  if (a === null || b === null) return a === b
  return b4a.equals(a, b)
}

function normalize(p) {
  return unixPathResolve('/', p)
}
