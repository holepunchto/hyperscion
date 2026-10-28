// One process serving many repos' hubs (docs/DESIGN.md, multi-repo hub): every repo lives in
// a namespace of one root corestore, and one @holepunchto/replicator holds the connections.
// Each connection replicates the root store, but only the cores a peer opens (the store is
// passive, lib/hubs.js). Agents still run a swarm per repo (DESIGN.md §15).
//
// RepoSwarm gives a repo's Network the slice of hyperswarm it uses (connection events, join
// with flushed/refresh, dht, destroy) on top of the shared replicator. The replicator already
// replicates every connection, so the Network is made with `replicate: false`, and since the
// replicator is shared, destroying a RepoSwarm only leaves its topics.
const EventEmitter = require('bare-events')
const Replicator = require('@holepunchto/replicator')
const HyperDHT = require('hyperdht')

// a hub is an always-on peer for every agent of every repo it serves
const MAX_PEERS = 1024

function createReplicator(root, { bootstrap = null } = {}) {
  const loopback =
    bootstrap && bootstrap.every((b) => b.host === '127.0.0.1' || b.host === 'localhost')
  // on a loopback-only DHT, run unfirewalled on 127.0.0.1 as lib/net.js does
  const dht = loopback ? new HyperDHT({ bootstrap, host: '127.0.0.1', firewalled: false }) : null
  const rep = new Replicator(root, {
    ...(dht ? { dht } : { bootstrap }),
    autoswarm: false, // every repo a hub serves is pinned, never rotated out
    maxPeers: MAX_PEERS,
    minPeers: MAX_PEERS,
    discoveryStartupDelay: 0
  })
  rep.ownedDht = dht // borrowed dhts aren't closed by the replicator
  return rep
}

async function closeReplicator(rep) {
  await rep.close()
  if (rep.ownedDht) await rep.ownedDht.destroy()
}

class RepoSwarm extends EventEmitter {
  constructor(rep, store) {
    super()
    this.rep = rep
    this.store = store
    this.dht = rep.dht
    this.sessions = []
    this._onconnected = (connection) => this._connection(connection)
    rep.on('connected', this._onconnected)
  }

  _connection(connection) {
    // a holder's connection: Network only reads client/topics to spot a feed's outage links
    this.emit('connection', connection.stream, { client: false, topics: [] })
  }

  // the existing connections, as hyperswarm would have announced them on join
  _replay() {
    for (const connection of this.rep.connections) this._connection(connection)
  }

  join(topic, { server = true, client = true } = {}) {
    const session = this.rep.join(this.store.session(), topic, { pin: true, server, client })
    this.sessions.push(session)
    if (this.sessions.length === 1) queueMicrotask(() => this._replay())
    // refresh() applies the pin and starts the announce; flush then waits for it, so a
    // "seeding" line still means peers can find us
    return {
      flushed: async () => {
        await this.rep.refresh()
        await session.flush()
      },
      refresh: async () => {
        session.discover()
        await this.rep.refresh()
      }
    }
  }

  async destroy() {
    this.rep.off('connected', this._onconnected)
    for (const session of this.sessions) await session.close().catch(() => {})
    this.sessions = []
  }
}

module.exports = { createReplicator, closeReplicator, RepoSwarm }
