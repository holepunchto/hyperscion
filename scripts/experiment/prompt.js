// Render an agent prompt: node scripts/experiment/prompt.js <agent> <teamdir>
const fs = require('fs')
const path = require('path')

const [agent, teamdir] = process.argv.slice(2)
if (!agent || !teamdir) {
  console.error('usage: node scripts/experiment/prompt.js <agent> <teamdir>')
  process.exit(1)
}

const dir = path.resolve(teamdir)
const roles = JSON.parse(fs.readFileSync(path.join(__dirname, 'roles.json'), 'utf8'))
const vars = {
  AGENT: agent,
  ROLE: roles[agent],
  WORKTREE: path.join(dir, 'agents', agent),
  AGENTS_DIR: path.join(dir, 'agents'),
  HS: path.join(dir, 'bin', 'hs-' + agent),
  PLAYBOOK: path.resolve(__dirname, '../../docs/AGENTS.md'),
  REPORT: path.join(dir, 'reports', agent + '.md')
}
const template = fs.readFileSync(path.join(__dirname, 'agent-prompt.md'), 'utf8')
process.stdout.write(template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k]))
