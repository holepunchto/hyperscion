// A scripted q2 (no LLM agents): the q2 team, swarm and outage, with fixed lands, to see why a
// land made during the outage reaches no feed's mirror in time (q2-hs-4, q2-hs-5).
//
//   scripts/experiment/setup.sh <teamdir> hs q2
//   node scripts/experiment/outage-replay.js <teamdir>
//
// Feeds (a1..a3 `hs watch --json`) log their mirror steps to <teamdir>/mirror-aN.log
// (HS_DEBUG_MIRROR). a2 lands at minute 2.4, with the hub down; a3 then syncs every 15 s and
// the replay reports when a2's file first arrives. Writes <teamdir>/replay.jsonl.
//
// --like-q2-hs-5: a2 lands as in q2-hs-5 instead: its first land (before the outage) hits a
// real conflict in CONTRACTS.md with a1's, a2 resolves it and lands again with --check
// 24 s into the outage
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const dir = path.resolve(process.argv[2] || '')
const LIKE = process.argv.includes('--like-q2-hs-5')
const ROOT = path.resolve(__dirname, '../..')
const started = Date.now()
const minute = () => Number(((Date.now() - started) / 60_000).toFixed(2))
const out = fs.createWriteStream(path.join(dir, 'replay.jsonl'), { flags: 'a' })
const log = (o) => {
  const line = JSON.stringify({ minute: minute(), ...o })
  out.write(line + '\n')
  console.log(line)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = (m) => sleep(Math.max(0, started + m * 60_000 - Date.now()))
const agent = (a) => path.join(dir, 'agents', a)

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
  // the outage schedule and the swarm, as in a q2 run
  background('node', [path.join(ROOT, 'scripts/experiment/inject.js'), dir], {
    stdio: ['ignore', fs.openSync(path.join(dir, 'inject.log'), 'a'), 'inherit']
  })
  background(
    'node',
    [
      path.join(ROOT, 'scripts/experiment/swarm-load.js'),
      dir,
      '--writers',
      '20',
      '--minutes',
      '10'
    ],
    { stdio: ['ignore', fs.openSync(path.join(dir, 'swarm-load.log'), 'a'), 'inherit'] }
  )

  // the agents' feeds, started early as the prompts ask
  for (const a of ['a1', 'a2', 'a3']) {
    background(path.join(dir, 'bin', 'hs-' + a), ['watch', '--json'], {
      cwd: agent(a),
      env: { ...process.env, HS_DEBUG_MIRROR: path.join(dir, `mirror-${a}.log`) },
      stdio: ['ignore', fs.openSync(path.join(agent(a), '.hs', 'feed.jsonl'), 'a'), 'inherit']
    })
  }

  // early lands with the hub up (a1's also pins a CONTRACTS.md section)
  await until(1)
  if (LIKE) await hs('a2', ['sync']) // a2's base, before a1's contract lands
  for (const a of ['a1', 'a3']) {
    fs.writeFileSync(path.join(agent(a), 'src', `${a}.js`), `// ${a}\n`)
    fs.appendFileSync(path.join(agent(a), 'NOTES.md'), `- [${a}] early land\n`)
    if (a === 'a1') fs.appendFileSync(path.join(agent(a), 'CONTRACTS.md'), '\n## geo (a1)\n')
    const r = await hs(a, ['land', '-m', `${a} early`])
    log({ do: 'land', agent: a, ms: r.ms, code: r.code, out: tail(r.text) })
  }

  if (LIKE) {
    // a2's first land, with the hub still up: a real conflict with a1's CONTRACTS.md
    await until(1.4)
    fs.appendFileSync(path.join(agent('a2'), 'CONTRACTS.md'), '\n## scheduler (a2)\n')
    fs.writeFileSync(path.join(agent('a2'), 'src', 'outage.js'), '// landed during the outage\n')
    fs.appendFileSync(path.join(agent('a2'), 'NOTES.md'), '- [a2] outage land\n')
    const first = await hs('a2', ['land', '-m', 'a2 first try', '--check', 'true'])
    log({ do: 'land', agent: 'a2', try: 1, ms: first.ms, code: first.code, out: tail(first.text) })
    // resolve: keep both sections
    const file = path.join(agent('a2'), 'CONTRACTS.md')
    const resolved = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l))
      .join('\n')
    fs.writeFileSync(file, resolved)
  }

  // a2 lands with the hub down (it goes down at minute 2)
  await until(LIKE ? 2.4 : 2.4)
  if (!LIKE) {
    await hs('a2', ['sync'])
    fs.writeFileSync(path.join(agent('a2'), 'src', 'outage.js'), '// landed during the outage\n')
    fs.appendFileSync(path.join(agent('a2'), 'NOTES.md'), '- [a2] outage land\n')
  }
  const landAt = Date.now()
  const r = await hs('a2', ['land', '-m', 'a2 outage land', ...(LIKE ? ['--check', 'true'] : [])])
  log({ do: 'land', agent: 'a2', ms: r.ms, code: r.code, out: tail(r.text) })

  // a3 syncs every 15 s until it has a2's file
  while (minute() < 10) {
    const s = await hs('a3', ['sync'])
    const got = fs.existsSync(path.join(agent('a3'), 'src', 'outage.js'))
    log({ do: 'sync', agent: 'a3', ms: s.ms, code: s.code, got, out: tail(s.text, 2) })
    if (got) {
      log({ do: 'arrived', afterLandS: Math.round((Date.now() - landAt) / 1000) })
      break
    }
    await sleep(15_000)
  }

  await until(10.5)
  for (const p of procs) p.kill('SIGINT')
  await sleep(3000)
  spawn('node', [path.join(ROOT, 'scripts/experiment/inject.js'), dir, '--stop'], {
    stdio: 'inherit'
  })
}

function tail(text, n = 4) {
  return text
    .split('\n')
    .filter((l) => l && !/\/swarm\//.test(l))
    .slice(-n)
}

main()
