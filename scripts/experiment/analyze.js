// Summarize <teamdir>/trace.jsonl: how agents used hs and what went wrong.
//   node scripts/experiment/analyze.js <teamdir>
const fs = require('fs')
const path = require('path')

const dir = path.resolve(process.argv[2] || '.')
const recs = fs
  .readFileSync(path.join(dir, 'trace.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
const startedFile = path.join(dir, 'started.txt')
const started = fs.existsSync(startedFile)
  ? new Date(fs.readFileSync(startedFile, 'utf8').trim()).getTime()
  : Math.min(...recs.map((r) => new Date(r.t).getTime()))
// agents are a1..aN plus stand-ins like a3b; the hub and the change-request pm are not agents
const runs = recs
  .filter((r) => /^a\d+[a-z]*$/.test(r.agent) && new Date(r.t).getTime() >= started)
  .map(normalize)
const isGit = runs.some((r) => r.tool === 'git')

// git calls may start with global options (-C dir, -c k=v, --no-pager): drop them
function normalize(r) {
  if (r.tool !== 'git') return r
  const argv = [...r.argv]
  while (argv.length && argv[0].startsWith('-')) {
    argv.splice(0, ['-C', '-c'].includes(argv[0]) ? 2 : 1)
  }
  return { ...r, argv }
}

const OBSERVE = new Set(['log', 'show', 'cat', 'ls', 'diff', 'status', 'info', 'watch', 'doctor'])
const has = (r, re) => r.out.some((l) => re.test(l))
const pct = (xs, p) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const mins = (t) => ((new Date(t).getTime() - started) / 60000).toFixed(1)

const agents = {}
for (const r of runs) {
  const a = (agents[r.agent] ||= {
    cmds: {},
    ms: {},
    lands: 0,
    accepted: 0,
    rebased: 0,
    realConflicts: 0,
    staleRefusals: 0,
    pushTimeouts: 0,
    flipBanners: 0,
    stalls: 0,
    unavailable: 0,
    unresolved: 0,
    firstLand: null,
    // milestone 4/5 metrics: settlement, review, confusion, habits
    landFinal: 0,
    landSettled: 0,
    landProvisional: 0,
    needsReview: 0,
    showsSent: 0,
    proposals: 0,
    reviewsGiven: 0,
    errors: 0,
    warnings: 0,
    helps: 0,
    unknownFlags: 0,
    oldHabits: 0,
    pushRejected: 0,
    notLanded: 0,
    waitMs: 0,
    vcsMs: 0,
    first: r.t,
    last: r.t
  })
  const cmd = r.argv[0] || '(none)'
  a.cmds[cmd] = (a.cmds[cmd] || 0) + 1
  ;(a.ms[cmd] ||= []).push(r.ms)
  a.last = r.t
  // time in the tool, minus watching: a background feed runs all session, and waits count
  // separately (wait_min_total)
  if (cmd !== 'watch') a.vcsMs += r.ms
  if (cmd === 'watch' && r.argv.includes('--count')) a.waitMs += r.ms
  if (r.tool === 'git') {
    countGit(a, r, cmd)
    continue
  }
  // a land that didn't happen (failed check, conflict, needs review) exits 1 since the
  // round 4 fixes; that's a normal outcome, not a tool error
  const notLanded = has(r, /^!! not landed:/)
  if (notLanded) a.notLanded++
  if (r.exit === 1 && !notLanded) a.errors++
  if (r.exit === 2) a.warnings++
  if (r.argv.includes('--help') || r.argv.includes('-h') || cmd === 'help') a.helps++
  if (has(r, /UNKNOWN_FLAG|unknown flag|UNKNOWN_COMMAND|unknown command/i)) a.unknownFlags++
  if (cmd === 'pull' || (['land', 'propose'].includes(cmd) && r.argv.includes('-o'))) a.oldHabits++
  if (cmd === 'propose' && r.exit === 0) a.proposals++
  if (cmd === 'review' && r.exit === 0) a.reviewsGiven++
  if (r.stalled) a.stalls++
  if (has(r, /could not be fetched|behind main \(marked stale|content is not available/)) {
    a.unavailable++
  }
  if (has(r, /undone by a concurrent land/)) a.flipBanners++
  if (has(r, /also edited here, left as is/)) a.unresolved++
  if (cmd === 'land') {
    a.lands++
    if (has(r, /landed #/)) {
      a.accepted++
      if (!a.firstLand) a.firstLand = r.t
    }
    if (has(r, /rebasing onto main/)) a.rebased++
    if (has(r, /real conflicts in|CONFLICT/)) a.realConflicts++
    if (has(r, /refusing to land/)) a.staleRefusals++
    if (has(r, /push timed out/)) a.pushTimeouts++
    if (has(r, /needs review/)) a.needsReview++
    if (has(r, /review requested from/)) a.showsSent++
    if (has(r, /^#\d+ final/)) a.landFinal++
    else if (has(r, /^#\d+ settled/)) a.landSettled++
    else if (has(r, /^#\d+ provisional/)) a.landProvisional++
  }
}

// the git arm: a push is a land, a rebasing pull an auto-rebase
function countGit(a, r, cmd) {
  if (r.exit !== 0) a.errors++
  if (r.argv.includes('--help') || cmd === 'help') a.helps++
  if (
    has(r, /does not appear to be a git repository|Could not read from remote|this machine is gone/)
  ) {
    a.unavailable++
  }
  if (has(r, /^CONFLICT|Merge conflict in/)) a.realConflicts++
  if (['pull', 'rebase'].includes(cmd) && has(r, /Successfully rebased/)) a.rebased++
  if (cmd === 'push') {
    const toMain = !r.argv.some((x) => /ask\/|:refs\/heads\/(?!main)|HEAD:(?!main)/.test(x))
    if (!toMain) {
      a.proposals += r.exit === 0 ? 1 : 0
      return
    }
    a.lands++
    if (has(r, /\[rejected\]|failed to push/)) a.pushRejected++
    if (r.exit === 0 && !has(r, /Everything up-to-date/)) {
      a.accepted++
      if (!a.firstLand) a.firstLand = r.t
    }
  }
}

const rows = Object.entries(agents).sort()
const total = (k) => rows.reduce((n, [, a]) => n + a[k], 0)

console.log(`# hs usage: ${runs.length} calls since ${new Date(started).toISOString()}\n`)
console.log(
  '| agent | calls | observe | pull | sync | watch | lands (accepted) | auto-rebased | real conflicts | flips | stalls | unavailable | stale refusals | first land |'
)
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const [name, a] of rows) {
  const calls = Object.values(a.cmds).reduce((x, y) => x + y, 0)
  const observe = Object.entries(a.cmds)
    .filter(([c]) => OBSERVE.has(c))
    .reduce((x, [, n]) => x + n, 0)
  console.log(
    `| ${name} | ${calls} | ${observe} | ${a.cmds.pull || 0} | ${a.cmds.sync || 0} | ${a.cmds.watch || 0} | ${a.lands} (${a.accepted}) | ${a.rebased} | ${a.realConflicts} | ${a.flipBanners} | ${a.stalls} | ${a.unavailable} | ${a.staleRefusals} | ${a.firstLand ? mins(a.firstLand) + 'm' : '-'} |`
  )
}
console.log(
  `\ntotals: lands ${total('lands')} (accepted ${total('accepted')}), auto-rebased ${total('rebased')}, real conflicts ${total('realConflicts')}, flip banners ${total('flipBanners')}, stalls ${total('stalls')}, unavailable ${total('unavailable')}, stale refusals ${total('staleRefusals')}, push timeouts ${total('pushTimeouts')}, unresolved ${total('unresolved')}`
)

console.log('\n## latency p50/p90 (ms)')
for (const [name, a] of rows) {
  console.log(
    `${name}: ` +
      Object.entries(a.ms)
        .map(([c, xs]) => `${c} ${pct(xs, 50)}/${pct(xs, 90)}`)
        .join(', ')
  )
}

console.log('\n## command mix')
for (const [name, a] of rows) {
  console.log(
    `${name}: ` +
      Object.entries(a.cmds)
        .map(([c, n]) => `${c}=${n}`)
        .join(' ')
  )
}

console.log('\n## land timeline')
for (const r of runs.filter((r) => r.argv[0] === (isGit ? 'push' : 'land'))) {
  const res = isGit
    ? r.exit === 0
      ? 'pushed'
      : r.out.find((l) => /rejected|fatal|error/.test(l)) || 'exit ' + r.exit
    : r.out.find((l) =>
        /landed #|real conflicts|refusing|rejected|conflict on|nothing to land|hs:/.test(l)
      ) || ''
  const rebased = has(r, /rebasing onto main/) ? ' (rebased)' : ''
  const i = r.argv.indexOf('-m')
  const msg = i >= 0 ? r.argv[i + 1] : ''
  console.log(
    `${mins(r.t).padStart(5)}m ${r.agent} ${(res + rebased).slice(0, 55).padEnd(55)} ${msg.slice(0, 70)}`
  )
}

// a machine-readable summary, so rounds can be compared (scripts/experiment/compare.js)
const calls = runs.length
const accepted = total('accepted')
const landMs = runs
  .filter((r) => r.argv[0] === (isGit ? 'push' : 'land') && r.exit === 0)
  .map((r) => r.ms)
const span = runs.length
  ? (Math.max(...runs.map((r) => new Date(r.t).getTime())) - started) / 60000
  : 0
const reports = readReports(path.join(dir, 'reports'))
const metrics = {
  calls,
  minutes: Number(span.toFixed(1)),
  lands: total('lands'),
  accepted,
  calls_per_accepted_land: accepted ? Number((calls / accepted).toFixed(2)) : null,
  auto_rebased: total('rebased'),
  real_conflicts: total('realConflicts'),
  flips: total('flipBanners'),
  stalls: total('stalls'),
  unavailable: total('unavailable'),
  push_timeouts: total('pushTimeouts'),
  land_ended_final: total('landFinal'),
  land_ended_settled: total('landSettled'),
  land_ended_provisional: total('landProvisional'),
  land_ms_p50: pct(landMs, 50),
  land_ms_p90: pct(landMs, 90),
  tool: isGit ? 'git' : 'hs',
  polling_calls: runs.filter((r) => ['pull', 'fetch'].includes(r.argv[0])).length,
  push_rejected: total('pushRejected'),
  not_landed: total('notLanded'),
  wait_min_total: Number((total('waitMs') / 60000).toFixed(1)),
  vcs_min_total: Number((total('vcsMs') / 60000).toFixed(1)),
  vcs_share_pct: Number(
    (
      (100 * total('vcsMs')) /
      Math.max(
        1,
        rows.reduce((n, [, a]) => n + (new Date(a.last) - new Date(a.first)), 0)
      )
    ).toFixed(1)
  ),
  watch_calls: runs.filter((r) => r.argv[0] === 'watch').length,
  proposals: total('proposals'),
  reviews_given: total('reviewsGiven'),
  shows_sent: total('showsSent'),
  needs_review_rejections: total('needsReview'),
  exit_errors: total('errors'),
  exit_warnings: total('warnings'),
  help_calls: total('helps'),
  unknown_flag_or_command: total('unknownFlags'),
  old_habits: total('oldHabits'),
  ...reports
}
fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n')
console.log('\n## metrics (also in metrics.json)')
for (const [k, v] of Object.entries(metrics)) console.log(`${k}: ${JSON.stringify(v)}`)

// the JSON scorecard at the end of each agent's report
function readReports(rdir) {
  if (!fs.existsSync(rdir)) return {}
  const cards = []
  for (const f of fs.readdirSync(rdir).filter((f) => f.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(rdir, f), 'utf8')
    const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
    if (!blocks.length) continue
    try {
      cards.push(JSON.parse(blocks[blocks.length - 1][1]))
    } catch {}
  }
  if (!cards.length) return {}
  const nums = (k) => cards.map((c) => c[k]).filter((v) => typeof v === 'number')
  const mean = (k) => {
    const xs = nums(k)
    return xs.length ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)) : null
  }
  return {
    usefulness_vs_git: cards.map((c) => c.usefulness_vs_git),
    would_choose_hs:
      cards.filter((c) => c.would_choose_hs_over_git_for_this).length + '/' + cards.length,
    output_clarity_mean: mean('output_clarity'),
    land_state_trust_mean: mean('knew_when_my_land_was_safe'),
    minutes_lost_to_hs_total: nums('minutes_lost_to_hs').reduce((a, b) => a + b, 0),
    confusing_messages_total: nums('confusing_messages').reduce((a, b) => a + b, 0),
    review_usefulness_mean: mean('review_usefulness')
  }
}
