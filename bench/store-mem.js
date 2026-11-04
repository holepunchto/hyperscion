// Memory per store: N repos, each in its own Corestore, after a few lands.
//   bare bench/store-mem.js [n] [default|tuned]
// RSS for N repos, each in its own store, after a few lands: default vs tuned storage
const path = require('bare-path')
const fs = require('bare-fs')
const process = require('bare-process')
const b4a = require('b4a')
const Corestore = require('corestore')
const CoreStorage = require('hypercore-storage')
const Repo = require('../lib/repo')
const N = Number(Bare.argv[2] || 10)
const mode = Bare.argv[3] || 'default'
const dir = require('./helpers').tmpdir('store-mem-' + mode)

const rss = () => Math.round(process.memoryUsage().rss / 1e6)
async function main() {
  const base = rss()
  const repos = []
  for (let i = 0; i < N; i++) {
    const d = path.join(dir, 's' + i)
    const storage = mode === 'tuned' ? new CoreStorage(d, { writeBufferSize: 4 * 1024 * 1024 }) : d
    const store = new Corestore(storage)
    const repo = new Repo(store)
    await repo.ready()
    const ws = await repo.workspace('w')
    for (let k = 0; k < 5; k++) {
      await ws.commit([{ path: '/f' + k + '.txt', content: b4a.alloc(2000, k) }])
      await ws.land({ message: 'x' })
    }
    repos.push({ repo, store })
  }
  console.log(
    JSON.stringify({
      mode,
      N,
      baseMB: base,
      rssMB: rss(),
      perStoreMB: +((rss() - base) / N).toFixed(1)
    })
  )
  for (const r of repos) {
    await r.repo.close()
    await r.store.close()
  }
  fs.rmSync(dir, { recursive: true, force: true })
}
main()
