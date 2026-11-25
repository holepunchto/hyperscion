const test = require('brittle')
const b4a = require('b4a')
const fs = require('bare-fs')
const path = require('bare-path')
const { spawn } = require('bare-subprocess')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const Repo = require('../lib/repo')
const importGit = require('../lib/import-git')

test('import first-parent git history with authors, deletes and exec bits', async (t) => {
  const dir = await tmp(t)
  await run('git', ['init', '-q', '-b', 'main', dir])
  const commit = (msg) =>
    run('git', ['-C', dir, '-c', 'user.name=Ada', '-c', 'user.email=ada@x', 'commit', '-qm', msg])

  fs.writeFileSync(path.join(dir, 'a.txt'), 'a1\n')
  fs.mkdirSync(path.join(dir, 'bin'))
  fs.writeFileSync(path.join(dir, 'bin', 'run.sh'), '#!/bin/sh\n')
  fs.chmodSync(path.join(dir, 'bin', 'run.sh'), 0o755)
  await run('git', ['-C', dir, 'add', '.'])
  await commit('first')

  fs.writeFileSync(path.join(dir, 'a.txt'), 'a2\n')
  fs.writeFileSync(path.join(dir, 'b.bin'), b4a.alloc(100_000, 1))
  await run('git', ['-C', dir, 'add', '.'])
  await commit('second')

  await run('git', ['-C', dir, 'rm', '-q', 'bin/run.sh'])
  await commit('third')

  const store = new Corestore(await tmp(t))
  const repo = new Repo(store)
  await repo.ready()
  t.teardown(async () => {
    await repo.close()
    await store.close()
  })

  // chunk: 1 forces every path change into its own changeset (2 + 2 + 1)
  const stats = await importGit(repo, dir, { chunk: 1 })
  t.is(stats.commits, 3)
  t.is(stats.changesets, 5, 'large commits split into consecutive changesets')

  const drive = repo.drive()
  t.alike(await drive.get('/a.txt'), b4a.from('a2\n'))
  t.alike(await drive.get('/b.bin'), b4a.alloc(100_000, 1))
  t.is(await drive.entry('/bin/run.sh'), null)
  await drive.close()

  const log = []
  for await (const cs of repo.log()) log.push(cs)
  t.is(log[log.length - 1].author, 'Ada <ada@x>')
  t.ok(log[0].message.startsWith('third'))
})

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(cmd + ' ' + args.join(' ')))))
  })
}
