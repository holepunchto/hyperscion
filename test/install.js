// `npm init hs` runs install.js (the bin of create-hs): it asks before installing, and refuses
// while package.json's upgrade link is still the placeholder (no release to fetch yet)
const test = require('brittle')
const path = require('bare-path')
const { spawn } = require('bare-subprocess')
const b4a = require('b4a')
const { env } = require('bare-process')
const pkg = require('../package.json')

const INSTALL = path.join(__dirname, '..', 'install.js')
const placeholder = !/^pear:\/\/[a-z0-9]+/i.test(pkg.upgrade || '') || pkg.upgrade.includes('<')

function node(input, extraEnv = {}) {
  return new Promise((resolve) => {
    const e = { ...env, ...extraEnv }
    delete e.npm_config_yes
    const p = spawn('node', [INSTALL], { env: e })
    const out = []
    p.stdout.on('data', (d) => out.push(d))
    p.stderr.on('data', (d) => out.push(d))
    p.on('exit', (code) => resolve({ code, out: b4a.toString(b4a.concat(out)) }))
    p.stdin.end(input)
  })
}

test('install: the package is create-hs, installing the hs binary', (t) => {
  t.is(pkg.name, 'create-hs', '`npm init hs` runs create-hs')
  t.is(pkg.productName, 'hs')
  t.is(pkg.bin['create-hs'], 'install.js', 'the installer is not named hs, so it never shadows hs')
  t.alike(pkg.files, ['install.js', 'README.md', 'LICENSE'], 'only the installer ships')
  t.absent(pkg.dependencies, 'no runtime dependencies: npm init downloads only the installer')
})

test('install: asks first, and refuses without a release link', async (t) => {
  if (placeholder) {
    const r = await node('y\n')
    t.is(r.code, 1)
    t.ok(/no pear:\/\/ link/.test(r.out), r.out)
    return
  }
  const r = await node('n\n')
  t.is(r.code, 0, 'declined: nothing installed')
  t.ok(/Install hs to /.test(r.out), r.out)
})
