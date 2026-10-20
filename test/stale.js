// Regression for experiment 1's near-silent revert: a file whose new version could not be
// fetched must never look like a local edit, and local edits are never clobbered.
const test = require('brittle')
const b4a = require('b4a')
const fs = require('bare-fs')
const path = require('bare-path')
const Corestore = require('corestore')
const tmp = require('test-tmp')
const Repo = require('../lib/repo')
const Worktree = require('../lib/worktree')

const put = (p, s) => ({ path: p, content: b4a.from(s) })

test('content that could not be fetched is stale, never an edit', async (t) => {
  const { a, b, connect } = await pair(t)
  let disconnect = connect()

  const wa = await a.workspace('wa')
  await wa.commit([put('/f.txt', 'f v1\n'), put('/g.txt', 'g v1\n')])
  await wa.land()
  await settle(a, b)

  const dir = await tmp(t)
  const wt = new Worktree(dir)
  const wb = await b.workspace('wb')
  await wt.checkout(wb, { wait: true, timeout: 5000 })
  t.is(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'f v1\n')

  // A lands v2; B learns about it (oplog) but goes offline before fetching the new content
  await wa.commit([put('/f.txt', 'f v2\n'), put('/g.txt', 'g v2\n')])
  await wa.land()
  await settle(a, b)
  await disconnect()

  wb.io = { wait: false }
  await wb.sync()
  const co = await wt.checkout(wb)
  t.alike(co.missing.sort(), ['/f.txt', '/g.txt'], 'new versions reported missing')
  t.is(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'f v1\n', 'old content left on disk')

  let st = await wt.status(wb)
  t.alike([...st], [], 'stale files are not modifications')
  t.alike(st.stale, ['/f.txt', '/g.txt'])

  const res = await wt.commit(wb)
  t.is(res.committed, 0, 'nothing committed, so nothing reverted')

  // an edit on top of a stale copy is held back, and checkout won't overwrite it
  fs.writeFileSync(path.join(dir, 'g.txt'), 'g v1 + my edit\n')
  st = await wt.status(wb)
  t.alike(
    st.map((ch) => ch.status + ' ' + ch.path),
    ['modified (stale base) /g.txt']
  )
  const blocked = await wt.commit(wb)
  t.alike(blocked.blocked, ['/g.txt'], 'edit on a stale base is not committed')
  t.is((await wb.changes()).length, 0, 'workspace still has no changes to land')

  // content arrives: the untouched stale file updates, the edited one is left for the user
  disconnect = connect()
  const again = await wt.checkout(wb, { wait: true, timeout: 5000 })
  t.alike(again.unresolved, ['/g.txt'])
  t.is(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8'), 'f v2\n')
  t.is(fs.readFileSync(path.join(dir, 'g.txt'), 'utf8'), 'g v1 + my edit\n', 'local edit kept')

  wb.io = { timeout: 5000 }
  t.alike(await wt.restore(wb, ['/g.txt']), ['/g.txt'])
  t.is(fs.readFileSync(path.join(dir, 'g.txt'), 'utf8'), 'g v2\n')
  st = await wt.status(wb)
  t.alike([...st], [])
  t.alike(st.stale, [])
  await disconnect()
})

// q2-hs-3: a sync killed mid-checkout wrote files it had fetched but not the stat cache, so a
// file cached as stale (never written) sat on disk with exactly main's content, and `land`
// refused it as "edited on top of a stale copy" though nobody had touched it
test('a stale file that already has the wanted content is up to date, not an edit', async (t) => {
  const { a, b, connect } = await pair(t)
  let disconnect = connect()

  const wa = await a.workspace('wa')
  await wa.commit([put('/old.txt', 'old v1\n')])
  await wa.land()
  await settle(a, b)

  const dir = await tmp(t)
  const wt = new Worktree(dir)
  const wb = await b.workspace('wb')
  await wt.checkout(wb, { wait: true, timeout: 5000 })

  // a new file and a new version land; b goes offline before fetching either
  await wa.commit([put('/new.txt', 'new v1\n'), put('/old.txt', 'old v2\n')])
  await wa.land()
  await settle(a, b)
  await disconnect()
  wb.io = { wait: false }
  await wb.sync()
  const co = await wt.checkout(wb)
  t.alike(co.missing.sort(), ['/new.txt', '/old.txt'], 'both stale')

  // what a checkout killed before saving its cache leaves: main's content on disk, the cache
  // still saying stale
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new v1\n')
  fs.writeFileSync(path.join(dir, 'old.txt'), 'old v2\n')
  const st = await wt.status(wb)
  t.alike([...st], [], 'not edits: ' + st.map((ch) => ch.status + ' ' + ch.path).join(', '))
  t.alike(st.stale, [], 'and no longer stale')
  const res = await wt.commit(wb)
  t.alike(res.blocked, [], 'nothing held back')

  // the version we waited for arrives after main moved on again: behind, still not an edit
  disconnect = connect()
  await wa.commit([put('/new.txt', 'new v2\n')])
  await wa.land()
  await settle(a, b)
  await disconnect()
  await wb.sync()
  await wt.checkout(wb) // new.txt v2 can't be fetched: stale, wanting v2
  fs.writeFileSync(path.join(dir, 'new.txt'), 'new v1\n') // rewritten, same content
  const behind = await wt.status(wb)
  t.alike([...behind], [], 'content unchanged since marked stale: not an edit')
  t.alike(behind.stale, ['/new.txt'], 'still behind main')

  // a file someone really did create over a stale one is still held back
  disconnect = connect()
  await wa.commit([put('/more.txt', 'more v1\n')])
  await wa.land()
  await settle(a, b)
  await disconnect()
  await wb.sync()
  await wt.checkout(wb)
  fs.writeFileSync(path.join(dir, 'more.txt'), 'my own more\n')
  const mine = await wt.status(wb)
  t.alike(
    mine.map((ch) => ch.status + ' ' + ch.path),
    ['modified (stale base) /more.txt']
  )
})

test('offline sync over missing content fails fast and leaves the workspace untouched', async (t) => {
  const { a, b, connect } = await pair(t)
  const disconnect = connect()

  const seed = await a.workspace('seed')
  await seed.commit([put('/n.txt', 'one\ntwo\nthree\n')])
  await seed.land()
  await settle(a, b)

  const wb = await b.workspace('wb')
  await wb.commit([put('/n.txt', 'one\ntwo\nthree\nB\n')])

  const wa = await a.workspace('wa')
  await wa.commit([put('/n.txt', 'A\none\ntwo\nthree\n')])
  await wa.land()
  await settle(a, b)
  await disconnect()

  const before = { head: wb.head(), fork: wb.state.fork, base: wb.state.base }
  wb.io = { wait: false }
  await t.exception(() => wb.sync(), /not available/)
  t.alike(wb.head(), before.head, 'root not moved')
  t.alike(wb.state.base, before.base, 'base unchanged')
  t.is((await wb.changes()).length, 1, 'our change is still there')
})

async function pair(t) {
  const sa = new Corestore(await tmp(t))
  const sb = new Corestore(await tmp(t))
  const a = new Repo(sa)
  await a.ready()
  const b = new Repo(sb, { key: a.key })
  await b.ready()

  t.teardown(async () => {
    await a.close()
    await b.close()
    await sa.close()
    await sb.close()
  })

  const connect = () => {
    const s1 = sa.replicate(true)
    const s2 = sb.replicate(false)
    s1.pipe(s2).pipe(s1)
    return async () => {
      s1.destroy()
      s2.destroy()
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  const disconnect = connect()
  await a.addWriter(b.writerKey, { indexer: false })
  await settle(a, b)
  await disconnect()
  return { a, b, connect }
}

async function settle(...repos) {
  let last = null
  let stable = 0
  for (let i = 0; i < 200 && stable < 3; i++) {
    for (const r of repos) await r.update()
    const metas = await Promise.all(repos.map((r) => r.meta()))
    const id = metas.map((m) => m.seq + ':' + b4a.toString(m.hash, 'hex')).join(',')
    const same = metas.every((m) => b4a.equals(m.hash, metas[0].hash))
    stable = same && id === last ? stable + 1 : 0
    last = id
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
