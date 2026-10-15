// Outcome metrics for a finished run, the same for both arms: replay every state main went
// through (hs: each changeset; git: each push, from origin's reflog), run the team's own
// `npm test` and the hidden acceptance suite on it, and merge the results into metrics.json.
//   node scripts/experiment/outcomes.js <teamdir> <acceptance.js>
// For hs, stop the hub first (inject.js --stop): export needs the hub's store.
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const dir = path.resolve(process.argv[2] || '')
const acceptance = path.resolve(process.argv[3] || '')
if (!fs.existsSync(acceptance)) {
  console.error('usage: node scripts/experiment/outcomes.js <teamdir> <acceptance.js>')
  process.exit(1)
}
const ROOT = path.resolve(__dirname, '../..')
const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'))
const scenario = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'scenarios', run.scenario, 'scenario.json'), 'utf8')
)
const started = new Date(fs.readFileSync(path.join(dir, 'started.txt'), 'utf8').trim()).getTime()
const work = fs.mkdtempSync(path.join(dir, 'replay-'))
const minute = (t) => Number(((t - started) / 60_000).toFixed(1))

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 180_000, ...opts })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

// [{ id, t, author, export(dir) }] oldest first
function states() {
  if (run.arm === 'git') {
    const origin = path.join(dir, 'origin.git')
    const res = sh('git', [
      '-C',
      origin,
      'log',
      '-g',
      '--date=unix',
      '--format=%H|%gd|%an',
      'refs/heads/main'
    ])
    return res.out
      .trim()
      .split('\n')
      .map((l) => {
        const [sha, gd, author] = l.split('|')
        return {
          id: sha.slice(0, 10),
          t: Number(gd.match(/\{(\d+)\}/)[1]) * 1000,
          author,
          export: (to) => sh('sh', ['-c', `git -C '${origin}' archive ${sha} | tar -x -C '${to}'`])
        }
      })
      .reverse()
      .filter((st, i, all) => i === 0 || st.id !== all[i - 1].id) // a reflog entry per no-op push too
  }
  const bare = require(path.join(ROOT, 'node_modules', 'bare-runtime'))()
  const hs = (args) =>
    sh(bare, [path.join(ROOT, 'bin.mjs'), ...args], { cwd: path.join(dir, 'hub') })
  const res = hs(['log', '-n', '100000'])
  return [...res.out.matchAll(/^#(\d+) \S+ (\S+) (\S+Z)/gm)]
    .map((m) => ({
      id: '#' + m[1],
      t: new Date(m[3]).getTime(),
      author: m[2],
      export: (to) => {
        fs.rmSync(to, { recursive: true, force: true })
        return hs(['export', to, '--at', m[1]])
      }
    }))
    .reverse()
}

const rows = []
for (const s of states().filter((st, i, all) => i === 0 || st.id !== all[i - 1].id)) {
  const to = path.join(work, s.id.replace('#', 'n'))
  fs.mkdirSync(to, { recursive: true })
  const ex = s.export(to)
  if (ex.code !== 0) {
    rows.push({ id: s.id, minute: minute(s.t), author: s.author, error: ex.out.slice(0, 200) })
    continue
  }
  const test = sh('npm', ['test', '--silent'], { cwd: to })
  const acc = sh('node', [acceptance, to, ...(scenario.acceptance || [])])
  let a = { passed: 0, total: 0, failures: [] }
  try {
    a = JSON.parse(acc.out)
  } catch {}
  const perMinute = (a.failures || []).filter((f) => /per-minute/.test(f.name)).length === 0
  rows.push({
    id: s.id,
    minute: minute(s.t),
    author: s.author,
    green: test.code === 0,
    acceptance: a.total ? Number((a.passed / a.total).toFixed(3)) : 0,
    ...(scenario.acceptance ? { perMinute: perMinute && a.total > 0 } : {})
  })
  fs.rmSync(to, { recursive: true, force: true })
  console.log(JSON.stringify(rows[rows.length - 1]))
}
fs.rmSync(work, { recursive: true, force: true })

// skip the skeleton state; everything after it is the team's work
const team = rows.slice(1).filter((r) => !r.error)
const firstAt = (pred) => {
  const r = team.find(pred)
  return r ? r.minute : null
}
let longestRed = 0
let redSince = null
let regressions = 0
for (let i = 0; i < team.length; i++) {
  const r = team[i]
  if (!r.green && redSince === null) redSince = r.minute
  if (r.green && redSince !== null) {
    longestRed = Math.max(longestRed, r.minute - redSince)
    redSince = null
  }
  if (i > 0 && team[i - 1].green && !r.green) regressions++
}
const last = team[team.length - 1] || {}
const outcomes = {
  main_states: team.length,
  main_green_pct: team.length
    ? Number(((100 * team.filter((r) => r.green).length) / team.length).toFixed(1))
    : 0,
  main_regressions: regressions,
  main_longest_red_min: Number(longestRed.toFixed(1)),
  final_green: !!last.green,
  acceptance_final_pct:
    last.acceptance !== undefined ? Number((100 * last.acceptance).toFixed(1)) : 0,
  acceptance_50_at_min: firstAt((r) => r.acceptance >= 0.5),
  acceptance_80_at_min: firstAt((r) => r.acceptance >= 0.8),
  acceptance_100_at_min: firstAt((r) => r.acceptance >= 1),
  final_state_min: last.minute ?? null
}
if (scenario.acceptance) {
  const cr = team.find((r) => r.author === 'pm')
  const done = cr ? team.find((r) => r.minute >= cr.minute && r.perMinute) : null
  outcomes.change_request_at_min = cr ? cr.minute : null
  outcomes.change_request_done_after_min =
    cr && done ? Number((done.minute - cr.minute).toFixed(1)) : null
}
fs.writeFileSync(
  path.join(dir, 'outcomes.json'),
  JSON.stringify({ outcomes, rows }, null, 2) + '\n'
)
const mfile = path.join(dir, 'metrics.json')
const metrics = fs.existsSync(mfile) ? JSON.parse(fs.readFileSync(mfile, 'utf8')) : {}
fs.writeFileSync(
  mfile,
  JSON.stringify({ arm: run.arm, scenario: run.scenario, ...metrics, ...outcomes }, null, 2) + '\n'
)
console.log(JSON.stringify(outcomes, null, 2))
