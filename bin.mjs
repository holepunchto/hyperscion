import process from 'bare-process'
import path from 'bare-path'
import fs from 'bare-fs'
import createCli from './lib/cli.js'
import menu from './lib/menu.js'
import startUpdates from './lib/updates.js'
import self from './lib/self.js'

const argv = Bare.argv.slice(self.isDev() ? 2 : 1)

createCli.setUpdates(startUpdates)
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
    'hs: stalled: this command needs data that is not local (often part of main left behind ' +
      'by an interrupted download) and no connected peer provided it. Nothing is lost: retry ' +
      "when the hub or a teammate's `hs watch` is online. `hs doctor` checks connectivity."
  )
  Bare.exitCode = 1
  // the command never got to clean up: don't leave this worktree marked busy (q2h-1: a stale
  // busy.json named a land long gone)
  clearBusy()
  if (trace) trace.end(1, { stalled: true })
})

try {
  // `hs --menu` (or `hs <cmd> --menu`): pick and fill a command in a form, then run it as typed
  let args = argv
  if (menu.isMenu(argv)) {
    args = await menu.pick(cli, argv)
    if (args) console.log('$ hs ' + args.map(quote).join(' '))
  }
  const program = args ? cli.parse(args) : null
  if (program && program.running) await program.running
} catch (err) {
  // paparam hands command errors back as their stack text; users get the message only
  // (HS_DEBUG=1 for the stack)
  let msg = err && err.message ? err.message : String(err)
  if (!process.env.HS_DEBUG) {
    msg = msg
      .split('\n')
      .filter((l) => !/^\s+at /.test(l))
      .join('\n')
      .trim()
      .replace(/^Error: /, '')
  }
  console.error('hs: ' + msg)
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

// remove .hs/busy.json if it names this process (walks up from cwd like Context.load)
function clearBusy() {
  try {
    let dir = process.cwd()
    for (;;) {
      const file = path.join(dir, '.hs', 'busy.json')
      if (fs.existsSync(file)) {
        const info = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (info && info.pid === process.pid) fs.rmSync(file, { force: true })
        return
      }
      const up = path.dirname(dir)
      if (up === dir) return
      dir = up
    }
  } catch {}
}

// a token as you would type it in a shell (shown after `hs --menu`, so people learn the command)
function quote(token) {
  return /^[\w@%+=:,./#-]+$/.test(token) && !token.startsWith('#')
    ? token
    : `'${token.replace(/'/g, "'\\''")}'`
}
