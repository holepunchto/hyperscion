// Which untracked files on disk hs leaves alone. hs honors the repo's .gitignore files (agents
// and existing projects already have them, and without them `npm install` in a worktree would
// land node_modules for every peer to replicate), and an optional .hsignore in the same places
// layers on top: its rules apply after .gitignore's, so `!dist/` shares what git ignores and a
// new pattern ignores what git tracks. Unlike .npmignore, it never replaces .gitignore.
//
// Git's semantics: a file's rules are relative to its directory, a deeper directory's rules
// win, and the last matching rule decides. Only untracked files are ignored: a file already on
// main stays tracked until someone deletes it (the worktree checks that, not this).
const fs = require('bare-fs/promises')
const path = require('bare-path')
const ignore = require('ignore')

const FILES = ['.gitignore', '.hsignore']

class Ignorer {
  constructor(root) {
    this.root = root
    this._rules = new Map() // repo dir ('' for the root) -> ignore() instance, or null
  }

  // the rules a directory's own .gitignore and .hsignore add (.hsignore last, so it wins)
  async _dirRules(dir) {
    if (this._rules.has(dir)) return this._rules.get(dir)
    let ig = null
    for (const name of FILES) {
      const file = path.join(this.root, ...dir.split('/').filter(Boolean), name)
      let text = null
      try {
        text = await fs.readFile(file, 'utf8')
      } catch {
        continue
      }
      ig = ig || ignore()
      ig.add(text)
    }
    this._rules.set(dir, ig)
    return ig
  }

  // is this repo path ('/node_modules', '/src/a.log') ignored? isDir: it's a directory
  async ignored(p, isDir = false) {
    const parts = p.split('/').filter(Boolean)
    let result = false
    // every ancestor directory's rules, root first: a deeper directory overrides
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      const ig = await this._dirRules(dir)
      if (!ig) continue
      const rel = parts.slice(i).join('/') + (isDir ? '/' : '')
      const t = ig.test(rel)
      if (t.ignored) result = true
      else if (t.unignored) result = false
    }
    return result
  }
}

module.exports = { Ignorer, FILES }
