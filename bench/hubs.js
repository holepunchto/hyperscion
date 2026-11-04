// Hub-home benchmark (M3 of the one-hub-many-repos plan): what hubbing R repos costs from one
// `hs hubs serve` (a home) against one `hs seed` per repo (standalone), with agents' feeds
// connected, over a local DHT testnet.
//
//   bare bench/hubs.js --repos 10 --feeds 10 --per-feed 3 --mode home
//   bare bench/hubs.js --repos 10 --feeds 10 --per-feed 3 --mode standalone
//
// --repos R       repos hubbed
// --feeds F       feed processes (bench/hubs-feed.js); each follows --per-feed K repos, round
//                 robin, each with its own store and Network as a separate `hs watch` would be
// --lands L       lands from owner worktrees, timed to `final` (the CLI's own wait) and to the
//                 feeds that follow that repo
// --idle S        seconds of quiet over which the hubs' CPU is measured
//
// Memory and CPU are the hub processes' only (/proc, so Linux). Prints one JSON result and a
// markdown row. Every feed store preallocates RocksDB's write-ahead log (~72 MB on disk), so
// for 100+ feeds point HS_BENCH_DIR at a disk: on a tmpfs /tmp, 200 feeds fill 12 GB of RAM.
const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')
const process = require('bare-process')
const { spawn } = require('bare-subprocess')
const createTestnet = require('hyperdht/testnet')
const { HubHome } = require('../lib/hubs')
const { tmpdir, rm } = require('./helpers')

const args = parseArgs(Bare.argv.slice(2))
const R = Number(args.repos || 10)
const F = Number(args.feeds || 10)
const K = Math.min(R, Number(args['per-feed'] || 3))
const MODE = args.mode || 'home'
const LANDS = Number(args.lands || 10)
const IDLE = Number(args.idle || 20)
const BIN = path.join(__dirname, '..', 'bin.mjs')
const TICK_HZ = 100 // USER_HZ on Linux

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const children = []

async function main() {
  const testnet = await createTestnet(3)
  const bootstrap = testnet.bootstrap
  const env = {
    ...process.env,
    HS_BOOTSTRAP: bootstrap.map((b) => b.host + ':' + b.port).join(','),
    USER: 'owner'
  }
  const dir = tmpdir('hubs-' + MODE)
  const result = { mode: MODE, repos: R, feeds: F, perFeed: K, cores: os.availableParallelism() }

  // the repos, and who hubs them
  let t0 = Date.now()
  const repos = [] // { name, key, bootstrapWeight, owner }
  const hubs = [] // { pid, proc }
  if (MODE === 'home') {
    const home = new HubHome(path.join(dir, 'home'))
    const root = home.openStore()
    for (let i = 0; i < R; i++) {
      const name = 'r' + i
      const { entry, hub } = await home.createRepo(root, name, { handle: 'owner' })
      await hub.close()
      repos.push({ name, key: entry.key, bootstrapWeight: 2, owner: home.file('owners', name) })
    }
    await root.close()
    result.createMs = Date.now() - t0
    t0 = Date.now()
    const p = start(dir, ['hubs', 'serve', '--home', home.dir], env)
    await p.until(/hubs serving/)
    hubs.push(p)
    result.statusFile = home.file('status.json')
  } else {
    for (let i = 0; i < R; i++) {
      const name = 'r' + i
      const owner = path.join(dir, 'owner-' + name)
      fs.mkdirSync(owner, { recursive: true })
      const init = await run(
        owner,
        ['init', '--as', 'owner', '--hub', path.join(dir, 'hub-' + name)],
        env
      )
      const key = init.stdout.match(/^repo (\S+)/m)[1]
      repos.push({ name, key, bootstrapWeight: 2, owner })
    }
    result.createMs = Date.now() - t0
    t0 = Date.now()
    for (const r of repos) {
      const p = start(path.join(dir, 'hub-' + r.name), ['seed'], env)
      hubs.push(p)
    }
    for (const p of hubs) await p.until(/seeding/)
  }
  result.startMs = Date.now() - t0
  await sleep(5000)
  result.idleRssMB = mb(sum(hubs.map((h) => rssOf(h.pid))))

  // feeds: F processes, K repos each
  const feeds = []
  const followers = new Map(repos.map((r) => [r.name, 0]))
  t0 = Date.now()
  for (let f = 0; f < F; f++) {
    const mine = []
    for (let j = 0; j < K; j++) mine.push(repos[(f * K + j) % R])
    for (const r of mine) followers.set(r.name, followers.get(r.name) + 1)
    const fdir = path.join(dir, 'feed-' + f)
    fs.mkdirSync(fdir, { recursive: true })
    const p = startFeed({ bootstrap, dir: fdir, repos: mine })
    feeds.push(p)
  }
  const pairs = F * K
  await waitFor(
    () =>
      feeds.reduce((n, p) => n + p.events.filter((e) => e.type === 'connected').length, 0) >= pairs,
    120_000
  )
  result.feedsConnectedMs = Date.now() - t0
  await sleep(5000)
  result.feedRssMB = mb(sum(hubs.map((h) => rssOf(h.pid))))
  if (result.statusFile) {
    result.hubConnections = JSON.parse(fs.readFileSync(result.statusFile, 'utf8')).connections
  }

  // idle CPU with feeds connected
  const cpu0 = sum(hubs.map((h) => cpuOf(h.pid)))
  await sleep(IDLE * 1000)
  const cpu1 = sum(hubs.map((h) => cpuOf(h.pid)))
  result.idleCpuPct = +(((cpu1 - cpu0) / TICK_HZ / IDLE) * 100).toFixed(1)

  // lands: owner worktrees of repos that feeds follow, timed to final and to every follower
  const followed = repos.filter((r) => followers.get(r.name) > 0)
  const toFinal = []
  const toFeeds = []
  let notFinal = 0
  for (let i = 0; i < LANDS; i++) {
    const r = followed[i % followed.length]
    fs.writeFileSync(path.join(r.owner, 'f' + i + '.txt'), 'land ' + i + '\n')
    const start = Date.now()
    const res = await run(r.owner, ['land', '-m', 'bench ' + i], env)
    const m = res.stdout.match(/landed #(\d+)/)
    if (!/#\d+ final/.test(res.stdout) || !m) {
      notFinal++
      continue
    }
    toFinal.push(Date.now() - start)
    const seq = Number(m[1])
    const seen = () =>
      feeds.flatMap((p) =>
        p.events.filter((e) => e.type === 'seq' && e.repo === r.name && e.seq >= seq)
      )
    await waitFor(() => seen().length >= followers.get(r.name), 30_000).catch(() => {})
    for (const e of seen()) toFeeds.push(e.at - start)
  }
  result.lands = LANDS
  result.notFinal = notFinal
  result.landFinalMs = stats(toFinal)
  result.landToFeedMs = stats(toFeeds)

  for (const p of feeds) p.stop()
  for (const h of hubs) h.stop()
  await sleep(2000)
  await testnet.destroy()
  rm(dir)
  delete result.statusFile

  console.log(JSON.stringify(result))
  const conns = result.hubConnections === undefined ? '-' : result.hubConnections
  console.log(
    `| ${MODE} | ${R} | ${F}×${K} | ${hubs.length} | ${result.startMs} | ${result.idleRssMB} | ${result.feedRssMB} | ${conns} | ${result.idleCpuPct} | ${result.landFinalMs.p50}/${result.landFinalMs.p90} | ${result.landToFeedMs.p50}/${result.landToFeedMs.p90} | ${notFinal} |`
  )
}

function start(cwd, argv, env) {
  const p = spawn(os.execPath(), [BIN, ...argv], { cwd, env })
  let out = ''
  p.stdout.on('data', (d) => (out += d))
  p.stderr.on('data', (d) => (out += d))
  const h = {
    pid: p.pid,
    until: (re) => waitFor(() => re.test(out), 60_000),
    stop: () => p.kill('SIGTERM')
  }
  children.push(p)
  return h
}

function startFeed(opts) {
  const p = spawn(os.execPath(), [path.join(__dirname, 'hubs-feed.js'), JSON.stringify(opts)])
  const events = []
  let buf = ''
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      try {
        const e = JSON.parse(line)
        if (e.type === 'error') console.error('feed error', e.error)
        events.push(e)
      } catch {}
    }
  })
  children.push(p)
  return { events, stop: () => p.kill('SIGTERM') }
}

function run(cwd, argv, env) {
  return new Promise((resolve) => {
    const p = spawn(os.execPath(), [BIN, ...argv], { cwd, env })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d))
    p.stderr.on('data', (d) => (stderr += d))
    p.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

// resident memory and CPU ticks of a process, from /proc
function rssOf(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
    return Number(status.match(/VmRSS:\s+(\d+) kB/)[1]) * 1024
  } catch {
    return 0
  }
}

function cpuOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return Number(fields[11]) + Number(fields[12]) // utime + stime
  } catch {
    return 0
  }
}

function stats(xs) {
  if (!xs.length) return { n: 0, p50: '-', p90: '-' }
  const s = xs.slice().sort((a, b) => a - b)
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))]
  return { n: s.length, p50: at(0.5), p90: at(0.9) }
}

const sum = (xs) => xs.reduce((n, x) => n + x, 0)
const mb = (bytes) => Math.round(bytes / 1e6)

async function waitFor(fn, timeout) {
  const deadline = Date.now() + timeout
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(100)
  }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const k = argv[i].slice(2)
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true
    out[k] = v
  }
  return out
}

// never leave hubs and feeds behind
Bare.on('exit', () => {
  for (const p of children) {
    try {
      p.kill('SIGKILL')
    } catch {}
  }
})

main().catch((err) => {
  console.error(err)
  Bare.exit(1)
})
