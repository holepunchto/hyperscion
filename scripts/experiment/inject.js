// Run a scenario's fault and change schedule against a team, identically for both arms.
//   node scripts/experiment/inject.js <teamdir> [--scale f]   wait for started.txt, run the schedule
//   node scripts/experiment/inject.js <teamdir> --do <action> [agent]   one action now
//   node scripts/experiment/inject.js <teamdir> --stop        end of run: stop the hub and feeds
// --scale shrinks the timeline (0.1: minute 10 happens after 1 minute) for dry runs.
// Every action is logged to <teamdir>/faults/events.jsonl. The process exits after the last
// event, so whoever runs the agents can be woken by it (S3 ends with killing a3).
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const argv = process.argv.slice(2)
const dir = path.resolve(argv[0] || '')
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv.slice(i + 1) : null
}
const ROOT = path.resolve(__dirname, '../..')
const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'))
const SC = path.join(__dirname, 'scenarios', run.scenario)
const scenario = JSON.parse(fs.readFileSync(path.join(SC, 'scenario.json'), 'utf8'))
const hs = run.arm !== 'git'
const faults = path.join(dir, 'faults')
fs.mkdirSync(faults, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function log(event) {
  const rec = { t: new Date().toISOString(), ...event }
  fs.appendFileSync(path.join(faults, 'events.jsonl'), JSON.stringify(rec) + '\n')
  console.log(JSON.stringify(rec))
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function stopPid(pid) {
  if (!pid || !alive(pid)) return false
  process.kill(pid, 'SIGINT')
  for (let i = 0; i < 150 && alive(pid); i++) await sleep(100)
  if (alive(pid)) process.kill(pid, 'SIGKILL')
  return true
}

function readPid(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim()) || null
  } catch {
    return null
  }
}

// an agent's background `hs watch` keeps its connection; a fault has to cut it too
function stopFeed(agent) {
  const root = [path.join(dir, 'agents', agent), path.join(dir, 'agents', agent + '.dead')].find(
    (p) => fs.existsSync(p)
  )
  if (!root) return Promise.resolve(false)
  return stopPid(readPid(path.join(root, '.hs', 'watch.pid')))
}

function tool(agent, args, cwd) {
  const bin = path.join(dir, 'bin', (hs ? 'hs-' : 'git-') + agent)
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: 120_000 })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

const actions = {
  async offline({ agent }) {
    fs.writeFileSync(path.join(faults, agent + '.offline'), '')
    return { feedStopped: hs ? await stopFeed(agent) : false }
  },

  online({ agent }) {
    fs.rmSync(path.join(faults, agent + '.offline'), { force: true })
    return {}
  },

  async 'origin-down'() {
    if (!hs) {
      fs.renameSync(path.join(dir, 'origin.git'), path.join(dir, 'origin.git.down'))
      return {}
    }
    return { stopped: await stopPid(readPid(path.join(dir, 'hub-seed.pid'))) }
  },

  'origin-up'() {
    if (!hs) {
      fs.renameSync(path.join(dir, 'origin.git.down'), path.join(dir, 'origin.git'))
      return {}
    }
    const bare = require(path.join(ROOT, 'node_modules', 'bare-runtime'))()
    const logFd = fs.openSync(path.join(dir, 'hub-seed.log'), 'a')
    const child = spawn(
      bare,
      [path.join(ROOT, 'bin.mjs'), 'seed', '--admit', path.join(dir, 'admit')],
      {
        cwd: path.join(dir, 'hub'),
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: run.bootstrap ? { ...process.env, HS_BOOTSTRAP: run.bootstrap } : process.env
      }
    )
    child.unref()
    fs.writeFileSync(path.join(dir, 'hub-seed.pid'), String(child.pid) + '\n')
    return { pid: child.pid }
  },

  async kill({ agent }) {
    fs.writeFileSync(path.join(faults, agent + '.dead'), '')
    const feedStopped = hs ? await stopFeed(agent) : false
    const from = path.join(dir, 'agents', agent)
    if (fs.existsSync(from)) fs.renameSync(from, from + '.dead')
    return { feedStopped, note: `stop the ${agent} agent now and start its replacement` }
  },

  async 'change-request'({ files }) {
    const src = path.join(SC, files)
    const cwd = path.join(dir, 'agents', 'pm')
    const line = fs.readFileSync(path.join(src, 'NOTES.line'), 'utf8')
    const message = 'CR-1: pricing becomes per flight-minute (see CHANGE-REQUEST.md)'
    // keep trying for up to 10 minutes: the origin may be down when the request is due
    for (let attempt = 1; attempt <= 60; attempt++) {
      const steps = hs ? [['sync']] : [['pull']]
      for (const s of steps) tool('pm', s, cwd)
      if (!fs.existsSync(path.join(cwd, 'CHANGE-REQUEST.md'))) {
        fs.copyFileSync(path.join(src, 'CHANGE-REQUEST.md'), path.join(cwd, 'CHANGE-REQUEST.md'))
        fs.appendFileSync(path.join(cwd, 'NOTES.md'), line)
      }
      let res
      if (hs) {
        res = tool('pm', ['land', '-m', message], cwd)
        if (/landed #\d+/.test(res.out)) return { attempt, out: res.out.split('\n').slice(-4) }
      } else {
        tool('pm', ['add', '-A'], cwd)
        tool('pm', ['commit', '-q', '-m', message], cwd)
        res = tool('pm', ['push', '-q', 'origin', 'HEAD:main'], cwd)
        if (res.code === 0) return { attempt }
        tool('pm', ['pull'], cwd)
      }
      log({ do: 'change-request', retry: attempt, out: res.out.slice(-300) })
      await sleep(10_000)
    }
    return { failed: true }
  }
}

async function stop() {
  const stopped = []
  if (hs && (await stopPid(readPid(path.join(dir, 'hub-seed.pid'))))) stopped.push('hub')
  // quick runs: the local testnet goes last (feeds and the hub were using it)
  const stopTestnet = () => stopPid(readPid(path.join(dir, 'testnet.pid')))
  for (const a of fs.existsSync(path.join(dir, 'agents'))
    ? fs.readdirSync(path.join(dir, 'agents'))
    : []) {
    if (await stopFeed(a.replace(/\.dead$/, ''))) stopped.push('feed ' + a)
  }
  if (!hs && fs.existsSync(path.join(dir, 'origin.git.down'))) {
    fs.renameSync(path.join(dir, 'origin.git.down'), path.join(dir, 'origin.git'))
  }
  if (await stopTestnet()) stopped.push('testnet')
  for (const f of fs.readdirSync(faults)) {
    if (/\.(offline|dead)$/.test(f)) fs.rmSync(path.join(faults, f))
  }
  log({ do: 'stop', stopped })
}

async function main() {
  if (opt('--stop')) return stop()
  const now = opt('--do')
  if (now) {
    const [action, agent] = now
    log({
      do: action,
      agent,
      manual: true,
      ...(await actions[action]({ agent, ...scenario.schedule.find((e) => e.do === action) }))
    })
    return
  }
  const scale = Number((opt('--scale') || [])[0]) || 1
  const startedFile = path.join(dir, 'started.txt')
  while (!fs.existsSync(startedFile)) await sleep(1000)
  const started = new Date(fs.readFileSync(startedFile, 'utf8').trim()).getTime()
  const events = [...scenario.schedule].sort((a, b) => a.at - b.at)
  log({ do: 'schedule', scenario: run.scenario, arm: run.arm, scale, events: events.length })
  // each event fires on its own clock: a slow one (a change request retrying while the
  // origin is down) must not delay the next (the origin coming back)
  await Promise.all(
    events.map(async (e) => {
      const due = started + e.at * 60_000 * scale
      if (Date.now() < due) await sleep(due - Date.now())
      const res = await actions[e.do](e)
      log({ ...e, minute: Number(((Date.now() - started) / 60_000).toFixed(2)), ...res })
    })
  )
}

main().catch((err) => {
  log({ do: 'error', error: String(err.stack || err) })
  process.exit(1)
})
