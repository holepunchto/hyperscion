// Run a scenario's fault and change schedule against a team, identically for both arms.
//   node scripts/experiment/inject.js <teamdir> [--scale f]   wait for started.txt, run the schedule
//   node scripts/experiment/inject.js <teamdir> --do <action> [agent]   one action now
//   node scripts/experiment/inject.js <teamdir> --stop        end of run: stop the hub and feeds
// --scale shrinks the timeline (0.1: minute 10 happens after 1 minute) for dry runs.
// Every action is logged to <teamdir>/faults/events.jsonl. The process exits after the last
// event, so whoever runs the agents can be woken by it (S3 ends with killing a3).
const { spawn } = require('child_process')
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

// async: a blocking spawn would hold up the schedule (an origin-up due while pm retries)
function tool(agent, args, cwd) {
  const bin = path.join(dir, 'bin', (hs ? 'hs-' : 'git-') + agent)
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, out: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
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
      await tool('pm', hs ? ['sync'] : ['pull'], cwd)
      if (!fs.existsSync(path.join(cwd, 'CHANGE-REQUEST.md'))) {
        fs.copyFileSync(path.join(src, 'CHANGE-REQUEST.md'), path.join(cwd, 'CHANGE-REQUEST.md'))
      }
      const notes = path.join(cwd, 'NOTES.md')
      if (!fs.readFileSync(notes, 'utf8').includes(line.trim())) fs.appendFileSync(notes, line)
      // q2h: the change request lands with a review policy (contract changes need a person)
      if (hs && scenario.changeRequestPolicy) {
        fs.copyFileSync(
          path.join(src, scenario.changeRequestPolicy),
          path.join(cwd, scenario.changeRequestPolicy)
        )
      }
      let res
      if (hs) {
        res = await tool('pm', ['land', '-m', message], cwd)
        if (/landed #\d+/.test(res.out)) {
          // claims (docs/CLAIMS.md): the change request is also an item agents can claim
          let item = null
          if (scenario.claims) {
            const lead = scenario.changeRequestLead ? ['--lead', scenario.changeRequestLead] : []
            const kind = scenario.changeRequestKind || 'implement'
            const paths = (scenario.changeRequestPaths || []).flatMap((p) => ['--paths', p])
            const made = await tool(
              'pm',
              ['item', 'new', '--from', 'CHANGE-REQUEST.md', '--kind', kind, ...paths, ...lead],
              cwd
            )
            item = (made.out.match(/item (C[0-9a-f]{6})/) || [])[1] || made.out.slice(-200)
          }
          return { attempt, out: res.out.split('\n').slice(-4), ...(item ? { item } : {}) }
        }
        // a sync during an outage can leave NOTES.md behind main: drop the edit, resync, redo
        if (/stale copy/.test(res.out)) await tool('pm', ['restore', 'NOTES.md'], cwd)
      } else {
        await tool('pm', ['add', '-A'], cwd)
        await tool('pm', ['commit', '-q', '-m', message], cwd)
        res = await tool('pm', ['push', '-q', 'origin', 'HEAD:main'], cwd)
        if (res.code === 0) return { attempt }
        await tool('pm', ['pull'], cwd)
      }
      log({ do: 'change-request', retry: attempt, out: res.out.slice(-300) })
      await sleep(10_000)
    }
    return { failed: true }
  }
}

// q2h: a scripted person approving from hs inbox, detached so it outlives the schedule
function startApprover() {
  if (!hs || !scenario.approver) return null
  const logFd = fs.openSync(path.join(dir, 'approver.log'), 'a')
  const child = spawn('node', [path.join(__dirname, 'approver.js'), dir], {
    detached: true,
    stdio: ['ignore', logFd, logFd]
  })
  child.unref()
  fs.writeFileSync(path.join(dir, 'approver.pid'), String(child.pid) + '\n')
  return child.pid
}

async function stop() {
  const stopped = []
  if (await stopPid(readPid(path.join(dir, 'approver.pid')))) stopped.push('approver')
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
  const approver = startApprover()
  if (approver) log({ do: 'approver', pid: approver })
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
