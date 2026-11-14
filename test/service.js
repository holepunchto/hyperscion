// `hs hubs service`: the systemd unit and launchd agent it writes (lib/service.js)
const test = require('brittle')
const service = require('../lib/service')

const home = '/home/me/my hubs'
const cmd = {
  exe: '/home/me/.local/bin/hs',
  args: ['hubs', 'serve', '--home', home, '--updates', '--restart-on-update']
}

test('service: the systemd unit runs the home and restarts on any exit', (t) => {
  const env = service.serviceEnv(home, { HS_BOOTSTRAP: '127.0.0.1:49737', OTHER: 'x' })
  const unit = service.renderSystemd({ home, ...cmd, env })
  t.ok(
    unit.includes(
      'ExecStart=/home/me/.local/bin/hs hubs serve --home "/home/me/my hubs" --updates --restart-on-update'
    ),
    'paths with spaces are quoted'
  )
  t.ok(unit.includes('Restart=always'), 'started again whenever it exits')
  t.ok(unit.includes('Environment="HS_HUB_HOME=/home/me/my hubs"'))
  t.ok(unit.includes('Environment=HS_BOOTSTRAP=127.0.0.1:49737'), 'a private DHT carries over')
  t.absent(unit.includes('OTHER'), 'nothing else from the environment')
  t.ok(unit.includes('WantedBy=default.target'))
})

test('service: the launchd agent keeps the home alive and logs into it', (t) => {
  const env = service.serviceEnv('/Users/me/a&b', {})
  const plist = service.renderLaunchd({
    label: 'to.holepunch.hs-hubs',
    home: '/Users/me/a&b',
    exe: cmd.exe,
    args: ['hubs', 'serve', '--home', '/Users/me/a&b'],
    env
  })
  t.ok(plist.includes('<key>KeepAlive</key>\n  <true/>'), 'started again whenever it exits')
  t.ok(plist.includes('<string>/Users/me/a&amp;b</string>'), 'XML-escaped')
  t.ok(plist.includes('<string>/Users/me/a&amp;b/hubs.log</string>'), 'logs into the home')
  t.ok(plist.includes('<key>HS_HUB_HOME</key>'))
  t.absent(plist.includes('HS_BOOTSTRAP'))
})

test('service: a checkout never asks for updates; a binary does', (t) => {
  t.absent(service.serveCommand(home, { dev: true }).args.includes('--updates'), 'checkout')
  const bin = service.serveCommand(home, { dev: false }).args
  t.ok(bin.includes('--updates') && bin.includes('--restart-on-update'), 'standalone binary')
})

test('service: plan names the file for each platform', (t) => {
  const env = { XDG_CONFIG_HOME: '/cfg' }
  const sd = service.plan(home, { kind: 'systemd', env })
  t.is(sd.file, '/cfg/systemd/user/hs-hubs.service')
  const ld = service.plan(home, { kind: 'launchd', name: 'work', env })
  t.is(ld.label, 'to.holepunch.work')
  t.ok(ld.file.endsWith('/Library/LaunchAgents/to.holepunch.work.plist'))
  t.exception(() => service.plan(home, { kind: null }), /Linux \(systemd\) and macOS/)
})
