// .gitignore and .hsignore (lib/ignore.js): untracked files they match never show up or land;
// .hsignore layers on top of .gitignore (and can un-ignore); tracked files stay tracked
const test = require('brittle')
const b4a = require('b4a')
const fs = require('bare-fs')
const path = require('bare-path')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const Repo = require('../lib/repo')
const Worktree = require('../lib/worktree')
const { run } = require('./helpers/team')

const put = (p, s) => ({ path: p, content: b4a.from(s) })

async function setup(t, files) {
  const store = new Corestore(await tmp(t))
  const repo = new Repo(store)
  await repo.ready()
  t.teardown(async () => {
    await repo.close()
    await store.close()
  })
  const seed = await repo.workspace('seed')
  await seed.commit(Object.entries(files).map(([p, s]) => put(p, s)))
  await seed.land()
  const dir = await tmp(t)
  const wt = new Worktree(dir)
  const ws = await repo.workspace('w')
  await wt.checkout(ws)
  const write = (p, s) => {
    const abs = path.join(dir, ...p.split('/').filter(Boolean))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, s)
  }
  return { wt, ws, write }
}

test('ignore: .gitignore and .hsignore keep untracked files out', async (t) => {
  const { wt, ws, write } = await setup(t, {
    '/.gitignore': 'node_modules/\n*.log\ndist\n',
    '/.hsignore': '!dist/\nscratch/\n',
    '/sub/.gitignore': '*.tmp\n',
    '/old.log': 'tracked before the rule\n'
  })
  write('/src/a.js', 'a')
  write('/node_modules/x/index.js', 'dep')
  write('/debug.log', 'noise')
  write('/dist/out.js', 'built')
  write('/scratch/notes.md', 'mine')
  write('/sub/a.tmp', 'tmp')
  write('/sub/b.js', 'b')
  write('/old.log', 'tracked, edited\n')

  const st = await wt.status(ws)
  t.alike(
    st.map((c) => c.status + ' ' + c.path),
    ['added /dist/out.js', 'modified /old.log', 'added /src/a.js', 'added /sub/b.js'],
    'dist un-ignored by .hsignore; a tracked file matching *.log is still an edit'
  )
  t.alike(
    st.ignored,
    ['/debug.log', '/node_modules/', '/scratch/', '/sub/a.tmp'],
    'what was skipped'
  )

  await wt.commit(ws, st)
  const landed = []
  for await (const e of ws.drive.list('/')) landed.push(e.key)
  t.absent(
    landed.some((p) => /node_modules|debug\.log|scratch|a\.tmp/.test(p)),
    'nothing ignored is committed'
  )
})

test('ignore: a directory holding a tracked file is still walked', async (t) => {
  const { wt, ws, write } = await setup(t, {
    '/.gitignore': 'vendor/\n',
    '/vendor/kept.js': 'tracked\n'
  })
  write('/vendor/kept.js', 'tracked, edited\n')
  write('/vendor/new.js', 'untracked\n')
  const st = await wt.status(ws)
  t.alike(
    st.map((c) => c.status + ' ' + c.path),
    ['modified /vendor/kept.js']
  )
  t.alike(st.ignored, ['/vendor/new.js'])
})

test('ignore: hs status --ignored lists them', async (t) => {
  const dir = await tmp(t)
  const { env } = require('bare-process')
  const e = { ...env, HS_SURFACE: '', USER: 'me' }
  t.is((await run(dir, ['init', '--as', 'me'], e)).code, 0)
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n')
  fs.mkdirSync(path.join(dir, 'node_modules'))
  fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'dep')
  fs.writeFileSync(path.join(dir, 'a.js'), 'a')
  const st = await run(dir, ['status', '--ignored'], e)
  t.ok(/added\s+\/a\.js/.test(st.stdout), st.stdout)
  t.absent(/added\s+\/node_modules/.test(st.stdout), 'not an edit')
  t.ok(/ignored\s+\/node_modules\//.test(st.stdout), st.stdout)

  // a file landed before a rule matched it stays tracked, and --ignored says so
  fs.writeFileSync(path.join(dir, 'old.log'), 'kept')
  t.is((await run(dir, ['land', '-m', 'first'], e)).code, 0)
  fs.appendFileSync(path.join(dir, '.gitignore'), '*.log\n')
  const after = await run(dir, ['status', '--ignored'], e)
  t.ok(/tracked\s+\/old\.log/.test(after.stdout), after.stdout)
})
