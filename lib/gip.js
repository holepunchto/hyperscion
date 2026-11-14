// hs <-> git+pear (gip, https://github.com/holepunchto/gip-transport): main published as a git
// branch in a gip repo, and git commits pushed to someone's gip repo landed back on main.
//
// - publish: hs main is the source of truth. Settled changesets after the branch tip become
//   commits (lib/gitexport.js) pushed in one gip-remote push. The tip's `Hs-Changeset` trailer
//   says where to resume, so hs stores nothing about it. The gip repo is a single-writer
//   hypercore owned by the publishing store (the hub's).
// - import: a human pushes commits on top of a published commit to their own gip repo (they
//   can't write the hub's). Every commit after the newest one carrying this repo's trailer is
//   replayed onto main like a sync: paths main hasn't changed since apply as they are, text
//   both changed is 3-way merged, anything else stops the import. Commits that carry a trailer
//   are never imported, and each import's land records `Git-Commit: <oid>`, so re-running is
//   idempotent and nothing loops.
const b4a = require('b4a')
const c = require('compact-encoding')
const z32 = require('z32')
const driveEntry = require('hyperdrive/lib/encoding')
const { getEncoding } = require('./schema/spec')
const keys = require('./keys')
const merge = require('./merge')
const gx = require('./gitexport')

const Hist = getEncoding('@hs/hist')

const BRANCH = 'main'
const BATCH_BYTES = 32 * 1024 * 1024 // push at least every this many bytes of new objects
const GIT_COMMIT = 'Git-Commit'

// gip-remote is only loaded by the commands that use it
function Remote() {
  return require('gip-remote').Remote
}

// this repo's own gip repo, named `name`, in its store (writable by it)
function open(store, name) {
  const R = Remote()
  return new R(store.namespace('hs-gip'), name)
}

// someone's gip repo by link, read-only
function openLink(store, link, opts = {}) {
  const R = Remote()
  return new R(store.namespace('hs-gip'), link, opts)
}

function repoId(repo) {
  return z32.encode(repo.key)
}

function link(remote) {
  return `git+pear://${z32.encode(remote.key)}/${remote.name}`
}

// Export settled changesets after the branch tip and push them. Returns
// { from, to, commits, tip } (commits 0: nothing new).
async function publish(
  repo,
  remote,
  { branch = BRANCH, to = null, batchBytes = BATCH_BYTES, onprogress = noop } = {}
) {
  await remote.ready()
  const id = repoId(repo)
  const get = (oid) => remote.getObject(oid)

  const ref = await remote.getBranchRef(branch)
  let tip = ref ? ref.oid : null
  let from = 0
  let tree = new gx.TreeBuilder()
  if (tip) {
    const head = await get(tip)
    const commit = gx.parseCommit(head.data)
    const t = gx.parseTrailer(commit.message)
    if (!t || t.repoId !== id) {
      throw new Error(`branch ${branch} of ${link(remote)} is not an export of this repo`)
    }
    from = t.seq
    tree = await gx.TreeBuilder.from(commit.tree, get)
  }

  const snap = repo.snapshot()
  const drive = repo.drive(snap)
  try {
    // only settled changesets: a provisional one can still be reordered, and a published
    // commit can't be taken back
    const settled = await repo.settledSeq(snap)
    const target = to === null ? settled : Math.min(to, settled)
    if (target <= from) return { from, to: from, commits: 0, tip }

    const changes = await changesBetween(repo, from, target, snap)
    let objects = new Map()
    let bytes = 0
    let commits = 0

    for (let seq = from + 1; seq <= target; seq++) {
      const cs = await repo.changeset(seq, snap)
      if (!cs) throw new Error(`changeset #${seq} is missing`)
      for (const { path, next } of changes.get(seq) || []) {
        if (!next) {
          tree.delete(path)
          continue
        }
        const blob = await blobOf(drive, next)
        if (!objects.has(blob.oid)) {
          objects.set(blob.oid, blob)
          bytes += blob.size
        }
        tree.set(path, { mode: blob.mode, oid: blob.oid })
      }
      const commit = gx.commit({ tree: tree.flush(objects), parent: tip, cs, repoId: id })
      objects.set(commit.oid, commit)
      tip = commit.oid
      commits++
      onprogress({ seq, commits, target })

      if (bytes >= batchBytes || seq === target) {
        await remote.push(branch, tip, objects)
        objects = new Map()
        bytes = 0
      }
    }

    return { from, to: target, commits, tip }
  } finally {
    await drive.close()
    await snap.close()
  }
}

// seq -> [{ path, next }] for from < seq <= to, from path history. A changeset lists its first
// 100 paths; bigger ones are read from one scan of the history keyspace
async function changesBetween(repo, from, to, snap) {
  const out = new Map()
  let scan = false
  for (let seq = from + 1; seq <= to && !scan; seq++) {
    const shown = await repo.show(seq, snap)
    if (!shown || shown.truncated) {
      scan = true
      break
    }
    const list = []
    for (const f of shown.files) {
      if (f.next === undefined && f.prev === undefined) throw noHistory(seq)
      list.push({ path: f.path, next: f.deleted ? null : f.next || null })
    }
    out.set(seq, list)
  }
  if (!scan) return out

  out.clear()
  for await (const node of snap.createReadStream(keys.histAll())) {
    const seq = keys.histSeq(node.key)
    if (seq <= from || seq > to) continue
    if (!node.value.byteLength) throw noHistory(seq)
    const rec = c.decode(Hist, node.value)
    if (!out.has(seq)) out.set(seq, [])
    out.get(seq).push({ path: keys.histPath(node.key), next: rec.next || null })
  }
  return out
}

function noHistory(seq) {
  return new Error(`#${seq} landed before hs kept file history values; it can't be exported`)
}

// a drive entry as a git blob, with its tree mode
async function blobOf(drive, value) {
  const entry = c.decode(driveEntry, value)
  if (entry.linkname) {
    return { ...gx.object('blob', b4a.from(entry.linkname)), mode: gx.MODE_LINK }
  }
  let data = b4a.alloc(0)
  if (entry.blob) {
    const blobs = await drive.getBlobsFor(entry.blob)
    data = await blobs.get(entry.blob)
  }
  return { ...gx.object('blob', data), mode: entry.executable ? gx.MODE_EXEC : gx.MODE_FILE }
}

// Land the commits on `source`'s branch that follow the newest commit published from this
// repo. Returns { fork, imported: [{ oid, seq }], skipped, conflicts } and stops at the first
// commit that conflicts with main (conflicts: [path], nothing of it landed).
async function importFrom(
  repo,
  source,
  { branch = BRANCH, workspace = 'gip-import', onprogress = noop } = {}
) {
  await source.ready()
  const id = repoId(repo)
  const get = async (oid) => {
    const obj = await source.getObject(oid)
    if (!obj) throw new Error(`git object ${oid} isn't available from ${link(source)}`)
    return obj
  }

  const ref = await source.getBranchRef(branch)
  if (!ref) throw new Error(`${link(source)} has no branch ${branch}`)

  // first-parent back to the newest commit published from this repo
  const chain = []
  let fork = null
  for (let oid = ref.oid; oid;) {
    const commit = gx.parseCommit((await get(oid)).data)
    if (gx.isPublished(commit, id)) {
      fork = { oid, seq: gx.parseTrailer(commit.message).seq, tree: commit.tree }
      break
    }
    const t = gx.parseTrailer(commit.message)
    if (t && t.repoId !== id && commit.who === commit.by) {
      throw new Error(`branch ${branch} was published from another repo`)
    }
    chain.push({ oid, commit })
    oid = commit.parents[0] || null
  }
  if (!fork) {
    throw new Error(
      `no commit of ${branch} was published from this repo: clone the hs repo's git+pear link and commit on top of it`
    )
  }
  chain.reverse()

  const done = await importedOids(repo, fork.seq)
  const res = { fork: fork.seq, imported: [], skipped: 0, conflicts: [] }
  const ws = await repo.workspace(workspace)
  await ws.sync()

  let parentTree = fork.tree
  for (const { oid, commit } of chain) {
    const prevTree = parentTree
    parentTree = commit.tree
    if (done.has(oid)) continue

    const changes = []
    const conflicts = []
    for (const d of await diffTrees(get, prevTree, commit.tree)) {
      if (d.mode === gx.MODE_LINK || d.mode === '160000' || d.oldMode === '160000') {
        res.skipped++ // symlinks and submodules, as hs import-git
        continue
      }
      const base = d.old ? (await get(d.old)).data : null
      const theirs = d.oid ? (await get(d.oid)).data : null
      const entry = await ws.drive.entry(d.path)
      const ours = entry ? await ws.drive.get(d.path) : null
      const oursExec = !!(entry && entry.value.executable)
      // the mode git changed, unless main changed it too
      const baseExec = d.oldMode === gx.MODE_EXEC
      const executable = oursExec === baseExec ? d.mode === gx.MODE_EXEC : oursExec

      // 3-way per path: whichever side changed wins, text both changed is merged; undefined
      // is a conflict (both changed, not mergeable; or one deleted what the other changed)
      let content
      if (same(ours, theirs)) content = ours
      else if (same(ours, base)) content = theirs
      else if (same(theirs, base)) content = ours
      else if (ours && base && theirs && merge.isText(ours) && merge.isText(theirs)) {
        const m = merge.diff3(base, ours, theirs)
        if (m.clean) content = m.content
      }
      if (content === undefined) {
        conflicts.push(d.path)
        continue
      }
      if (content === null ? ours === null : same(content, ours) && executable === oursExec) {
        continue
      }
      changes.push({ path: d.path, content, executable })
    }

    if (conflicts.length) {
      res.conflicts = conflicts
      res.stopped = oid
      break
    }

    if (changes.length) await ws.commit(changes)
    const { outcome } = await ws.land({
      message: `${commit.message}\n\n${GIT_COMMIT}: ${oid}`,
      author: commit.author || '',
      time: commit.time || Date.now(),
      rebase: 3
    })
    if (outcome.status === 'accepted') res.imported.push({ oid, seq: outcome.seq })
    else if (outcome.status !== 'empty') {
      throw new Error(`land of ${oid} was ${outcome.status}`)
    }
    onprogress(res)
  }
  return res
}

// git oids already landed by an import since #from
async function importedOids(repo, from) {
  const out = new Set()
  const meta = await repo.meta()
  const re = new RegExp(`^${GIT_COMMIT}: ([0-9a-f]{40})$`, 'gm')
  for (const cs of await repo.changesetsBetween(from, meta.seq)) {
    for (const m of (cs.message || '').matchAll(re)) out.add(m[1])
  }
  return out
}

// files that differ between two trees: [{ path, old, oldMode, oid, mode }] (null when absent),
// skipping subtrees with the same oid
async function diffTrees(get, a, b, prefix = '') {
  if (a === b) return []
  const left = a ? gx.decodeTree((await get(a)).data) : []
  const right = b ? gx.decodeTree((await get(b)).data) : []
  const names = new Set([...left.map((e) => e.name), ...right.map((e) => e.name)])
  const byName = (list) => new Map(list.map((e) => [e.name, e]))
  const L = byName(left)
  const R = byName(right)
  const out = []
  for (const name of [...names].sort()) {
    const l = L.get(name) || null
    const r = R.get(name) || null
    const path = prefix + '/' + name
    const lt = l && l.mode === gx.MODE_TREE
    const rt = r && r.mode === gx.MODE_TREE
    if (lt || rt) {
      // a tree on either side: recurse into it; a file on the other side is a change too
      out.push(...(await diffTrees(get, lt ? l.oid : null, rt ? r.oid : null, path)))
      if (l && !lt) out.push({ path, old: l.oid, oldMode: l.mode, oid: null, mode: null })
      if (r && !rt) out.push({ path, old: null, oldMode: null, oid: r.oid, mode: r.mode })
      continue
    }
    if (l && r && l.oid === r.oid && l.mode === r.mode) continue
    out.push({
      path,
      old: l ? l.oid : null,
      oldMode: l ? l.mode : null,
      oid: r ? r.oid : null,
      mode: r ? r.mode : null
    })
  }
  return out
}

function same(a, b) {
  if (!a || !b) return !a && !b
  return b4a.equals(a, b)
}

function noop() {}

module.exports = { open, openLink, link, repoId, publish, importFrom, diffTrees, BRANCH }
