// The run panel's $.state contract: what the pane and the status line entry draw from.
export type Item = { number: number; title: string }
export type Waiting = Item & { kind: 'question' | 'review' }
export type Panel =
  | { state: 'checking' }
  | { state: 'no-run' }
  | { state: 'not-found' }
  | { state: 'failed' }
  | { state: 'unreachable'; run: string }
  | {
      state: 'ok'
      run: string
      stage: { title: string; done: number; total: number } | null
      changes: { open: number; reviewed: number; items: Item[] }
      left: string
      waiting: Waiting[]
    }

declare module 'claude-code' {
  interface PluginState {
    'proteus-panel': { panel: Shaped<Panel>; isBusy: boolean }
  }
}
