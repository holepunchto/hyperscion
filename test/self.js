// hs runs itself again (the feed's keepalive): `bare bin.mjs` in a checkout, the binary alone
// when standalone (it once passed the bundle's bin.mjs path along, and the binary refused it)
const test = require('brittle')
const os = require('bare-os')
const { selfCommand, isDev, BIN } = require('../lib/self')

test('self: a checkout runs bin.mjs with bare', (t) => {
  t.ok(isDev('/usr/local/bin/bare'))
  t.alike(selfCommand(['keepalive'], '/usr/local/bin/bare'), [os.execPath(), [BIN, 'keepalive']])
})

test('self: the standalone binary runs itself, with no script path', (t) => {
  t.absent(isDev('/home/me/.local/bin/hs'))
  t.alike(selfCommand(['keepalive'], '/home/me/.local/bin/hs'), [os.execPath(), ['keepalive']])
})
