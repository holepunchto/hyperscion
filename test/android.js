// lib/android.js: hs as a CLI in Termux. Simulated on any host: output goes to fds 1 and 2
// (Bare's console writes to logcat there), and a missing libc++ search path re-runs the command
// with LD_LIBRARY_PATH set
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const b4a = require('b4a')
const tmp = require('test-tmp')
const { spawn } = require('bare-subprocess')

const ANDROID = path.join(__dirname, '..', 'lib', 'android.js')

function runScript(file, env) {
  return new Promise((resolve) => {
    const p = spawn(os.execPath(), [file], env ? { env } : {})
    const out = []
    const err = []
    p.stdout.on('data', (d) => out.push(d))
    p.stderr.on('data', (d) => err.push(d))
    p.on('exit', (code) =>
      resolve({
        code,
        stdout: b4a.toString(b4a.concat(out)),
        stderr: b4a.toString(b4a.concat(err))
      })
    )
  })
}

test('android: output setup does nothing off Android', (t) => {
  const { install } = require('../lib/android')
  t.is(install('linux'), false)
})

test('android: console goes to fds 1 and 2; uncaught errors print and exit 1', async (t) => {
  const dir = await tmp(t)
  const file = path.join(dir, 'sim.js')
  fs.writeFileSync(
    file,
    `require(${JSON.stringify(ANDROID)}).install('android')
console.log('out', { a: 1 })
console.error('err %d', 5)
Promise.reject(new Error('boom'))
`
  )
  const res = await runScript(file)
  t.is(res.code, 1, 'exits 1, not an abort')
  t.is(res.stdout, 'out { a: 1 }\n')
  t.ok(res.stderr.startsWith('err 5\nhs: Error: boom'), res.stderr)
})

test('android: a libc++ the loader cannot see is found under $PREFIX/lib', async (t) => {
  const prefix = await tmp(t)
  fs.mkdirSync(path.join(prefix, 'lib'))
  const { libraryPath } = require('../lib/android')
  t.is(libraryPath({ PREFIX: prefix }), null, 'no libc++ there: nothing to do')
  fs.writeFileSync(path.join(prefix, 'lib', 'libc++_shared.so'), '')
  t.is(libraryPath({ PREFIX: prefix }), path.join(prefix, 'lib'))
  t.is(
    libraryPath({ PREFIX: prefix, LD_LIBRARY_PATH: '/x:' + path.join(prefix, 'lib') }),
    null,
    'already on LD_LIBRARY_PATH'
  )
})

test('android: re-runs the command once with LD_LIBRARY_PATH set, and passes its exit code on', async (t) => {
  const prefix = await tmp(t)
  fs.mkdirSync(path.join(prefix, 'lib'))
  fs.writeFileSync(path.join(prefix, 'lib', 'libc++_shared.so'), '')
  const file = path.join(prefix, 'sim.js')
  fs.writeFileSync(
    file,
    `const env = require(${JSON.stringify(require.resolve('bare-env'))})
const fs = require(${JSON.stringify(require.resolve('bare-fs'))})
if (env.HS_ANDROID_REEXEC) {
  fs.writeSync(1, 'child ' + env.LD_LIBRARY_PATH + '\\n')
  Bare.exit(7)
}
const code = require(${JSON.stringify(ANDROID)}).reexec()
fs.writeSync(1, 'parent ' + code + '\\n')
`
  )
  const { env } = require('bare-process')
  const res = await runScript(file, { ...env, PREFIX: prefix, LD_LIBRARY_PATH: '/old' })
  t.is(res.code, 0, res.stderr)
  t.is(res.stdout, `child ${path.join(prefix, 'lib')}:/old\nparent 7\n`)
})
