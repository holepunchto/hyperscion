// Locates and opens the repo for a working directory: <root>/.hs/{store,config.json,stat.json}
const fs = require('bare-fs/promises')
const path = require('bare-path')
const Corestore = require('corestore')
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

  static async open(cwd) {
    const root = await Context.find(cwd)
    if (!root) {
      throw new Error('not a hyperscion worktree (no .hs found), run `hs init` or `hs clone`')
    }
    const config = JSON.parse(await fs.readFile(path.join(root, HS, 'config.json'), 'utf8'))
    const ctx = new Context(root, config)
    await ctx._openRepo(config.key ? z32.decode(config.key) : null)
    return ctx
  }

  static async create(
    root,
    { key = null, encryptionKey = null, workspace = 'default', sparse = ['/'] } = {}
  ) {
    await fs.mkdir(path.join(root, HS), { recursive: true })
    const config = {
      key: null,
      encryptionKey: encryptionKey ? z32.encode(encryptionKey) : null,
      workspace,
      sparse
    }
    const ctx = new Context(root, config)
    await ctx._openRepo(key)
    ctx.config.key = z32.encode(ctx.repo.key)
    await ctx.save()
    return ctx
  }

  // what another peer needs to join: the repo key, plus the encryption key if any
  get invite() {
    return this.config.encryptionKey
      ? this.config.key + '.' + this.config.encryptionKey
      : this.config.key
  }

  static parseInvite(invite) {
    const [key, enc] = invite.split('.')
    return { key: z32.decode(key), encryptionKey: enc ? z32.decode(enc) : null }
  }

  async _openRepo(key) {
    const encryptionKey = this.config.encryptionKey ? z32.decode(this.config.encryptionKey) : null
    this.store = new Corestore(path.join(this.root, HS, 'store'))
    this.repo = new Repo(this.store, { key, encryptionKey })
    await this.repo.ready()
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
    if (this.repo) await this.repo.close()
    if (this.store) await this.store.close()
  }
}
