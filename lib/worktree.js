// An on-disk working copy of a workspace. Materialization is sparse (only the configured
// prefixes) and lazy at the block level: only blobs for files inside the prefixes are
// fetched. A stat cache (path -> mtime, size, hash) keeps `status` to a stat() per file.
const fs = require('bare-fs/promises')
const path = require('bare-path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const unixPathResolve = require('unix-path-resolve')

const HS = '.hs'

module.exports = class Worktree {
  constructor(root, { sparse = ['/'] } = {}) {
    this.root = root
    this.sparse = sparse.map((p) => unixPathResolve('/', p))
    this.statFile = path.join(root, HS, 'stat.json')
    this.cache = null
  }

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
  // With wait: false nothing blocks on the network: files whose blobs are not held locally
  // are reported in `missing` and left untouched, so the caller can go online and retry.
  async checkout(ws, { wait = false, timeout = 0 } = {}) {
    const cache = await this._loadCache()
    const seen = new Set()
    const stats = { written: 0, skipped: 0, removed: 0, missing: [] }

    for (const prefix of this.sparse) {
      for await (const entry of ws.drive.list(prefix === '/' ? '/' : prefix)) {
        const p = entry.key
        seen.add(p)

        const v = entry.value
        const hex = v.hash ? b4a.toString(v.hash, 'hex') : null
        const abs = this._abs(p)
        const cached = cache[p]

        if (cached && hex && cached[2] === hex && (await matchesStat(abs, cached))) {
          stats.skipped++
          continue
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
          stats.missing.push(p)
          continue
        }

        await fs.writeFile(abs, content)
        await fs.chmod(abs, v.executable ? 0o755 : 0o644)

        const st = await fs.stat(abs)
        cache[p] = [st.mtimeMs, st.size, hex || b4a.toString(crypto.hash(content), 'hex')]
        stats.written++
      }
    }

    for (const p of Object.keys(cache)) {
      if (seen.has(p) || !this.inSparse(p)) continue
      await fs.rm(this._abs(p), { force: true })
      delete cache[p]
      stats.removed++
    }

    await this._saveCache()
    return stats
  }

  // Compare disk against the workspace. Returns changes in the shape Workspace.commit takes.
  async status(ws) {
    const cache = await this._loadCache()
    const tracked = new Map()

    for (const prefix of this.sparse) {
      for await (const entry of ws.drive.list(prefix)) {
        tracked.set(entry.key, entry.value)
      }
    }

    const changes = []
    const onDisk = new Set()

    for (const prefix of this.sparse) {
      for await (const { p, abs, st } of walk(this.root, prefix)) {
        onDisk.add(p)

        const cached = cache[p]
        let hex = null
        let content = null

        if (cached && cached[0] === st.mtimeMs && cached[1] === st.size) {
          hex = cached[2]
        } else {
          content = await fs.readFile(abs)
          hex = b4a.toString(crypto.hash(content), 'hex')
        }

        const executable = (st.mode & 0o111) !== 0
        const t = tracked.get(p)
        const same =
          t && t.hash && b4a.toString(t.hash, 'hex') === hex && t.executable === executable

        if (same) {
          if (!cached || cached[2] !== hex) cache[p] = [st.mtimeMs, st.size, hex]
          continue
        }

        if (content === null) content = await fs.readFile(abs)
        changes.push({ path: p, content, executable, status: t ? 'modified' : 'added', st, hex })
      }
    }

    // only files we materialized can be deleted; unfetched or sparse-excluded files are not
    for (const [p, v] of tracked) {
      if (onDisk.has(p) || v.linkname || !cache[p]) continue
      changes.push({ path: p, content: null, status: 'deleted' })
    }

    changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return changes
  }

  async commit(ws, changes = null) {
    if (changes === null) changes = await this.status(ws)
    const n = await ws.commit(changes)

    const cache = await this._loadCache()
    for (const ch of changes) {
      if (ch.content === null) delete cache[ch.path]
      else cache[ch.path] = [ch.st.mtimeMs, ch.st.size, ch.hex]
    }
    await this._saveCache()

    return n
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

async function matchesStat(abs, cached) {
  try {
    const st = await fs.stat(abs)
    return st.mtimeMs === cached[0] && st.size === cached[1]
  } catch {
    return false
  }
}

async function* walk(root, prefix) {
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

      if (s.isDirectory()) stack.push([abs, p])
      else if (s.isFile()) yield { p, abs, st: s }
    }
  }
}
