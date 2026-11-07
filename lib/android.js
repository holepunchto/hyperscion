// hs as a CLI on Android (Termux). bin.mjs imports this first, so it runs before anything
// else loads; elsewhere it does nothing.
//
// 1. Native addons. Android prebuilds (sodium-native, udx-native) link libc++_shared.so, which
//    an Android app ships in its APK. A shell has no APK: Termux has the library in
//    $PREFIX/lib (`pkg install libc++`), but the loader only searches there when
//    LD_LIBRARY_PATH says so, and it reads that once, at process start. So when it's missing we
//    run ourselves again with it set, wait, and exit with the child's code.
// 2. Output. Bare's console writes to the system log (logcat) on Android, which a terminal
//    never shows: every line vanishes, and an uncaught error aborts (exit 134) silently. Console
//    goes to fds 1 and 2 instead, and uncaught errors are printed before exiting.
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const env = require('bare-env')
const { format } = require('bare-format')

const LIBCXX = 'libc++_shared.so'
const HINT =
  'native addons need ' + LIBCXX + ': in Termux, `pkg install libc++` (or set LD_LIBRARY_PATH)'

// the directory holding libc++_shared.so, when the loader can't already see it: null if it is on
// LD_LIBRARY_PATH, or isn't to be found
function libraryPath(e = env) {
  const dirs = (e.LD_LIBRARY_PATH || '').split(':').filter(Boolean)
  const candidates = [e.PREFIX && path.join(e.PREFIX, 'lib'), '/data/data/com.termux/files/usr/lib']
  for (const dir of candidates) {
    if (!dir || dirs.includes(dir)) continue
    if (fs.existsSync(path.join(dir, LIBCXX))) return dir
  }
  return null
}

// run this command again with the library path set; returns the exit code, or null when there
// is no need (or it already happened once: never loop)
function reexec(argv = Bare.argv) {
  if (env.HS_ANDROID_REEXEC) return null
  const dir = libraryPath()
  if (!dir) return null
  const { spawnSync } = require('bare-subprocess')
  const ld = [dir, env.LD_LIBRARY_PATH].filter(Boolean).join(':')
  const res = spawnSync(os.execPath(), argv.slice(1), {
    stdio: 'inherit',
    env: { ...env, LD_LIBRARY_PATH: ld, HS_ANDROID_REEXEC: '1' }
  })
  if (res.error) return null // run here instead; the addon error then says what's missing
  if (res.signal) return 128 + (os.constants.signals[res.signal] || 6)
  return res.status === null ? 1 : res.status
}

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
    let msg = e && e.stack ? e.stack : String(e)
    if (/Cannot load addon/.test(msg)) msg += '\n' + HINT
    err('hs: ' + msg)
    Bare.exit(1)
  }
  Bare.on('uncaughtException', fatal).on('unhandledRejection', fatal)
  return true
}

if (Bare.platform === 'android') {
  const code = reexec()
  if (code !== null) Bare.exit(code)
  install()
}

module.exports = { install, libraryPath, reexec }
