#!/usr/bin/env node
'use strict'
// Smoke test of the built standalone binary (CI runs the quick tier against `bare bin.mjs`,
// never the binary). Each command runs twice: bare-build runtimes have hung at exit only
// from the second run on (addons already unpacked). Usage: node scripts/smoke.js [binary]
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const exe = process.platform === 'win32' ? 'hs.exe' : 'hs'
const bin = path.resolve(process.argv[2] || path.join('out', 'make', exe))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-smoke-'))
const env = {
  ...process.env,
  HOME: dir,
  USERPROFILE: dir,
  XDG_CONFIG_HOME: path.join(dir, '.config')
}

let failed = 0
function run(args, { cwd = dir, expect = 0 } = {}) {
  const t0 = Date.now()
  const r = spawnSync(bin, args, { cwd, env, encoding: 'utf8', timeout: 30_000 })
  const ms = Date.now() - t0
  const hung = r.error && r.error.code === 'ETIMEDOUT'
  const ok = !hung && r.status === expect
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} hs ${args.join(' ')} (exit ${hung ? 'timeout' : r.status}, ${ms} ms)`
  )
  if (!ok) {
    failed++
    console.log((r.stdout || '') + (r.stderr || ''))
  }
  return r
}

for (let i = 0; i < 2; i++) {
  run(['--version'])
  run(['help', 'land'])
  run(['task', '--help'])
  run(['no-such-command'], { expect: 1 })
}
const repo = path.join(dir, 'repo')
run(['init', repo, '--as', 'me'])
fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
for (let i = 0; i < 2; i++) run(['status'], { cwd: repo })
run(['land', '--offline', '-m', 'smoke'], { cwd: repo })
run(['log', '--oneline'], { cwd: repo })
run(['info'], { cwd: repo })

fs.rmSync(dir, { recursive: true, force: true })
if (failed) {
  console.log(`${failed} smoke check(s) failed`)
  process.exit(1)
}
console.log('smoke: ok')
