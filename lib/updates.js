// Peer-to-peer OTA updates (from the hello-pear-bare template) for long-running `hs seed`.
// One-shot commands never update mid-flight.
const path = require('bare-path')
const os = require('bare-os')
const { persistent } = require('bare-storage')
const { isWindows } = require('which-runtime')
const pkg = require('../package.json')

const PLACEHOLDER = 'pear://<YOUR_KEY_HERE>'

module.exports = async function startUpdates(log) {
  if (!pkg.upgrade || pkg.upgrade === PLACEHOLDER) {
    log('updates: no upgrade link in package.json (create one with `pear touch`), skipping')
    return null
  }

  const App = require('../app.js')
  const appName = pkg.productName || pkg.name
  const isDev = path.basename(Bare.argv[0]) === (isWindows ? 'bare.exe' : 'bare')

  const app = new App({
    dir: isDev ? path.join(os.tmpdir(), 'pear', appName) : path.join(persistent(), appName),
    app: isDev ? null : os.execPath(),
    updates: true,
    version: pkg.version,
    upgrade: pkg.upgrade,
    name: isWindows ? appName + '.exe' : appName
  })

  app.on('updating', () => log('[updater] getting new update'))
  app.on('updated', () => log('[updater] update complete... applying'))
  app.on('update-applied', () => log('[updater] applied update, restart `hs seed` to run it'))
  app.on('error', (err) => log('[updater] ' + err.message))

  await app.ready()
  log(`updates: enabled (${pkg.upgrade})`)
  return app
}
