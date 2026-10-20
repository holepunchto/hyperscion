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
const STUCK_GRACE_MS = 60_000

const writers = [] // { name, repo, net, store }
let swarm = null
let root = null
let dht = null

function sharedDht() {
  if (!dht) dht = new HyperDHT({ bootstrap: opts.bootstrap, host: '127.0.0.1', firewalled: false })
  return dht
}

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
    const repo = new Repo(root, { key, bootstrapWeight: opts.bootstrapWeight || 2 })
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
      const repo = new Repo(store, { key, bootstrapWeight: opts.bootstrapWeight || 2 })
      // --shared-dht: writers keep their own swarm (own peer identity and connections, as on
      // separate hosts) but share one DHT node per process, so 100-200 of them fit in memory
      const net = new Network(repo, {
        bootstrap,
        // --mesh star (default): writers are feeds, dialing the hub only; full: every writer
        // announces and dials everyone (the mesh before milestone 7)
        role: opts.mesh === 'full' ? 'holder' : 'feed',
        keepAlive: true,
        mirror: !!opts.mirror,
        swarm: opts.sharedDht
          ? new Hyperswarm({
              dht: sharedDht(),
              ...(opts.maxPeers ? { maxPeers: opts.maxPeers } : {})
            })
          : null
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
  // a writer stuck past the deadline is reported (with the step it's stuck in) and left
  // behind: the run still finishes and reports
  const loops = Promise.all(writers.map((w, i) => writerLoop(w, i, deadline)))
  const watchdog = sleep(opts.duration * 1000 + STUCK_GRACE_MS).then(() => 'stuck')
  if ((await Promise.race([loops, watchdog])) === 'stuck') {
    const stuck = writers
      .filter((w) => !w.done)
      .map((w) => ({ w: w.name, step: w.step, for: now() - w.stepAt }))
    emit({ type: 'stuck', id: opts.id, stuck })
  }
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
    // (with a shared DHT the first close destroys it for everyone: ignore the rest)
    if (w.net) await w.net.close().catch(() => {})
    await repo.close().catch(() => {})
    if (w.store) await w.store.close().catch(() => {})
  }
  if (swarm) await swarm.destroy()
  if (root) await root.close()
}

const pendingSettle = [] // { w, seq, at }

async function writerLoop(w, i, deadline) {
  const step = (name) => {
    w.step = name
    w.stepAt = now()
  }
  step('workspace')
  const ws = await w.repo.workspace('ws-' + w.name)
  ws.io = { timeout: 15_000 }
  let n = 0
  while (now() < deadline) {
    // think time: exponential around the mean, so lands don't arrive in lockstep
    step('think')
    // (capped at the time left: an exponential tail must not sleep past the end of the run)
    await sleep(
      Math.min(-Math.log(1 - Math.random()) * opts.think * 1000, Math.max(0, deadline - now()))
    )
    if (now() >= deadline) break
    n++
    const changes = [{ path: `/swarm/${w.name}/${n}.txt`, content: b4a.from(`land ${n}\n`) }]
    try {
      if (Math.random() < opts.hotP) {
        const hot = opts.hot[Math.floor(Math.random() * opts.hot.length)]
        step('read hot')
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
      step('commit')
      await ws.commit(changes)
      step('land')
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
      step('held')
      held = await heldBySomeone(w, ws)
      pendingSettle.push({ w, seq: res.outcome.seq, at: now() })
    }
    let flipped = false
    try {
      step('flipped')
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
    if (status !== 'accepted') {
      step('sync')
      await ws.sync().catch(() => {})
    }
  }
  w.done = true
  step('done')
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
