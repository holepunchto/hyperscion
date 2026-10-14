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
const runs = recs.filter((r) => /^a\d+$/.test(r.agent) && new Date(r.t).getTime() >= started)

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
    first: r.t,
    last: r.t
  })
  const cmd = r.argv[0] || '(none)'
  a.cmds[cmd] = (a.cmds[cmd] || 0) + 1
  ;(a.ms[cmd] ||= []).push(r.ms)
  a.last = r.t
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
for (const r of runs.filter((r) => r.argv[0] === 'land')) {
  const res =
    r.out.find((l) =>
      /landed #|real conflicts|refusing|rejected|conflict on|nothing to land|hs:/.test(l)
    ) || ''
  const rebased = has(r, /rebasing onto main/) ? ' (rebased)' : ''
  const i = r.argv.indexOf('-m')
  const msg = i >= 0 ? r.argv[i + 1] : ''
  console.log(
    `${mins(r.t).padStart(5)}m ${r.agent} ${(res + rebased).slice(0, 55).padEnd(55)} ${msg.slice(0, 70)}`
  )
}
