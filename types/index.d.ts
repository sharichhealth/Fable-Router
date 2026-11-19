export type RouterTick = number

declare module 'claude-code' {
  interface PluginState {
    'fable-router': { tick: RouterTick }
  }
}
