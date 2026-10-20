const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
const { spawn } = require('bare-subprocess')
const Corestore = require('corestore')
const driveEntry = require('hyperdrive/lib/encoding')
const Repo = require('../lib/repo')

exports.now = () => Number(process.hrtime.bigint()) / 1e6

exports.tmpdir = function tmpdir(name) {
  const base = process.env.HS_BENCH_DIR || path.join(os.tmpdir(), 'hs-bench')
  const dir = path.join(base, name + '-' + b4a.toString(crypto.randomBytes(4), 'hex'))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

exports.rm = (dir) => fs.rmSync(dir, { recursive: true, force: true })

exports.openRepo = async function openRepo(dir, opts = {}) {
  const store = new Corestore(dir)
  const repo = new Repo(store, opts)
  await repo.ready()
  return {
    store,
    repo,
    async close() {
      await repo.close()
      await store.close()
    }
  }
}

// Grow main to n paths quickly: land entries in 20k chunks that all reference one blob.
// The tree shape (keys, depth, fan-out) is what matters for commit/fork/diff cost.
exports.seedTree = async function seedTree(repo, n, { dirs = Math.ceil(n / 100) } = {}) {
  const ws = await repo.workspace('seed-blob')
  await ws.commit([{ path: '/.seed', content: b4a.from('x') }])
  const entry = (await ws.drive.entry('/.seed')).value
  const value = c.encode(driveEntry, entry)
  await ws.land()

  for (let i = 0; i < n;) {
    const entries = []
    for (let j = 0; j < 20_000 && i < n; j++, i++) {
      entries.push({ path: exports.pathFor(i, dirs), value })
    }
    const res = await repo.land({
      ws: { key: ws.tree.key, length: ws.tree.length },
      base: await repo.meta(),
      entries,
      message: 'seed',
      author: 'bench',
      time: 0
    })
    if (res.outcome.status !== 'accepted') throw new Error('seed failed: ' + res.outcome.status)
  }
}

exports.pathFor = (i, dirs) =>
  `/src/d${String(i % dirs).padStart(5, '0')}/f${String(i).padStart(7, '0')}.js`

exports.git = function git(cwd, args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['-C', cwd, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'b',
        GIT_AUTHOR_EMAIL: 'b@b',
        GIT_COMMITTER_NAME: 'b',
        GIT_COMMITTER_EMAIL: 'b@b',
        ...env
      }
    })
    const out = []
    p.stdout.on('data', (d) => out.push(d))
    p.stderr.on('data', () => {})
    p.on('exit', (code) =>
      code === 0
        ? resolve(b4a.concat(out))
        : reject(new Error('git ' + args.join(' ') + ' -> ' + code))
    )
  })
}

exports.median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

exports.fmt = (ms) => (ms < 10 ? ms.toFixed(2) : ms.toFixed(1)) + 'ms'

exports.dirSize = function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name)
      const st = fs.lstatSync(p)
      if (st.isDirectory()) stack.push(p)
      else total += st.size
    }
  }
  return total
}
