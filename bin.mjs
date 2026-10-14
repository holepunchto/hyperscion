import process from 'bare-process'
import path from 'bare-path'
import fs from 'bare-fs'
import { isWindows } from 'which-runtime'
import createCli from './lib/cli.js'

const isDev = path.basename(Bare.argv[0]) === (isWindows ? 'bare.exe' : 'bare')
const argv = Bare.argv.slice(isDev ? 2 : 1)

const cli = createCli()

// Bare exits when its event loop drains, even with a promise still pending. If that happens
// mid-command we were waiting on data nobody can serve: fail loudly instead of exiting 0.
// HS_TRACE=<file> appends one JSON line per invocation (for observing how hs gets used)
const trace = process.env.HS_TRACE ? startTrace() : null

let running = true
Bare.on('beforeExit', () => {
  if (!running) return
  running = false
  console.error(
    'hs: stalled: this command needs data that is not local and no connected peer provided it. ' +
      'Run `hs pull` (needs a holder online: `hs seed --mirror` on a hub, or a blind peer), ' +
      'then retry. `hs doctor` checks connectivity.'
  )
  Bare.exitCode = 1
  if (trace) trace.end(1, { stalled: true })
})

try {
  const program = cli.parse(argv)
  if (program && program.running) await program.running
} catch (err) {
  console.error('hs: ' + (err && err.message ? err.message : err))
  if (process.env.HS_DEBUG) console.error(err)
  process.exitCode = 1
}

running = false
Bare.exitCode = process.exitCode || 0
if (trace) trace.end(Bare.exitCode)

function startTrace() {
  const started = Date.now()
  const lines = []
  for (const name of ['log', 'error']) {
    const orig = console[name].bind(console)
    console[name] = (...args) => {
      if (lines.length < 40) lines.push(args.join(' ').slice(0, 300))
      orig(...args)
    }
  }
  return {
    end(exit, extra = {}) {
      const rec = {
        t: new Date(started).toISOString(),
        agent: process.env.HS_AGENT || null,
        cwd: process.cwd(),
        argv,
        ms: Date.now() - started,
        exit,
        ...extra,
        out: lines
      }
      fs.appendFileSync(process.env.HS_TRACE, JSON.stringify(rec) + '\n')
    }
  }
}
