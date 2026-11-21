// The trial round trip: `import-git --tip` brings a git branch in as one changeset, writers
// land on top, and `export-git` writes what landed back as a git branch on the imported commit
const test = require('brittle')
const b4a = require('b4a')
const fs = require('bare-fs')
const path = require('bare-path')
const { spawn } = require('bare-subprocess')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const Repo = require('../lib/repo')
const importGit = require('../lib/import-git')
const exportGit = require('../lib/export-git')
const { excludeFromGit } = require('../lib/context')

const put = (p, s) => ({ path: p, content: b4a.from(s) })

test('export-git: --tip in, lands on top, a branch out on the imported commit', async (t) => {
  const dir = await gitRepo(t)
  const { repo } = await setup(t)

  const stats = await importGit(repo, dir, { branch: 'main', tip: true })
  t.is(stats.changesets, 1, 'one changeset for the files as they are')
  t.is(stats.paths, 3, "every file of the tip, not only its commit's change")
  await settle(repo)
  const head = await git(dir, ['rev-parse', 'main'])
  const cs1 = await repo.changeset(1)
  t.ok(cs1.message.includes('git: ' + head), 'it says which commit it came from')

  const ws = await repo.workspace('agent')
  await ws.commit([put('/a.txt', 'a2\n'), put('/dir name/new file.txt', 'n\n')])
  await ws.land({ message: 'agent: change a, add a file', author: 'me' })
  await ws.commit([{ path: '/b.txt', content: null }])
  await ws.land({ message: 'agent: drop b', author: 'me' })
  await settle(repo)
  await ws.commit([put('/late.txt', 'l\n')])
  await ws.land({ message: 'not settled yet', author: 'me' }) // no ack: provisional

  const out = await exportGit(repo, dir, { branch: 'out' })
  t.is(out.base, 1)
  t.is(out.onto, head, 'on top of the imported commit')
  t.is(out.commits, 2, 'the settled changesets after the import')
  t.is(out.provisional, 1, 'the provisional one is left out')

  t.is(await git(dir, ['rev-list', '--count', 'main..out']), '2')
  t.is(await git(dir, ['show', 'out:a.txt']), 'a2')
  t.is(await git(dir, ['show', 'out:dir name/new file.txt']), 'n')
  await t.exception(git(dir, ['show', 'out:b.txt']), 'the delete came through')
  t.is(await git(dir, ['show', 'out:sub/run.sh']), '#!/bin/sh', 'files nobody touched stay')
  t.ok((await git(dir, ['ls-tree', 'out', 'sub/run.sh'])).startsWith('100755'), 'exec bit')
  const msg = await git(dir, ['log', '-1', '--format=%B', 'out'])
  t.ok(/^agent: drop b\n\nHs-Changeset: \w+#3$/.test(msg), msg)
  t.is(await git(dir, ['status', '--porcelain']), '', 'the checkout is untouched')

  await t.exception(exportGit(repo, dir, { branch: 'out' }), /exists/, 'never clobbers')
  const tip = await git(dir, ['rev-parse', 'out'])
  const again = await exportGit(repo, dir, { branch: 'out', force: true })
  t.is(again.tip, tip, 'the same main gives the same commits')

  const wt = path.join(await tmp(t), 'review')
  await git(dir, ['worktree', 'add', '-q', wt, 'out'])
  await t.exception(
    exportGit(repo, dir, { branch: 'out', force: true }),
    /checked out/,
    'not under a worktree that has it checked out'
  )

  const since = await exportGit(repo, dir, { branch: 'from2', since: 2, onto: 'main' })
  t.is(since.commits, 1, '--since picks the start by hand')
})

test('export-git: a repo with no git import needs --since', async (t) => {
  const dir = await gitRepo(t)
  const { repo } = await setup(t)
  const ws = await repo.workspace('w')
  await ws.commit([put('/x.txt', 'x\n')])
  await ws.land({ message: 'x', author: 'me' })
  await settle(repo)
  await t.exception(exportGit(repo, dir, { branch: 'out' }), /--since/)
  const s = await exportGit(repo, dir, { branch: 'out', since: 0, onto: 'main' })
  t.is(s.commits, 1)
  t.is(await git(dir, ['show', 'out:x.txt']), 'x')
})

test('excludeFromGit: a linked git worktree keeps .hs out of its status', async (t) => {
  const dir = await gitRepo(t)
  const wt = path.join(await tmp(t), 'wt')
  await git(dir, ['worktree', 'add', '-q', '-b', 'trial', wt])
  fs.mkdirSync(path.join(wt, '.hs'))
  fs.writeFileSync(path.join(wt, '.hs', 'config'), '{}')
  await excludeFromGit(wt)
  t.is(await git(wt, ['status', '--porcelain']), '', '.hs/ is not untracked')
  await excludeFromGit(wt)
  const lines = fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8').split('\n')
  t.is(lines.filter((l) => l === '/.hs/').length, 1, 'added once')
})

// a git repo on main: a.txt, b.txt, sub/run.sh (exec) over two commits
async function gitRepo(t) {
  const dir = await tmp(t)
  await git(dir, ['init', '-q', '-b', 'main', '.'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a1\n')
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'sub', 'run.sh'), '#!/bin/sh\n')
  fs.chmodSync(path.join(dir, 'sub', 'run.sh'), 0o755)
  await git(dir, ['add', '-A'])
  // and in git's index, for Windows, where git keeps no file modes (core.filemode false)
  await git(dir, ['update-index', '--chmod=+x', 'sub/run.sh'])
  await git(dir, ['commit', '-qm', 'first'])
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-qm', 'second'])
  return dir
}

async function setup(t) {
  const store = new Corestore(await tmp(t))
  const repo = new Repo(store)
  await repo.ready()
  t.teardown(async () => {
    await repo.close()
    await store.close()
  })
  return { store, repo }
}

async function settle(repo) {
  await repo.ack()
  await repo.update()
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    const env = {
      ...require('bare-process').env,
      GIT_AUTHOR_NAME: 'Ada',
      GIT_AUTHOR_EMAIL: 'ada@x',
      GIT_COMMITTER_NAME: 'Ada',
      GIT_COMMITTER_EMAIL: 'ada@x'
    }
    const p = spawn('git', args, { cwd, env })
    const out = []
    const err = []
    p.stdout.on('data', (d) => out.push(d))
    p.stderr.on('data', (d) => err.push(d))
    p.on('exit', (code) =>
      code === 0
        ? resolve(b4a.toString(b4a.concat(out)).trim())
        : reject(new Error(`git ${args.join(' ')}: ${b4a.toString(b4a.concat(err))}`))
    )
  })
}
