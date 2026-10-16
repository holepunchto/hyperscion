// A scripted q2 (no LLM agents): the q2 team, swarm and outage with fixed lands, for chasing
// outage bugs in about 2 minutes instead of a 15-25 minute LLM run.
//
//   scripts/experiment/setup.sh <teamdir> hs q2
//   node scripts/experiment/outage-replay.js <teamdir> [--like-q2-hs-5] [--outage-wait s]
//
// Event-driven, not on q2's clock: once the swarm is admitted, a1 and a3 land with the hub
// up; the hub goes down (inject.js --do origin-down); after --outage-wait seconds (6) a2
// lands; a3 syncs every 5 s until a2's file arrives (90 s at most); the hub comes back and
// the replay stops. The last line is a summary with a2's land phases (HS_DEBUG_LAND, set by
// the wrappers; feeds log their mirror steps to <teamdir>/debug/ too).
//
// --like-q2-hs-5: a2's first land (hub up) hits a real conflict in CONTRACTS.md with a1's;
// a2 resolves it and lands again with --check during the outage.
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const argv = process.argv.slice(2)
const dir = path.resolve(argv[0] || '')
const LIKE = argv.includes('--like-q2-hs-5')
const wi = argv.indexOf('--outage-wait')
const OUTAGE_WAIT_S = wi >= 0 ? Number(argv[wi + 1]) : 6
const ROOT = path.resolve(__dirname, '../..')

const started = Date.now()
const seconds = () => Math.round((Date.now() - started) / 1000)
const out = fs.createWriteStream(path.join(dir, 'replay.jsonl'), { flags: 'a' })
const log = (o) => {
  const line = JSON.stringify({ s: seconds(), ...o })
  out.write(line + '\n')
  console.log(line)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const agent = (a) => path.join(dir, 'agents', a)
const inject = (action) =>
  new Promise((resolve) => {
    const child = spawn('node', [path.join(ROOT, 'scripts/experiment/inject.js'), dir, ...action])
    child.on('close', resolve)
  })

function hs(a, args) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(path.join(dir, 'bin', 'hs-' + a), args, { cwd: agent(a) })
    let text = ''
    child.stdout.on('data', (d) => (text += d))
    child.stderr.on('data', (d) => (text += d))
    child.on('close', (code) => resolve({ code, ms: Date.now() - t0, text }))
  })
}

const procs = []
function background(cmd, args, opts) {
  const child = spawn(cmd, args, opts)
  procs.push(child)
  return child
}

async function main() {
  fs.writeFileSync(path.join(dir, 'started.txt'), new Date().toISOString() + '\n')
  const swarmLog = path.join(dir, 'swarm-load.log')
  background('node', [path.join(ROOT, 'scripts/experiment/swarm-load.js'), dir, '--minutes', '4'], {
    stdio: ['ignore', fs.openSync(swarmLog, 'a'), 'inherit']
  })
  // the agents' feeds, started early as the prompts ask
  for (const a of ['a1', 'a2', 'a3']) {
    background(path.join(dir, 'bin', 'hs-' + a), ['watch', '--json'], {
      cwd: agent(a),
      stdio: ['ignore', fs.openSync(path.join(agent(a), '.hs', 'feed.jsonl'), 'a'), 'inherit']
    })
  }
  while (!/admitted and landing/.test(read(swarmLog))) await sleep(1000)
  log({ do: 'swarm ready' })

  // early lands with the hub up (a1's also pins a CONTRACTS.md section)
  if (LIKE) await hs('a2', ['sync']) // a2's base, before a1's contract lands
  for (const a of ['a1', 'a3']) {
    fs.writeFileSync(path.join(agent(a), 'src', `${a}.js`), `// ${a}\n`)
    fs.appendFileSync(path.join(agent(a), 'NOTES.md'), `- [${a}] early land\n`)
    if (a === 'a1') fs.appendFileSync(path.join(agent(a), 'CONTRACTS.md'), '\n## geo (a1)\n')
    const r = await hs(a, ['land', '-m', `${a} early`])
    log({ do: 'land', agent: a, ms: r.ms, code: r.code, out: tail(r.text) })
  }
  if (LIKE) {
    // a2's first try, with the hub still up: a real conflict with a1's CONTRACTS.md
    fs.appendFileSync(path.join(agent('a2'), 'CONTRACTS.md'), '\n## scheduler (a2)\n')
    fs.writeFileSync(path.join(agent('a2'), 'src', 'outage.js'), '// landed during the outage\n')
    fs.appendFileSync(path.join(agent('a2'), 'NOTES.md'), '- [a2] outage land\n')
    const first = await hs('a2', ['land', '-m', 'a2 first try', '--check', 'true'])
    log({ do: 'land', agent: 'a2', try: 1, ms: first.ms, code: first.code, out: tail(first.text) })
    const file = path.join(agent('a2'), 'CONTRACTS.md')
    const kept = read(file)
      .split('\n')
      .filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l))
    fs.writeFileSync(file, kept.join('\n')) // resolved: both sections kept
  }

  await inject(['--do', 'origin-down'])
  log({ do: 'hub down' })
  await sleep(OUTAGE_WAIT_S * 1000)

  if (!LIKE) {
    await hs('a2', ['sync'])
    fs.writeFileSync(path.join(agent('a2'), 'src', 'outage.js'), '// landed during the outage\n')
    fs.appendFileSync(path.join(agent('a2'), 'NOTES.md'), '- [a2] outage land\n')
  }
  const landAt = Date.now()
  const r = await hs('a2', ['land', '-m', 'a2 outage land', ...(LIKE ? ['--check', 'true'] : [])])
  log({ do: 'land', agent: 'a2', ms: r.ms, code: r.code, out: tail(r.text) })

  // a3 syncs every 5 s until it has a2's file (90 s at most)
  let arrived = null
  while (Date.now() - landAt < 90_000) {
    const s = await hs('a3', ['sync'])
    const got = fs.existsSync(path.join(agent('a3'), 'src', 'outage.js'))
    log({ do: 'sync', agent: 'a3', ms: s.ms, code: s.code, got, out: tail(s.text, 2) })
    if (got) {
      arrived = Math.round((Date.now() - landAt) / 1000)
      break
    }
    await sleep(5000)
  }

  await inject(['--do', 'origin-up'])
  log({
    do: 'summary',
    landMs: r.ms,
    pushed: /pushed: a holder has the changes/.test(r.text),
    arrivedAfterS: arrived,
    phases: phasesOf(path.join(dir, 'debug', 'land-a2.log'), landAt)
  })
  for (const p of procs) p.kill('SIGINT')
  await sleep(3000)
  await inject(['--stop'])
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

// the phases of the `land` that started at (or just after) t, from an HS_DEBUG_LAND log
function phasesOf(file, t) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
    const start = lines.find(
      (l) => / land \+\d+ms start$/.test(l) && Date.parse(l.split(' ')[0]) >= t - 1000
    )
    if (!start) return []
    const pid = start.split(' ')[1]
    return lines.filter((l) => l.split(' ')[1] === pid).map((l) => l.split(' ').slice(3).join(' '))
  } catch {
    return []
  }
}

function tail(text, n = 4) {
  return text
    .split('\n')
    .filter((l) => l && !/\/swarm\//.test(l))
    .slice(-n)
}

main()
