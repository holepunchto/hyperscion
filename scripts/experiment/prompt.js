// Render an agent prompt:
//   node scripts/experiment/prompt.js <agent> <teamdir> [--arm hs|git] [--scenario s1|s2|s3]
// Defaults come from <teamdir>/run.json (written by setup.sh), else hs and s1.
const fs = require('fs')
const path = require('path')

const argv = process.argv.slice(2)
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv.splice(i, 2)[1] : null
}
const armFlag = opt('--arm')
const scenarioFlag = opt('--scenario')
const [agent, teamdir] = argv
if (!agent || !teamdir) {
  console.error(
    'usage: node scripts/experiment/prompt.js <agent> <teamdir> [--arm hs|git] [--scenario sN]'
  )
  process.exit(1)
}

const dir = path.resolve(teamdir)
const runFile = path.join(dir, 'run.json')
const run = fs.existsSync(runFile) ? JSON.parse(fs.readFileSync(runFile, 'utf8')) : {}
const arm = armFlag || run.arm || 'hs'
const scenarioName = scenarioFlag || run.scenario || 's1'
const scenario = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'scenarios', scenarioName, 'scenario.json'), 'utf8')
)
const roles = {
  ...JSON.parse(fs.readFileSync(path.join(__dirname, 'roles.json'), 'utf8')),
  ...scenario.roles
}
const repo = path.resolve(__dirname, '../..')
const vars = {
  AGENT: agent,
  ROLE: roles[agent],
  WORKTREE: path.join(dir, 'agents', agent),
  AGENTS_DIR: path.join(dir, 'agents'),
  TEAMDIR: dir,
  REPO: repo,
  HS: path.join(dir, 'bin', 'hs-' + agent),
  GIT: path.join(dir, 'bin', 'git-' + agent),
  // a copy inside the team dir (setup.sh): reading docs/AGENTS-git.md makes Claude Code load
  // docs/AGENTS.md (the hs playbook) as directory instructions, which leaked into the git arm
  PLAYBOOK: fs.existsSync(path.join(dir, 'playbook.md'))
    ? path.join(dir, 'playbook.md')
    : path.join(repo, 'docs', arm === 'git' ? 'AGENTS-git.md' : 'AGENTS.md'),
  REPORT: path.join(dir, 'reports', agent + '.md'),
  SCENARIO: scenario.brief || ''
}
if (!vars.ROLE) {
  console.error('no role for ' + agent + ' in ' + scenarioName)
  process.exit(1)
}
const variant = scenario.template ? '-' + scenario.template : ''
const template = fs.readFileSync(
  path.join(__dirname, (arm === 'git' ? 'agent-prompt-git' : 'agent-prompt') + variant + '.md'),
  'utf8'
)
process.stdout.write(template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]))
