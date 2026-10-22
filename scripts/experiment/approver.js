// A scripted person in the loop (q2h, docs/TASKS.md phase 2): polls `hs inbox` and
// `hs proposals` as the scenario's human writer and approves what waits, after a short human
// delay, holding items whose title matches `holdMatching` for `holdS` seconds instead.
//
//   node scripts/experiment/approver.js <teamdir>
//
// inject.js starts it (detached) with the schedule and stops it with --stop. Every decision
// goes to <teamdir>/approvals.jsonl: seen (first time in the inbox) and approved, with the
// seconds it waited; alerts.js prints them.
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const dir = path.resolve(process.argv[2] || '')
const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'))
const scenario = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'scenarios', run.scenario, 'scenario.json'), 'utf8')
)
const cfg = { delayS: 10, holdS: 90, holdMatching: null, ...scenario.approver }
const me = cfg.as
const hold = cfg.holdMatching ? new RegExp(cfg.holdMatching) : null
const TICK_MS = 5000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (o) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...o })
  fs.appendFileSync(path.join(dir, 'approvals.jsonl'), line + '\n')
  console.log(line)
}

function hs(args) {
  return new Promise((resolve) => {
    const child = spawn(path.join(dir, 'bin', 'hs-' + me), args, {
      cwd: path.join(dir, 'agents', me),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    })
  })
}

const seen = new Map() // target -> { at, title, waitS }
const done = new Set()

function notice(target, title, kind) {
  if (seen.has(target) || done.has(target)) return
  // the hold is for items (the change request), not proposals that mention it
  const waitS = kind === 'task' && hold && hold.test(title) ? cfg.holdS : cfg.delayS
  seen.set(target, { at: Date.now(), title, waitS })
  log({ do: 'seen', target, kind, title, holdS: waitS })
}

async function tick() {
  const inbox = await hs(['inbox', '--json'])
  for (const line of inbox.out.split('\n')) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type === 'task') notice(e.task, e.title || '', 'task')
  }
  // every open proposal, not only those naming us: a person would look at what's blocked
  const props = await hs(['proposals', '--offline'])
  for (const line of props.out.split('\n')) {
    const m = line.match(/^P(\d+) open\s+(\d+)\/(\d+) by (\S+) .*:: (.*)$/)
    if (!m || m[4] === me) continue
    // approved before, open again with fewer approvals: a new revision reset them
    if (done.has('P' + m[1]) && Number(m[2]) < Number(m[3])) {
      done.delete('P' + m[1])
      log({ do: 'revised', target: 'P' + m[1] })
    }
    notice('P' + m[1], m[5], 'proposal')
  }
  for (const [target, s] of seen) {
    if (Date.now() - s.at < s.waitS * 1000) continue
    const res = await hs(['review', target, 'approve', '-m', 'ok from ' + me])
    const ok = res.code === 0 && /approved by you|approved;|approvals/.test(res.out)
    if (ok) {
      seen.delete(target)
      done.add(target)
      log({ do: 'approved', target, waitedS: Math.round((Date.now() - s.at) / 1000) })
    } else {
      log({ do: 'retry', target, error: res.out.trim().split('\n').slice(-1)[0] })
    }
  }
}

async function main() {
  log({ do: 'start', as: me, ...cfg })
  for (;;) {
    try {
      await tick()
    } catch (err) {
      log({ do: 'error', error: String(err.message || err) })
    }
    await sleep(TICK_MS)
  }
}

process.on('SIGINT', () => process.exit(0))
main()
