// Proteus run panel (#311): an optional pane and status line entry showing the run and what waits on the human.
// Display only: no approve, accept, merge or post control, no hook on tool calls, checks, permissions, config or
// settings, no file writes and no network. Its one process is `node <hooks>/proteus-status.js --json`, found the way
// harnesses.md resolves <hooks>; any failure is a state the pane draws, never a throw. Text from the tracker is
// untrusted: drawn as plain capped text, and never put into the explain prompt, which is fixed words and a number.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Panel, Waiting } from '../types'

const PANE = 'proteus-panel'
const COMMAND = 'proteus-panel'
const EVERY_MS = 120000
const RUN_MS = 60000
const TITLE_MAX = 120
const NAME_MAX = 60
const ITEMS_MAX = 50

// change the tag when Panel's fields change: it declines what an earlier version stored
const panel = atom({ plugin: 'proteus-panel', key: 'panel' } as const, { state: 'checking' } as Panel, { shape: 'panel-1' })
const isBusy = atom({ plugin: 'proteus-panel', key: 'isBusy' } as const, false)

// untrusted text as one plain line: control and direction characters out, capped by code point
export const clean = (s: unknown, max: number): string => {
  const one = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(one)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : one
}
const isNumber = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0
const items = (list: unknown): Item[] =>
  (Array.isArray(list) ? list : []).filter(i => i && isNumber(i.number)).slice(0, ITEMS_MAX).map(i => ({ number: i.number, title: clean(i.title, TITLE_MAX) }))
const count = (n: unknown) => (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0)

const left = (ms: unknown): string => {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'not known yet'
  if (ms === 0) return 'this stage’s tasks are done'
  const m = Math.max(1, Math.round(ms / 60000))
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60)
  return `about ${d ? `${d} d ${h} h` : h ? `${h} h ${m % 60} min` : `${m} min`}`
}

// the status script's JSON as the panel's own shape; anything else is a failed check
export const toPanel = (stdout: string): Panel => {
  let j: any
  try { j = JSON.parse(stdout) } catch { return { state: 'failed' } }
  if (!j || typeof j !== 'object') return { state: 'failed' }
  if (j.state === 'no-run') return { state: 'no-run' }
  if (j.state === 'unreachable') return { state: 'unreachable', run: clean(j.run, NAME_MAX) }
  if (j.state !== 'ok') return { state: 'failed' }
  const ms = j.milestone && typeof j.milestone === 'object' ? j.milestone : null
  const w = j.waiting && typeof j.waiting === 'object' ? j.waiting : {}
  const waiting: Waiting[] = [
    ...items(w.questions).map(i => ({ ...i, kind: 'question' as const })),
    ...items(w.reviews).map(i => ({ ...i, kind: 'review' as const })),
  ]
  return {
    state: 'ok',
    run: clean(j.run, NAME_MAX),
    stage: ms ? { title: clean(ms.title, NAME_MAX), done: count(ms.closed), total: count(ms.total) } : null,
    changes: { open: count(j.prs?.open), reviewed: count(j.prs?.verdict), items: items(j.prs?.items) },
    left: j.eta && typeof j.eta === 'object' && j.eta.medianMs ? left(j.eta.ms) : 'not known yet',
    waiting,
  }
}

// the status line entry: the run and how many items wait on the human; nothing where Proteus has no run here
export const statusLine = (p: Panel): string | undefined => {
  if (p.state === 'ok') return `Proteus ${p.run}: ${p.waiting.length ? `${p.waiting.length} waiting on you` : 'nothing waiting on you'}`
  if (p.state === 'unreachable') return `Proteus ${p.run}: tracker not reachable`
  if (p.state === 'failed') return 'Proteus: status check failed'
  return undefined
}

// fixed words and the item's number only: a title is never part of the prompt
export const explainPrompt = (kind: Waiting['kind'], n: number): string =>
  `Explain the ${kind === 'question' ? 'question' : 'stage review'} waiting on me, number ${n}, in plain words at my level: what it asks of me, the choices and what each would mean. Do not answer it for me.`

const KIND = { question: 'Question', review: 'Stage review' } as const
const HOW = 'Answer it in the review session (/proteus-review).'

const isAbs = (p: string) => /^([A-Za-z]:)?[\\/]/.test(p)
const join = (a: string, b: string) => `${a.replace(/[\\/]+$/, '')}/${b}`
const at = (base: string, p: string) => (isAbs(p) ? p : join(base, p))
const text = ($: EngineInterface, p: string) => $.fs.read(p).then(t => String(t), () => '')
const isFile = ($: EngineInterface, p: string) => $.fs.stat(p).then(s => s.kind === 'file', () => false)

// the checkout's top (the dir holding .git) and git's common dir, read from files: no process but the status script
async function gitDirs($: EngineInterface, start: string): Promise<{ top: string; common: string } | null> {
  let d = start.replace(/[\\/]+$/, '')
  for (let i = 0; i < 64 && d; i++) {
    const dot = join(d, '.git')
    const st = await $.fs.stat(dot).catch(() => null)
    if (st?.kind === 'dir') return { top: d, common: dot }
    if (st?.kind === 'file') {
      const m = /^gitdir:\s*(.+)$/m.exec(await text($, dot))
      if (!m?.[1]) return null
      const gitDir = at(d, m[1].trim())
      const up = (await text($, join(gitDir, 'commondir'))).trim()
      return { top: d, common: up ? at(gitDir, up) : gitDir }
    }
    const parent = d.replace(/[\\/][^\\/]*$/, '')
    if (parent === d) break
    d = parent
  }
  return null
}

// <hooks> as harnesses.md resolves it: the autostart's hooks-root record, the plugin install, then .claude/hooks
export async function findScript($: EngineInterface, root: string): Promise<string | null> {
  const dirs = await gitDirs($, root)
  const top = dirs?.top ?? root
  const tries: string[] = []
  const rec = dirs ? (await text($, join(dirs.common, 'proteus-lead/hooks-root'))).trim() : ''
  if (rec && isAbs(rec)) tries.push(join(rec, 'proteus-status.js'))
  const cfg = (await $.env.get('CLAUDE_CONFIG_DIR')) || join((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '', '.claude')
  let installs: any[] = []
  try { installs = JSON.parse(await text($, join(cfg, 'plugins/installed_plugins.json'))).plugins['proteus@proteus'] } catch {}
  if (Array.isArray(installs)) {
    const ok = installs.filter(e => e && typeof e.installPath === 'string' && isAbs(e.installPath))
    const pick = ok.find(e => e.projectPath === top) ?? ok.find(e => e.scope === 'user') ?? ok[0]
    if (pick) tries.push(join(pick.installPath, 'templates/hooks/proteus-status.js'))
  }
  tries.push(join(top, '.claude/hooks/proteus-status.js'))
  for (const t of tries) if (await isFile($, t)) return t
  return null
}

// one check in flight at a time; a second ask while it runs shares it. Module variables: a reload starts them over
let inFlight: Promise<void> | null = null
let tick: { cancel: () => void } | null = null

async function check($: EngineInterface): Promise<void> {
  await update($, isBusy, () => true)
  let next: Panel = { state: 'failed' }
  try {
    const root = await $.session.root()
    const script = await findScript($, root)
    if (!script) next = { state: 'not-found' }
    else {
      const ran = await $.process.run(['node', script, '--json'], { cwd: root, timeoutMs: RUN_MS })
      next = ran.exitCode === 0 ? toPanel(ran.stdout) : { state: 'failed' }
    }
  } catch {}
  await update($, panel, () => next)
  $.ui.status(statusLine(next))
  await update($, isBusy, () => false)
}

export function refresh($: EngineInterface): Promise<void> {
  if (!inFlight) inFlight = check($).catch(() => {}).finally(() => { inFlight = null })
  return inFlight
}

function startTick($: EngineInterface): void {
  if (!tick) tick = $.clock.every(EVERY_MS, () => void refresh($))
}

function stopTick(): void {
  tick?.cancel()
  tick = null
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show the Proteus run and what waits on you in a pane' })
    // a reload while the pane stayed up keeps its refresh
    if ((await $.ui.panes()).some(p => p.id === PANE)) startTick($)
    void refresh($)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    await $.ui.open({ id: PANE, title: 'Proteus run' })
    startTick($)
    void refresh($)
    return { text: 'Proteus run panel opened.' }
  }).catch(() => ({ text: 'The Proteus run panel could not open.' }))

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) void refresh($)
    return next(e)
  })

  on('ui.close', ($, e, next) => {
    if (e.id === PANE) stopTick()
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const p = await read($, panel)
    const busy = await read($, isBusy)
    const card = (w: Waiting) => (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{KIND[w.kind]} (number {w.number})</Text>
        <Text>{w.title}</Text>
        <Text dimColor>{HOW}</Text>
        <Button key={`explain-${w.number}`} label="Explain" onPress={() => void $.prompt.submit({ text: explainPrompt(w.kind, w.number) })} />
      </Box>
    )
    const body =
      p.state === 'checking' ? <Text dimColor>Checking the run…</Text>
      : p.state === 'no-run' ? <Text>No run is open in this project.</Text>
      : p.state === 'not-found' ? <Text>Proteus’s status script was not found for this project.</Text>
      : p.state === 'failed' ? <Text>The status check failed. Try again with Refresh.</Text>
      : p.state === 'unreachable' ? (
        <Box flexDirection="column">
          <Text bold>Run {p.run}</Text>
          <Text>The project’s tracker could not be reached. The panel tries again on its own.</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text bold>Run {p.run}</Text>
          <Text>{p.stage ? `Stage ${p.stage.title}: ${p.stage.done} of ${p.stage.total} tasks done` : 'No stage planned yet'}</Text>
          <Text>Time left in this stage: {p.left}</Text>
          <Text>Changes being checked: {p.changes.open} ({p.changes.reviewed} with a reviewer’s decision)</Text>
          {p.changes.items.map(c => <Text dimColor>  {c.number}: {c.title}</Text>)}
          <Text bold>{p.waiting.length ? `Waiting on you: ${p.waiting.length}` : 'Nothing is waiting on you.'}</Text>
          {p.waiting.map(card)}
        </Box>
      )
    return (
      <Box flexDirection="column">
        {body}
        <Box marginTop={1}>
          <Button key="refresh" label={busy ? 'Refreshing…' : 'Refresh'} onPress={() => void refresh($)} />
        </Box>
      </Box>
    )
  })
}
