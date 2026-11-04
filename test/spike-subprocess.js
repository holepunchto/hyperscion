// Spike D: bare-subprocess can stream `git fast-export` for the importer.
const test = require('brittle')
const { spawn } = require('bare-subprocess')
const fs = require('bare-fs')
const path = require('bare-path')
const tmp = require('test-tmp')

test('stream git fast-export through bare-subprocess', async (t) => {
  const dir = await tmp(t)
  await run('git', ['init', '-q', '-b', 'main', dir])
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), `content ${i}\n`)
    await run('git', ['-C', dir, 'add', '.'])
    await run('git', [
      '-C',
      dir,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-qm',
      `c${i}`
    ])
  }

  const out = await run('git', ['-C', dir, 'fast-export', '--reencode=yes', 'main'])
  const text = out.toString()
  t.is(text.match(/^commit /gm).length, 3)
  t.ok(text.includes('content 2'))
})

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args)
    const chunks = []
    p.stdout.on('data', (d) => chunks.push(d))
    p.on('exit', (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(cmd + ' ' + code))
    )
  })
}
