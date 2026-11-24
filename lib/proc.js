// Waiting for a child process: its output can still arrive after 'exit' (under load,
// `git rev-parse` "returned" nothing: test/trial.js). Resolves with the exit code once the
// process exited and its piped streams ended, waiting at most `grace` ms for the streams
// after the exit (a backgrounded grandchild can hold a pipe open for good).
function finished(proc, { grace = 1000 } = {}) {
  return new Promise((resolve) => {
    const streams = [proc.stdout, proc.stderr].filter(Boolean)
    let open = streams.length
    let exited = false
    let code = null
    let timer = null
    const done = () => {
      if (timer) clearTimeout(timer)
      resolve(code)
    }
    for (const s of streams) {
      let ended = false
      const end = () => {
        if (ended) return
        ended = true
        open--
        if (exited && open === 0) done()
      }
      s.on('end', end)
      s.on('close', end)
    }
    proc.on('exit', (c) => {
      code = c
      exited = true
      if (open === 0) return done()
      timer = setTimeout(done, grace)
    })
  })
}

module.exports = { finished }
