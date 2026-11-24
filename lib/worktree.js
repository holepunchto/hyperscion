// An on-disk working copy of a workspace. Materialization is sparse (only the configured
// prefixes) and lazy at the block level: only blobs for files inside the prefixes are
// fetched. A stat cache (path -> mtime, size, hash) keeps `status` to a stat() per file.
const fs = require('bare-fs/promises')
const path = require('bare-path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const unixPathResolve = require('unix-path-resolve')
const { Ignorer } = require('./ignore')

const HS = '.hs'

module.exports = class Worktree {
  constructor(root, { sparse = ['/'] } = {}) {
    this.root = root
    this.sparse = sparse.map((p) => unixPathResolve('/', p))
    this.statFile = path.join(root, HS, 'stat.json')
    this.cache = null
  }

  // stat cache: path -> { mtime, size, hash } for files we wrote or verified. A file we could
  // not update to the workspace version is { stale: true, want, mtime, size, hash } where
  // hash/mtime/size describe what is (still) on disk.
  async _loadCache() {
    if (this.cache) return this.cache
    try {
      this.cache = JSON.parse(await fs.readFile(this.statFile, 'utf8'))
    } catch {
      this.cache = {}
    }
    return this.cache
  }

  async _saveCache() {
    await fs.mkdir(path.dirname(this.statFile), { recursive: true })
    await fs.writeFile(this.statFile, JSON.stringify(this.cache))
  }

  inSparse(p) {
    return this.sparse.some((s) => s === '/' || p === s || p.startsWith(s + '/'))
  }

  _abs(p) {
    return path.join(this.root, ...p.split('/').filter(Boolean))
  }

  // Write the workspace's files to disk. Files whose cached hash already matches are skipped,
  // tracked files that disappeared from the workspace are removed.
  // Never clobbers local work: a file whose disk state differs from what we last wrote is left
  // alone and reported in `unresolved` (see restore()).
  // With wait: false nothing blocks on the network: files whose blobs are not held locally are
  // marked stale (never treated as local edits) and reported in `missing`.
  async checkout(ws, { wait = false, timeout = 0 } = {}) {
    const cache = await this._loadCache()
    const seen = new Set()
    const stats = { written: 0, skipped: 0, removed: 0, missing: [], unresolved: [] }

    for (const prefix of this.sparse) {
      for await (const entry of ws.drive.list(prefix === '/' ? '/' : prefix)) {
        const p = entry.key
        seen.add(p)

        const v = entry.value
        const hex = v.hash ? b4a.toString(v.hash, 'hex') : null
        const abs = this._abs(p)
        const cached = cache[p]
        const st = await statOrNull(abs)

        if (cached && !cached.stale && hex && cached.hash === hex && sameStat(st, cached)) {
          stats.skipped++
          continue
        }

        // local edits: the file on disk is not what we last wrote (or an untracked file is in
        // the way). Keep it unless it already has the wanted content.
        if (st && (cached ? !sameStat(st, cached) : true)) {
          const diskHex = b4a.toString(crypto.hash(await fs.readFile(abs)), 'hex')
          if (diskHex === hex) {
            cache[p] = statEntry(st, hex)
            stats.skipped++
            continue
          }
          // still what we last wrote or verified: not an edit, just a stat we couldn't trust
          // (racy), so update it like an unchanged file
          if (!cached || !cached.hash || diskHex !== cached.hash) {
            stats.unresolved.push(p)
            continue
          }
        }

        await fs.mkdir(path.dirname(abs), { recursive: true })

        if (v.linkname) {
          await fs.rm(abs, { force: true })
          await fs.symlink(v.linkname, abs)
          delete cache[p]
          stats.written++
          continue
        }

        const content = v.blob ? await fetch(ws.drive, p, { wait, timeout }) : b4a.alloc(0)
        if (content === null) {
          // keep what is on disk, but remember it is behind the workspace
          cache[p] = st
            ? { stale: true, want: hex, ...statEntry(st, cached && cached.hash) }
            : { stale: true, want: hex, absent: true }
          stats.missing.push(p)
          continue
        }

        await fs.writeFile(abs, content)
        await fs.chmod(abs, v.executable ? 0o755 : 0o644)

        const written = await fs.stat(abs)
        cache[p] = statEntry(written, hex || b4a.toString(crypto.hash(content), 'hex'))
        stats.written++
      }
    }

    for (const p of Object.keys(cache)) {
      if (seen.has(p) || !this.inSparse(p)) continue
      const st = await statOrNull(this._abs(p))
      if (
        st &&
        !cache[p].absent &&
        !sameStat(st, cache[p]) &&
        !(await sameContent(this._abs(p), cache[p]))
      ) {
        stats.unresolved.push(p) // deleted upstream but edited here
        continue
      }
      await fs.rm(this._abs(p), { force: true })
      delete cache[p]
      stats.removed++
    }

    await this._saveCache()
    return stats
  }

  // Overwrite working files with the workspace version, discarding local edits.
  async restore(ws, paths) {
    const cache = await this._loadCache()
    const restored = []
    for (const raw of paths) {
      const p = unixPathResolve('/', raw)
      const abs = this._abs(p)
      const entry = await ws.drive.entry(p)
      if (!entry) {
        await fs.rm(abs, { force: true })
        delete cache[p]
        restored.push(p)
        continue
      }
      const content = entry.value.blob ? await ws.drive.get(p, ws.io) : b4a.alloc(0)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content)
      await fs.chmod(abs, entry.value.executable ? 0o755 : 0o644)
      const st = await fs.stat(abs)
      cache[p] = statEntry(st, b4a.toString(crypto.hash(content), 'hex'))
      restored.push(p)
    }
    await this._saveCache()
    return restored
  }

  // Compare disk against the workspace. Returns changes in the shape Workspace.commit takes.
  // `changes.stale` lists files that are behind the workspace because their content could not
  // be fetched; they are never reported as edits. Edits made on top of a stale file are
  // returned with staleBase: true and must not be committed.
  async status(ws) {
    const cache = await this._loadCache()
    const tracked = new Map()

    for (const prefix of this.sparse) {
      for await (const entry of ws.drive.list(prefix)) {
        tracked.set(entry.key, entry.value)
      }
    }

    const changes = []
    const stale = []
    const onDisk = new Set()
    // untracked files .gitignore or .hsignore rules exclude (lib/ignore.js); tracked files are
    // never ignored, nor are directories that hold one
    const ignored = []
    const filter = { ignorer: new Ignorer(this.root), tracked, dirs: trackedDirs(tracked), ignored }

    for (const prefix of this.sparse) {
      for await (const { p, abs, st } of walk(this.root, prefix, filter)) {
        onDisk.add(p)

        const cached = cache[p]
        const executable = (st.mode & 0o111) !== 0

        if (cached && cached.stale) {
          if (sameStat(st, cached)) {
            stale.push(p)
            continue
          }
          const content = await fs.readFile(abs)
          const hex = b4a.toString(crypto.hash(content), 'hex')
          // main's version is already here (a checkout killed before saving the cache wrote
          // it): up to date, not an edit. Content unchanged since we marked it (only its stat
          // moved), or the version we were waiting for while main moved on again: still just
          // behind, not an edit either
          const t = tracked.get(p)
          if (t && t.hash && hex === b4a.toString(t.hash, 'hex')) {
            cache[p] = statEntry(st, hex)
            continue
          }
          if (hex === cached.want || (cached.hash && hex === cached.hash)) {
            const { racy, ...rest } = cached
            cache[p] = { ...rest, ...statEntry(st, hex) }
            stale.push(p)
            continue
          }
          changes.push({
            path: p,
            content,
            executable,
            status: 'modified (stale base)',
            staleBase: true,
            st,
            hex
          })
          continue
        }

        let hex = null
        let content = null

        if (cached && sameStat(st, cached)) {
          hex = cached.hash
        } else {
          content = await fs.readFile(abs)
          hex = b4a.toString(crypto.hash(content), 'hex')
        }

        const t = tracked.get(p)
        const same =
          t && t.hash && b4a.toString(t.hash, 'hex') === hex && t.executable === executable

        if (same) {
          // re-record a racy entry once its file is old enough to trust
          if (!cached || cached.hash !== hex || cached.racy) {
            cache[p] = statEntry(st, hex)
          }
          continue
        }

        if (content === null) content = await fs.readFile(abs)
        changes.push({ path: p, content, executable, status: t ? 'modified' : 'added', st, hex })
      }
    }

    // only files we materialized can be deleted; unfetched, stale or sparse-excluded files are not
    for (const [p, v] of tracked) {
      if (onDisk.has(p) || v.linkname || !cache[p]) continue
      if (cache[p].stale) {
        stale.push(p)
        continue
      }
      changes.push({ path: p, content: null, status: 'deleted' })
    }

    changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    changes.stale = stale.sort()
    changes.ignored = ignored.sort()
    return changes
  }

  // Commit working changes. Edits on top of stale files are held back (returned in `blocked`).
  async commit(ws, changes = null) {
    if (changes === null) changes = await this.status(ws)
    const blocked = changes.filter((ch) => ch.staleBase)
    const ok = changes.filter((ch) => !ch.staleBase)
    const n = await ws.commit(ok)

    const cache = await this._loadCache()
    for (const ch of ok) {
      if (ch.content === null) delete cache[ch.path]
      else cache[ch.path] = statEntry(ch.st, ch.hex)
    }
    await this._saveCache()

    return { committed: n, blocked: blocked.map((ch) => ch.path), stale: changes.stale || [] }
  }
}

// Racy entries (git's "racily clean" problem): a file changed again within the filesystem's
// mtime granularity of when we recorded it can keep the same mtime and size with different
// content (Windows advances mtime per clock tick, ~16ms; FAT keeps 2s, HFS+ 1s). CI caught
// it: a checkout, then an edit to same-size content right after, read as unchanged. So an
// entry recorded less than RACY_MS after its file's mtime isn't trusted: it is re-hashed
// until its file is old enough to record again
const RACY_MS = 3000

function statEntry(st, hash) {
  const e = { mtime: st.mtimeMs, size: st.size, hash }
  if (Date.now() - st.mtimeMs < RACY_MS) e.racy = true
  return e
}

// a file whose stat we can't trust (racy, or touched) still holds what we last recorded
async function sameContent(abs, cached) {
  if (!cached || !cached.hash) return false
  try {
    return b4a.toString(crypto.hash(await fs.readFile(abs)), 'hex') === cached.hash
  } catch {
    return false
  }
}

function sameStat(st, cached) {
  return !!st && !!cached && !cached.racy && st.mtimeMs === cached.mtime && st.size === cached.size
}

async function statOrNull(abs) {
  try {
    return await fs.stat(abs)
  } catch {
    return null
  }
}

async function fetch(drive, p, opts) {
  try {
    return await drive.get(p, opts)
  } catch (err) {
    if (err.code === 'BLOCK_NOT_AVAILABLE' || err.code === 'REQUEST_TIMEOUT') return null
    throw err
  }
}

// every directory that holds a tracked file ('/src', '/src/geo'): an ignore rule never hides it
function trackedDirs(tracked) {
  const dirs = new Set()
  for (const p of tracked.keys()) {
    let d = p.slice(0, p.lastIndexOf('/')) || '/'
    while (d !== '/' && !dirs.has(d)) {
      dirs.add(d)
      d = d.slice(0, d.lastIndexOf('/')) || '/'
    }
  }
  return dirs
}

// filter: { ignorer, tracked, dirs, ignored } skips what ignore rules exclude, collecting it
// (an ignored directory once, as '/node_modules/', without walking into it)
async function* walk(root, prefix, filter = null) {
  const start = path.join(root, ...prefix.split('/').filter(Boolean))
  let st = null
  try {
    st = await fs.lstat(start)
  } catch {
    return
  }

  if (!st.isDirectory()) {
    if (st.isFile()) yield { p: prefix, abs: start, st }
    return
  }

  const stack = [[start, prefix === '/' ? '' : prefix]]

  while (stack.length) {
    const [dir, rel] = stack.pop()
    const names = await fs.readdir(dir)

    for (const name of names) {
      if (rel === '' && name === HS) continue
      if (name === '.git') continue

      const abs = path.join(dir, name)
      const p = rel + '/' + name
      const s = await fs.lstat(abs)

      if (s.isDirectory()) {
        if (filter && !filter.dirs.has(p) && (await filter.ignorer.ignored(p, true))) {
          filter.ignored.push(p + '/')
          continue
        }
        stack.push([abs, p])
      } else if (s.isFile()) {
        if (filter && !filter.tracked.has(p) && (await filter.ignorer.ignored(p))) {
          filter.ignored.push(p)
          continue
        }
        yield { p, abs, st: s }
      }
    }
  }
}
