const test = require('brittle')
const b4a = require('b4a')
const fs = require('bare-fs')
const path = require('bare-path')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const Repo = require('../lib/repo')
const Worktree = require('../lib/worktree')

const put = (p, s) => ({ path: p, content: b4a.from(s) })

async function setup(t) {
  const store = new Corestore(await tmp(t))
  const repo = new Repo(store)
  await repo.ready()
  t.teardown(async () => {
    await repo.close()
    await store.close()
  })
  return repo
}

test('checkout, edit, status, commit round-trip', async (t) => {
  const repo = await setup(t)
  const seed = await repo.workspace('seed')
  await seed.commit([put('/a.txt', 'a\n'), put('/dir/b.txt', 'b\n'), put('/dir/c.txt', 'c\n')])
  await seed.land()

  const dir = await tmp(t)
  const wt = new Worktree(dir)
  const ws = await repo.workspace('w')
  const stats = await wt.checkout(ws)
  t.is(stats.written, 3)
  t.is(fs.readFileSync(path.join(dir, 'dir', 'b.txt'), 'utf8'), 'b\n')

  t.alike([...(await wt.status(ws))], [], 'clean after checkout')
  t.is((await wt.checkout(ws)).skipped, 3, 'second checkout skips via stat cache')

  fs.writeFileSync(path.join(dir, 'a.txt'), 'A\n')
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new\n')
  fs.unlinkSync(path.join(dir, 'dir', 'c.txt'))

  const st = await wt.status(ws)
  t.alike(
    st.map((c) => c.status + ' ' + c.path),
    ['modified /a.txt', 'deleted /dir/c.txt', 'added /new.txt']
  )

  t.is((await wt.commit(ws)).committed, 3)
  t.alike([...(await wt.status(ws))], [])
  t.is((await ws.land()).outcome.status, 'accepted')

  const main = repo.drive()
  t.alike(await main.get('/a.txt'), b4a.from('A\n'))
  t.is(await main.entry('/dir/c.txt'), null)
  await main.close()
})

test('sparse checkout only materializes prefixes and never deletes outside them', async (t) => {
  const repo = await setup(t)
  const seed = await repo.workspace('seed')
  await seed.commit([put('/src/x.js', 'x'), put('/docs/y.md', 'y')])
  await seed.land()

  const dir = await tmp(t)
  const wt = new Worktree(dir, { sparse: ['/src'] })
  const ws = await repo.workspace('w')
  await wt.checkout(ws)

  t.ok(fs.existsSync(path.join(dir, 'src', 'x.js')))
  t.absent(fs.existsSync(path.join(dir, 'docs')))
  t.alike([...(await wt.status(ws))], [], 'unmaterialized files are not deletions')
})

test('missing blobs are reported, not silently skipped or deleted', async (t) => {
  const repo = await setup(t)
  const seed = await repo.workspace('seed')
  await seed.commit([put('/a.txt', 'aaa'), put('/b.txt', 'bbb')])
  await seed.land()

  // drop the local copy of the blob, as if it was landed by an offline peer
  const entry = await (await repo.workspace('seed')).drive.entry('/b.txt')
  await seed.blobs.core.clear(
    entry.value.blob.blockOffset,
    entry.value.blob.blockOffset + entry.value.blob.blockLength
  )

  const dir = await tmp(t)
  const wt = new Worktree(dir)
  const ws = await repo.workspace('w')
  const stats = await wt.checkout(ws)
  t.alike(stats.missing, ['/b.txt'])
  t.is(stats.written, 1)
  t.alike([...(await wt.status(ws))], [], 'missing file is not reported as deleted')
})
