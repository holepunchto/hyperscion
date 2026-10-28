// A hub home as a user service (README "Run your hubs as a service"): a systemd user unit on
// Linux, a launchd agent on macOS. The service runs `hs hubs serve --updates
// --restart-on-update` and starts it again whenever it exits, so an applied update or
// `hs hubs restart` comes back on the new binary by itself.
//
// Rendering (pure, tested in test/service.js) is kept apart from installing (systemctl,
// launchctl). Which service a home has is recorded in <home>/service.json.
const fs = require('bare-fs/promises')
const path = require('bare-path')
const os = require('bare-os')
const process = require('bare-process')
const { spawn } = require('bare-subprocess')
const { isLinux, isMac } = require('which-runtime')
const self = require('./self')

const DEFAULT_NAME = 'hs-hubs'

function platform() {
  if (isLinux) return 'systemd'
  if (isMac) return 'launchd'
  return null
}

// what the service runs: this hs, serving the home, updating itself unless it runs from a
// checkout (where an update never replaces the code)
function serveCommand(home, { dev = self.isDev() } = {}) {
  const args = ['hubs', 'serve', '--home', home]
  if (!dev) args.push('--updates', '--restart-on-update')
  const [exe, argv] = self.selfCommand(args)
  return { exe, args: argv }
}

// HS_BOOTSTRAP (a private DHT) carries over, so a test or airgapped home keeps its network
function serviceEnv(home, env = process.env) {
  const out = { HS_HUB_HOME: home }
  if (env.HS_BOOTSTRAP) out.HS_BOOTSTRAP = env.HS_BOOTSTRAP
  return out
}

function renderSystemd({ home, exe, args, env }) {
  const q = (s) => (/[\s"\\]/.test(s) ? '"' + s.replace(/[\\"]/g, '\\$&') + '"' : s)
  return [
    '[Unit]',
    `Description=hs hub home ${home}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${[exe, ...args].map(q).join(' ')}`,
    `WorkingDirectory=${q(home)}`,
    ...Object.entries(env).map(([k, v]) => `Environment=${q(k + '=' + v)}`),
    // any exit starts it again (an update, `hs hubs restart`, a crash); `stop` doesn't
    'Restart=always',
    'RestartSec=2',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=60',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n')
}

function renderLaunchd({ label, home, exe, args, env }) {
  const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const str = (s) => `    <string>${x(s)}</string>`
  const log = path.join(home, 'hubs.log')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${x(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[exe, ...args].map(str),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${x(home)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(env).flatMap(([k, v]) => [
      `    <key>${x(k)}</key>`,
      `    <string>${x(v)}</string>`
    ]),
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    // any exit starts it again (an update, `hs hubs restart`, a crash)
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>ThrottleInterval</key>',
    '  <integer>5</integer>',
    '  <key>StandardOutPath</key>',
    `  <string>${x(log)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${x(log)}</string>`,
    '</dict>',
    '</plist>',
    ''
  ].join('\n')
}

// where the service's file goes, and what it renders to
function plan(home, { name = DEFAULT_NAME, kind = platform(), env = process.env } = {}) {
  if (!kind) {
    throw new Error(
      'hs can install a service on Linux (systemd) and macOS (launchd) so far; elsewhere, run ' +
        '`hs hubs serve --updates` under your own supervisor'
    )
  }
  const { exe, args } = serveCommand(home)
  const vars = serviceEnv(home, env)
  if (kind === 'systemd') {
    const dir = path.join(
      env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
      'systemd',
      'user'
    )
    return {
      kind,
      name,
      file: path.join(dir, name + '.service'),
      text: renderSystemd({ home, exe, args, env: vars })
    }
  }
  const label = 'to.holepunch.' + name
  return {
    kind,
    name,
    label,
    file: path.join(os.homedir(), 'Library', 'LaunchAgents', label + '.plist'),
    text: renderLaunchd({ label, home, exe, args, env: vars })
  }
}

async function recorded(home) {
  try {
    return JSON.parse(await fs.readFile(home.file('service.json'), 'utf8'))
  } catch {
    return null
  }
}

async function installed(home) {
  return !!(await recorded(home))
}

async function install(home, { name = DEFAULT_NAME } = {}) {
  const p = plan(home.dir, { name })
  await fs.mkdir(path.dirname(p.file), { recursive: true })
  await fs.writeFile(p.file, p.text)
  await fs.writeFile(
    home.file('service.json'),
    JSON.stringify(
      p.kind === 'launchd'
        ? { kind: p.kind, name, label: p.label, file: p.file }
        : { kind: p.kind, name, file: p.file }
    ) + '\n'
  )
  const notes = []
  if (p.kind === 'systemd') {
    await must('systemctl', ['--user', 'daemon-reload'])
    await must('systemctl', ['--user', 'enable', '--now', name + '.service'])
    const linger = await run('loginctl', ['show-user', process.env.USER || '', '-p', 'Linger'])
    if (!/Linger=yes/.test(linger.stdout)) {
      notes.push(
        'systemd stops user services when you log out: `loginctl enable-linger` keeps the hubs ' +
          'running after logout and starts them at boot'
      )
    }
  } else {
    const domain = 'gui/' + (await uid())
    await run('launchctl', ['bootout', domain, p.file]) // a previous install, if any
    await must('launchctl', ['bootstrap', domain, p.file])
  }
  return { ...p, notes }
}

async function uninstall(home) {
  const r = await recorded(home)
  if (!r) throw new Error(`${home.dir} has no service (\`hs hubs service install\`)`)
  if (r.kind === 'systemd') {
    await run('systemctl', ['--user', 'disable', '--now', r.name + '.service'])
    await fs.rm(r.file, { force: true })
    await run('systemctl', ['--user', 'daemon-reload'])
  } else {
    await run('launchctl', ['bootout', 'gui/' + (await uid()), r.file])
    await fs.rm(r.file, { force: true })
  }
  await fs.rm(home.file('service.json'), { force: true })
  return r
}

async function status(home) {
  const r = await recorded(home)
  if (!r) return null
  const res =
    r.kind === 'systemd'
      ? await run('systemctl', [
          '--user',
          'status',
          '--no-pager',
          '--lines',
          '0',
          r.name + '.service'
        ])
      : await run('launchctl', ['print', 'gui/' + (await uid()) + '/' + r.label])
  return { ...r, text: (res.stdout + res.stderr).trim() }
}

// the command that shows the service's log
function logsCommand(r, home, { follow = false, lines = 50 } = {}) {
  if (r.kind === 'systemd') {
    return [
      'journalctl',
      [
        '--user',
        '-u',
        r.name + '.service',
        '-n',
        String(lines),
        ...(follow ? ['-f'] : []),
        '--no-pager'
      ]
    ]
  }
  return ['tail', ['-n', String(lines), ...(follow ? ['-f'] : []), home.file('hubs.log')]]
}

async function uid() {
  return (await must('id', ['-u'])).stdout.trim()
}

function run(cmd, args, { stdio = 'pipe' } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let p
    try {
      p = spawn(cmd, args, { stdio: stdio === 'inherit' ? 'inherit' : 'pipe' })
    } catch (err) {
      return resolve({ code: 127, stdout, stderr: err.message })
    }
    if (p.stdout) p.stdout.on('data', (d) => (stdout += d))
    if (p.stderr) p.stderr.on('data', (d) => (stderr += d))
    p.on('error', (err) => resolve({ code: 127, stdout, stderr: err.message }))
    p.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

async function must(cmd, args) {
  const res = await run(cmd, args)
  if (res.code !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${(res.stderr || res.stdout).trim()}`)
  }
  return res
}

module.exports = {
  DEFAULT_NAME,
  platform,
  serveCommand,
  serviceEnv,
  renderSystemd,
  renderLaunchd,
  plan,
  recorded,
  installed,
  install,
  uninstall,
  status,
  logsCommand,
  run
}
