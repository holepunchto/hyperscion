// Streams main's changesets as they land, so agents watch instead of polling `hs pull`.
// Emits 'changeset' (cs) in seq order and 'reorg' ({ seq, before, after }) when a changeset it
// already reported was replaced by a concurrent land (a provisional land was undone).
const EventEmitter = require('bare-events')
const b4a = require('b4a')

const REMEMBER = 256

module.exports = class Watcher extends EventEmitter {
  constructor(repo, { since = null, paths = [] } = {}) {
    super()
    this.repo = repo
    this.since = since
    this.paths = paths.map((p) => '/' + p.replace(/^\/+/, '').replace(/\/+$/, ''))
    this.last = 0
    this.seen = new Map() // seq -> changeset we reported (or skipped by filter)
    this.closed = false
    this._running = null
    this._again = false
    this._onupdate = () => this._schedule()
  }

  async start() {
    await this.repo.ready()
    await this.repo.update()
    this.last = this.since === null ? (await this.repo.meta()).seq : this.since
    for (let s = Math.max(1, this.last - 16); s <= this.last; s++) {
      const cs = await this.repo.changeset(s)
      if (cs) this.seen.set(s, cs)
    }
    this.repo.main.view.on('update', this._onupdate)
    this._schedule()
  }

  close() {
    this.closed = true
    this.repo.main.view.off('update', this._onupdate)
    return this._running
  }

  matches(cs) {
    if (!this.paths.length) return true
    return (cs.files || []).some((f) => {
      const p = f.replace(/^-/, '')
      return this.paths.some((w) => p === w || p.startsWith(w + '/'))
    })
  }

  _schedule() {
    if (this.closed) return
    if (this._running) {
      this._again = true
      return
    }
    this._running = this._poll()
      .catch((err) => this.emit('error', err))
      .finally(() => {
        this._running = null
        if (this._again) {
          this._again = false
          this._schedule()
        }
      })
  }

  async _poll() {
    const meta = await this.repo.meta()

    // a changeset we already reported now has a different hash: history was reordered
    let rewind = Infinity
    for (const [seq, before] of this.seen) {
      const after = seq <= meta.seq ? await this.repo.changeset(seq) : null
      if (!after || !b4a.equals(after.hash, before.hash)) {
        if (this.matches(before) || (after && this.matches(after))) {
          this.emit('reorg', { seq, before, after })
        }
        rewind = Math.min(rewind, seq - 1)
      }
    }
    if (rewind !== Infinity) {
      for (const seq of [...this.seen.keys()]) if (seq > rewind) this.seen.delete(seq)
      this.last = Math.min(this.last, rewind)
    }

    while (!this.closed && this.last < meta.seq) {
      const seq = this.last + 1
      const cs = await this.repo.changeset(seq)
      if (!cs) break
      this.last = seq
      this.seen.set(seq, cs)
      if (this.seen.size > REMEMBER) this.seen.delete(this.seen.keys().next().value)
      if (this.matches(cs)) this.emit('changeset', cs)
    }
  }
}
