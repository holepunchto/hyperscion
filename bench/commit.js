// Commit / fork / diff cost as the tree grows, vs git at the same size.
//
//   bare bench/commit.js [sizes...]        default: 10000 100000 1000000
//   HS_BENCH_GIT_MAX=100000                 largest size to also run git on
//
// hyperscion runs in API mode (no checkout), which is how agents use it. git needs a
// working tree, so its numbers include index work proportional to the tree size.
const b4a = require('b4a')
const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const keys = require('../lib/keys')
const { now, tmpdir, rm, openRepo, seedTree, pathFor, git, median, fmt } = require('./helpers')

const sizes = Bare.argv.slice(2).map(Number).filter(Boolean)
if (!sizes.length) sizes.push(10_000, 100_000, 1_000_000)
const GIT_MAX = Number(process.env.HS_BENCH_GIT_MAX || 100_000)
const ITER = 10

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})

async function main() {
  const rows = []
  for (const n of sizes) {
    const hs = await benchHs(n)
    const g = n <= GIT_MAX ? await benchGit(n) : null
    rows.push({ n, hs, git: g })
    console.log(JSON.stringify({ n, hs, git: g }))
  }

  console.log(
    '\n| paths | fork | commit 1 (random) | commit 100 (random) | commit 100 (one dir) | diff 100 | land 100 | blocks / commit | read cold | read warm | git commit 1 | git worktree add |'
  )
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const { n, hs, git: g } of rows) {
    console.log(
      `| ${n.toLocaleString()} | ${fmt(hs.forkMs)} | ${fmt(hs.commit1Ms)} | ${fmt(hs.commit100Ms)} | ${fmt(hs.commit100LocalMs)} | ${fmt(hs.diffMs)} | ${fmt(hs.landMs)} | ${hs.blocksPerCommit} | ${fmt(hs.readColdMs)} | ${fmt(hs.readWarmMs)} | ${g ? fmt(g.commit1Ms) : 'n/a'} | ${g ? fmt(g.worktreeMs) : 'n/a'} |`
    )
  }
}

async function benchHs(n) {
  const dir = tmpdir('hs-commit-' + n)
  let { repo, close } = await openRepo(dir)
  const dirs = Math.ceil(n / 100)

  try {
    let t = now()
    await seedTree(repo, n, { dirs })
    const seedMs = now() - t

    // reopen so every measurement below starts from cold caches
    await close()
    ;({ repo, close } = await openRepo(dir))

    const sample = []
    for (let i = 0; i < 50; i++) {
      sample.push(keys.files.encode(pathFor(Math.floor(Math.random() * n), dirs)))
    }
    const cold = []
    const warm = []
    for (const k of sample) {
      t = now()
      await repo.main.view.get(k)
      cold.push(now() - t)
    }
    for (const k of sample) {
      t = now()
      await repo.main.view.get(k)
      warm.push(now() - t)
    }

    const forks = []
    for (let i = 0; i < 5; i++) {
      t = now()
      await repo.workspace('fork-' + i)
      forks.push(now() - t)
    }

    const ws = await repo.workspace('w')
    const commit1 = []
    const blocks = []
    for (let i = 0; i < ITER; i++) {
      const p = pathFor(Math.floor(Math.random() * n), dirs)
      const before = ws.tree.length
      t = now()
      await ws.commit([{ path: p, content: b4a.from('edit ' + i + ' ' + Math.random()) }])
      commit1.push(now() - t)
      blocks.push(ws.tree.length - before)
    }

    const commit100 = []
    for (let i = 0; i < ITER; i++) {
      const changes = []
      for (let j = 0; j < 100; j++) {
        changes.push({
          path: pathFor(Math.floor(Math.random() * n), dirs),
          content: b4a.from('e' + i + j + Math.random())
        })
      }
      t = now()
      await ws.commit(changes)
      commit100.push(now() - t)
    }

    // agents edit related files: 100 changes within one directory's neighbourhood
    const local = []
    for (let i = 0; i < ITER; i++) {
      const d = Math.floor(Math.random() * dirs)
      const changes = []
      for (let j = 0; j < 100; j++) {
        const f = d + dirs * (j % Math.max(1, Math.floor(n / dirs)))
        changes.push({ path: pathFor(f % n, dirs), content: b4a.from('l' + i + j + Math.random()) })
      }
      t = now()
      await ws.commit(changes)
      local.push(now() - t)
    }

    // a fresh workspace with exactly 100 changes, for diff and land
    const w2 = await repo.workspace('w2')
    const changes = []
    for (let j = 0; j < 100; j++) {
      changes.push({ path: pathFor(j * Math.floor(n / 100), dirs), content: b4a.from('x' + j) })
    }
    await w2.commit(changes)

    t = now()
    const diff = await w2.changes()
    const diffMs = now() - t
    if (diff.length !== 100) throw new Error('diff size ' + diff.length)

    t = now()
    const { outcome } = await w2.land()
    const landMs = now() - t
    if (outcome.status !== 'accepted') throw new Error('land ' + outcome.status)

    return {
      seedMs,
      forkMs: median(forks),
      commit1Ms: median(commit1),
      commit100Ms: median(commit100),
      commit100LocalMs: median(local),
      readColdMs: median(cold),
      readWarmMs: median(warm),
      diffMs,
      landMs,
      blocksPerCommit: median(blocks)
    }
  } finally {
    await close()
    rm(dir)
  }
}

async function benchGit(n) {
  const dir = tmpdir('git-commit-' + n)
  const dirs = Math.ceil(n / 100)

  try {
    await git(dir, ['init', '-q', '-b', 'main'])
    for (let i = 0; i < n; i++) {
      const p = path.join(dir, pathFor(i, dirs))
      if (i < dirs) fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, 'x')
    }
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-q', '-m', 'seed'])

    const commit1 = []
    for (let i = 0; i < ITER; i++) {
      const rel = pathFor(Math.floor(Math.random() * n), dirs).slice(1)
      fs.writeFileSync(path.join(dir, rel), 'edit ' + i + ' ' + Math.random())
      const t = now()
      await git(dir, ['add', rel])
      await git(dir, ['commit', '-q', '-m', 'e' + i])
      commit1.push(now() - t)
    }

    // closest git analog of an isolated writable fork
    const wt = dir + '-wt'
    const t = now()
    await git(dir, ['worktree', 'add', '-q', wt, '-b', 'fork'])
    const worktreeMs = now() - t
    rm(wt)

    return { commit1Ms: median(commit1), worktreeMs }
  } finally {
    rm(dir)
  }
}
