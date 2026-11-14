// hs <-> git+pear (lib/gitexport.js, lib/gip.js): main published as a git branch in a gip repo
// and git commits landed back. git is used here only to check the objects we write.
const test = require('brittle')
const b4a = require('b4a')
const fs = require('bare-fs')
const path = require('bare-path')
const { spawn } = require('bare-subprocess')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const { Remote } = require('gip-remote')
const { toDisk } = require('gip-remote/git')
const Repo = require('../lib/repo')
const gx = require('../lib/gitexport')
const gip = require('../lib/gip')

const put = (p, s) => ({ path: p, content: b4a.from(s) })

function git(cwd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd, env: { ...require('bare-process').env, ...env } })
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

async function landAll(repo, ws, changes, message) {
  await ws.commit(changes)
  const res = await ws.land({ message, author: 'me', time: 1_700_000_000_000 })
  await repo.ack()
  await repo.update()
  return res.outcome.seq
}

// every object reachable from a branch tip, as toDisk wants them
async function reachable(remote, oid, out = new Map()) {
  if (!oid || out.has(oid)) return out
  const obj = await remote.getObject(oid)
  out.set(oid, { id: oid, ...obj })
  if (obj.type === 'commit') {
    const cm = gx.parseCommit(obj.data)
    await reachable(remote, cm.tree, out)
    for (const p of cm.parents) await reachable(remote, p, out)
  } else if (obj.type === 'tree') {
    for (const e of gx.decodeTree(obj.data)) await reachable(remote, e.oid, out)
  }
  return out
}

test('gitexport: blobs, trees and commits hash as git does', async (t) => {
  const dir = await tmp(t)
  await git(dir, ['init', '-q', '.'])
  fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true })
  const files = { 'a/b/x.txt': 'one\n', 'a.txt': 'two\n', 'a-b': 'z\n', 'run.sh': '#!/bin/sh\n' }
  for (const [p, s] of Object.entries(files)) fs.writeFileSync(path.join(dir, p), s)
  fs.chmodSync(path.join(dir, 'run.sh'), 0o755)
  fs.symlinkSync('a.txt', path.join(dir, 'link'))
  await git(dir, ['add', '-A'])
  const who = { NAME: 'me', EMAIL: 'me@hs', DATE: '1700000000 +0000' }
  const env = {}
  for (const role of ['AUTHOR', 'COMMITTER']) {
    for (const [k, v] of Object.entries(who)) env[`GIT_${role}_${k}`] = v
  }
  await git(dir, ['commit', '-q', '-m', 'first', '-m', 'Hs-Changeset: abc#1'], env)

  const tree = new gx.TreeBuilder()
  for (const [p, s] of Object.entries(files)) {
    const mode = p === 'run.sh' ? gx.MODE_EXEC : gx.MODE_FILE
    tree.set('/' + p, { mode, oid: gx.object('blob', b4a.from(s)).oid })
  }
  tree.set('/link', { mode: gx.MODE_LINK, oid: gx.object('blob', b4a.from('a.txt')).oid })
  const objects = new Map()
  const root = tree.flush(objects)
  t.is(root, await git(dir, ['rev-parse', 'HEAD^{tree}']), 'tree: entry order, modes, symlink')
  const cs = { seq: 1, author: 'me', time: 1_700_000_000_000, message: 'first' }
  t.is(gx.commit({ tree: root, cs, repoId: 'abc' }).oid, await git(dir, ['rev-parse', 'HEAD']))

  tree.delete('/a/b/x.txt')
  await git(dir, ['rm', '-q', 'a/b/x.txt'])
  t.is(tree.flush(objects), await git(dir, ['write-tree']), 'emptied directories are dropped')

  const reloaded = await gx.TreeBuilder.from(root, (oid) => objects.get(oid))
  t.alike(reloaded.files().length, 5, 'a tree loads back from its objects')
})

test('gip: publish main as a git branch, resume from the tip, round trip through git', async (t) => {
  const { store, repo } = await setup(t)
  const ws = await repo.workspace('w')
  await landAll(repo, ws, [put('/README.md', 'hello\n'), put('/src/a.js', 'a\n')], 'first')
  await landAll(
    repo,
    ws,
    [put('/src/a.js', 'a\nb\n'), { path: '/README.md', content: null }],
    'two'
  )

  const remote = gip.open(store, 'demo')
  t.teardown(() => remote.close())
  const first = await gip.publish(repo, remote)
  t.is(first.commits, 2)
  t.is(first.to, 2)
  t.is((await gip.publish(repo, remote)).commits, 0, 'nothing new: nothing pushed')

  await landAll(repo, ws, [put('/src/deep/c.js', 'c\n')], 'three')
  const again = await gip.publish(repo, remote)
  t.is(again.from, 2, 'resumes from the tip commit trailer')
  t.is(again.commits, 1)

  // the same main exported from scratch gives the same commits
  const fresh = new Remote(store.namespace('other'), 'demo2')
  t.teardown(() => fresh.close())
  t.is((await gip.publish(repo, fresh)).tip, again.tip, 'deterministic')

  // gip-remote's own toDisk rebuilds a git repo that git reads back
  const dir = await tmp(t)
  await git(dir, ['init', '-q', '.'])
  const objects = [...(await reachable(remote, again.tip)).values()]
  await toDisk({ gitDir: path.join(dir, '.git'), objects, refs: { 'refs/heads/main': again.tip } })
  await git(dir, ['checkout', '-q', 'main'])
  t.is(await git(dir, ['log', '--format=%s', 'main']), 'three\ntwo\nfirst')
  t.is(await git(dir, ['ls-files']), 'src/a.js\nsrc/deep/c.js')
  t.is(fs.readFileSync(path.join(dir, 'src/a.js'), 'utf8'), 'a\nb\n')
  t.is(await git(dir, ['fsck', '--strict']), '', 'git finds nothing wrong')
  t.is(await git(dir, ['log', '-1', '--format=%an <%ae>']), 'me <me@hs>')
})

test('gip: a changeset of more than 100 paths, and binary content, export whole', async (t) => {
  const { store, repo } = await setup(t)
  const ws = await repo.workspace('w')
  const many = []
  for (let i = 0; i < 150; i++) many.push(put(`/d${i % 7}/f${i}.txt`, `${i}\n`))
  many.push({ path: '/bin.dat', content: b4a.from([0, 1, 2, 255, 0]) })
  await landAll(repo, ws, many, 'big')
  const gone = []
  for (let i = 0; i < 120; i++) gone.push({ path: `/d${i % 7}/f${i}.txt`, content: null })
  await landAll(repo, ws, gone, 'drop')

  const remote = gip.open(store, 'big')
  t.teardown(() => remote.close())
  const pub = await gip.publish(repo, remote)
  t.is(pub.commits, 2)

  const dir = await tmp(t)
  await git(dir, ['init', '-q', '.'])
  const objects = [...(await reachable(remote, pub.tip)).values()]
  await toDisk({ gitDir: path.join(dir, '.git'), objects, refs: { 'refs/heads/main': pub.tip } })
  await git(dir, ['checkout', '-q', 'main'])
  t.is((await git(dir, ['ls-files'])).split('\n').length, 31, '30 files and bin.dat')
  t.alike([...fs.readFileSync(path.join(dir, 'bin.dat'))], [0, 1, 2, 255, 0])
  t.is((await git(dir, ['show', '--format=', '--name-only', 'main~1'])).split('\n').length, 151)
})

test('gip: commits pushed on top of a published one land back, merged and idempotent', async (t) => {
  const { store, repo } = await setup(t)
  const ws = await repo.workspace('w')
  await landAll(repo, ws, [put('/a.txt', 'one\ntwo\nthree\n'), put('/b.txt', 'b\n')], 'first')
  const remote = gip.open(store, 'demo')
  t.teardown(() => remote.close())
  const pub = await gip.publish(repo, remote)

  // a human clones it (toDisk), commits with git, and pushes to their own gip repo
  const dir = await tmp(t)
  await git(dir, ['init', '-q', '.'])
  const objects = [...(await reachable(remote, pub.tip)).values()]
  await toDisk({ gitDir: path.join(dir, '.git'), objects, refs: { 'refs/heads/main': pub.tip } })
  await git(dir, ['checkout', '-q', 'main'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n')
  const env = { GIT_AUTHOR_NAME: 'Human', GIT_AUTHOR_EMAIL: 'h@x', GIT_COMMITTER_NAME: 'Human' }
  env.GIT_COMMITTER_EMAIL = 'h@x'
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'from git'], env)
  const theirs = new Remote(store.namespace('human'), 'fork')
  t.teardown(() => theirs.close())
  await pushDir(theirs, dir)

  // meanwhile an agent changed the top of a.txt on main: a clean 3-way merge
  await landAll(repo, ws, [put('/a.txt', 'ONE\ntwo\nthree\n')], 'agent')

  const res = await gip.importFrom(repo, theirs)
  t.is(res.fork, 1)
  t.is(res.imported.length, 1)
  t.alike(res.conflicts, [])
  await repo.update()
  const cs = await repo.changeset(res.imported[0].seq)
  t.is(cs.author, 'Human <h@x>')
  t.ok(cs.message.startsWith('from git\n\nGit-Commit: '), cs.message)
  const drive = repo.drive()
  t.is(b4a.toString(await drive.get('/a.txt')), 'ONE\ntwo\nthree\nfour\n', 'merged')
  t.is(b4a.toString(await drive.get('/new.txt')), 'new\n')
  await drive.close()

  t.is((await gip.importFrom(repo, theirs)).imported.length, 0, 'already imported')

  // published back, the import comes out as an hs commit: the next import has nothing to do
  await repo.ack()
  await repo.update()
  t.is((await gip.publish(repo, remote)).commits, 2)
  await pushRef(theirs, remote, 'main')
  t.is((await gip.importFrom(repo, theirs)).imported.length, 0, 'never re-imported')
})

test('gip: an import that conflicts with main stops and lands nothing', async (t) => {
  const { store, repo } = await setup(t)
  const ws = await repo.workspace('w')
  await landAll(repo, ws, [put('/a.txt', 'one\n')], 'first')
  const remote = gip.open(store, 'demo')
  t.teardown(() => remote.close())
  const pub = await gip.publish(repo, remote)

  const dir = await tmp(t)
  await git(dir, ['init', '-q', '.'])
  const objects = [...(await reachable(remote, pub.tip)).values()]
  await toDisk({ gitDir: path.join(dir, '.git'), objects, refs: { 'refs/heads/main': pub.tip } })
  await git(dir, ['checkout', '-q', 'main'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'theirs\n')
  await git(dir, ['commit', '-q', '-am', 'mine'], { GIT_AUTHOR_NAME: 'h', GIT_AUTHOR_EMAIL: 'h@x' })
  const theirs = new Remote(store.namespace('human'), 'fork')
  t.teardown(() => theirs.close())
  await pushDir(theirs, dir)

  const seq = await landAll(repo, ws, [put('/a.txt', 'ours\n')], 'agent')
  const res = await gip.importFrom(repo, theirs)
  t.alike(res.conflicts, ['/a.txt'])
  t.is(res.imported.length, 0)
  t.is((await repo.meta()).seq, seq, 'nothing landed')
})

// a published repo checked out with git (as `git clone git+pear://…` would)
async function checkoutOf(t, remote, tip) {
  const dir = await tmp(t)
  await git(dir, ['init', '-q', '.'])
  const objects = [...(await reachable(remote, tip)).values()]
  await toDisk({ gitDir: path.join(dir, '.git'), objects, refs: { 'refs/heads/main': tip } })
  await git(dir, ['checkout', '-q', 'main'])
  return dir
}

const HUMAN = {
  GIT_AUTHOR_NAME: 'Human',
  GIT_AUTHOR_EMAIL: 'h@x',
  GIT_COMMITTER_NAME: 'Human',
  GIT_COMMITTER_EMAIL: 'h@x'
}

test('gip: a mode-only change imports', async (t) => {
  const { store, repo } = await setup(t)
  const ws = await repo.workspace('w')
  await landAll(repo, ws, [put('/run.sh', 'echo hi\n')], 'first')
  const remote = gip.open(store, 'demo')
  t.teardown(() => remote.close())
  const dir = await checkoutOf(t, remote, (await gip.publish(repo, remote)).tip)
  fs.chmodSync(path.join(dir, 'run.sh'), 0o755)
  await git(dir, ['commit', '-q', '-am', 'make it runnable'], HUMAN)
  const theirs = new Remote(store.namespace('human'), 'fork')
  t.teardown(() => theirs.close())
  await pushDir(theirs, dir)

  const res = await gip.importFrom(repo, theirs)
  t.is(res.imported.length, 1)
  const drive = repo.drive()
  t.ok((await drive.entry('/run.sh')).value.executable, 'executable on main')
  await drive.close()
})

test('gip: an amended published commit keeps the trailer but still imports', async (t) => {
  const { store, repo } = await setup(t)
  const ws = await repo.workspace('w')
  await landAll(repo, ws, [put('/a.txt', 'a\n')], 'first')
  await landAll(repo, ws, [put('/b.txt', 'b\n')], 'second')
  const remote = gip.open(store, 'demo')
  t.teardown(() => remote.close())
  const dir = await checkoutOf(t, remote, (await gip.publish(repo, remote)).tip)
  fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n')
  await git(dir, ['add', 'c.txt'])
  await git(dir, ['commit', '-q', '--amend', '--no-edit'], {
    ...HUMAN,
    GIT_COMMITTER_DATE: '1800000000 +0000'
  })
  t.ok(
    /Hs-Changeset: /.test(await git(dir, ['log', '-1', '--format=%B'])),
    'the trailer is still there'
  )
  const theirs = new Remote(store.namespace('human'), 'fork')
  t.teardown(() => theirs.close())
  await pushDir(theirs, dir)

  const res = await gip.importFrom(repo, theirs)
  t.is(res.fork, 1, 'the fork point is the last commit exactly as published')
  t.is(res.imported.length, 1)
  const drive = repo.drive()
  t.is(b4a.toString(await drive.get('/c.txt')), 'c\n', 'the amendment landed')
  await drive.close()
})

test('gip: the CLI refuses to publish an encrypted repo, and acks its own imports', async (t) => {
  const { run } = require('./helpers/team')
  const { env } = require('bare-process')
  const e = { ...env, HS_SURFACE: '', USER: 'me' }

  const enc = await tmp(t)
  t.is((await run(enc, ['init', '--as', 'me', '--encrypt'], e)).code, 0)
  const refused = await run(enc, ['gip', 'publish'], e)
  t.is(refused.code, 1)
  t.ok(/encrypted/.test(refused.stderr), refused.stderr)

  // a git history imported into a solo repo publishes whole, no `hs land` needed in between
  const src = await tmp(t)
  await git(src, ['init', '-q', '-b', 'main', '.'])
  for (const n of ['one', 'two']) {
    fs.writeFileSync(path.join(src, n + '.txt'), n + '\n')
    await git(src, ['add', '-A'])
    await git(src, ['commit', '-q', '-m', n], HUMAN)
  }
  const dir = await tmp(t)
  await git(dir, ['init', '-q', '.'])
  t.is((await run(dir, ['init', '--as', 'me'], e)).code, 0)
  t.ok(
    fs.readFileSync(path.join(dir, '.git/info/exclude'), 'utf8').includes('/.hs/'),
    '.hs out of git'
  )
  t.is((await run(dir, ['import-git', src, '--branch', 'main'], e)).code, 0)
  const pub = await run(dir, ['gip', 'publish'], e)
  t.is(pub.code, 0, pub.stderr)
  t.ok(/published #1\.\.#2 as 2 commit/.test(pub.stdout), pub.stdout)
  t.ok(/^git\+pear:\/\/\w+\//m.test(pub.stdout), 'prints the link')
})

// push a git checkout's main to a gip Remote, as gip's remote helper does
async function pushDir(remote, dir) {
  const tip = await git(dir, ['rev-parse', 'main'])
  const list = (await git(dir, ['rev-list', '--objects', 'main'])).split('\n')
  const objects = new Map()
  for (const line of list) {
    const oid = line.split(' ')[0]
    const type = await git(dir, ['cat-file', '-t', oid])
    const data = await gitBytes(dir, ['cat-file', type, oid])
    objects.set(oid, { type, size: data.byteLength, data })
  }
  await remote.push('main', tip, objects)
}

// copy a branch from one gip Remote to another (a human fetching the hub's and pushing it)
async function pushRef(to, from, branch) {
  const ref = await from.getBranchRef(branch)
  const objects = new Map()
  for (const [oid, o] of await reachable(from, ref.oid)) {
    objects.set(oid, { type: o.type, size: o.size, data: o.data })
  }
  await to.push(branch, ref.oid, objects)
}

function gitBytes(cwd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd })
    const out = []
    p.stdout.on('data', (d) => out.push(d))
    p.on('exit', (code) => (code === 0 ? resolve(b4a.concat(out)) : reject(new Error(args[0]))))
  })
}
