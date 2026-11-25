// docs/trial.md end to end with the real binary: a git worktree of a checkout becomes an hs repo
// with a hub, `import-git --tip` brings the files in (and pushes them, so a clone gets them), an
// agent lands, and `export-git` writes its land back as a git branch on the imported commit
const test = require('brittle')
const b4a = require('b4a')
const fs = require('bare-fs')
const path = require('bare-path')
const { spawn } = require('bare-subprocess')
const tmp = require('test-tmp')
const createTestnet = require('hyperdht/testnet')
const { run, background, waitFor } = require('./helpers/team')

test('trial: git worktree in, an agent lands, export-git out', { timeout: 300000 }, async (t) => {
  const testnet = await createTestnet(3, t.teardown)
  const env = {
    ...require('bare-process').env,
    HS_BOOTSTRAP: testnet.bootstrap.map((b) => b.host + ':' + b.port).join(',')
  }
  const hs = (cwd, args, user = 'me') => run(cwd, args, { ...env, USER: user })

  const dir = await tmp(t)
  const app = path.join(dir, 'app')
  fs.mkdirSync(path.join(app, 'src'), { recursive: true })
  await git(app, ['init', '-q', '-b', 'main', '.'])
  fs.writeFileSync(path.join(app, 'a.txt'), 'one\n')
  fs.writeFileSync(path.join(app, 'src', 'x.js'), 'x\n')
  await git(app, ['add', '-A'])
  await git(app, ['commit', '-qm', 'first'])
  fs.writeFileSync(path.join(app, 'a.txt'), 'two\n')
  await git(app, ['commit', '-qam', 'second'])
  const imported = await git(app, ['rev-parse', 'HEAD'])

  const trial = path.join(dir, 'app-trial')
  const swarm = path.join(trial, 'swarm')
  await git(app, ['worktree', 'add', '-q', '--detach', swarm])
  const init = await hs(swarm, ['init', '--as', 'me', '--hub', '../hub'])
  t.is(init.code, 0, init.stderr)
  const invite = init.stdout.match(/^repo (\S+)/m)[1]
  t.is(await git(swarm, ['status', '--porcelain']), '', '.hs/ stays out of git, in a worktree')

  const seed = background(path.join(trial, 'hub'), ['seed', '--admit', '../admit'], env)
  t.teardown(() => seed.stop(), { order: 1 })
  await waitFor(() => seed.output().includes('admitting'), 30_000)

  const imp = await hs(swarm, ['import-git', '--tip'])
  t.is(imp.code, 0, imp.stderr)
  t.ok(/imported 1 commits as 1 changesets, 2 path changes/.test(imp.stdout), imp.stdout)
  t.ok(imp.stdout.includes('pushed'), 'the import reached the hub')
  t.is((await hs(swarm, ['sync'])).code, 0)

  const clone = await hs(
    trial,
    ['clone', invite, 'agent-1', '--as', 'a1', '--admit', 'admit'],
    'a1'
  )
  t.is(clone.code, 0, clone.stderr)
  t.ok(/: 2 file\(s\)/.test(clone.stdout), 'a clone gets the imported files: ' + clone.stdout)
  const agent = path.join(trial, 'agent-1')
  await waitFor(async () => {
    await hs(agent, ['fetch'], 'a1')
    return (await hs(agent, ['info'], 'a1')).stdout.includes('(writable)')
  }, 30_000)
  fs.writeFileSync(path.join(agent, 'src', 'feat.js'), 'feat\n')
  const land = await hs(agent, ['land', '-m', 'a1: add feat'], 'a1')
  t.ok(/#2 final/.test(land.stdout), land.stdout + land.stderr)

  // the owner's worktree last synced at #1: export brings main up to date itself
  const out = await hs(swarm, ['export-git', 'swarm-results'])
  t.is(out.code, 0, out.stderr)
  t.ok(out.stdout.includes('wrote #2..#2 as 1 commit(s) on swarm-results'), out.stdout)
  t.is(await git(app, ['rev-parse', 'swarm-results~1']), imported, 'on the imported commit')
  t.is(await git(app, ['log', '-1', '--format=%an|%s', 'swarm-results']), 'a1|a1: add feat')
  t.is(await git(app, ['show', 'swarm-results:src/feat.js']), 'feat')
  t.is(await git(app, ['status', '--porcelain']), '', 'the checkout is untouched')

  await seed.stop()
  await git(app, ['worktree', 'remove', '--force', swarm])
  fs.rmSync(trial, { recursive: true, force: true })
  t.is(
    await git(app, ['worktree', 'list', '--porcelain']).then((s) => s.split('worktree ').length),
    2
  )
})

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
