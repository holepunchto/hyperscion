import process from 'bare-process'
import path from 'bare-path'
import { isWindows } from 'which-runtime'
import createCli from './lib/cli.js'

const isDev = path.basename(Bare.argv[0]) === (isWindows ? 'bare.exe' : 'bare')
const argv = Bare.argv.slice(isDev ? 2 : 1)

const cli = createCli()

// Bare exits when its event loop drains, even with a promise still pending. If that happens
// mid-command we were waiting on data nobody can serve: fail loudly instead of exiting 0.
let running = true
Bare.on('beforeExit', () => {
  if (!running) return
  running = false
  console.error('hs: stalled waiting for data that no connected peer can provide')
  Bare.exitCode = 1
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
