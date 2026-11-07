// On Android, Bare's console writes to the system log (logcat), not the terminal. That's right for
// an app embedding Bare and wrong for a CLI in Termux: every line hs prints vanishes, and an
// uncaught error aborts (exit 134) without a word. There, console goes to fds 1 and 2 instead,
// and uncaught errors are printed before exiting. bin.mjs imports this first, so it is in place
// before anything else loads. Elsewhere it does nothing.
const fs = require('bare-fs')
const { format } = require('bare-format')

function install(platform = Bare.platform) {
  if (platform !== 'android') return false

  const writer =
    (fd) =>
    (...args) => {
      try {
        fs.writeSync(fd, format(...args) + '\n')
      } catch {}
    }
  const out = writer(1)
  const err = writer(2)
  console.log = console.info = console.debug = out
  console.error = console.warn = console.trace = err

  const fatal = (e) => {
    err('hs: ' + (e && e.stack ? e.stack : String(e)))
    Bare.exit(1)
  }
  Bare.on('uncaughtException', fatal).on('unhandledRejection', fatal)
  return true
}

install()

module.exports = { install }
