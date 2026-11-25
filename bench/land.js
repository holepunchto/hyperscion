// Concurrent landing without a merge queue: W writers (peers), K workspaces spread over them,
// all landing at once against a shared hot set of paths. Losers sync (3-way merge or replay)
// and re-land until every workspace is in. Writers replicate in a star over in-memory streams.
//
//   bare bench/land.js [writers] [workspaces] [hotPaths] [rebase]   default: 4 200 50 0
const b4a = require('b4a')
const process = require('bare-process')
const { now, tmpdir, rm, openRepo, seedTree, pathFor } = require('./helpers')

const W = Number(Bare.argv[2] || 4)
const K = Number(Bare.argv[3] || 200)
const HOT = Number(Bare.argv[4] || 50)
// local rebase-and-retry attempts per land (0 = report raw conflicts, losers wait for next round)
const REBASE = Number(Bare.argv[5] || 0)
const TREE = 10_000
const LINES = 400
const DIRS = 100

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})

async function main() {
  const peers = []
  const dirs = []
  for (let i = 0; i < W; i++) {
    const dir = tmpdir('land-' + i)
    dirs.push(dir)
    peers.push(await openRepo(dir, i === 0 ? {} : { key: peers[0].repo.key }))
  }
  const repos = peers.map((p) => p.repo)

  // replication topology: full mesh (default) or star around writer 0 (HS_BENCH_STAR=1)
  for (let i = 0; i < W; i++) {
    for (let j = i + 1; j < W; j++) {
      if (process.env.HS_BENCH_STAR && i !== 0) continue
      const s1 = repos[i].store.replicate(true)
      const s2 = repos[j].store.replicate(false)
      s1.pipe(s2).pipe(s1)
    }
  }

  try {
    const t0 = now()
    await seedTree(repos[0], TREE, { dirs: DIRS })
    for (let i = 1; i < W; i++) await repos[0].addWriter(repos[i].writerKey, { indexer: i < 3 })
    await converge(repos)

    // each workspace edits 2 hot (contended) text files and 1 file of its own
    const hot = []
    for (let i = 0; i < HOT; i++) hot.push(pathFor(i, DIRS))

    // hot files are 400-line source files; agents edit different lines, so most overlapping
    // edits are mergeable and only true same-region edits conflict
    const setup = await repos[0].workspace('hot-setup')
    const lines = []
    for (let l = 0; l < LINES; l++) lines.push('line ' + l)
    await setup.commit(hot.map((p) => ({ path: p, content: b4a.from(lines.join('\n') + '\n') })))
    await setup.land()
    await converge(repos)

    const wss = []
    for (let k = 0; k < K; k++) {
      const repo = repos[k % W]
      const ws = await repo.workspace('ws-' + k)
      const a = hot[Math.floor(Math.random() * HOT)]
      let b = hot[Math.floor(Math.random() * HOT)]
      if (b === a) b = hot[(hot.indexOf(a) + 1) % HOT]
      await ws.commit([
        { path: a, content: await edit(ws, a, k) },
        { path: b, content: await edit(ws, b, k) },
        { path: `/agents/${k}.txt`, content: b4a.from('work of agent ' + k + '\n') }
      ])
      wss.push(ws)
    }

    if (process.env.HS_BENCH_VERBOSE) console.error(`setup ${((now() - t0) / 1000).toFixed(1)}s`)
    const started = now()
    let pending = wss
    let rounds = 0
    let attempts = 0
    const firstRound = { accepted: 0, conflict: 0, 'stale-base': 0 }

    while (pending.length) {
      rounds++
      // every pending workspace lands at once: per writer in order, writers in parallel
      await Promise.all(
        repos.map(async (repo) => {
          for (const ws of pending) {
            if (ws.repo !== repo) continue
            if (process.env.HS_BENCH_VERBOSE > 1) console.error('land start', ws.name)
            const res = await ws.land({ message: ws.name, rebase: REBASE })
            if (process.env.HS_BENCH_VERBOSE > 1) {
              console.error('land done', ws.name, res.outcome.status, res.attempts)
            }
            attempts += res.attempts || 1
          }
        })
      )
      await converge(repos)

      const next = []
      for (const ws of pending) {
        const last = await ws.lastLand()
        const status = last ? last.status : (await ws.changes()).length ? 'conflict' : 'accepted'
        if (rounds === 1) firstRound[status] = (firstRound[status] || 0) + 1
        if (status !== 'accepted' || (await ws.changes()).length) next.push(ws)
      }
      for (const ws of next) await ws.sync()
      if (process.env.HS_BENCH_VERBOSE) {
        console.error(
          `round ${rounds}: ${pending.length - next.length} landed, ${next.length} pending, ${((now() - started) / 1000).toFixed(1)}s`
        )
      }
      pending = next
      if (rounds > 50) throw new Error('did not converge')
    }

    const elapsed = now() - started
    const metas = await Promise.all(repos.map((r) => r.meta()))
    const same = metas.every((m) => m.seq === metas[0].seq && b4a.equals(m.hash, metas[0].hash))

    // every agent's own file made it to main
    const drive = repos[W - 1].drive()
    let present = 0
    for (let k = 0; k < K; k++) if (await drive.entry(`/agents/${k}.txt`)) present++
    await drive.close()

    const result = {
      writers: W,
      workspaces: K,
      hotPaths: HOT,
      rebase: REBASE,
      firstRound,
      rounds,
      landAttempts: attempts,
      changesets: metas[0].seq,
      seconds: +(elapsed / 1000).toFixed(2),
      acceptedPerSec: +((K / elapsed) * 1000).toFixed(1),
      converged: same,
      agentsLanded: present
    }
    console.log(JSON.stringify(result))
    console.log(
      `| ${W} | ${K} | ${HOT} | ${REBASE} | ${firstRound.accepted}/${firstRound.conflict}/${firstRound['stale-base'] || 0} | ${rounds} | ${attempts} | ${result.seconds}s | ${result.acceptedPerSec} | ${same && present === K ? 'yes' : 'NO'} |`
    )
  } finally {
    for (const p of peers) await p.close()
    for (const d of dirs) rm(d)
  }
}

// rewrite one line (spread out by agent number) of a hot file
async function edit(ws, path, k) {
  const lines = b4a.toString(await ws.drive.get(path)).split('\n')
  const at = (k * 37) % LINES
  lines[at] = `line ${at} edited by agent ${k}`
  return b4a.from(lines.join('\n'))
}

async function converge(repos) {
  let last = ''
  let stable = 0
  for (let i = 0; i < 400; i++) {
    for (const r of repos) await r.update()
    const metas = await Promise.all(repos.map((r) => r.meta()))
    const id = metas.map((m) => m.seq + ':' + b4a.toString(m.hash, 'hex')).join(',')
    const allSame = metas.every((m) => m.seq === metas[0].seq)
    if (id === last && allSame) {
      if (++stable >= 3) return
    } else {
      stable = 0
    }
    last = id
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
