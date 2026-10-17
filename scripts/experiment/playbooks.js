// The q0 arms' playbooks, built from docs/AGENTS.md so the arms differ only in how they
// coordinate: the same model, loop, land states, shared files, messages and tips, with the
// claims/review sections replaced by one coordination section per arm
// (scripts/experiment/playbook-sections/<arm>.md).
//   node scripts/experiment/playbooks.js     writes docs/AGENTS-min.md and docs/AGENTS-plain.md
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const text = fs.readFileSync(path.join(ROOT, 'docs', 'AGENTS.md'), 'utf8')
const [head, ...parts] = text.split(/^(?=## )/m)
const section = (prefix) => {
  const s = parts.find((p) => p.startsWith(prefix))
  if (!s) throw new Error('docs/AGENTS.md has no section ' + prefix)
  return s
}
// rows of the messages table that send an agent to commands these arms don't have
const messages = section('## What the messages')
  .split('\n')
  .filter((l) => !/hs propose --reviewers|stale-review/.test(l))
  .join('\n')

for (const [arm, title] of [
  ['min', 'minimal surface'],
  ['plain', 'task-board arm']
]) {
  const coordination = fs.readFileSync(
    path.join(__dirname, 'playbook-sections', arm + '.md'),
    'utf8'
  )
  const out = [
    head.replace(/^(# .*)$/m, `$1 (${title})`),
    section('## The model'),
    section('## The loop'),
    coordination.trimEnd() + '\n\n',
    section('## Provisional'),
    section('## Shared files'),
    messages,
    section('## Good to know')
  ].join('')
  fs.writeFileSync(path.join(ROOT, 'docs', `AGENTS-${arm}.md`), out)
}
