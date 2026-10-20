// What does a peer fetch to work on one directory of a large repo?
// hyperscion: join, settle main, sparse checkout of one prefix (blocks fetched on demand).
// git: clone --filter=blob:none --sparse, then sparse-checkout the same directory.
//
//   bare bench/sparse.js [files] [filesPerDir] [bytesPerFile]   default: 20000 100 2048
const b4a = require('b4a')
const process = require('bare-process')
const fs = require('bare-fs')
const path = require('bare-path')
const crypto = require('hypercore-crypto')
const Worktree = require('../lib/worktree')
const { now, tmpdir, rm, openRepo, git, fmt } = require('./helpers')

const FILES = Number(Bare.argv[2] || 20_000)
const PER_DIR = Number(Bare.argv[3] || 100)
const BYTES = Number(Bare.argv[4] || 2048)
const DIRS = Math.ceil(FILES / PER_DIR)
const TARGET = dirName(Math.floor(DIRS / 2))

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})

function dirName(d) {
  return `src/d${String(d).padStart(5, '0')}`
}

function fileContent(i) {
  // unique, incompressible-ish content so the blob cost is real
  const head = b4a.from(`// file ${i}\n`)
  return b4a.concat([
    head,
    b4a
      .from(b4a.toString(crypto.randomBytes(BYTES / 2), 'hex'))
      .subarray(0, BYTES - head.byteLength)
  ])
}

async function main() {
  const files = []
  for (let i = 0; i < FILES; i++) {
    files.push({
      path: `/${dirName(i % DIRS)}/f${String(i).padStart(7, '0')}.js`,
      content: fileContent(i)
    })
  }
  const totalBytes = files.reduce((n, f) => n + f.content.byteLength, 0)

  const hs = await benchHs(files)
  const g = await benchGit(files)

  const result = {
    files: FILES,
    dirs: DIRS,
    totalMB: +(totalBytes / 1e6).toFixed(1),
    target: TARGET,
    hs,
    git: g
  }
  console.log(JSON.stringify(result))
  console.log(
    '\n| system | full clone bytes | sparse peer received | share | sparse checkout time |'
  )
  console.log('|---|---|---|---|---|')
  console.log(
    `| hyperscion | ${mb(hs.fullBytes)} | ${mb(hs.sparseBytes)} | ${pct(hs.sparseBytes, hs.fullBytes)} | ${fmt(hs.ms)} |`
  )
  console.log(
    `| ↳ total writer oplog (what a peer without fast-forward would replay) | | ${mb(hs.oplogBytes)} | | |`
  )
  console.log(
    `| git (blob:none + sparse) | ${mb(g.fullBytes)} | ${mb(g.sparseBytes)} | ${pct(g.sparseBytes, g.fullBytes)} | ${fmt(g.ms)} |`
  )
}

async function benchHs(files) {
  const da = tmpdir('sparse-a')
  const db = tmpdir('sparse-b')
  const wt = tmpdir('sparse-wt')
  const a = await openRepo(da)
  let b = null

  try {
    // a history of 500-file changesets rather than one giant land
    const ws = await a.repo.workspace('import')
    for (let i = 0; i < files.length; i += 500) {
      await ws.commit(files.slice(i, i + 500))
      const { outcome } = await ws.land({ message: 'import ' + i })
      if (outcome.status !== 'accepted') throw new Error('land ' + outcome.status)
    }

    const ff = process.env.HS_BENCH_FF
      ? { boot: { head: { key: a.repo.main.local.key, length: a.repo.main.local.length } } }
      : undefined
    b = await openRepo(db, { key: a.repo.key, fastForward: ff })
    const s1 = a.repo.store.replicate(true)
    const s2 = b.repo.store.replicate(false)
    let received = 0
    s1.on('data', (data) => {
      received += data.byteLength
    })
    s1.pipe(s2).pipe(s1)
    // everything a full clone would have to receive: the writer oplog, A's view and the content
    const fullWire = await fullCloneBytes(a.repo)
    const oplogBytes = a.repo.main.local.byteLength

    const t = now()
    const target = (await a.repo.meta()).seq
    for (let i = 0; i < 500 && (await b.repo.meta()).seq < target; i++) {
      await b.repo.update()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const bws = await b.repo.workspace('w')
    const tree = new Worktree(wt, { sparse: ['/' + TARGET] })
    const stats = await tree.checkout(bws, { wait: true, timeout: 30_000 })
    const ms = now() - t

    if (process.env.HS_BENCH_VERBOSE) {
      console.error('main stats', JSON.stringify(b.repo.main.stats))
      const imp = a.repo.workspaces.get('import')
      const cores = {
        oplog: a.repo.main.local.key,
        view: a.repo.main.view.core.key,
        wsTree: imp.tree.key,
        wsBlobs: imp.blobs.core.key
      }
      for (const [name, key] of Object.entries(cores)) {
        const core = b.repo.store.get({ key })
        await core.ready()
        let held = 0
        let bytes = 0
        for (let i = 0; i < core.length; i++) {
          if (await core.has(i)) {
            held++
            bytes += (await core.get(i)).byteLength
          }
        }
        console.error(`  ${name}: ${held}/${core.length} blocks, ${(bytes / 1e3).toFixed(0)} KB`)
        await core.close()
      }
    }

    if (stats.written !== files.length / (files.length / PER_DIR)) {
      throw new Error(
        `expected ${PER_DIR} files, wrote ${stats.written} (missing ${stats.missing.length})`
      )
    }

    await b.close()
    b = null
    await a.close()

    return { fullBytes: fullWire, sparseBytes: received, oplogBytes, ms, files: stats.written }
  } finally {
    if (b) await b.close()
    rm(da)
    rm(db)
    rm(wt)
  }
}

async function benchGit(files) {
  const src = tmpdir('sparse-git-src')
  const dst = tmpdir('sparse-git-dst')
  rm(dst)

  try {
    await git(src, ['init', '-q', '-b', 'main'])
    await git(src, ['config', 'uploadpack.allowFilter', 'true'])
    for (const f of files) {
      const p = path.join(src, f.path)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, f.content)
    }
    await git(src, ['add', '-A'])
    await git(src, ['commit', '-q', '-m', 'import'])
    await git(src, ['gc', '-q'])

    const t = now()
    await git(path.dirname(dst), [
      'clone',
      '-q',
      '--filter=blob:none',
      '--sparse',
      'file://' + src,
      dst
    ])
    await git(dst, ['sparse-checkout', 'set', TARGET])
    const ms = now() - t

    const written = fs.readdirSync(path.join(dst, TARGET)).length
    if (written !== PER_DIR) throw new Error('git wrote ' + written)

    return { fullBytes: await packBytes(src), sparseBytes: await packBytes(dst), ms }
  } finally {
    rm(src)
    rm(dst)
  }
}

// sum of byteLength of every core a full clone needs
async function fullCloneBytes(repo) {
  let total = 0
  const keys = new Set()
  for await (const core of allCores(repo)) {
    const id = b4a.toString(core.key, 'hex')
    if (keys.has(id)) continue
    keys.add(id)
    total += core.byteLength
  }
  return total
}

async function* allCores(repo) {
  yield repo.main.local
  yield repo.main.view.core
  for (const ws of repo.workspaces.values()) {
    yield ws.tree
    yield ws.blobs.core
  }
}

async function packBytes(dir) {
  const out = b4a.toString(await git(dir, ['count-objects', '-v']))
  const get = (k) => Number((out.match(new RegExp('^' + k + ': (\\d+)', 'm')) || [0, 0])[1])
  return (get('size') + get('size-pack')) * 1024
}

function mb(n) {
  return (n / 1e6).toFixed(1) + ' MB'
}

function pct(a, b) {
  return ((a / b) * 100).toFixed(1) + '%'
}
