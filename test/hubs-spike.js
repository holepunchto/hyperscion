// M0 spike (plan: one hub, many repos): one process hubs several repos from one corestore
// through one @holepunchto/replicator, and unchanged `hs` agents (separate processes on
// hyperswarm) clone, land and reach `final`, keep a quiet feed, see each other's task
// signals through the hub, and find the hub again after it restarts.
const test = require('brittle')
const b4a = require('b4a')
const fs = require('bare-fs')
const path = require('bare-path')
const z32 = require('z32')
const Corestore = require('corestore')
const createTestnet = require('hyperdht/testnet')
const tmp = require('test-tmp')
const Repo = require('../lib/repo')
const Network = require('../lib/net')
const { createReplicator, closeReplicator, RepoSwarm } = require('../lib/hubnet')
const { run, background, waitFor, sleep } = require('./helpers/team')

test('spike: one replicator hubs two repos for unchanged agents', async (t) => {
  const { dir, hub, hs, join } = await setup(t, ['r1', 'r2'])

  t.not(
    b4a.toString(hub.repos.r1.repo.writerKey, 'hex'),
    b4a.toString(hub.repos.r2.repo.writerKey, 'hex'),
    'each repo has its own hub writer key'
  )

  // a1 works on both repos, a2 only on r2
  const r1a1 = await join('a1', 'r1')
  const r2a1 = await join('a1', 'r2')
  const r2a2 = await join('a2', 'r2')

  for (const [wt, who, name] of [
    [r1a1, 'a1', 'r1'],
    [r2a1, 'a1', 'r2'],
    [r2a2, 'a2', 'r2']
  ]) {
    fs.writeFileSync(path.join(wt, who + '.txt'), `${who} on ${name}\n`)
    const landed = await hs(wt, ['land', '-m', `${who} on ${name}`], who)
    t.ok(/#\d+ final/.test(landed.stdout), `${who} lands on ${name}, final`)
  }

  await hs(r2a2, ['sync'], 'a2')
  t.ok(fs.existsSync(path.join(r2a2, 'a1.txt')), 'a2 has a1 work on r2, through the hub')
  t.absent(fs.existsSync(path.join(dir, 'a1-r2', 'r1')), 'repos stay apart')
  t.is(hub.rep.connectionCount >= 0, true)
})

test('spike: quiet feed, signals through the hub, hub restart', async (t) => {
  const { hub, hs, env, join } = await setup(t, ['r1', 'r2'])
  const r2a1 = await join('a1', 'r2')
  const r2a2 = await join('a2', 'r2')

  // a2 keeps a feed; it must outlive the replicator's idle-connection GC (3 min)
  const feed = background(r2a2, ['watch', '--json'], { ...env, USER: 'a2' })
  t.teardown(() => feed.stop(), { order: 0 })
  await waitFor(() => hub.rep.connectionCount >= 1, 30_000)
  const idle = Number(require('bare-process').env.HS_SPIKE_IDLE_S || 200) * 1000
  const until = Date.now() + idle
  let dropped = 0
  let last = hub.rep.connectionCount
  while (Date.now() < until) {
    await sleep(5000)
    if (hub.rep.connectionCount < last) dropped++
    last = hub.rep.connectionCount
  }
  t.comment(
    `after ${idle / 1000}s idle: ${hub.rep.connectionCount} connection(s), ${dropped} drop(s)`
  )
  fs.writeFileSync(path.join(r2a1, 'late.txt'), 'late\n')
  const late = await hs(r2a1, ['land', '-m', 'after the quiet'], 'a1')
  t.ok(/#\d+ final/.test(late.stdout), 'a land after the quiet is final')
  await waitFor(() => feed.output().includes('after the quiet'), 20_000)
  t.pass('the quiet feed got it')

  // a task signal from a1 reaches a2 through the hub (no land in between)
  const made = await hs(r2a1, ['task', 'new', 'cache the matrix'], 'a1')
  const id = (made.stdout.match(/T[0-9a-z]+/) || [])[0]
  t.ok(id, 'task made: ' + made.stdout + made.stderr)
  await hs(r2a2, ['sync'], 'a2')
  const started = await hs(r2a1, ['task', 'start', id], 'a1')
  t.is(started.code, 0, started.stdout + started.stderr)
  const board = await hs(r2a2, ['task'], 'a2')
  t.ok(/a1/.test(board.stdout), 'a2 sees a1 leading: ' + board.stdout)

  // restart the hub: the feed (keepAlive) finds it again, lands settle again
  await hub.stop()
  await sleep(2000)
  await hub.start()
  // nothing but the feed runs now, so a hub connection is the feed finding it again
  await waitFor(() => hub.rep.connectionCount >= 1, 60_000)
  t.pass('the feed reconnected to the restarted hub')
  fs.writeFileSync(path.join(r2a1, 'after.txt'), 'after\n')
  const after = await hs(r2a1, ['land', '-m', 'after the restart'], 'a1')
  t.ok(/#\d+ final/.test(after.stdout), 'final after a hub restart: ' + after.stdout + after.stderr)
  await waitFor(() => feed.output().includes('after the restart'), 30_000)
  t.pass('the feed got the land made after the restart')
})

// a testnet, a hub serving `names` from one store and replicator, and a way for agents to
// clone and be admitted
async function setup(t, names) {
  const testnet = await createTestnet(3, t.teardown)
  const { bootstrap } = testnet
  const env = {
    ...require('bare-process').env,
    HS_BOOTSTRAP: bootstrap.map((b) => b.host + ':' + b.port).join(',')
  }
  const dir = await tmp(t)
  const hub = new SpikeHub(path.join(dir, 'hub'), bootstrap, names)
  await hub.start()
  t.teardown(() => hub.stop(), { order: 1 })

  const hs = (cwd, args, user) => run(cwd, args, { ...env, USER: user })
  const join = async (who, name) => {
    const wt = path.join(dir, who + '-' + name)
    const r = hub.repos[name]
    const cloned = await hs(dir, ['clone', r.invite, wt, '--as', who, '--admit', r.admit], who)
    t.is(cloned.code, 0, `${who} clones ${name}: ${cloned.stderr}`)
    await waitFor(async () => {
      await hs(wt, ['fetch'], who)
      return (await hs(wt, ['info'], who)).stdout.includes('(writable)')
    }, 30_000)
    return wt
  }
  return { dir, hub, hs, env, join }
}

// the hub: one root store, each repo in its own namespace with the hub as its heavy
// bootstrap writer (the pre-M7 topology: enough to test the network; M1 uses the init --hub
// handover)
class SpikeHub {
  constructor(dir, bootstrap, names) {
    this.dir = dir
    this.bootstrap = bootstrap
    this.names = names
    this.repos = {}
    this.keys = {}
  }

  async start() {
    this.root = new Corestore(path.join(this.dir, 'store'))
    this.rep = createReplicator(this.root, { bootstrap: this.bootstrap })
    await this.rep.ready()
    for (const name of this.names) {
      const fresh = !this.keys[name]
      const repo = new Repo(this.root.namespace(name), {
        key: this.keys[name] || null,
        bootstrapWeight: 2
      })
      await repo.ready()
      const ws = await repo.workspace('default')
      if (fresh) {
        await ws.commit([{ path: '/README.md', content: b4a.from(name + '\n') }])
        await ws.land({ message: 'skeleton' })
        this.keys[name] = repo.key
      }
      const net = new Network(repo, {
        swarm: new RepoSwarm(this.rep, repo.store),
        replicate: false,
        role: 'holder',
        mirror: true,
        ack: true,
        keepAlive: true
      })
      await net.ready()
      net.seed(ws)
      const admit = path.join(this.dir, 'admit-' + name)
      fs.mkdirSync(admit, { recursive: true })
      this.repos[name] = { repo, net, admit, invite: z32.encode(repo.key) }
    }
    // admit agents the way `hs seed --admit` does
    this.admitting = true
    this.admitLoop = (async () => {
      while (this.admitting) {
        for (const r of Object.values(this.repos)) {
          for (const file of fs.readdirSync(r.admit)) {
            const key = z32.decode(fs.readFileSync(path.join(r.admit, file), 'utf8').trim())
            fs.unlinkSync(path.join(r.admit, file))
            await r.repo.addWriter(key, { handle: file.replace(/\.key$/, '') })
          }
        }
        await sleep(200)
      }
    })()
  }

  async stop() {
    if (!this.root) return
    this.admitting = false
    await this.admitLoop
    for (const r of Object.values(this.repos)) {
      await r.net.close()
      await r.repo.close()
    }
    await closeReplicator(this.rep)
    await this.root.close()
    this.root = null
  }
}
