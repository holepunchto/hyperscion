// A scripted swarm landing into a team's repo while LLM agents work (milestone 7 check).
// Reuses the swarm benchmark's worker: N writers in P processes, each landing its own files
// under /swarm/ every ~think seconds, admitted through the hub's --admit directory.
//
//   node scripts/experiment/swarm-load.js <teamdir> [--writers 20] [--procs 4] [--think 30]
//                                         [--minutes 12]
//
// Writes <teamdir>/swarm.jsonl (one line per land) and prints a summary at the end. Start it
// when the agents start (after started.txt); it stops on its own after --minutes.
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const argv = process.argv.slice(2)
const dir = path.resolve(argv[0] || '')
const opt = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? Number(argv[i + 1]) : def
}
const WRITERS = opt('writers', 20)
const PROCS = Math.min(WRITERS, opt('procs', 4))
const THINK = opt('think', 30)
const MINUTES = opt('minutes', 12)

const ROOT = path.resolve(__dirname, '../..')
const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'))
if (!run.bootstrap) throw new Error('swarm-load needs a local-testnet run (run.json bootstrap)')
const config = JSON.parse(fs.readFileSync(path.join(dir, 'hub', '.hs', 'config.json'), 'utf8'))
const bootstrap = run.bootstrap.split(',').map((hp) => {
  const [host, port] = hp.split(':')
  return { host, port: Number(port) }
})
const bare = require(path.join(ROOT, 'node_modules', 'bare-runtime'))()
const key = Buffer.from(require(path.join(ROOT, 'node_modules', 'z32')).decode(config.key))
const out = fs.createWriteStream(path.join(dir, 'swarm.jsonl'), { flags: 'a' })
const storeDir = path.join(dir, 'swarm-stores')

const workers = []
const ready = new Set()
const finals = []
const lands = []

for (let i = 0; i < PROCS; i++) {
  const count = Math.floor(WRITERS / PROCS) + (i < WRITERS % PROCS ? 1 : 0)
  const opts = {
    id: 'sw' + i,
    count,
    mode: 'per-writer',
    dir: path.join(storeDir, 'p' + i),
    key: key.toString('hex'),
    bootstrap,
    bootstrapWeight: config.bootstrapWeight === 1 ? 1 : 2,
    hot: [],
    hotP: 0,
    think: THINK,
    duration: MINUTES * 60,
    mesh: 'star'
  }
  const child = spawn(bare, [path.join(ROOT, 'bench', 'swarm-worker.js'), JSON.stringify(opts)], {
    stdio: ['pipe', 'pipe', 'inherit']
  })
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString()
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
      onevent(ev)
    }
  })
  workers.push({ child, exited: new Promise((resolve) => child.on('exit', resolve)) })
}

function onevent(ev) {
  if (ev.type === 'keys') {
    // the hub's seed --admit picks these up (handles sw0-0, sw0-1, ...)
    ev.keys.forEach((k, j) => {
      const file = path.join(dir, 'admit', `${ev.id}-${j}.key`)
      fs.writeFileSync(
        file,
        require(path.join(ROOT, 'node_modules', 'z32')).encode(Buffer.from(k, 'hex')) + '\n'
      )
    })
  } else if (ev.type === 'ready') {
    ready.add(ev.id)
    if (ready.size === PROCS) {
      console.log(`swarm: ${WRITERS} writers admitted and landing for ${MINUTES} min`)
      for (const w of workers) w.child.stdin.write('go\n')
    }
  } else if (ev.type === 'final') {
    finals.push(ev)
    if (finals.length === PROCS) finish()
  } else if (ev.type === 'error') {
    console.error('swarm worker error: ' + ev.error)
  } else {
    if (ev.type === 'land') lands.push(ev)
    out.write(JSON.stringify(ev) + '\n')
  }
}

async function finish() {
  const ok = lands.filter((l) => l.status === 'accepted')
  const ms = ok.map((l) => l.ms).sort((a, b) => a - b)
  const at = (p) =>
    ms.length ? ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))] : null
  const summary = {
    type: 'summary',
    writers: WRITERS,
    procs: PROCS,
    think: THINK,
    lands: lands.length,
    accepted: ok.length,
    landMsP50: at(50),
    landMsP90: at(90),
    rssMB: Math.round(finals.reduce((n, f) => n + f.rss, 0) / 1e6)
  }
  out.write(JSON.stringify(summary) + '\n')
  console.log(JSON.stringify(summary))
  for (const w of workers) w.child.stdin.write('exit\n')
  await Promise.all(workers.map((w) => w.exited))
  fs.rmSync(storeDir, { recursive: true, force: true })
  process.exit(0)
}
