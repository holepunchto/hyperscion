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

test(
  'gip: a hub home publishes its repos to git+pear while served',
  { timeout: 300000 },
  async (t) => {
    const createTestnet = require('hyperdht/testnet')
    const { run, background } = helpers
    const testnet = await createTestnet(3, t.teardown)
    const dir = await tmp(t)
    const home = path.join(dir, 'home')
    const env = {
      ...require('bare-process').env,
      HS_BOOTSTRAP: testnet.bootstrap.map((b) => b.host + ':' + b.port).join(','),
      HS_HUB_HOME: home,
      USER: 'me'
    }
    const hs = (cwd, args) => run(cwd, args, env)

    // r1 published from the start, before the home is served; r2 turned on while served
    const made = await hs(dir, ['hubs', 'new', 'r1', '--gip'])
    t.is(made.code, 0, made.stderr)
    const link = made.stdout.match(/git\+pear (git\+pear:\/\/\S+)/)[1]
    t.ok(link.endsWith('/r1'), 'named after the repo: ' + link)
    const secret = await hs(dir, ['hubs', 'new', 's1', '--encrypt', '--gip'])
    t.is(secret.code, 1, 'an encrypted repo needs --public: ' + secret.stderr.trim())
    t.is((await hs(dir, ['hubs', 'new', 'r2'])).code, 0)

    const server = background(dir, ['hubs', 'serve'], env)
    t.teardown(() => server.stop(), { order: 1 })
    hubOut.output = server.output
    await waitFor(() => server.output().includes('hubs serving 2 repo(s)'), 30_000, 'the server')
    await waitFor(() => server.output().includes(`r1: git+pear: ${link}`), 30_000, 'r1 published')

    const owner = path.join(home, 'owners', 'r1')
    fs.writeFileSync(path.join(owner, 'README.md'), 'hello from a hub home\n')
    const landed = await hs(owner, ['land', '-m', 'first'])
    t.is(landed.code, 0, landed.stderr)
    const seq = Number(landed.stdout.match(/#(\d+) final/)[1])
    await waitFor(
      () => new RegExp(`r1: git\\+pear: published #\\d+\\.\\.#${seq}\\b`).test(server.output()),
      60_000,
      'the land published'
    )

    // a git+pear peer finds the home on the DHT and reads the branch
    const bootstrap = env.HS_BOOTSTRAP.split(',').map((hp) => {
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
    const remote = new Remote(store, link)
    await remote.ready()
    swarm.join(remote.discoveryKey, { server: false, client: true })
    await swarm.flush()
    let readme = null
    await waitFor(
      async () => {
        await remote.core.update({ wait: true }).catch(() => {})
        await remote.update()
        const ref = await remote.getBranchRef('main')
        if (!ref) return false
        const head = gx.parseCommit((await remote.getObject(ref.oid)).data)
        const trailer = gx.parseTrailer(head.message)
        if (!trailer || trailer.seq !== seq) return false
        const tree = await gx.TreeBuilder.from(head.tree, (oid) => remote.getObject(oid))
        const file = tree.files().find((f) => f.path === '/README.md')
        readme = file && b4a.toString((await remote.getObject(file.oid)).data)
        return true
      },
      60_000,
      'the branch on the git peer'
    )
    t.is(readme, 'hello from a hub home\n', 'a git+pear peer reads main from the hub home')
    await remote.close()

    const listed = await hs(dir, ['hubs', 'list'])
    t.ok(listed.stdout.includes(`git+pear ${link}  published #${seq}`), listed.stdout)

    // on and off while served
    const on = await hs(dir, ['hubs', 'gip', 'r2'])
    t.is(on.code, 0, on.stderr)
    t.ok(/git\+pear git\+pear:\/\/\S+\/r2/.test(on.stdout), on.stdout)
    t.ok(server.output().includes('r2: git+pear: git+pear://'), 'served without a restart')
    const off = await hs(dir, ['hubs', 'gip', 'r2', '--off'])
    t.is(off.code, 0, off.stderr)
    // the list reads the server's status file: give a write already under way a moment
    let after = null
    await waitFor(
      async () => {
        after = await hs(dir, ['hubs', 'list'])
        return !/git\+pear \S+\/r2/.test(after.stdout)
      },
      10_000,
      'r2 gone from the list'
    ).catch(() => {})
    t.absent(/git\+pear \S+\/r2/.test(after.stdout), 'r2 not published any more')
  }
)
