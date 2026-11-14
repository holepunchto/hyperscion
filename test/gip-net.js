// hs <-> git+pear over a DHT testnet: the hub publishes with `hs seed --gip`, a git user (a
// plain gip-remote peer here, as gip's remote helper is) reads it, pushes a commit to their own
// gip repo, and `hs gip import` lands it; the hub publishes it back
const test = require('brittle')
const b4a = require('b4a')
const fs = require('bare-fs')
const path = require('bare-path')
const z32 = require('z32')
const tmp = require('test-tmp')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const { Remote } = require('gip-remote')
const gx = require('../lib/gitexport')
const helpers = require('./helpers/team')
const { team } = helpers

test(
  'gip: seed --gip serves main to git+pear peers, and import lands their commits',
  { timeout: 300000 },
  async (t) => {
    const tm = await team(t, { agents: [] })
    const owner = path.join(tm.dir, 'owner')
    await tm.seed.stop() // the team's plain hub: this one also publishes
    tm.seed = null
    const seed = tm.bg(tm.hub, ['seed', '--gip'])
    hubOut.output = seed.output
    t.teardown(() => seed.stop(), { order: 1 })
    await waitFor(() => /git\+pear: git\+pear:\/\/\S+/.test(seed.output()), 60_000, 'the link')
    const link = seed.output().match(/git\+pear: (git\+pear:\/\/\S+)/)[1]

    fs.writeFileSync(path.join(owner, 'README.md'), 'hello\n')
    const landed = await tm.hs(owner, ['land', '-m', 'first from hs'], 'owner')
    t.is(landed.code, 0, landed.stderr)
    const seq = Number(landed.stdout.match(/#(\d+) final/)[1])
    await waitFor(
      () => new RegExp(`published #\\d+\\.\\.#${seq}\\b`).test(seed.output()),
      60_000,
      'the first publish'
    )

    // the git user: their own store and swarm on the same DHT
    const bootstrap = tm.env.HS_BOOTSTRAP.split(',').map((hp) => {
      const [host, port] = hp.split(':')
      return { host, port: Number(port) }
    })
    const store = new Corestore(await tmp(t))
    const swarm = new Hyperswarm({ bootstrap })
    swarm.on('connection', (conn) => store.replicate(conn))
    t.teardown(
      async () => {
        await swarm.destroy()
        await store.close()
      },
      { order: 2 }
    )

    const hub = new Remote(store, link)
    await hub.ready()
    swarm.join(hub.discoveryKey, { server: false, client: true })
    await swarm.flush()
    let tip = null
    await waitFor(
      async () => {
        await hub.core.update({ wait: true }).catch(() => {})
        await hub.update()
        const ref = await hub.getBranchRef('main')
        if (!ref) return false
        const t2 = gx.parseTrailer(gx.parseCommit((await hub.getObject(ref.oid)).data).message)
        tip = ref.oid
        return t2 && t2.seq === seq
      },
      60_000,
      'the hub branch on the git peer'
    )
    t.pass('a git+pear peer reads the published branch from the hub')

    // a commit on top, pushed to the git user's own gip repo (with what it builds on)
    const objects = new Map()
    const get = (oid) => objects.get(oid) || hub.getObject(oid)
    await copyReachable(hub, tip, objects)
    const tree = await gx.TreeBuilder.from(gx.parseCommit(objects.get(tip).data).tree, get)
    const blob = gx.object('blob', b4a.from('from git\n'))
    objects.set(blob.oid, blob)
    tree.set('/HUMAN.md', { mode: gx.MODE_FILE, oid: blob.oid })
    const root = tree.flush(objects)
    const who = 'Human <h@x> 1700000000 +0000'
    const commit = gx.object(
      'commit',
      b4a.from(`tree ${root}\nparent ${tip}\nauthor ${who}\ncommitter ${who}\n\nfrom git\n`)
    )
    objects.set(commit.oid, commit)
    const fork = new Remote(store.namespace('human'), 'fork')
    await fork.push('main', commit.oid, objects)
    swarm.join(fork.discoveryKey, { server: true, client: false })
    await swarm.flush()
    const forkLink = `git+pear://${z32.encode(fork.key)}/fork`

    const imp = await tm.hs(owner, ['gip', 'import', forkLink], 'owner')
    t.is(imp.code, 0, imp.stderr)
    t.ok(/landed [0-9a-f]+ as #\d+/.test(imp.stdout), imp.stdout)
    const again = await tm.hs(owner, ['gip', 'import', forkLink], 'owner')
    t.is(again.code, 0, again.stderr)
    t.ok(/nothing new/.test(again.stdout), 'importing twice does nothing')

    // the hub publishes the import back as an hs commit
    const back = Number(imp.stdout.match(/as #(\d+)/)[1])
    await waitFor(
      () => new RegExp(`published #\\d+\\.\\.#${back}\\b`).test(seed.output()),
      60_000,
      'the import published back'
    )
    await waitFor(
      async () => {
        await hub.core.update({ wait: true }).catch(() => {})
        await hub.update()
        const ref = await hub.getBranchRef('main')
        const msg = gx.parseCommit((await hub.getObject(ref.oid)).data).message
        return msg.includes(`Git-Commit: ${commit.oid}`)
      },
      60_000,
      'the Git-Commit note on the hub branch'
    )
    t.pass('published back with its Git-Commit note')

    await fork.close()
    await hub.close()
  }
)

// waitFor, failing with what we waited for and the hub's output
const hubOut = { output: () => '' }
async function waitFor(fn, timeout, what = 'condition') {
  try {
    await helpers.waitFor(fn, timeout)
  } catch {
    throw new Error(`timed out waiting for ${what}; hub said:\n${hubOut.output()}`)
  }
}

async function copyReachable(remote, oid, out) {
  if (out.has(oid)) return
  const obj = await remote.getObject(oid)
  out.set(oid, { type: obj.type, size: obj.size, data: obj.data })
  if (obj.type === 'commit') {
    const c = gx.parseCommit(obj.data)
    await copyReachable(remote, c.tree, out)
    for (const p of c.parents) await copyReachable(remote, p, out)
  } else if (obj.type === 'tree') {
    for (const e of gx.decodeTree(obj.data)) await copyReachable(remote, e.oid, out)
  }
}
