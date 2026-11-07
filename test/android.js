// lib/stdio.js: on Android, console output and uncaught errors reach fds 1 and 2 (Bare's
// console writes to logcat there). Simulated on any host by installing it for 'android'
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const b4a = require('b4a')
const tmp = require('test-tmp')
const { spawn } = require('bare-subprocess')

const STDIO = path.join(__dirname, '..', 'lib', 'stdio.js')

function runScript(file) {
  return new Promise((resolve) => {
    const p = spawn(os.execPath(), [file])
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

test('stdio: does nothing off Android', (t) => {
  const { install } = require('../lib/stdio')
  t.is(install('linux'), false)
})

test('stdio: on Android, console goes to fds 1 and 2; uncaught errors print and exit 1', async (t) => {
  const dir = await tmp(t)
  const file = path.join(dir, 'sim.js')
  fs.writeFileSync(
    file,
    `require(${JSON.stringify(STDIO)}).install('android')
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
