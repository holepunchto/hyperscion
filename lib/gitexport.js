// Git objects for main's history (lib/gip.js publishes them to a git+pear repo). Pure: no repo,
// no network. Each changeset #n becomes one commit whose parent is #n-1's, with a deterministic
// author line, time and an `Hs-Changeset: <repo>#<n>` trailer, so any peer exporting the same
// main gets the same oids.
const b4a = require('b4a')
const crypto = require('bare-crypto')

const MODE_FILE = '100644'
const MODE_EXEC = '100755'
const MODE_LINK = '120000'
const MODE_TREE = '40000'

const TRAILER = 'Hs-Changeset'
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// a git object: its oid (sha1 over "<type> <len>\0" + data) and its headerless payload, the
// { type, size, data } shape gip-remote stores
function object(type, data) {
  const hash = crypto.createHash('sha1')
  hash.update(b4a.from(`${type} ${data.byteLength}\0`))
  hash.update(data)
  return { oid: b4a.toString(hash.digest(), 'hex'), type, size: data.byteLength, data }
}

// git sorts tree entries by name, with directories compared as if they ended in '/'
function sortKey(e) {
  return e.mode === MODE_TREE ? e.name + '/' : e.name
}

function encodeTree(entries) {
  const sorted = [...entries].sort((a, b) => {
    const x = sortKey(a)
    const y = sortKey(b)
    return x < y ? -1 : x > y ? 1 : 0
  })
  const parts = []
  for (const e of sorted) {
    parts.push(b4a.from(`${e.mode} ${e.name}\0`), b4a.from(e.oid, 'hex'))
  }
  return b4a.concat(parts)
}

// git tree entries: [{ mode, name, oid }], the inverse of encodeTree
function decodeTree(data) {
  const out = []
  let i = 0
  while (i < data.byteLength) {
    const space = data.indexOf(32, i)
    const nul = data.indexOf(0, space)
    out.push({
      mode: b4a.toString(data.subarray(i, space)),
      name: b4a.toString(data.subarray(space + 1, nul)),
      oid: b4a.toString(data.subarray(nul + 1, nul + 21), 'hex')
    })
    i = nul + 21
  }
  return out
}

// A path tree that remembers each directory's oid and recomputes only the directories a
// change touched. Files are { mode, oid }; directories hold their children.
class TreeBuilder {
  constructor() {
    this.root = dir()
  }

  // load an existing git tree (e.g. the gip branch tip), reading tree objects with `get`
  static async from(rootOid, get) {
    const t = new TreeBuilder()
    if (rootOid && rootOid !== EMPTY_TREE) await load(t.root, rootOid, get)
    return t
  }

  set(path, file) {
    const names = split(path)
    let node = this.root
    node.oid = null
    for (const name of names.slice(0, -1)) {
      let next = node.dirs.get(name)
      if (!next) {
        next = dir()
        node.dirs.set(name, next)
        node.files.delete(name) // a file replaced by a directory
      }
      next.oid = null
      node = next
    }
    const name = names[names.length - 1]
    node.dirs.delete(name) // a directory replaced by a file
    node.files.set(name, file)
  }

  delete(path) {
    const names = split(path)
    const trail = [this.root]
    let node = this.root
    for (const name of names.slice(0, -1)) {
      node = node.dirs.get(name)
      if (!node) return
      trail.push(node)
    }
    if (!node.files.delete(names[names.length - 1])) return
    for (const n of trail) n.oid = null
    // drop directories left empty: git has no empty trees below the root
    for (let i = trail.length - 1; i > 0; i--) {
      const n = trail[i]
      if (n.files.size || n.dirs.size) break
      trail[i - 1].dirs.delete(names[i - 1])
    }
  }

  // the root tree's oid; new tree objects go into `objects` (oid -> object)
  flush(objects) {
    return flushDir(this.root, objects)
  }

  // every file: [{ path, mode, oid }]
  files() {
    const out = []
    walk(this.root, '', out)
    return out
  }
}

function dir() {
  return { oid: null, files: new Map(), dirs: new Map() }
}

function split(path) {
  const names = path.split('/').filter(Boolean)
  if (names.length === 0) throw new Error('not a file path: ' + path)
  return names
}

async function load(node, oid, get) {
  const obj = await get(oid)
  if (!obj || obj.type !== 'tree') throw new Error('git tree missing: ' + oid)
  node.oid = oid
  for (const e of decodeTree(obj.data)) {
    if (e.mode === MODE_TREE) {
      const child = dir()
      await load(child, e.oid, get)
      node.dirs.set(e.name, child)
    } else {
      node.files.set(e.name, { mode: e.mode, oid: e.oid })
    }
  }
}

function flushDir(node, objects) {
  if (node.oid) return node.oid
  const entries = []
  for (const [name, f] of node.files) entries.push({ mode: f.mode, name, oid: f.oid })
  for (const [name, child] of node.dirs) {
    entries.push({ mode: MODE_TREE, name, oid: flushDir(child, objects) })
  }
  const tree = object('tree', encodeTree(entries))
  objects.set(tree.oid, tree)
  node.oid = tree.oid
  return tree.oid
}

function walk(node, prefix, out) {
  for (const [name, f] of node.files) out.push({ path: prefix + '/' + name, ...f })
  for (const [name, child] of node.dirs) walk(child, prefix + '/' + name, out)
}

// "Name <email>" as git wants it: an author that already is one (hs import-git keeps git's)
// stays as it is, an hs handle becomes "handle <handle@hs>"
function identity(author) {
  const a = (author || '').trim()
  if (/^[^<>]+ <[^<>]*>$/.test(a)) return a
  const name = a.replace(/[<>\n]/g, '') || 'hs'
  return `${name} <${name.replace(/\s+/g, '.')}@hs>`
}

// the commit for changeset `cs` of repo `repoId` (z32 key)
function commit({ tree, parent = null, cs, repoId }) {
  const who = `${identity(cs.author)} ${Math.floor((cs.time || 0) / 1000)} +0000`
  const message = (cs.message || '').trim() || `changeset #${cs.seq}`
  const lines = [`tree ${tree}`]
  if (parent) lines.push(`parent ${parent}`)
  lines.push(`author ${who}`, `committer ${who}`, '', message, '', trailer(repoId, cs.seq), '')
  return object('commit', b4a.from(lines.join('\n')))
}

function trailer(repoId, seq) {
  return `${TRAILER}: ${repoId}#${seq}`
}

// the `Hs-Changeset` trailer of a commit message, if any: { repoId, seq }
function parseTrailer(message) {
  const re = new RegExp(`^${TRAILER}: ([a-z0-9]+)#(\\d+)$`, 'm')
  const m = re.exec(message || '')
  return m ? { repoId: m[1], seq: Number(m[2]) } : null
}

// a commit object's fields: { tree, parents, author, time, message }, plus the raw author
// (who) and committer (by) lines
function parseCommit(data) {
  const text = b4a.toString(data)
  const blank = text.indexOf('\n\n')
  const head = blank === -1 ? text : text.slice(0, blank)
  const out = { tree: null, parents: [], author: null, time: 0, message: '', who: null, by: null }
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5)
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7))
    else if (line.startsWith('committer ')) out.by = line.slice(10)
    else if (line.startsWith('author ')) {
      out.who = line.slice(7)
      const m = /^author (.*) (\d+) [+-]\d{4}$/.exec(line)
      if (m) {
        out.author = m[1]
        out.time = Number(m[2]) * 1000
      }
    }
  }
  out.message = blank === -1 ? '' : text.slice(blank + 2).replace(/\n+$/, '')
  return out
}

// a commit exactly as publish writes it: this repo's trailer, and the same author and
// committer line. An amended or cherry-picked copy keeps the trailer but not the committer
function isPublished(commit, repoId) {
  const t = parseTrailer(commit.message)
  return !!(t && t.repoId === repoId && commit.who && commit.who === commit.by)
}

module.exports = {
  MODE_FILE,
  MODE_EXEC,
  MODE_LINK,
  MODE_TREE,
  EMPTY_TREE,
  TRAILER,
  object,
  encodeTree,
  decodeTree,
  TreeBuilder,
  identity,
  commit,
  trailer,
  parseTrailer,
  parseCommit,
  isPublished
}
