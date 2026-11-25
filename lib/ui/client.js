// The UI's side of the worker threads (lib/ui/worker.js). read() goes to one long-lived read
// worker, started on first use and again if it dies; run() starts a fresh worker per command,
// so each runs as a typed command would.
//
// Reads open the store as `hs status` does: writable while it's free. So the two lanes keep
// off each other's lock: a run waits for the reads in flight, and no read starts while a run
// waits or runs (one run at a time).
const Worker = require('bare-worker')

const ENTRY = require.resolve('./worker.js')

const STALLED =
  'stalled: this command needs data that is not local and no connected peer provided it. ' +
  "Nothing is lost: retry when the hub or a teammate's `hs watch` is online"

class Client {
  // cwd: the worktree reads look at. Runs use the process's cwd, as typed commands do (a thread
  // can't have its own)
  constructor({ cwd = null } = {}) {
    this.cwd = cwd
    this._reader = null
    this._pending = new Map()
    this._ids = 0
    this._runs = new Set()
    this._reads = new Set() // reads in flight
    this._writing = null // the run in progress (or waiting for reads to finish)
  }

  _readWorker() {
    if (this._reader) return this._reader
    const w = new Worker(ENTRY, { workerData: { role: 'read', cwd: this.cwd } })
    const stop = (why) => {
      if (this._reader === w) this._reader = null
      for (const p of this._pending.values()) p.reject(new Error(why))
      this._pending.clear()
    }
    w.on('message', (m) => {
      if (m.fatal) {
        stop('reading failed: ' + m.fatal)
        w.terminate()
        return
      }
      const p = this._pending.get(m.id)
      if (!p) return
      this._pending.delete(m.id)
      if (m.ok) p.resolve(m.data)
      else p.reject(new Error(m.error))
    })
    w.on('exit', () => stop('the read worker stopped'))
    this._reader = w
    return w
  }

  // a read op of lib/ui/backend.js: snapshot, log, show
  async read(op, args = {}) {
    while (this._writing) await this._writing.catch(() => {})
    const id = ++this._ids
    const p = new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      this._readWorker().postMessage({ id, op, args })
    })
    this._reads.add(p)
    try {
      return await p
    } finally {
      this._reads.delete(p)
    }
  }

  // run `hs <argv>`; onLine(line, stream) for each line it prints. Resolves { code, lines } as
  // soon as the command is done; the lane stays held until its thread has closed everything
  async run(argv, onLine = () => {}) {
    while (this._writing) await this._writing.catch(() => {})
    let done = null
    const result = new Promise((resolve) => {
      done = resolve
    })
    const running = (async () => {
      await Promise.allSettled([...this._reads])
      await this._spawn(argv, onLine, done)
    })()
    this._writing = running
    running.finally(() => {
      if (this._writing === running) this._writing = null
    })
    return result
  }

  // resolves when the thread exits; done({ code, lines }) is called once, at the command's end
  _spawn(argv, onLine, done) {
    return new Promise((resolve) => {
      const lines = []
      let code = null
      const w = new Worker(ENTRY, { workerData: { role: 'run', argv } })
      this._runs.add(w)
      const line = (text, stream) => {
        lines.push(text)
        onLine(text, stream)
      }
      w.on('message', (m) => {
        if (!m.done) return line(m.line, m.stream)
        code = m.code
        done({ code, lines })
      })
      w.on('exit', () => {
        this._runs.delete(w)
        if (code === null) {
          line('hs: ' + STALLED, 'stderr')
          code = 1
          done({ code, lines })
        }
        resolve()
      })
    })
  }

  async close() {
    const all = [...this._runs]
    if (this._reader) all.push(this._reader)
    await Promise.all(all.map((w) => w.terminate()))
  }
}

module.exports = Client
