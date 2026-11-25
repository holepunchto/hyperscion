// One process of the hub-home benchmark (bench/hubs.js): feeds for several repos, each its own
// store and Network (as separate `hs watch` processes would be), reporting one JSON line per
// event: when each feed reaches a hub, and when main moves.
const path = require('bare-path')
const process = require('bare-process')
const z32 = require('z32')
const Corestore = require('corestore')
const Repo = require('../lib/repo')
const Network = require('../lib/net')

const opts = JSON.parse(Bare.argv[2])
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const feeds = []

async function main() {
  for (const [i, r] of opts.repos.entries()) {
    const store = new Corestore(path.join(opts.dir, 'f' + i))
    const repo = new Repo(store, { key: z32.decode(r.key), bootstrapWeight: r.bootstrapWeight })
    await repo.ready()
    const net = new Network(repo, { bootstrap: opts.bootstrap, role: 'feed', keepAlive: true })
    await net.ready()
    let seq = (await repo.meta()).seq || 0
    repo.main.view.on('update', async () => {
      const now = (await repo.meta()).seq || 0
      if (now > seq) {
        seq = now
        emit({ type: 'seq', repo: r.name, seq, at: Date.now() })
      }
    })
    feeds.push({ name: r.name, repo, net, store, connected: false })
  }
  emit({ type: 'ready', rss: process.memoryUsage().rss })
  const poll = setInterval(() => {
    for (const f of feeds) {
      if (!f.connected && f.net.holderConnected()) {
        f.connected = true
        emit({ type: 'connected', repo: f.name, at: Date.now() })
      }
    }
  }, 100)
  await new Promise((resolve) => process.once('SIGTERM', resolve))
  clearInterval(poll)
  emit({ type: 'final', rss: process.memoryUsage().rss })
  for (const f of feeds) {
    await f.net.close()
    await f.repo.close()
    await f.store.close()
  }
}

main().catch((err) => {
  emit({ type: 'error', error: String((err && err.stack) || err) })
  Bare.exitCode = 1
})
