// hs ui's worker threads (bare-worker). workerData.role:
//   read: long-lived; answers { id, op, args } with { id, ok, data | error } (lib/ui/backend.js)
//   run:  runs one hs command as typed (workerData.argv) and posts each line it prints as
//         { line, stream }, then { done, code }, and ends once idle. It shares the terminal with the TUI, so
//         nothing may reach stdout: console and process.stdout/stderr are redirected first.
const Worker = require('bare-worker')
const process = require('bare-process')
const b4a = require('b4a')

const port = Worker.parentPort
const { role, argv = [], cwd = null } = Worker.workerData || {}

if (role === 'read') read()
else if (role === 'run') run()

// one op at a time: two opens of the store in one thread would see each other as busy
function read() {
  const backend = require('./backend')
  const fatal = (err) => port.postMessage({ fatal: (err && err.message) || String(err) })
  Bare.on('uncaughtException', fatal).on('unhandledRejection', fatal)
  let queue = Promise.resolve()
  port.on('message', ({ id, op, args }) => {
    queue = queue.then(async () => {
      try {
        if (!Object.hasOwn(backend, op)) throw new Error('unknown op ' + op)
        port.postMessage({
          id,
          ok: true,
          data: await backend[op](cwd || process.cwd(), args || {})
        })
      } catch (err) {
        port.postMessage({ id, ok: false, error: err.message || String(err) })
      }
    })
  })
}

async function run() {
  const post =
    (stream) =>
    (...a) => {
      for (const line of a.join(' ').replace(/\n$/, '').split('\n')) {
        port.postMessage({ line, stream })
      }
    }
  console.log = console.info = post('stdout')
  console.error = console.warn = post('stderr')
  // diff, cat and agents write to process.stdout directly: shadow it (and stderr) without
  // touching the getters, so nothing this thread does reaches the TUI's terminal
  for (const stream of ['stdout', 'stderr']) {
    const fake = {
      isTTY: false,
      write(chunk) {
        post(stream)(typeof chunk === 'string' ? chunk : b4a.toString(chunk))
        return true
      }
    }
    Object.defineProperty(process, stream, { value: fake, configurable: true })
  }

  // an error outside the command's promise chain (a store or the network failing later)
  // ends this run, not the UI's process
  let finished = false
  const fatal = (err) => {
    if (finished) return
    finished = true
    post('stderr')('hs: ' + ((err && err.message) || String(err)))
    port.postMessage({ done: true, code: 1 })
    port.unref()
  }
  Bare.on('uncaughtException', fatal).on('unhandledRejection', fatal)

  let code = 0
  try {
    const cli = require('../cli')()
    const program = cli.parse(argv)
    if (program && program.running) await program.running
    code = process.exitCode || 0
  } catch (err) {
    // as bin.mjs reports it: the message, not paparam's stack text
    const msg = (err && err.message ? err.message : String(err))
      .split('\n')
      .filter((l) => !/^\s+at /.test(l))
      .join('\n')
      .trim()
      .replace(/^Error: /, '')
    post('stderr')('hs: ' + msg)
    code = 1
  }
  if (finished) return
  finished = true
  port.postMessage({ done: true, code })
  // let the thread end when its event loop drains, as a process exits: the command's stores
  // may still be flushing and closing (terminating here left writes a reader then tripped on)
  port.unref()
}
