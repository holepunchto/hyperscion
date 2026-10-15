// Swarm benchmark (milestone 7): N writers landing continuously against a hub, over a local
// DHT testnet, spread over P worker processes (bench/swarm-worker.js).
//
//   bare bench/swarm.js --writers 50 --procs 8 --mode per-writer --duration 120 --think 30
//   bare bench/swarm.js --writers 50 --procs 8 --mode shared ...
//
// --mode per-writer: every writer has its own store and swarm (today's one-hs-per-agent)
// --mode shared:     one store and swarm per process, writers as namespaces (daemon model)
// --think s          mean seconds between a writer's lands (exponential); 200 writers at 30 s is
//                    ~6.7 lands/s, about 20x Scion's 30k changes/day average
// --hot n --hot-p p  n shared 400-line files; each land edits one of them with probability p
// --mirror           writers also mirror everything (feeds-as-holders, the cost of it)
// --shared-dht       per-writer mode, but writers in a process share one DHT node (their
//                    swarms, identities and connections stay separate): many writers per box
// --mesh star|full   star (default): agents dial the hub only (feeds' shape since M7); full:
//                    every agent announces and dials everyone (the shape before)
// --max-peers n      with --shared-dht: cap each writer's connections (default hyperswarm's 64)
//
// Prints one JSON result and a markdown row. Latencies are upper bounds: every process
// shares one machine (see `cores` in the result).
const b4a = require('b4a')
const os = require('bare-os')
const path = require('bare-path')
const { spawn } = require('bare-subprocess')
const createTestnet = require('hyperdht/testnet')
const Network = require('../lib/net')
const { tmpdir, rm, openRepo, seedTree, pathFor } = require('./helpers')

const args = parseArgs(Bare.argv.slice(2))
const N = Number(args.writers || 10)
const P = Math.min(N, Number(args.procs || 2))
const MODE = args.mode || 'per-writer'
const DURATION = Number(args.duration || 60)
const THINK = Number(args.think || 30)
const HOT = Number(args.hot || 20)
const HOT_P = Number(args['hot-p'] ?? 0.5)
const TREE = Number(args.tree || 2000)
const MIRROR = !!args.mirror
const SHARED_DHT = !!args['shared-dht']
const MAX_PEERS = args['max-peers'] ? Number(args['max-peers']) : null
const MESH = args.mesh || 'star'
const LINES = 400

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})

async function main() {
  const started = Date.now()
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap
  const hubDir = tmpdir('swarm-hub')
  const hub = await openRepo(hubDir)
  const dirs = [hubDir]
  const workers = []
  let net = null

  try {
    // the repo: a tree of TREE paths plus HOT shared 400-line files
    await seedTree(hub.repo, TREE)
    const hot = []
    for (let i = 0; i < HOT; i++) hot.push('/hot' + pathFor(i, 20))
    const lines = []
    for (let l = 0; l < LINES; l++) lines.push('line ' + l)
    const setup = await hub.repo.workspace('hot-setup')
    await setup.commit(hot.map((p) => ({ path: p, content: b4a.from(lines.join('\n') + '\n') })))
    await setup.land()

    // the hub is `hs seed`: mirrors everything, acks (settles), stays online
    net = new Network(hub.repo, {
      bootstrap,
      mirror: true,
      server: true,
      ack: true,
      keepAlive: true
    })
    await net.ready()

    // workers
    const per = []
    for (let i = 0; i < P; i++) per.push(Math.floor(N / P) + (i < N % P ? 1 : 0))
    const events = []
    const finals = []
    const ready = new Set()
    for (let i = 0; i < P; i++) {
      const dir = tmpdir('swarm-w' + i)
      dirs.push(dir)
      const w = startWorker(
        {
          id: 'p' + i,
          count: per[i],
          mode: MODE,
          dir,
          key: b4a.toString(hub.repo.key, 'hex'),
          bootstrap,
          hot,
          hotP: HOT_P,
          think: THINK,
          duration: DURATION,
          mirror: MIRROR,
          sharedDht: SHARED_DHT,
          maxPeers: MAX_PEERS,
          mesh: MESH
        },
        async (ev) => {
          if (ev.type === 'keys') {
            for (const k of ev.keys) await hub.repo.addWriter(b4a.from(k, 'hex'))
          } else if (ev.type === 'ready') ready.add(ev.id)
          else if (ev.type === 'final') finals.push(ev)
          else if (ev.type === 'error') console.error(`worker ${ev.id}: ${ev.error}`)
          else if (ev.type === 'stuck') {
            console.error(`worker ${ev.id}: stuck writers ${JSON.stringify(ev.stuck)}`)
            events.push(ev)
          } else events.push(ev)
        }
      )
      workers.push(w)
    }

    const setupStart = Date.now()
    await waitUntil(() => ready.size === P, 300_000, 'workers ready')
    const setupMs = Date.now() - setupStart
    log(`setup: ${N} writers in ${P} processes ready in ${(setupMs / 1000).toFixed(1)}s`)

    for (const w of workers) w.send('go')
    const loadStart = Date.now()
    // hub-side view of progress during the load
    const hubSamples = []
    const sampler = setInterval(async () => {
      const m = await hub.repo.meta().catch(() => null)
      if (!m) return
      hubSamples.push({
        t: Date.now() - loadStart,
        head: m.seq,
        settled: m.settled || 0,
        mirrored: net.mirrored
      })
    }, 2000)
    await waitUntil(() => finals.length === P, (DURATION + 120) * 1000, 'workers final')
    clearInterval(sampler)

    const hubMeta = await hub.repo.meta()
    const result = summarize({ events, finals, hubMeta, hubSamples, setupMs })
    console.log(JSON.stringify(result))
    console.log(
      `| ${MODE} | ${N} | ${P} | ${THINK}s | ${result.lands.accepted}/${result.lands.total} | ${result.lands.perSec} | ${result.latencyMs.p50}/${result.latencyMs.p90}/${result.latencyMs.p99} | ${result.heldMs.p50}/${result.heldMs.p90} | ${result.settleLagMs.p50}/${result.settleLagMs.p90} | ${result.attemptsMean} | ${result.flips} | ${result.unavailable} | ${result.rssPerWriterMB} | ${result.converged} |`
    )
    log(`total ${((Date.now() - started) / 1000).toFixed(0)}s`)
  } finally {
    await Promise.all(workers.map((w) => w.stop().catch(() => {})))
    if (net) await net.close()
    await hub.close()
    await testnet.destroy()
    for (const d of dirs) rm(d)
  }
}

function summarize({ events, finals, hubMeta, hubSamples, setupMs }) {
  const lands = events.filter((e) => e.type === 'land')
  const accepted = lands.filter((e) => e.status === 'accepted')
  const settled = events.filter((e) => e.type === 'settled')
  const heads = finals.flatMap((f) => f.metas)
  const atHead = heads.filter(
    (m) => m.seq === hubMeta.seq && m.hash === b4a.toString(hubMeta.hash, 'hex')
  ).length
  const rss = finals.reduce((n, f) => n + f.rss, 0)
  const cpuUs = finals.reduce((n, f) => n + f.cpu.user + f.cpu.system, 0)
  const statuses = {}
  for (const l of lands) statuses[l.status] = (statuses[l.status] || 0) + 1
  const lastSample = hubSamples[hubSamples.length - 1] || {}
  return {
    mode: MODE,
    writers: N,
    procs: P,
    cores: os.availableParallelism ? os.availableParallelism() : null,
    durationS: DURATION,
    thinkS: THINK,
    hot: HOT,
    hotP: HOT_P,
    mirror: MIRROR,
    sharedDht: SHARED_DHT,
    maxPeers: MAX_PEERS,
    mesh: MESH,
    setupS: +(setupMs / 1000).toFixed(1),
    lands: {
      total: lands.length,
      accepted: accepted.length,
      statuses,
      perSec: +(accepted.length / DURATION).toFixed(2)
    },
    latencyMs: pcts(accepted.map((l) => l.ms)),
    heldMs: pcts(accepted.map((l) => l.heldMs).filter((x) => x !== null && x >= 0)),
    notHeld: accepted.filter((l) => l.heldMs === -1).length,
    settleLagMs: pcts(settled.map((s) => s.lagMs)),
    unsettled: events.filter((e) => e.type === 'unsettled').length,
    attemptsMean: accepted.length
      ? +(accepted.reduce((n, l) => n + l.attempts, 0) / accepted.length).toFixed(2)
      : 0,
    flips: lands.filter((l) => l.flipped).length,
    unavailable: events.filter((e) => e.type === 'unavailable').length,
    stuck: events.filter((e) => e.type === 'stuck').flatMap((e) => e.stuck),
    hub: {
      head: hubMeta.seq,
      settled: hubMeta.settled || 0,
      mirroredAtEnd: lastSample.mirrored || 0
    },
    converged: `${atHead}/${heads.length}`,
    rssPerWriterMB: +(rss / N / 1e6).toFixed(1),
    rssTotalMB: +(rss / 1e6).toFixed(0),
    cpuMsPerLand: accepted.length ? +(cpuUs / 1000 / accepted.length).toFixed(1) : null,
    connections: finals.reduce((n, f) => n + f.connections, 0)
  }
}

function pcts(xs) {
  if (!xs.length) return { p50: null, p90: null, p99: null, n: 0 }
  const s = [...xs].sort((a, b) => a - b)
  const at = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
  return { p50: at(50), p90: at(90), p99: at(99), n: s.length }
}

function startWorker(opts, onevent) {
  const child = spawn(
    os.execPath(),
    [path.join(__dirname, 'swarm-worker.js'), JSON.stringify(opts)],
    {
      stdio: ['pipe', 'pipe', 'inherit']
    }
  )
  let buf = ''
  let queue = Promise.resolve()
  child.stdout.on('data', (d) => {
    buf += b4a.toString(d)
    const parts = buf.split('\n')
    buf = parts.pop()
    for (const line of parts) {
      if (!line.trim()) continue
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      queue = queue.then(() => onevent(ev)).catch((err) => console.error(err))
    }
  })
  let done = false
  const exited = new Promise((resolve) =>
    child.on('exit', () => {
      done = true
      resolve()
    })
  )
  return {
    // a worker that doesn't exit on its own is killed: a hung close must never leak a process
    // (and its store) into the next run
    async stop(graceMs = 20_000) {
      this.send('exit')
      const timer = setTimeout(() => {
        if (!done) child.kill('SIGKILL')
      }, graceMs)
      await exited
      clearTimeout(timer)
    },
    send: (word) => {
      try {
        child.stdin.write(word + '\n')
      } catch {}
    },
    exited
  }
}

async function waitUntil(fn, timeout, what) {
  const deadline = Date.now() + timeout
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

function log(msg) {
  console.error('# ' + msg)
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else out[key] = argv[++i]
  }
  return out
}
