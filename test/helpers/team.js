// A scripted team on a private DHT testnet: a hub seeding with --admit plus N writer agents,
// all driven through the real `hs` binary. Shared by tests and by fast scenario replays.
const b4a = require('b4a')
const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')
const { spawn } = require('bare-subprocess')
const createTestnet = require('hyperdht/testnet')
const tmp = require('test-tmp')

const BIN = path.join(__dirname, '..', '..', 'bin.mjs')

// files: { 'path': 'content' } for the skeleton the hub lands first
async function team(t, { agents = ['a1', 'a2'], files = {}, env: extraEnv = {} } = {}) {
  const testnet = await createTestnet(3, t.teardown)
  const env = {
    ...require('bare-process').env,
    HS_BOOTSTRAP: testnet.bootstrap.map((b) => b.host + ':' + b.port).join(','),
    ...extraEnv
  }
  const dir = await tmp(t)
  // the owner creates the repo (a light bootstrap writer) and the hub (its indexer)
  const owner = path.join(dir, 'owner')
  const hub = path.join(dir, 'hub')
  const admit = path.join(dir, 'admit')
  fs.mkdirSync(owner, { recursive: true })
  for (const [p, content] of Object.entries({
    '.hsattributes': 'NOTES.md merge=union\n',
    ...files
  })) {
    fs.mkdirSync(path.dirname(path.join(owner, p)), { recursive: true })
    fs.writeFileSync(path.join(owner, p), content)
  }

  // HS_AGENT names the caller in an HS_TRACE trace (as the experiment wrappers do)
  const hs = (cwd, args, user = 'hub') => run(cwd, args, { ...env, USER: user, HS_AGENT: user })
  const bg = (cwd, args, user = 'hub') =>
    background(cwd, args, { ...env, USER: user, HS_AGENT: user })

  const init = await hs(owner, ['init', '--as', 'owner', '--hub', hub], 'owner')
  if (init.code !== 0) throw new Error('init: ' + init.stderr)
  const invite = init.stdout.match(/^repo (\S+)/m)[1]

  const self = {
    env,
    dir,
    hub,
    invite,
    hs,
    bg,
    seed: null,
    agents: {},
    // (re)start the hub's seed
    async startHub() {
      self.seed = bg(hub, ['seed', '--admit', admit])
      t.teardown(() => self.seed && self.seed.stop(), { order: 1 })
      await waitFor(() => self.seed.output().includes('admitting'))
    },
    async stopHub() {
      if (self.seed) await self.seed.stop()
      self.seed = null
    },
    // per-agent DHT: agents moved to site B (a site split) meet only each other
    sites: {},
    siteB: null,
    async split(names) {
      if (!self.siteB) {
        const b = await createTestnet(3, t.teardown)
        self.siteB = b.bootstrap.map((x) => x.host + ':' + x.port).join(',')
      }
      for (const n of names) self.sites[n] = self.siteB
    },
    heal(names) {
      for (const n of names) delete self.sites[n]
    },
    envOf(name) {
      const site = self.sites[name] ? { HS_BOOTSTRAP: self.sites[name] } : {}
      return { ...env, USER: name, HS_AGENT: name, ...site }
    },
    // run hs as an agent in its worktree
    as(name, args) {
      return run(self.agents[name], args, self.envOf(name))
    },
    // a background command (e.g. a feed) as an agent
    bgAs(name, args) {
      const p = background(self.agents[name], args, self.envOf(name))
      t.teardown(() => p.stop(), { order: 0 })
      return p
    },
    write(name, file, content) {
      const abs = path.join(self.agents[name], file)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
    },
    read(name, file) {
      const abs = path.join(self.agents[name], file)
      return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
    }
  }

  await self.startHub()
  // the skeleton lands from the owner while the hub is up, so the hub holds and settles it
  const skeleton = await hs(owner, ['land', '-m', 'skeleton'], 'owner')
  if (!/landed #\d+/.test(skeleton.stdout)) throw new Error('skeleton: ' + skeleton.stderr)
  for (const a of agents) {
    const res = await hs(dir, ['clone', invite, a, '--as', a, '--admit', admit], a)
    if (res.code !== 0) throw new Error(`${a} clone: ${res.stderr}`)
    self.agents[a] = path.join(dir, a)
  }
  await waitFor(() => self.seed.output().split('admitted').length === agents.length + 1, 30_000)
  for (const a of agents) {
    await waitFor(async () => {
      await self.as(a, ['fetch'])
      return (await self.as(a, ['info'])).stdout.includes('(writable)')
    }, 30_000)
  }
  return self
}

function run(cwd, args, env) {
  return new Promise((resolve) => {
    const p = spawn(os.execPath(), [BIN, ...args], { cwd, env })
    const out = []
    const err = []
    p.stdout.on('data', (d) => out.push(d))
    p.stderr.on('data', (d) => err.push(d))
    p.on('exit', (code) =>
      resolve({
        code,
        stdout: b4a.toString(b4a.concat(out)),
        stderr: b4a.toString(b4a.concat(err))
      })
    )
  })
}

function background(cwd, args, env) {
  const p = spawn(os.execPath(), [BIN, ...args], { cwd, env })
  const chunks = []
  let exited = false
  p.stdout.on('data', (d) => chunks.push(d))
  p.stderr.on('data', (d) => chunks.push(d))
  p.on('exit', () => {
    exited = true
  })
  return {
    output: () => b4a.toString(b4a.concat(chunks)),
    exited: () => exited,
    async stop() {
      if (exited) return
      p.kill('SIGINT')
      await waitFor(() => exited, 10_000).catch(() => p.kill('SIGKILL'))
    }
  }
}

async function waitFor(fn, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(100)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = { team, run, background, waitFor, sleep }
