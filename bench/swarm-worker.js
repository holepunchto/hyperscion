// One process of the swarm benchmark (bench/swarm.js): hosts several writers and lands
// continuously, reporting one JSON line per event on stdout.
//
// Modes:
//   per-writer  each writer is its own Corestore + Network (announcing, rejoining), which is
//               what every agent runs today (one `hs` process tree per agent)
//   shared      one Corestore and one Hyperswarm for the whole process; writers are
//               namespaces of it (the per-machine daemon model)
const b4a = require('b4a')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const HyperDHT = require('hyperdht')
const Repo = require('../lib/repo')
const Network = require('../lib/net')

const opts = JSON.parse(process.argv[2] || Bare.argv[2])
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const now = () => Date.now()
const LAND_TIMEOUT_MS = 120_000
const dbg = (m) => process.env.HS_BENCH_DEBUG && process.stderr.write(opts.id + ': ' + m + '\n')

const writers = [] // { name, repo, net, store }
let swarm = null
let root = null

main().catch((err) => {
  emit({ type: 'error', id: opts.id, error: String((err && err.stack) || err) })
  Bare.exitCode = 1
})

async function main() {
  const key = b4a.from(opts.key, 'hex')
  const bootstrap = opts.bootstrap

  if (opts.mode === 'shared') {
    // one autobee per repo per store: its view cores are keyed by the repo, so two writers of
    // the same repo can't share a store. The daemon model is therefore one writer per machine
    // with every agent's workspace landing through it.
    root = new Corestore(opts.dir)
    const repo = new Repo(root, { key })
    await repo.ready()
    for (let i = 0; i < opts.count; i++) writers.push({ name: `${opts.id}.${i}`, repo })
    swarm = new Hyperswarm({
      dht: new HyperDHT({ bootstrap, host: '127.0.0.1', firewalled: false })
    })
    swarm.on('connection', (conn) => root.replicate(conn))
    swarm.join(repo.discoveryKey, { server: true, client: true })
    await swarm.flush()
  } else {
    for (let i = 0; i < opts.count; i++) {
      const store = new Corestore(path.join(opts.dir, 'w' + i))
      const repo = new Repo(store, { key })
      const net = new Network(repo, {
        bootstrap,
        server: true,
        keepAlive: true,
        mirror: !!opts.mirror
      })
      await net.ready()
      writers.push({ name: `${opts.id}.${i}`, repo, net, store })
    }
  }

  emit({
    type: 'keys',
    id: opts.id,
    keys: writers.map((w) => b4a.toString(w.repo.writerKey, 'hex'))
  })

  // wait until the hub has admitted everyone
  for (;;) {
    let all = true
    for (const w of writers) {
      await w.repo.update()
      if (!w.repo.writable) all = false
    }
    if (all) break
    if (process.env.HS_BENCH_DEBUG) {
      const conns = swarm
        ? swarm.connections.size
        : writers.reduce((n, w) => n + w.net.connections, 0)
      process.stderr.write(
        `${opts.id} waiting: ${conns} connections, writable ${writers.filter((w) => w.repo.writable).length}/${writers.length}\n`
      )
    }
    await sleep(250)
  }
  emit({ type: 'ready', id: opts.id })

  await waitForLine('go')
  const deadline = now() + opts.duration * 1000
  const settler = settleLoop(deadline + 30_000)
  await Promise.all(writers.map((w, i) => writerLoop(w, i, deadline)))
  await settler

  // let replication settle, then report where each writer's main is
  await sleep(5000)
  const metas = []
  for (const w of writers) {
    await w.repo.update()
    const m = await w.repo.meta()
    metas.push({ seq: m.seq, hash: b4a.toString(m.hash, 'hex'), settled: m.settled || 0 })
  }
  emit({
    type: 'final',
    id: opts.id,
    metas,
    rss: process.memoryUsage().rss,
    cpu: os.cpuUsage(),
    connections: swarm ? swarm.connections.size : writers.reduce((n, w) => n + w.net.connections, 0)
  })

  await waitForLine('exit')
  // never outlive the orchestrator's grace period on a hung close
  setTimeout(() => Bare.exit(0), 15_000)
  for (const repo of new Set(writers.map((w) => w.repo))) {
    const w = writers.find((x) => x.repo === repo)
    if (w.net) await w.net.close()
    await repo.close()
    if (w.store) await w.store.close()
  }
  if (swarm) await swarm.destroy()
  if (root) await root.close()
}

const pendingSettle = [] // { w, seq, at }

async function writerLoop(w, i, deadline) {
  const ws = await w.repo.workspace('ws-' + w.name)
  ws.io = { timeout: 15_000 }
  let n = 0
  while (now() < deadline) {
    // think time: exponential around the mean, so lands don't arrive in lockstep
    await sleep(-Math.log(1 - Math.random()) * opts.think * 1000)
    if (now() >= deadline) break
    n++
    const changes = [{ path: `/swarm/${w.name}/${n}.txt`, content: b4a.from(`land ${n}\n`) }]
    try {
      if (Math.random() < opts.hotP) {
        const hot = opts.hot[Math.floor(Math.random() * opts.hot.length)]
        const text = b4a.toString(await ws.drive.get(hot, { timeout: 15_000 }))
        const lines = text.split('\n')
        const at = Math.floor(Math.random() * Math.max(1, lines.length - 1))
        lines[at] = `line ${at} edited by ${w.name} #${n}`
        changes.push({ path: hot, content: b4a.from(lines.join('\n')) })
      }
    } catch (err) {
      emit({ type: 'unavailable', w: w.name, error: String(err.code || err.message) })
    }

    const t0 = now()
    let res
    try {
      await ws.commit(changes)
      // a land stuck on a peer that never answers is reported, not waited on forever
      res = await Promise.race([
        ws.land({ message: `${w.name} ${n}`, rebase: 3 }),
        sleep(LAND_TIMEOUT_MS).then(() => {
          throw Object.assign(new Error('land timed out'), { code: 'LAND_TIMEOUT' })
        })
      ])
    } catch (err) {
      emit({
        type: 'land',
        w: w.name,
        t: t0,
        ms: now() - t0,
        status: 'error',
        error: String(err.code || err.message)
      })
      continue
    }
    const ms = now() - t0
    const status = res.outcome.status
    let held = null
    if (status === 'accepted') {
      held = await heldBySomeone(w, ws)
      pendingSettle.push({ w, seq: res.outcome.seq, at: now() })
    }
    let flipped = false
    try {
      flipped = !!(await ws.flipped())
    } catch {}
    emit({
      type: 'land',
      w: w.name,
      t: t0,
      ms,
      heldMs: held,
      status,
      attempts: res.attempts || 1,
      seq: res.outcome.seq || null,
      flipped
    })
    // a land that didn't go in: bring main in and try again next round
    if (status !== 'accepted') await ws.sync().catch(() => {})
  }
}

// the "pushed: a holder has the changes" wait: some peer holds our oplog, tree and blobs
async function heldBySomeone(w, ws) {
  const t0 = now()
  const tree = ws.state.landed ? ws.state.landed.length : ws.tree.length
  const targets = [
    [w.repo.main.local, w.repo.main.local.length],
    [ws.tree, tree],
    [ws.blobs.core, ws.blobs.core.length]
  ].filter(([, length]) => length > 0)
  while (now() - t0 < 30_000) {
    if (
      targets.every(([core, length]) => core.peers.some((p) => p.remoteContiguousLength >= length))
    ) {
      return now() - t0
    }
    await sleep(25)
  }
  return -1
}

async function settleLoop(until) {
  while (now() < until && (pendingSettle.length || now() < until - 30_000)) {
    await sleep(250)
    for (let i = pendingSettle.length - 1; i >= 0; i--) {
      const p = pendingSettle[i]
      const settled = (await p.w.repo.meta()).settled || 0
      if (settled >= p.seq) {
        emit({ type: 'settled', w: p.w.name, seq: p.seq, lagMs: now() - p.at })
        pendingSettle.splice(i, 1)
      }
    }
  }
  for (const p of pendingSettle) emit({ type: 'unsettled', w: p.w.name, seq: p.seq })
}

function waitForLine(word) {
  return new Promise((resolve) => {
    let buf = ''
    const ondata = (d) => {
      buf += b4a.toString(d)
      if (buf.split('\n').includes(word)) {
        process.stdin.off('data', ondata)
        resolve()
      }
    }
    process.stdin.on('data', ondata)
  })
}
