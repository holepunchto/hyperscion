// `hs ui`: start the TUI in this worktree and resolve when the person quits
const process = require('bare-process')
const { spawn } = require('bare-subprocess')
const { Program, suspend } = require('bare-tui')
const Context = require('../context')
const Client = require('./client')
const App = require('./app')

async function run({ cwd = process.cwd() } = {}) {
  if (!(await Context.find(cwd))) {
    throw new Error('not a hyperscion worktree (no .hs found), run `hs init` or `hs clone`')
  }
  const client = new Client()
  const app = new App({ client, edit })
  const program = new Program(app)
  app.send = (msg) => program.send(msg)
  // anything that still escapes quits through the Program, which gives the terminal back
  const bail = () => program.quit()
  Bare.on('uncaughtException', bail).on('unhandledRejection', bail)
  try {
    await program.run()
  } finally {
    Bare.off('uncaughtException', bail).off('unhandledRejection', bail)
    await client.close()
  }
}

// e on a file: inside Neovim (lazyscion sets nothing; Neovim's terminal sets $NVIM) the file
// opens in that Neovim and lazyscion hides its float; elsewhere $VISUAL or $EDITOR takes over
// the terminal until it exits
function edit(file) {
  const env = process.env
  if (env.NVIM) {
    return () =>
      wait(
        spawn('nvim', [
          '--server',
          env.NVIM,
          '--remote-expr',
          `v:lua.require'lazyscion'.edit(${JSON.stringify(file)})`
        ])
      ).then(() => ({ type: 'edited', file }))
  }
  const [editor, ...args] = (env.VISUAL || env.EDITOR || 'vi').split(' ').filter(Boolean)
  return suspend(async () => {
    await wait(spawn(editor, [...args, file], { stdio: 'inherit' }))
    return { type: 'edited', file }
  })
}

function wait(child) {
  return new Promise((resolve) => {
    child.on('exit', resolve)
    child.on('error', () => resolve(1))
  })
}

module.exports = { run }
