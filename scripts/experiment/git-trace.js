// Run git with the given arguments and append one trace line per call, in the same shape as
// hs's HS_TRACE records (t, agent, cwd, argv, ms, exit, out), plus tool: 'git'.
// Used by the per-agent wrappers that scripts/git-team.sh writes.
const { spawn } = require('child_process')
const fs = require('fs')

const argv = process.argv.slice(2)
const started = Date.now()
const lines = []
let partial = ''

function capture(chunk) {
  const text = partial + chunk.toString()
  const parts = text.split('\n')
  partial = parts.pop()
  for (const l of parts) lines.push(l.slice(0, 300))
}

const child = spawn('git', argv, { stdio: ['inherit', 'pipe', 'pipe'] })
// `git log | head` closes our stdout early: keep tracing instead of crashing on EPIPE
let closed = false
for (const out of [process.stdout, process.stderr]) out.on('error', () => (closed = true))
child.stdout.on('data', (d) => {
  if (!closed) process.stdout.write(d)
  capture(d)
})
child.stderr.on('data', (d) => {
  if (!closed) process.stderr.write(d)
  capture(d)
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))

child.on('close', (code, signal) => {
  if (partial) lines.push(partial.slice(0, 300))
  const exit = code === null ? 128 : code
  // keep the head and the tail: conflicts and rejections are usually at the end
  const out = lines.length > 40 ? [...lines.slice(0, 20), '...', ...lines.slice(-20)] : lines
  const rec = {
    t: new Date(started).toISOString(),
    tool: 'git',
    agent: process.env.HS_AGENT || null,
    cwd: process.cwd(),
    argv,
    ms: Date.now() - started,
    exit,
    ...(signal ? { signal } : {}),
    out
  }
  if (process.env.HS_TRACE) fs.appendFileSync(process.env.HS_TRACE, JSON.stringify(rec) + '\n')
  process.exit(exit)
})
