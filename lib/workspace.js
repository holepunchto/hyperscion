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

// A read needed data that is not held locally and could not be fetched in time.
class ContentUnavailableError extends Error {
  constructor(path, cause) {
    super(`content for ${path || 'the repo tree'} is not available from any connected peer`)
    this.code = 'CONTENT_UNAVAILABLE'
    this.path = path
    this.cause = cause
  }
}

function isUnavailable(err) {
  return !!err && (err.code === 'BLOCK_NOT_AVAILABLE' || err.code === 'REQUEST_TIMEOUT')
}

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
    // how reads of data that may live on other peers behave: the library default waits for
    // the network; the CLI sets { timeout } when online and { wait: false } when offline
    this.io = { wait: true, timeout: 0 }
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
        preLandBase: null,
        proposal: 0
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

  // Put paths back exactly as they are at the fork point (main at your last sync), entry for
  // entry, so they drop out of changes(). Returns how many paths changed.
  async revert(paths) {
    if (!this.opened) await this.ready()
    const fork = this.bee.checkout({ ...this.state.fork, ...this.io })
    const drive = this.drive
    let changed = 0
    drive.batch()
    try {
      for (const p of paths) {
        const key = keys.files.encode(normalize(p))
        const was = await fork.get(key)
        const now = await this.bee.get(key)
        if (!was && !now) continue
        if (was && now && b4a.equals(was.value, now.value)) continue
        if (!was) await drive.del(normalize(p))
        else drive._batch.tryPut(key, was.value) // the exact bytes: a re-encode may differ
        changed++
      }
      await drive.flush()
    } catch (err) {
      drive._batch = null
      throw err
    } finally {
      await fork.close()
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

    const fork = this.bee.checkout({ ...this.state.fork, ...this.io })
    const entries = []

    try {
      for await (const { left, right } of fork.createDiffStream(this.bee, {
        ...filesRange(),
        config: fork.config
      })) {
        // the diff reports rewritten keys too; a path put back as it was is not a change
        if (left && right && b4a.equals(left.value, right.value)) continue
        const key = (right || left).key
        entries.push({ path: keys.files.decode(key), value: right ? right.value : null })
      }
    } catch (err) {
      if (isUnavailable(err)) throw new ContentUnavailableError(null, err)
      throw err
    } finally {
      await fork.close()
    }

    return entries
  }

  // rebase: on conflict or stale base, sync and retry up to this many times as long as the
  // 3-way merge is clean (what a merge queue would do server side, done by the lander)
  async land({
    message = '',
    author = '',
    time = Date.now(),
    rebase = 0,
    reviewers = null,
    proposal = null
  } = {}) {
    const opts = { message, author, time, reviewers, proposal }
    let res = await this._land(opts)
    let attempts = 1

    while (
      rebase-- > 0 &&
      res.outcome &&
      (res.outcome.status === 'conflict' || res.outcome.status === 'stale-base')
    ) {
      const sync = await this.sync()
      if (sync.conflicts.length) break
      res = await this._land(opts)
      attempts++
    }

    res.attempts = attempts
    return res
  }

  async _land({ message, author, time, reviewers = null, proposal = null }) {
    // if our previous land was undone, restore and rebase it first; otherwise this land would
    // overwrite the pre-land state and the undone changes would be lost
    if (this.state.landNode && (await this.flipped())) await this.sync()

    const entries = await this.changes()
    if (entries.length === 0) return { node: null, outcome: { status: 'empty' } }

    const head = { key: this.tree.key, length: this.tree.length }

    const pre = { head: this.bee.head(), fork: this.state.fork, base: this.state.base }

    // Ask: this workspace's open proposal lands with it (apply checks it was approved)
    if (proposal === null && this.state.proposal) {
      const open = await this.repo.proposal(this.state.proposal)
      if (open && open.statusName !== 'landed') proposal = open.id
    }
    // teammates read messages in their feeds: never land an empty one
    if (!message && proposal) {
      const p = await this.repo.proposal(proposal)
      if (p && p.message) message = p.message
    }
    if (!message) {
      const paths = entries.map((e) => e.path)
      message =
        'update ' +
        paths.slice(0, 3).join(' ') +
        (paths.length > 3 ? ` +${paths.length - 3} more` : '')
    }

    const res = await this.repo.land({
      ws: head,
      base: this.state.base,
      entries,
      message,
      author,
      time,
      blobs: this.blobs.core.key,
      blobsLength: this.blobs.core.length + 1,
      proposal: proposal || 0,
      reviewers: reviewers && reviewers.length ? reviewers : null,
      policy: await this._policyText(entries)
    })

    if (res.outcome && res.outcome.status === 'accepted') {
      if (proposal) this.state.proposal = 0
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

    const snap = repo.main.view.snapshot(this.io)
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
      const fork = this.bee.checkout({ ...this.state.fork, ...this.io })
      const theirs = new Map()
      let attributes = null

      // Every read that may need the network happens before the root moves, so a missing
      // block aborts the sync with the workspace untouched.
      try {
        // only paths we touched matter, so look them up instead of diffing all of main
        for (const e of ours) {
          const k = keys.files.encode(e.path)
          const [b, t] = await Promise.all([fork.get(k), snap.get(k)])
          const bv = b ? b.value : null
          const tv = t ? t.value : null
          if (!eqBuf(bv, tv)) theirs.set(e.path, { base: bv, theirs: tv })
        }

        for (const [p, t] of theirs) {
          const ov = ours.find((e) => e.path === p).value
          if (eqBuf(ov, t.theirs)) continue
          const [b, o, th] = await Promise.all([
            this._read(t.base, p),
            this._read(ov, p),
            this._read(t.theirs, p)
          ])
          t.contents = { b, o, t: th }
        }

        if (theirs.size) attributes = await this._attributes(snap)
      } catch (err) {
        if (isUnavailable(err)) throw new ContentUnavailableError(null, err)
        throw err
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

        const merged = await this._merge(e.path, e.value, t.contents, attributes)
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

  // Ask: publish this workspace's changes for review without landing them. Calling it again
  // updates the same proposal (new revision; earlier approvals no longer count).
  async propose({ message = '', author = '', time = Date.now(), reviewers = [], quorum = 0 } = {}) {
    const entries = await this.changes()
    if (entries.length === 0) return { node: null, outcome: { status: 'empty' } }

    let replaces = 0
    if (this.state.proposal) {
      const open = await this.repo.proposal(this.state.proposal)
      if (open && open.statusName !== 'landed') replaces = open.id
    }

    const res = await this.repo.propose({
      ws: { key: this.tree.key, length: this.tree.length },
      base: this.state.base,
      entries,
      message,
      author,
      time,
      blobs: this.blobs.core.key,
      blobsLength: this.blobs.core.length + 1,
      reviewers,
      quorum,
      replaces,
      policy: await this._policyText(entries)
    })

    if (res.outcome && res.outcome.status === 'accepted') {
      this.state.proposal = res.outcome.proposal
      await this.repo._saveWorkspace(this)
    }
    return res
  }

  // the text of /.hsreview when these entries change it (apply needs it inline)
  async _policyText(entries) {
    const e = entries.find((x) => x.path === '/.hsreview')
    if (!e || !e.value) return null
    return b4a.toString(await this._read(e.value, e.path))
  }

  lastLand() {
    if (!this.state.landNode) return null
    return this.repo.outcome(this.state.landNode)
  }

  // the last land if a concurrent land has since undone it (until sync restores it)
  async flipped() {
    const last = await this.lastLand()
    if (!last || last.status === 'accepted') return null
    const cs = { node: this.state.landNode, ...last }
    return cs
  }

  // Make everything this workspace's sparse set needs local, so later offline commands never
  // block: every tree block on the way to each entry (listing walks them) and every blob, for
  // both main's head and the workspace, plus the fork-point versions of paths we changed
  // (3-way merge inputs). Returns what could not be fetched.
  async prefetch({ sparse = ['/'], timeout = 15_000 } = {}) {
    if (!this.opened) await this.ready()

    const io = { timeout }
    const seen = new Set()
    const missing = []
    let fetched = 0

    const fetchEntry = async (p, value) => {
      const blob = value && value.blob
      if (!blob || blob.byteLength === 0) return
      const id = (blob.core ? b4a.toString(blob.core, 'hex') : '-') + ':' + blob.blockOffset
      if (seen.has(id)) return
      seen.add(id)
      try {
        const blobs = await this.drive.getBlobsFor(blob)
        const end = blob.blockOffset + blob.blockLength
        if (await blobs.core.has(blob.blockOffset, end)) return
        const res = await blobs.get(blob, io)
        if (res === null) missing.push({ path: p, core: blob.core })
        else fetched++
      } catch (err) {
        if (!isUnavailable(err)) throw err
        missing.push({ path: p, core: blob.core })
      }
    }

    const views = [this.repo.main.view.snapshot(io), this.bee.snapshot(io)]

    try {
      for (const view of views) {
        for (const prefix of sparse) {
          try {
            for await (const node of view.createReadStream(prefixRange(prefix))) {
              const p = keys.files.decode(node.key)
              await fetchEntry(p, c.decode(driveEntry, node.value))
            }
          } catch (err) {
            if (!isUnavailable(err)) throw err
            missing.push({ path: prefix, core: null })
          }
        }
      }

      // merge bases: the fork-point version of every path we changed
      const saved = this.io
      this.io = io
      try {
        const fork = this.bee.checkout({ ...this.state.fork, ...io })
        try {
          for (const e of await this.changes()) {
            const node = await fork.get(keys.files.encode(e.path))
            if (node) await fetchEntry(e.path, c.decode(driveEntry, node.value))
          }
        } finally {
          await fork.close()
        }
      } catch (err) {
        if (!(err instanceof ContentUnavailableError) && !isUnavailable(err)) throw err
        missing.push({ path: '(fork point)', core: null })
      } finally {
        this.io = saved
      }
    } finally {
      for (const view of views) await view.close()
    }

    return { fetched, missing }
  }

  // merge strategies from /.hsattributes on main ("<glob> merge=union"), read before the move
  async _attributes(snap) {
    const node = await snap.get(keys.files.encode('/.hsattributes'))
    if (!node) return []
    const content = await this._read(node.value, '/.hsattributes')
    return merge.parseAttributes(content)
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

  async _merge(path, ours, { b, o, t }, attributes) {
    const oe = ours ? c.decode(driveEntry, ours) : null
    const executable = oe ? oe.executable : false

    if (
      o !== null &&
      t !== null &&
      merge.isText(o) &&
      merge.isText(t) &&
      (b === null || merge.isText(b))
    ) {
      const strategy = merge.strategyFor(attributes || [], path)
      const res =
        strategy === 'union'
          ? merge.union(b || b4a.alloc(0), o, t)
          : merge.diff3(b || b4a.alloc(0), o, t)
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
    // dedup is an optimization: if the hash index can't be read, just upload
    const known = await this._knownBlob(hash).catch(() => null)
    if (known) await this.drive.putEntry(path, { executable, blob: known.blob, hash })
    else await this.drive.put(path, content, { executable, hash })
  }

  async _read(value, path = null) {
    if (!value) return null
    const entry = c.decode(driveEntry, value)
    if (!entry.blob) return b4a.alloc(0)
    try {
      const blobs = await this.drive.getBlobsFor(entry.blob)
      const res = await blobs.get(entry.blob, this.io)
      if (res === null) throw new ContentUnavailableError(path)
      return res
    } catch (err) {
      if (isUnavailable(err)) throw new ContentUnavailableError(path, err)
      throw err
    }
  }
}

module.exports.ContentUnavailableError = ContentUnavailableError
module.exports.isUnavailable = isUnavailable

function prefixRange(prefix) {
  if (prefix === '/') return filesRange()
  // '0' sorts right after '/', so this is exactly the paths under prefix/
  return keys.files.encodeRange({ gt: prefix + '/', lt: prefix + '0' })
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
