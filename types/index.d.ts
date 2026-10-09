// Styx's state contract: what survives a hot reload of its hooks module.

// An effort level as the Agent tool and turn.step name them.
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

// A git worktree styx made for an isolated subagent: where it is, its branch, the commit it started from,
// and the repository root it belongs to.
export type Worktree = { path: string; branch: string; base: string; root: string }

// The worktree the engine made for an isolated plain Agent call whose subagent styx routes: only where it is,
// because the engine removes it, not styx.
export type EngineWorktree = { path: string; engine: true }

// A subagent the styx agent tool started, or a plain Agent call made under a routed parent: its styx target
// (the alias or `provider/model` the call named, the parent's alias for an Agent call, or null for a native
// model), the model name the call gave, its agent type, the task prompt it was started with (remote targets),
// the call's effort, and its worktree when isolated. `wasIsolated` stands in for a worktree dropped from the
// route when the subagent finished (removed, or the engine's to remove): the subagent worked in a worktree.
// `refused` is the line a subagent hands back as its report instead of running, when styx started it for a
// styx model it could not then run it on. `parent` is the routed subagent whose Agent call (or styx agent call)
// started it, absent for a child of main: its tools never exceed that subagent's. `forkOf` is a fork's: the id of
// the Agent call that started it, which marks where its parent's history ends and its own begins.
export type Route = { target: string | null; label: string; type?: string; prompt?: string; effort?: Effort; worktree?: Worktree | EngineWorktree; wasIsolated?: true; refused?: string; parent?: string; forkOf?: string }

// The main conversation's route for one turn, fixed at its first step: null is native.
export type MainPin = { turnId: string; target: string | null }

declare module 'claude-code' {
  interface PluginState {
    styx: {
      // The main conversation's selected styx target (an alias or `provider/model`), or null for native.
      main: string | null
      mainPin: MainPin | null
      // One member per subagent the styx agent tool started, keyed by its agentId.
      routed: StateFamily<Route>
      // One member per routed conversation (main as `main`, a subagent by its agentId): the Agent calls styx
      // made from the styx agent calls of its steps, as tool_use id → the model the call named.
      translated: StateFamily<Record<string, string>>
    }
  }
}
