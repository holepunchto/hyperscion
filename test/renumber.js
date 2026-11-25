// "your land #n is now #m" is about one workspace's last land: switching workspaces isn't a
// renumbering (the README quick start printed "your land #2 is now #1" after `ws switch`)
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const tmp = require('test-tmp')
const { env } = require('bare-process')
const { run } = require('./helpers/team')

test('renumber note: switching workspaces is not a renumbering', async (t) => {
  const dir = await tmp(t)
  const hs = async (args) => {
    const res = await run(dir, args, env)
    t.is(res.code, 0, args.join(' ') + ': ' + res.stderr)
    return res.stdout + res.stderr
  }
  await hs(['init', '--as', 'me'])
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n')
  t.ok((await hs(['land', '--offline', '-m', 'first'])).includes('landed #1'))
  await hs(['ws', 'new', 'feature'])
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello world\n')
  t.ok((await hs(['land', '--offline', '-m', 'feature'])).includes('landed #2'))

  await hs(['ws', 'switch', 'default'])
  const synced = await hs(['sync', '--offline'])
  t.absent(/is now #/.test(synced), synced)
  t.ok(synced.includes('synced to main #2'), synced)

  // and back: the feature workspace's land is still #2
  await hs(['ws', 'switch', 'feature'])
  t.absent(/is now #/.test(await hs(['sync', '--offline'])))
})
