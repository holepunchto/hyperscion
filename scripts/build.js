#!/usr/bin/env node
'use strict'
// Builds the pear deployment folder (out/pear) from whatever binaries `npm run make:*` left in
// out/<host>/. The staged package.json is not ours verbatim: pear install fetches one binary per
// `bin` key from /by-arch/<host>/app/<key>, and our `bin` is create-hyperscion (the npm init
// installer), so the staged copy maps `bin` to hs (productName) instead.
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const pkg = require('../package.json')
const name = pkg.productName
const target = path.join(root, 'out', 'pear')
const manifest = path.join(root, 'out', 'pear-package.json')
const hosts = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']

if (!/^pear:\/\/[a-z0-9]+$/i.test(pkg.upgrade || '')) {
  console.error('package.json upgrade is not a pear:// link; create one with `pear touch`')
  process.exit(1)
}

const args = ['build', '--package', manifest, '--target', target]
for (const host of hosts) {
  const bin = path.join(root, 'out', host, host.startsWith('win32-') ? name + '.exe' : name)
  if (fs.existsSync(bin)) args.push('--' + host + '-app', bin)
}
if (args.length === 5) {
  console.error('no binaries in out/<host>/; run `npm run make:<host>` first')
  process.exit(1)
}

fs.writeFileSync(manifest, JSON.stringify({ ...pkg, bin: { [name]: 'bin.mjs' } }, null, 2) + '\n')
fs.rmSync(target, { recursive: true, force: true })

const res = spawnSync('pear', args, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
process.exit(res.status ?? 1)
