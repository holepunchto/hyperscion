// Locates and opens the repo for a working directory: <root>/.hs/{store,config.json,stat.json}
const fs = require('bare-fs/promises')
const path = require('bare-path')
const Corestore = require('corestore')
const os = require('bare-os')
const process = require('bare-process')
const z32 = require('z32')
const Repo = require('./repo')
const Worktree = require('./worktree')

const HS = '.hs'

module.exports = class Context {
  constructor(root, config) {
    this.root = root
    this.config = config
    this.store = null
    this.repo = null
    this.worktree = new Worktree(root, { sparse: config.sparse })
    this._ws = null
    // opened read-only because another hs process holds the store (see open)
    this.readOnly = false
  }

  static async find(cwd) {
    let dir = path.resolve(cwd)
    while (true) {
      try {
        const st = await fs.stat(path.join(dir, HS, 'config.json'))
        if (st.isFile()) return dir
      } catch {}
      const parent = path.dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
  }

  // the worktree root and config, without opening (and locking) its store
  static async load(cwd) {
    const root = await Context.find(cwd)
    if (!root) {
      throw new Error('not a hyperscion worktree (no .hs found), run `hs init` or `hs clone`')
    }
    const config = JSON.parse(await fs.readFile(path.join(root, HS, 'config.json'), 'utf8'))
    return { root, config }
  }

  // allowReadOnly: if another hs process (a land, a seed) holds the store, open it read-only
  // instead of failing: reads see what that process has written so far; writes throw
  static async open(cwd, { allowReadOnly = false } = {}) {
    const { root, config } = await Context.load(cwd)
    const ctx = new Context(root, config)
    const key = config.key ? z32.decode(config.key) : null
    try {
      await ctx._openRepo(key)
    } catch (err) {
      if (!allowReadOnly || err.code !== 'WORKTREE_BUSY') throw err
      await ctx._openRepo(key, { readOnly: true })
    }
    return ctx
  }

  // which hs command holds this worktree's store, if it said so: { pid, command, started }
  static async busy(root) {
    try {
      const info = JSON.parse(await fs.readFile(Context.file(root, 'busy.json'), 'utf8'))
      if (!info || !info.pid) return null
      os.kill(info.pid, 0) // throws if that process is gone (a crash left the file behind)
      return info
    } catch {
      return null
    }
  }

  async markBusy(command) {
    const info = { pid: process.pid, command, started: Date.now() }
    await fs.writeFile(Context.file(this.root, 'busy.json'), JSON.stringify(info) + '\n')
    this._busy = info.pid
  }

  async _clearBusy() {
    if (!this._busy) return
    this._busy = null
    await fs.rm(Context.file(this.root, 'busy.json'), { force: true }).catch(() => {})
  }

  static async create(
    root,
    {
      key = null,
      encryptionKey = null,
      workspace = 'default',
      sparse = ['/'],
      bootstrapWeight = 1
    } = {}
  ) {
    await fs.mkdir(path.join(root, HS), { recursive: true })
    const config = {
      key: null,
      encryptionKey: encryptionKey ? z32.encode(encryptionKey) : null,
      workspace,
      sparse,
      bootstrapWeight
    }
    const ctx = new Context(root, config)
    await ctx._openRepo(key)
    ctx.config.key = z32.encode(ctx.repo.key)
    await ctx.save()
    return ctx
  }

  // what another peer needs to join: the repo key, plus the encryption key if any, plus
  // "~1" for repos whose bootstrap writer is light (every peer must order by the same rule)
  get invite() {
    const base = this.config.encryptionKey
      ? this.config.key + '.' + this.config.encryptionKey
      : this.config.key
    return bootstrapWeightOf(this.config) === 1 ? base + '~1' : base
  }

  static parseInvite(invite) {
    const [keys, weight] = invite.split('~')
    const [key, enc] = keys.split('.')
    return {
      key: z32.decode(key),
      encryptionKey: enc ? z32.decode(enc) : null,
      bootstrapWeight: weight === '1' ? 1 : 2
    }
  }

  async _openRepo(key, { readOnly = false } = {}) {
    const encryptionKey = this.config.encryptionKey ? z32.decode(this.config.encryptionKey) : null
    this.store = new Corestore(path.join(this.root, HS, 'store'), readOnly ? { readOnly } : {})
    this.readOnly = readOnly
    this.repo = new Repo(this.store, {
      key,
      encryptionKey,
      bootstrapWeight: bootstrapWeightOf(this.config)
    })
    try {
      await this.repo.ready()
    } catch (err) {
      await this.store.close().catch(() => {})
      this.repo = null
      this.store = null
      if (/could not be locked/i.test(err.message)) {
        const busy = await Context.busy(this.root)
        const what = busy
          ? `\`hs ${busy.command}\` (pid ${busy.pid}, running ${Math.round((Date.now() - busy.started) / 1000)}s)`
          : 'another hs process (e.g. `hs seed`)'
        const e = new Error(
          `${what} is using this worktree; wait for it to finish` +
            (busy ? '' : ', or run long-lived commands like seed from a separate hub worktree')
        )
        e.code = 'WORKTREE_BUSY'
        throw e
      }
      throw err
    }
  }

  get encryptionKey() {
    return this.config.encryptionKey ? z32.decode(this.config.encryptionKey) : null
  }

  // Small state files next to the store that commands without the store (watch) can read:
  // base (seq the workspace is synced to), watch.pid, watch.last (last seq the feed printed).
  static file(root, name) {
    return path.join(root, HS, name)
  }

  static async readNumber(root, name) {
    try {
      const n = Number((await fs.readFile(Context.file(root, name), 'utf8')).trim())
      return Number.isFinite(n) ? n : null
    } catch {
      return null
    }
  }

  static async writeNumber(root, name, n) {
    await fs.writeFile(Context.file(root, name), String(n) + '\n')
  }

  // also: who we are (for watch --for-me) and how far the review log was when we last looked
  async saveBase() {
    if (this._ws && this._ws.state) {
      await Context.writeNumber(this.root, 'base', this._ws.state.base.seq)
    }
    if (this.repo) {
      await fs.writeFile(Context.file(this.root, 'writer'), z32.encode(this.repo.writerKey) + '\n')
      // local only: this runs after the command (often offline by now), and a read waiting for
      // a block nobody serves would hang the exit (push after an outage did)
      const events = await this.repo.eventCount(undefined, { wait: false }).catch(() => null)
      if (events !== null) await Context.writeNumber(this.root, 'events', events)
    }
  }

  static async readWriter(root) {
    try {
      return z32.decode((await fs.readFile(Context.file(root, 'writer'), 'utf8')).trim())
    } catch {
      return null
    }
  }

  async workspace() {
    if (!this._ws) this._ws = await this.repo.workspace(this.config.workspace)
    return this._ws
  }

  async switch(name) {
    this.config.workspace = name
    this._ws = null
    await this.save()
    return this.workspace()
  }

  async save() {
    await fs.writeFile(
      path.join(this.root, HS, 'config.json'),
      JSON.stringify(this.config, null, 2)
    )
  }

  async close() {
    await this._clearBusy()
    // a read-only store refuses the writes closing may try (nothing of ours to flush)
    const ignore = this.readOnly ? () => {} : null
    if (this.repo) await (ignore ? this.repo.close().catch(ignore) : this.repo.close())
    if (this.store) await (ignore ? this.store.close().catch(ignore) : this.store.close())
  }
}

// repos created before milestone 7 have no bootstrapWeight in their config: weight 2
function bootstrapWeightOf(config) {
  return config.bootstrapWeight === 1 ? 1 : 2
}

module.exports.bootstrapWeightOf = bootstrapWeightOf
