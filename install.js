#!/usr/bin/env node
// `npm init hyperscion` runs this (npm runs the bin of create-hyperscion): it fetches the
// hs binary peer-to-peer with pear-install, the library behind `pear install`, into
// ~/.local/bin (or %LOCALAPPDATA%\Programs on Windows). `npm init -y hyperscion` skips the
// question. The package is named for the project; the binary it installs is hs.
const fs = require('fs')
const { spawn } = require('child_process')
const { productName, upgrade } = require('./package.json')

const target =
  process.platform === 'win32'
    ? '%LOCALAPPDATA%\\Programs\\' + productName + '\\' + productName + '.exe'
    : '~/.local/bin/' + productName

if (!/^pear:\/\/[a-z0-9]+/i.test(upgrade || '') || upgrade.includes('<')) {
  console.error(productName + ': this release has no pear:// link to install from yet')
  process.exit(1)
}

let install = process.env.npm_config_yes ?? false
if (install === false) {
  fs.writeSync(1, 'Install ' + productName + ' to ' + target + ' [y|N]? ')
  const buf = Buffer.alloc(8)
  let n = 0
  try {
    n = fs.readSync(0, buf, 0, buf.length)
  } catch {}
  install = n > 0 && (buf[0] === 'y'.charCodeAt(0) || buf[0] === 'Y'.charCodeAt(0))
}

if (install) {
  const sp = spawn('npx', ['-y', 'pear-install', upgrade], {
    stdio: ['inherit', 'pipe', 'inherit'],
    shell: process.platform === 'win32'
  })

  // pear-install keeps seeding for a moment after "Installed": say why it hasn't exited
  let acc = ''
  let timer = null
  sp.stdout.on('data', (data) => {
    process.stdout.write(data)
    if (timer) return
    acc += data.toString()
    if (acc.includes('Installed')) {
      timer = setTimeout(() => {
        console.log('Exiting, please wait...')
      }, 3250)
    } else if (acc.length > 512) {
      acc = acc.slice(-512)
    }
  })

  sp.once('exit', (code) => {
    if (timer) clearTimeout(timer)
    process.exit(code)
  })
}
