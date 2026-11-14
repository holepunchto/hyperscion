// One-way git importer: replays a branch's first-parent history as lands on main, keeping
// git's author, time and message. Content comes from a single long-lived `git cat-file --batch`.
// Commits that change more than CHUNK paths become several consecutive changesets, since a
// land travels inline in one autobee node (one hypercore block).
const { spawn } = require('bare-subprocess')
const b4a = require('b4a')

const CHUNK = 20_000

const MODE_EXEC = '100755'
const MODE_LINK = '120000'
const MODE_GITLINK = '160000'

module.exports = async function importGit(repo, gitDir, opts = {}) {
  const {
    branch = 'HEAD',
    limit = Infinity,
    workspace = 'git-import',
    onprogress = noop,
    chunk = CHUNK
  } = opts

  const commits = (await git(gitDir, ['rev-list', '--first-parent', '--reverse', branch]))
    .toString()
    .split('\n')
    .filter(Boolean)
    .slice(0, limit)

  const ws = await repo.workspace(workspace)
  const cat = new CatFile(gitDir)
  const stats = { commits: 0, changesets: 0, paths: 0, bytes: 0, skipped: 0 }

  try {
    let parent = null

    for (const sha of commits) {
      const meta = await commitInfo(gitDir, sha)
      const changes = await diffTree(gitDir, parent, sha)
      parent = sha

      const batch = []
      for (const ch of changes) {
        if (ch.mode === MODE_GITLINK || ch.mode === MODE_LINK) {
          stats.skipped++
          continue
        }
        if (ch.status === 'D') {
          batch.push({ path: ch.path, content: null })
          continue
        }
        const content = await cat.get(ch.sha)
        stats.bytes += content.byteLength
        batch.push({ path: ch.path, content, executable: ch.mode === MODE_EXEC })
      }

      for (let i = 0; i < batch.length || i === 0; i += chunk) {
        const part = batch.slice(i, i + chunk)
        if (part.length) await ws.commit(part)
        const suffix =
          batch.length > chunk ? ` [${i / chunk + 1}/${Math.ceil(batch.length / chunk)}]` : ''
        const { outcome } = await ws.land({
          message: meta.message + suffix + `\n\ngit: ${sha}`,
          author: meta.author,
          time: meta.time
        })
        if (outcome.status === 'accepted') stats.changesets++
        else if (outcome.status !== 'empty') {
          throw new Error(
            `land of ${sha} was ${outcome.status}: ${outcome.reason || outcome.conflicts}`
          )
        }
        if (batch.length === 0) break
      }

      stats.commits++
      stats.paths += batch.length
      onprogress(stats, sha)
    }
  } finally {
    cat.destroy()
  }

  return stats
}

async function commitInfo(gitDir, sha) {
  const out = await git(gitDir, ['show', '-s', '--format=%an <%ae>%x00%at%x00%B', sha])
  const [author, at, message] = out.toString().split('\0')
  return { author, time: Number(at) * 1000, message: message.trim() }
}

async function diffTree(gitDir, parent, sha) {
  const args = ['diff-tree', '-r', '-z', '--raw', '--no-renames', '--no-commit-id']
  if (parent) args.push(parent, sha)
  else args.push('--root', sha)

  const parts = (await git(gitDir, args)).toString().split('\0')
  const changes = []

  // ":oldmode newmode oldsha newsha status" NUL path NUL
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const head = parts[i]
    if (!head.startsWith(':')) break
    const [, newMode, , newSha, status] = head.slice(1).split(' ')
    changes.push({ mode: newMode, sha: newSha, status: status[0], path: '/' + parts[i + 1] })
  }
  return changes
}

class CatFile {
  constructor(gitDir) {
    this.proc = spawn('git', ['-C', gitDir, 'cat-file', '--batch'])
    this.buffer = b4a.alloc(0)
    this.waiting = []
    this.proc.stdout.on('data', (data) => {
      this.buffer = this.buffer.byteLength ? b4a.concat([this.buffer, data]) : data
      this._drain()
    })
  }

  get(sha) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject })
      this.proc.stdin.write(sha + '\n')
    })
  }

  _drain() {
    while (this.waiting.length) {
      const nl = this.buffer.indexOf(10)
      if (nl === -1) return

      const header = b4a.toString(this.buffer.subarray(0, nl))
      const [, type, size] = header.split(' ')
      if (type === 'missing' || size === undefined) {
        this.buffer = this.buffer.subarray(nl + 1)
        this.waiting.shift().reject(new Error('git object missing: ' + header))
        continue
      }

      const n = Number(size)
      if (this.buffer.byteLength < nl + 1 + n + 1) return

      const content = b4a.from(this.buffer.subarray(nl + 1, nl + 1 + n))
      this.buffer = this.buffer.subarray(nl + 1 + n + 1)
      this.waiting.shift().resolve(content)
    }
  }

  destroy() {
    this.proc.stdin.end()
  }
}

function git(gitDir, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['-C', gitDir, ...args])
    const chunks = []
    const errs = []
    proc.stdout.on('data', (d) => chunks.push(d))
    proc.stderr.on('data', (d) => errs.push(d))
    proc.on('exit', (code) => {
      if (code === 0) resolve(b4a.concat(chunks))
      else reject(new Error(`git ${args[0]} failed: ${b4a.toString(b4a.concat(errs)).trim()}`))
    })
  })
}

function noop() {}
