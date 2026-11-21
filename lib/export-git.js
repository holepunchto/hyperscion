// hs main back into git: a branch with one commit per settled changeset after a base, on top
// of the git commit that base came from. The way out of a trial: `hs import-git` brought a
// branch in (each of its changesets says `git: <sha>`), agents landed on top, and this writes
// what they landed as a branch the team merges like any other.
//
// The base is recorded, not guessed: the newest changeset carrying a `git: <sha>` line, and
// its sha is the parent of the first commit. `since`/`onto` name them by hand instead. Only
// settled changesets are written, as `hs gip publish` does: a provisional one can still move.
// Commits go in through `git fast-import`, so git computes the trees and only the paths each
// changeset touched are written. Each carries the `Hs-Changeset: <repo>#<n>` trailer, and its
// committer is its author, so the same main always gives the same commits.
const b4a = require('b4a')
const { spawn } = require('bare-subprocess')
const gx = require('./gitexport')
const gip = require('./gip')
const { git } = require('./import-git')

const GIT_LINE = /^git: ([0-9a-f]{40})$/m

module.exports = async function exportGit(repo, gitDir, opts = {}) {
  const { branch, since = null, onto = null, force = false, io, onprogress = noop } = opts
  if (!branch) throw new Error('name the branch to write')
  await git(gitDir, ['check-ref-format', '--branch', branch]).catch(() => {
    throw new Error(`not a valid branch name: ${branch}`)
  })

  const snap = repo.main.view.snapshot(io)
  const drive = repo.drive(snap)
  try {
    const settled = await repo.settledSeq(snap)
    const head = (await repo.meta()).seq
    const base = since === null ? await importBase(repo, head, snap) : { seq: since, sha: null }
    if (base.seq > settled) {
      throw new Error(
        `#${base.seq} is not settled yet (main is settled to #${settled}): is the hub online?`
      )
    }
    const ontoRef = onto || base.sha || 'HEAD'
    const parent = await revParse(gitDir, ontoRef + '^{commit}').catch(() => {
      throw new Error(`${ontoRef} is not a commit in ${gitDir}`)
    })

    const ref = 'refs/heads/' + branch
    const exists = await revParse(gitDir, ref).catch(() => null)
    if (exists && !force) {
      throw new Error(`branch ${branch} exists: pick another name, or pass --force to replace it`)
    }
    // replacing a branch some worktree has checked out would leave its files behind the branch
    const checkedOut = exists
      ? await git(gitDir, ['for-each-ref', '--format=%(worktreepath)', ref])
          .then((b) => b4a.toString(b).trim())
          .catch(() => '')
      : ''
    if (checkedOut) {
      throw new Error(`branch ${branch} is checked out in ${checkedOut}: switch away from it first`)
    }

    const stats = {
      base: base.seq,
      onto: parent,
      from: base.seq + 1,
      to: settled,
      commits: 0,
      provisional: Math.max(0, head - settled),
      branch
    }
    if (settled <= base.seq) return stats

    const id = gip.repoId(repo)
    const changes = await gip.changesBetween(repo, base.seq, settled, snap)
    const proc = spawn('git', [
      '-C',
      gitDir,
      'fast-import',
      '--quiet',
      ...(force ? ['--force'] : [])
    ])
    const done = exited(proc)
    const w = writer(proc.stdin)
    try {
      await writeCommits()
    } catch (err) {
      // fast-import moves the branch only once its input ends cleanly: killed, it moves nothing
      proc.kill()
      await done.catch(() => {})
      throw err
    }
    proc.stdin.end()
    await done
    stats.tip = await revParse(gitDir, ref)
    return stats

    async function writeCommits() {
      for (let seq = base.seq + 1; seq <= settled; seq++) {
        const cs = await repo.changeset(seq, snap)
        if (!cs) throw new Error(`changeset #${seq} is missing`)
        const who = `${gx.identity(await authorOf(repo, cs, snap))} ${Math.floor((cs.time || 0) / 1000)} +0000`
        const message =
          ((cs.message || '').trim() || `changeset #${seq}`) + '\n\n' + gx.trailer(id, seq) + '\n'
        await w(`commit ${ref}\nauthor ${who}\ncommitter ${who}\n`)
        await w(data(b4a.from(message)))
        if (seq === base.seq + 1) await w(`from ${parent}\n`)
        for (const { path, next } of changes.get(seq) || []) {
          const p = quote(path.replace(/^\/+/, ''))
          if (!next) {
            await w(`D ${p}\n`)
            continue
          }
          const blob = await gip.blobOf(drive, next, io)
          await w(`M ${blob.mode} inline ${p}\n`)
          await w(data(blob.data))
        }
        await w('\n')
        stats.commits++
        onprogress(stats)
      }
    }
  } finally {
    await drive.close()
    await snap.close()
  }
}

// who to name: a git author kept by import-git ("Name <email>") as it is, else the writer's
// verified handle (what `hs log` shows), not the free text a land claimed (the OS user)
async function authorOf(repo, cs, snap) {
  if (/<[^<>]*>\s*$/.test(cs.author || '')) return cs.author
  return (await repo.handleOf(cs.writer, snap).catch(() => null)) || cs.author
}

// the newest settled changeset that came from git: { seq, sha }
async function importBase(repo, head, snap) {
  for (let seq = head; seq >= 1; seq--) {
    const cs = await repo.changeset(seq, snap)
    const m = cs && GIT_LINE.exec(cs.message || '')
    if (m) return { seq, sha: m[1] }
  }
  throw new Error(
    'no changeset came from git (`hs import-git`): name where to start with ' +
      '--since <n> (export the changesets after #n) and --onto <git ref> (the parent commit)'
  )
}

async function revParse(gitDir, ref) {
  return b4a.toString(await git(gitDir, ['rev-parse', '--verify', '--quiet', ref])).trim()
}

// fast-import's `data <n>` block
function data(bytes) {
  return b4a.concat([b4a.from(`data ${bytes.byteLength}\n`), bytes, b4a.from('\n')])
}

// fast-import takes a path as is unless it starts with a quote or holds a newline or backslash
function quote(p) {
  return /^"|[\n\\"]/.test(p) ? JSON.stringify(p) : p
}

// write to a stream, waiting for it to drain when its buffer is full
function writer(stream) {
  return (chunk) =>
    new Promise((resolve) => {
      if (stream.write(typeof chunk === 'string' ? b4a.from(chunk) : chunk)) resolve()
      else stream.once('drain', resolve)
    })
}

function exited(proc) {
  const errs = []
  proc.stderr.on('data', (d) => errs.push(d))
  return new Promise((resolve, reject) => {
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error('git fast-import failed: ' + b4a.toString(b4a.concat(errs)).trim()))
    })
  })
}

function noop() {}
