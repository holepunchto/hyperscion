// `hs ui`'s model (bare-tui, The Elm Architecture): lazygit's layout and keys over hs. The
// left column is Status, Files (what `land` would send), Log (landed changesets) and Review
// (what waits on you, and your open asks); the right is the main panel: the selected file's
// diff, changeset, ask or task. c lands, A asks for review instead, p syncs, d discards a file,
// e edits it; in Review, a approves, x asks for changes, m comments. Reads go to a read-only worker (they never
// take the store's lock); each action runs the real command in its own worker, one at a time.
const { style, key, textinput, batch, quit } = require('bare-tui')

const PANELS = ['status', 'files', 'log', 'review']
const LISTS = ['files', 'log', 'review']
const TITLES = { status: '[1] Status', files: '[2] Files', log: '[3] Log', review: '[4] Review' }
const IDLE_MS = 30_000
// a lone Esc press arrives as alt+escape (bare-ansi-escapes sets meta when its escape timer
// fires), and bare-tui 0.3 matches chords whole, so 'esc' alone never sees it
const ESC = ['esc', 'alt+escape']

const paint = (color, text) => style().foreground(color).render(text)
const bold = (text) => style().bold().render(text)
const faint = (text) => style().faint().render(text)

const FILE_COLORS = {
  modified: 'yellow',
  added: 'green',
  deleted: 'red',
  stale: 'magenta',
  commit: 'cyan',
  'commit-del': 'cyan',
  CONFLICT: 'red'
}
const STATE_COLORS = { final: 'green', settled: 'cyan', provisional: 'yellow' }
const KIND_COLORS = { task: 'magenta', ask: 'yellow', change: 'cyan' }

// the review verdicts a key gives, as `hs review <verb>` takes them
const VERDICTS = {
  a: {
    verb: 'approve',
    title: 'approve',
    needsMessage: false,
    prompt: 'What you checked (optional):'
  },
  x: {
    verb: 'changes',
    title: 'request changes',
    needsMessage: true,
    prompt: 'What should change:'
  },
  m: { verb: 'comment', title: 'comment', needsMessage: true, prompt: 'Your comment:' }
}

const HELP = [
  'hs ui: lazygit-style keys over hs',
  '',
  '  j/k, ↑/↓        move in a list (or scroll the main panel)',
  '  h/l, tab        previous / next panel; 1 2 3 4 jump to Status, Files, Log, Review',
  '  enter           focus the main panel to scroll it; esc goes back',
  '  J/K, ctrl+d/u   scroll the main panel from anywhere',
  '',
  '  c or P          land: asks for a message, then `hs land -m <message>`',
  '  A               ask for review instead of landing: `hs review ask -m <message> [-r who]`',
  '  p               sync: `hs sync` (brings main in, rebases your work)',
  '  d               discard the selected file: `hs restore <path>`',
  '  e               edit the selected file (in Neovim when run from lazyscion)',
  '',
  'In Review (tasks to approve, asks and changes to review, your own asks):',
  '  a               approve: `hs review approve <A5|27|T1a2b3c>` (a message is optional)',
  '  x               request changes: `hs review changes <target> -m <message>`',
  '  m               comment: `hs review comment <target> -m <message>`',
  '',
  '  r or R          refresh',
  '  ?               this help',
  '  q               quit (ctrl+c also during a land)',
  '',
  'Reads show this machine’s copy of main; `p` brings in what teammates landed.'
]

class App {
  // client: { read(op, args), run(argv, onLine) } (lib/ui/client.js); edit(path): open a file
  // (returns a Cmd or null); send(msg) is set by the Program runner for streamed output
  constructor({ client, edit = null, idleMs = IDLE_MS } = {}) {
    this.client = client
    this.edit = edit
    this.idleMs = idleMs
    this.send = null
    this.width = 80
    this.height = 24

    this.panel = 'files'
    this.back = 'files' // where esc from the main panel returns
    this.sel = { files: 0, log: 0, review: 0 }
    this.top = { files: 0, log: 0, review: 0 }
    this.mainTop = 0

    this.snap = null
    this.snapError = null
    this.log = []
    this.logError = null
    this.shows = new Map() // seq -> text (or { error })
    this.review = []
    this.reviewError = null
    this.details = new Map() // review id -> text (or { error })
    this.gen = { snap: 0, log: 0, review: 0, idle: 0 }

    this.running = null // { argv, title, lines, code } while (and after) an action runs
    this.popup = null // { kind: 'land' | 'ask' | 'verdict' | 'confirm' | 'output' | 'help', ... }
    this.notice = null
  }

  init() {
    return batch(this._refresh(), this._idle())
  }

  // --- commands -------------------------------------------------------------------------

  _refresh() {
    const l = ++this.gen.log
    return batch(
      this._refreshSnap(),
      () =>
        this.client.read('log', { limit: 200 }).then(
          (data) => ({ type: 'log', gen: l, data }),
          (err) => ({ type: 'log', gen: l, error: err.message })
        ),
      this._refreshReview()
    )
  }

  _refreshReview() {
    const g = ++this.gen.review
    return () =>
      this.client.read('review').then(
        (data) => ({ type: 'review', gen: g, data }),
        (err) => ({ type: 'review', gen: g, error: err.message })
      )
  }

  _refreshSnap() {
    const s = ++this.gen.snap
    return () =>
      this.client.read('snapshot').then(
        (data) => ({ type: 'snap', gen: s, data }),
        (err) => ({ type: 'snap', gen: s, error: err.message })
      )
  }

  // unref'd, so a pending refresh never keeps hs alive after q
  _idle() {
    const g = ++this.gen.idle
    return () =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ type: 'idle', gen: g }), this.idleMs)
        if (timer.unref) timer.unref()
      })
  }

  // what the focused list's main panel needs loaded
  _loadMain() {
    if (this.panel === 'log') return this._loadShow()
    if (this.panel === 'review') return this._loadDetail()
    return null
  }

  _loadDetail() {
    const e = this.review[this.sel.review]
    if (!e || this.details.has(e.id)) return null
    this.details.set(e.id, null) // loading
    const gen = this.gen.review
    return () =>
      this.client.read('detail', { id: e.id }).then(
        (text) => ({ type: 'detail', gen, id: e.id, text }),
        (err) => ({ type: 'detail', gen, id: e.id, error: err.message })
      )
  }

  _loadShow() {
    const cs = this.log[this.sel.log]
    if (!cs || this.shows.has(cs.seq)) return null
    this.shows.set(cs.seq, null) // loading
    const gen = this.gen.log
    return () =>
      this.client.read('show', { seq: cs.seq }).then(
        (text) => ({ type: 'show', gen, seq: cs.seq, text }),
        (err) => ({ type: 'show', gen, seq: cs.seq, error: err.message })
      )
  }

  // run one hs command as an action: its output streams into a popup; then everything refreshes
  _run(argv, title) {
    if (this.running && this.running.code === null) {
      this.notice = `wait: \`hs ${this.running.argv[0]}\` is still running`
      return null
    }
    this.running = { argv, title, lines: [], code: null }
    this.popup = { kind: 'output' }
    this.mainTop = 0
    const run = this.running
    return () =>
      this.client
        .run(argv, (line) => {
          if (this.send) this.send({ type: 'line', run, line })
        })
        .then(({ code, lines }) => ({ type: 'ran', run, code, lines }))
  }

  // --- update ---------------------------------------------------------------------------

  update(msg) {
    switch (msg.type) {
      case 'resize':
        this.width = msg.width
        this.height = msg.height
        for (const panel of LISTS) this._follow(panel)
        return [this, null]
      case 'snap':
        if (msg.gen !== this.gen.snap) return [this, null]
        if (msg.error) this.snapError = msg.error
        else {
          this.snap = msg.data
          this.snapError = null
        }
        this._clamp('files')
        return [this, null]
      case 'log':
        if (msg.gen !== this.gen.log) return [this, null]
        if (msg.error) this.logError = msg.error
        else {
          this.log = msg.data
          this.logError = null
          this.shows.clear()
        }
        this._clamp('log')
        return [this, this.panel === 'log' ? this._loadShow() : null]
      case 'show':
        if (msg.gen !== this.gen.log) return [this, null]
        this.shows.set(msg.seq, msg.error ? { error: msg.error } : msg.text)
        return [this, null]
      case 'review':
        if (msg.gen !== this.gen.review) return [this, null]
        if (msg.error) this.reviewError = msg.error
        else {
          this.review = msg.data
          this.reviewError = null
          this.details.clear()
        }
        this._clamp('review')
        return [this, this.panel === 'review' ? this._loadDetail() : null]
      case 'detail':
        if (msg.gen !== this.gen.review) return [this, null]
        this.details.set(msg.id, msg.error ? { error: msg.error } : msg.text)
        return [this, null]
      case 'line':
        if (msg.run === this.running) msg.run.lines.push(msg.line)
        return [this, null]
      case 'ran':
        msg.run.code = msg.code
        // lines streamed already when send is wired; otherwise (tests) take them all now
        if (!msg.run.lines.length) msg.run.lines.push(...msg.lines)
        return [this, this._refresh()]
      case 'idle':
        if (msg.gen !== this.gen.idle) return [this, null]
        if (this.running && this.running.code === null) return [this, this._idle()]
        return [this, batch(this._refreshSnap(), this._refreshReview(), this._idle())]
      case 'edited':
        return [this, this._refreshSnap()]
      case 'key':
        this.notice = null
        if (this.popup) return this._popupKey(msg)
        return this._key(msg)
    }
    return [this, null]
  }

  _popupKey(msg) {
    const p = this.popup
    if (key.matches(msg, 'ctrl+c')) return [this, quit]
    if (p.kind === 'land' || p.kind === 'ask' || p.kind === 'verdict') {
      if (key.matches(msg, ...ESC)) {
        this.popup = null
        return [this, null]
      }
      if (key.matches(msg, 'enter')) return [this, this._submit(p)]
      // the ask's second field: who to ask
      if (p.kind === 'ask' && key.matches(msg, 'tab', 'shift+tab')) {
        p.field = p.field === 0 ? 1 : 0
        p.inputs = p.inputs.map((f, i) => (i === p.field ? f.focus() : f.blur()))
        return [this, null]
      }
      const at = p.kind === 'ask' ? p.field : 0
      const [input, cmd] = p.inputs[at].update(msg)
      p.inputs[at] = input
      return [this, cmd]
    }
    if (p.kind === 'confirm') {
      if (key.matches(msg, 'y', 'enter')) return [this, this._run(p.argv, p.title)]
      if (key.matches(msg, 'n', ...ESC, 'q')) this.popup = null
      return [this, null]
    }
    if (p.kind === 'output') {
      const done = this.running && this.running.code !== null
      if (key.matches(msg, 'j', 'down')) this._scrollMain(1)
      else if (key.matches(msg, 'k', 'up')) this._scrollMain(-1)
      else if (done && key.matches(msg, ...ESC, 'enter', 'q', 'space')) {
        this.popup = null
        this.mainTop = 0
      }
      return [this, null]
    }
    // help
    if (key.matches(msg, ...ESC, 'q', '?', 'enter')) this.popup = null
    return [this, null]
  }

  // enter in a form: run its command, or say what's missing
  _submit(p) {
    const message = p.inputs[0].value.trim()
    if (p.kind === 'land') {
      if (!message) {
        this.notice = 'a land needs a message (teammates read it)'
        return null
      }
      return this._run(['land', '-m', message], 'land')
    }
    if (p.kind === 'ask') {
      if (!message) {
        this.notice = 'an ask needs a message: what and why, for reviewers'
        return null
      }
      const who = p.inputs[1].value.trim()
      return this._run(['review', 'ask', '-m', message, ...(who ? ['-r', who] : [])], 'ask')
    }
    const v = p.verdict
    if (v.needsMessage && !message) {
      this.notice = `${v.title} needs a message`
      return null
    }
    const argv = ['review', v.verb, p.target, ...(message ? ['-m', message] : [])]
    return this._run(argv, v.title)
  }

  _key(msg) {
    if (key.matches(msg, 'q', 'ctrl+c')) return [this, quit]
    if (key.matches(msg, '?')) {
      this.popup = { kind: 'help' }
      return [this, null]
    }
    if (key.matches(msg, 'r', 'R')) {
      this.notice = 'refreshing'
      return [this, this._refresh()]
    }
    if (key.matches(msg, 'c', 'P')) {
      if (this.snap && !this.snap.files.length) {
        this.notice = 'nothing to land'
        return [this, null]
      }
      this.popup = {
        kind: 'land',
        inputs: [textinput.create({ prompt: '> ', placeholder: 'what this changes' }).focus()]
      }
      return [this, null]
    }
    if (key.matches(msg, 'A')) {
      if (this.snap && !this.snap.files.length) {
        this.notice = 'nothing to ask for review of'
        return [this, null]
      }
      this.popup = {
        kind: 'ask',
        field: 0,
        inputs: [
          textinput.create({ prompt: '> ', placeholder: 'what and why, for reviewers' }).focus(),
          textinput.create({ prompt: '> ', placeholder: 'owners and /.hsreview by default' })
        ]
      }
      return [this, null]
    }
    if (key.matches(msg, 'p')) return [this, this._run(['sync'], 'sync')]
    if (key.matches(msg, 'J', 'ctrl+d')) return this._scrolled(this._page())
    if (key.matches(msg, 'K', 'ctrl+u')) return this._scrolled(-this._page())

    if (this.panel === 'main') {
      if (key.matches(msg, ...ESC, 'h', 'left')) this.panel = this.back
      else if (key.matches(msg, 'j', 'down')) this._scrollMain(1)
      else if (key.matches(msg, 'k', 'up')) this._scrollMain(-1)
      return [this, null]
    }

    const at = PANELS.indexOf(this.panel)
    const n = PANELS.length
    if (key.matches(msg, '1', '2', '3', '4')) return this._focus(PANELS[Number(msg.name) - 1])
    if (key.matches(msg, 'tab', 'l', 'right')) return this._focus(PANELS[(at + 1) % n])
    if (key.matches(msg, 'shift+tab', 'h', 'left')) return this._focus(PANELS[(at + n - 1) % n])
    if (key.matches(msg, 'enter')) {
      this.back = this.panel
      this.panel = 'main'
      return [this, null]
    }
    if (key.matches(msg, 'j', 'down')) return this._move(1)
    if (key.matches(msg, 'k', 'up')) return this._move(-1)

    const file = this.panel === 'files' && this.snap ? this.snap.files[this.sel.files] : null
    if (key.matches(msg, 'd') && file) {
      const gone = file.status === 'added'
      this.popup = {
        kind: 'confirm',
        title: 'discard',
        argv: ['restore', file.path],
        text: gone
          ? `Delete ${file.path}? It is new, so restoring removes it.`
          : `Discard your changes to ${file.path}? It goes back to main at your last sync.`
      }
      return [this, null]
    }
    if (key.matches(msg, 'e') && file && this.edit && file.status !== 'deleted') {
      return [this, this.edit(this.snap.root + file.path)]
    }

    const entry = this.panel === 'review' ? this.review[this.sel.review] : null
    if (entry && key.matches(msg, 'a', 'x', 'm')) {
      const v = VERDICTS[msg.name]
      if (entry.mine && v.verb !== 'comment') {
        this.notice = `${entry.id} is your own ask: teammates review it`
        return [this, null]
      }
      this.popup = {
        kind: 'verdict',
        verdict: v,
        target: entry.id,
        inputs: [textinput.create({ prompt: '> ' }).focus()]
      }
      return [this, null]
    }
    return [this, null]
  }

  _focus(panel) {
    this.panel = panel
    this.mainTop = 0
    return [this, this._loadMain()]
  }

  _move(d) {
    if (this.panel === 'status') return [this, null]
    const n = this._count(this.panel)
    if (!n) return [this, null]
    this.sel[this.panel] = Math.max(0, Math.min(n - 1, this.sel[this.panel] + d))
    this._follow(this.panel)
    this.mainTop = 0
    return [this, this._loadMain()]
  }

  _scrolled(d) {
    this._scrollMain(d)
    return [this, null]
  }

  _scrollMain(d) {
    const max = Math.max(0, this._mainLines().length - (this._bodyHeight() - 2))
    this.mainTop = Math.max(0, Math.min(max, this.mainTop + d))
  }

  _page() {
    return Math.max(1, Math.floor((this._bodyHeight() - 2) / 2))
  }

  _count(panel) {
    if (panel === 'files') return this.snap ? this.snap.files.length : 0
    if (panel === 'log') return this.log.length
    if (panel === 'review') return this.review.length
    return 0
  }

  _clamp(panel) {
    const n = this._count(panel)
    this.sel[panel] = Math.max(0, Math.min(n - 1, this.sel[panel]))
    this._follow(panel)
  }

  // scroll a list so its selection stays in view
  _follow(panel) {
    const L = this._layout()
    const inner = L[panel + 'H'] - 2
    const sel = this.sel[panel]
    let top = Math.min(this.top[panel], Math.max(0, this._count(panel) - inner))
    if (sel < top) top = sel
    if (sel >= top + inner) top = sel - inner + 1
    this.top[panel] = Math.max(0, top)
  }

  // --- view -----------------------------------------------------------------------------

  _bodyHeight() {
    return Math.max(6, this.height - 1)
  }

  _layout() {
    const H = this._bodyHeight()
    const leftW = Math.max(24, Math.min(60, Math.floor(this.width * 0.36)))
    const rightW = Math.max(20, this.width - leftW)
    const header = this._statusLines()
    const statusH = Math.max(3, Math.min(8, header.length + 2))
    const rest = H - statusH
    const reviewH = Math.max(3, Math.min(this.review.length + 2, Math.floor(rest * 0.3)))
    const filesH = Math.max(3, Math.floor((rest - reviewH) / 2))
    const logH = Math.max(3, rest - reviewH - filesH)
    return { H, leftW, rightW, statusH, filesH, logH, reviewH }
  }

  _statusLines() {
    if (this.snapError) return [paint('red', 'cannot read the worktree: ' + this.snapError)]
    if (!this.snap) return [faint('loading…')]
    return this.snap.header.map((l) => (l.startsWith('!!') ? paint('red', l) : l))
  }

  _fileLines() {
    if (!this.snap) return [faint(this.snapError ? '' : 'loading…')]
    if (!this.snap.files.length) return [faint('clean: nothing to land')]
    return this.snap.files.map((f) => {
      const status = paint(FILE_COLORS[f.status] || 'white', f.status.padEnd(9))
      return `${status} ${f.path}`
    })
  }

  _logLines() {
    if (this.logError) return [paint('red', this.logError)]
    if (!this.log.length) return [faint('nothing landed yet')]
    return this.log.map((cs) => {
      const state = cs.state ? paint(STATE_COLORS[cs.state] || 'white', cs.state) : '-'
      const message = (cs.message || '').split('\n')[0]
      return `${paint('yellow', '#' + cs.seq)} ${paint('cyan', cs.who)} ${state} ${message}`
    })
  }

  _reviewLines() {
    if (this.reviewError) return [paint('red', this.reviewError)]
    if (!this.review.length) return [faint('nothing waiting on you')]
    return this.review.map((e) => {
      const id = paint(KIND_COLORS[e.kind] || 'white', e.kind === 'change' ? '#' + e.id : e.id)
      const by = e.mine ? paint('green', 'yours') : paint('cyan', e.by)
      return `${id} ${by} ${e.title}`
    })
  }

  // the main panel's title and lines (before scrolling)
  _main() {
    const p = this.popup
    if (p && p.kind === 'help') return { title: 'Keys', lines: HELP }
    if (p && p.kind === 'output') {
      const r = this.running
      const state =
        r.code === null
          ? 'running…'
          : r.code === 0
            ? paint('green', 'done')
            : paint('red', `exit ${r.code}`)
      const lines = r.lines.map((l) => (/^(hs: |!!)/.test(l) ? paint('red', l) : l))
      if (r.code !== null) lines.push('', faint('esc: close'))
      return { title: `hs ${r.argv[0]}: ${state}`, lines }
    }
    if (p && p.kind === 'confirm') {
      return { title: p.title, lines: [p.text, '', bold('y') + ' yes   ' + bold('n') + ' no'] }
    }
    if (p && p.kind === 'land') {
      return {
        title: 'land',
        lines: [
          'Message for this land (teammates read it):',
          '',
          p.inputs[0].view(),
          '',
          faint('enter: land   esc: cancel')
        ]
      }
    }
    if (p && p.kind === 'ask') {
      return {
        title: 'ask for review',
        lines: [
          'Publish your changes for review instead of landing them.',
          '',
          (p.field === 0 ? bold('Message') : 'Message') + ' (what and why, for reviewers):',
          p.inputs[0].view(),
          '',
          (p.field === 1 ? bold('Reviewers') : 'Reviewers') +
            ' (comma-separated handles, optional):',
          p.inputs[1].view(),
          '',
          faint('tab: next field   enter: ask   esc: cancel'),
          faint('once approved, land it with c')
        ]
      }
    }
    if (p && p.kind === 'verdict') {
      const v = p.verdict
      return {
        title: `${v.title} ${p.target}`,
        lines: [
          v.prompt,
          '',
          p.inputs[0].view(),
          '',
          faint(`enter: ${v.title}   esc: cancel`),
          faint('start with path:line to point at a spot')
        ]
      }
    }

    const panel = this.panel === 'main' ? this.back : this.panel
    if (panel === 'status') return { title: 'Status', lines: this._statusLines() }
    if (panel === 'review') {
      const e = this.review[this.sel.review]
      if (!e) return { title: 'Review', lines: [faint('nothing waiting on you')] }
      const title = `${e.kind === 'change' ? '#' + e.id : e.id}: ${e.state}`
      const shown = this.details.get(e.id)
      if (!shown) return { title, lines: [faint('loading…')] }
      if (shown.error) return { title, lines: [paint('red', shown.error)] }
      return { title, lines: colorDiff(shown) }
    }
    if (panel === 'log') {
      const cs = this.log[this.sel.log]
      if (!cs) return { title: 'Changeset', lines: [] }
      const shown = this.shows.get(cs.seq)
      if (!shown) return { title: `#${cs.seq}`, lines: [faint('loading…')] }
      if (shown.error) return { title: `#${cs.seq}`, lines: [paint('red', shown.error)] }
      return { title: `#${cs.seq}`, lines: colorDiff(shown) }
    }
    const f = this.snap && this.snap.files[this.sel.files]
    if (!f) return { title: 'Diff', lines: [] }
    if (f.diff) return { title: f.path, lines: colorDiff(f.diff) }
    return { title: f.path, lines: [faint(f.note || f.status)] }
  }

  _mainLines() {
    return this._main().lines
  }

  _footer() {
    if (this.notice) return paint('yellow', this.notice)
    if (this.running && this.running.code === null) {
      const last = this.running.lines[this.running.lines.length - 1] || ''
      return paint('yellow', `hs ${this.running.argv[0]}… `) + faint(last)
    }
    const hints =
      this.panel === 'files'
        ? 'c land · A ask · p sync · d discard · e edit · enter scroll · ? keys · q quit'
        : this.panel === 'review'
          ? 'a approve · x request changes · m comment · enter scroll · r refresh · ? keys · q quit'
          : 'c land · A ask · p sync · 1-4 panels · enter scroll · r refresh · ? keys · q quit'
    return faint(hints)
  }

  view() {
    const L = this._layout()
    const list = (panel, h) => {
      const lines =
        panel === 'files'
          ? this._fileLines()
          : panel === 'log'
            ? this._logLines()
            : this._reviewLines()
      const inner = h - 2
      const sel = this.sel[panel]
      const focused = this.panel === panel || (this.panel === 'main' && this.back === panel)
      return lines
        .slice(this.top[panel], this.top[panel] + inner)
        .map((l, i) => (focused && i + this.top[panel] === sel && this._count(panel) ? mark(l) : l))
    }

    const left = style.joinVertical(
      style.position.left,
      box(TITLES.status, this._statusLines(), L.leftW, L.statusH, this.panel === 'status'),
      box(TITLES.files, list('files', L.filesH), L.leftW, L.filesH, this._on('files')),
      box(TITLES.log, list('log', L.logH), L.leftW, L.logH, this._on('log')),
      box(TITLES.review, list('review', L.reviewH), L.leftW, L.reviewH, this._on('review'))
    )
    const main = this._main()
    const lines = main.lines.slice(this.mainTop, this.mainTop + L.H - 2)
    const right = box(main.title, lines, L.rightW, L.H, this.panel === 'main' || !!this.popup)
    return style.joinHorizontal(style.position.top, left, right) + '\n' + this._footer()
  }

  _on(panel) {
    return this.panel === panel
  }
}

function mark(line) {
  return style().reverse().render(style.stripAnsi(line))
}

function colorDiff(text) {
  return String(text)
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => {
      if (l.startsWith('+++') || l.startsWith('---')) return bold(l)
      if (l.startsWith('+')) return paint('green', l)
      if (l.startsWith('-')) return paint('red', l)
      if (l.startsWith('@@')) return paint('cyan', l)
      return l
    })
}

// a rounded box with its title in the top border, exactly w × h cells
function box(title, lines, w, h, focused) {
  const color = focused ? 'green' : 'gray'
  const inner = Math.max(1, w - 2)
  const label = style.truncate(' ' + style.stripAnsi(title) + ' ', Math.max(0, inner - 1))
  const top = '╭─' + label + '─'.repeat(Math.max(0, inner - 1 - style.width(label))) + '╮'
  const out = [focused ? style().foreground(color).bold().render(top) : paint(color, top)]
  for (let i = 0; i < h - 2; i++) {
    const l = lines[i] || ''
    const cut = style.width(l) > inner ? style.truncate(l, inner) : l
    out.push(
      paint(color, '│') +
        cut +
        ' '.repeat(Math.max(0, inner - style.width(cut))) +
        paint(color, '│')
    )
  }
  out.push(paint(color, '╰' + '─'.repeat(inner) + '╯'))
  return out.join('\n')
}

module.exports = App
