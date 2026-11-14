// Watch a run for the problems we're chasing, one line each, so a run can be cut short as
// soon as it has shown what we need (or that a fix works).
//
//   node scripts/experiment/alerts.js <teamdir> [--follow]
//
// Reads <teamdir>/trace.jsonl (every hs call), inject.log (faults, change request) and the
// reports directory. Without --follow it prints what has happened so far and exits.
const fs = require('fs')
const path = require('path')

const argv = process.argv.slice(2)
const dir = path.resolve(argv[0] || '')
const follow = argv.includes('--follow')
const SLOW_MS = 30_000

const started = (() => {
  try {
    return new Date(fs.readFileSync(path.join(dir, 'started.txt'), 'utf8').trim()).getTime()
  } catch {
    return null
  }
})()
const at = (t) => (started ? `m${((new Date(t).getTime() - started) / 60_000).toFixed(1)}` : '')

const PATTERNS = [
  [/push timed out/, 'push timed out'],
  [/could not be fetched|not available from any|unobtainable/, 'content unfetchable'],
  [/stale copy/, 'refused: edited on a stale copy'],
  [/hs: stalled/, 'stalled'],
  [/no peers reachable/, 'no peers reachable'],
  [/is using this worktree; wait/, 'worktree busy'],
  [/not landed: needs review/, 'refused: needs approval']
]

function onTrace(d) {
  if (!d.agent || /^sw/.test(d.agent)) return
  const cmd = d.argv[0]
  const text = (d.out || []).join('\n')
  const hits = PATTERNS.filter(([re]) => re.test(text)).map(([, what]) => what)
  const slow = (cmd === 'land' || cmd === 'sync' || cmd === 'push') && d.ms > SLOW_MS
  if (!hits.length && !slow) return
  const landed = (text.match(/landed #\d+/) || [''])[0]
  const parts = [at(d.t), d.agent, cmd, `${Math.round(d.ms / 1000)}s`, `exit ${d.exit}`]
  if (landed) parts.push(landed)
  console.log(`ALERT ${parts.join(' ')}: ${[...hits, ...(slow ? ['slow'] : [])].join(', ')}`)
}

function onInject(e) {
  if (e.do === 'change-request' && e.attempt) {
    console.log(`EVENT m${e.minute} change request landed (attempt ${e.attempt})`)
  } else if (e.do === 'change-request' && e.retry) {
    console.log(`ALERT change request retry ${e.retry}: ${String(e.out || '').split('\n')[0]}`)
  } else if (e.do && e.minute !== undefined) {
    console.log(`EVENT m${e.minute} ${e.do}`)
  }
}

// follow a JSON-lines file from where we last read
function tail(file, onLine) {
  let pos = 0
  let buf = ''
  return () => {
    let fd
    try {
      fd = fs.openSync(file, 'r')
    } catch {
      return
    }
    const size = fs.fstatSync(fd).size
    if (size > pos) {
      const chunk = Buffer.alloc(size - pos)
      fs.readSync(fd, chunk, 0, chunk.length, pos)
      pos = size
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        try {
          onLine(JSON.parse(line))
        } catch {}
      }
    }
    fs.closeSync(fd)
  }
}

const seenReports = new Set()
function reports() {
  let names = []
  try {
    names = fs.readdirSync(path.join(dir, 'reports'))
  } catch {}
  for (const n of names) {
    if (seenReports.has(n)) continue
    seenReports.add(n)
    console.log(`EVENT report ${n}`)
  }
}

// q2h: the scripted approver's decisions
function onApproval(e) {
  if (!e.target) return
  console.log(
    `EVENT ${at(e.t)} ann ${e.do} ${e.target}${e.waitedS !== undefined ? ` after ${e.waitedS}s` : ''}${e.error ? ': ' + e.error : ''}`
  )
}

const polls = [
  tail(path.join(dir, 'trace.jsonl'), onTrace),
  tail(path.join(dir, 'inject.log'), onInject),
  tail(path.join(dir, 'approvals.jsonl'), onApproval)
]
const poll = () => {
  for (const p of polls) p()
  reports()
}
poll()
if (follow) setInterval(poll, 2000)
