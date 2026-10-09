// All of styx's mutable session memory in one object, and the one reset a config reload performs. Pure:
// register.ts creates one Session per registration and hands it to the modules that read and write it.
import type { Effort, MainPin, Route } from '../types'
import type { JsonSchema } from './config'
import type { Loaded } from './load'
import type { Pool } from './pool'
import type { ApiMessage, StepStats } from './protocol'
import type { createAssembler } from './step'

export type Assembler = ReturnType<typeof createAssembler>
// A remote step in flight, for the turn.step .catch: its target, and the assembler of what it has yielded.
export type StepRecord = { target: string; assembler?: Assembler }
// A conversation's last routed step: where it went, how it went, and where its system prompt came from.
type LastStep = { target: string; stats: StepStats; prompt: string }
// What an Agent call says that its spawn event does not carry: its effort, and whether it asked for a worktree.
// `target` marks a call styx made from a routed model's styx agent call: the styx target the caller chose
// (null: a native model, which the call names itself). `deny` is why styx left a styx agent call as it was, for
// the tool to answer.
export type CallNote = { effort?: Effort; isolated?: boolean; elsewhere?: string; target?: string | null; deny?: string }
// The notes kept for Agent calls whose spawn has not taken them: only the latest 64.
const CALLS_MAX = 64
// A route main has left: its alias (or `provider/model`), the `provider/model` behind it, and how many main turns
// it answered since it was chosen. Native Claude is told of the routes left, once, with the next prompt.
export type Left = { label: string; target: string; turns: number }
// The last tool set a remote request was built with: what it left out, and why.
type ToolReport = { schemaless: string[]; capped: string[]; long: string[]; cap: number }

export function createSession() {
  const s = {
    loaded: { errors: [], missing: true, path: '~/.claude/styx.json' } as Loaded, // until the first load says where it looked
    goodAliases: [] as readonly string[], // the alias names of the last valid config loaded
    mcpSchemas: {} as Readonly<Record<string, JsonSchema>>,
    notes: [] as string[], // what a load found worth saying in /styx
    toolReport: { schemaless: [], capped: [], long: [], cap: 0 } as ToolReport,
    // Files read for agent types this session (agent files, installed_plugins.json), parsed, by path (null: no file).
    agentFiles: new Map<string, unknown>(),
    agentNotes: new Set<string>(), // the agent types (custom, and built-in ones an agent file may define) whose definition lookup is logged, and the notes said once
    approved: new Set<string>(), // the fingerprints the backend has been told are approved
    userAgent: undefined as string | undefined, // the User-Agent of remote requests
    trashPath: undefined as string | undefined,
    platform: undefined as string | null | undefined, // `uname -s`, lowercased; null when it could not be read
    main: undefined as string | null | undefined, // main's target; undefined until read from state after a load
    pin: null as MainPin | null,
    // In memory only: a hot reload of the hooks module loses both (accepted; `/styx reload` keeps them).
    routedTurns: 0, // the main turns pinned to the current route since it was chosen (a turn, not its steps)
    left: [] as Left[], // the routes main left, oldest first, until a native main's prompt carries their note
    routes: new Map<string, Route>(), // agentId → route
    pendingSpawns: new Set<Promise<void>>(),
    // the pending spawns of a styx agent call styx made, or of a fork under a routed parent (`fork`), by their barrier → the target asked for, and the id the engine started once it has
    requested: new Map<Promise<void>, { target: string; id?: string; fork?: boolean }>(),
    calls: new Map<string, CallNote>(), // tool_use_id → an Agent call's note, until its spawn takes it
    // main (as "main") or an agentId → the styx agent calls of its routed steps that styx made Agent calls of: tool_use id → the model named
    translated: new Map<string, Readonly<Record<string, string>>>(),
    steps: new Map<string, StepRecord>(), // `${agentId ?? "main"}:${turnId}:${index}` → remote step
    offered: new Map<string, ReadonlySet<string>>(), // agentId → the tool names its last remote step offered
    pools: new Map<string, Pool>(), // agentId → the tools it may be offered: its type's, within its caller's (pool.ts)
    // agentId or "main" → the last remote prompt_tokens, and the messageCount of the request they counted
    promptTokens: new Map<string, { tokens: number; messageCount: number }>(),
    lastSteps: new Map<string, LastStep>(), // agentId or "main" → its last routed step, least recent first
    blindHandbacks: new Map<string, string>(), // agentId → the turn whose failure was handed back with its transcript unreadable
    // agentId → a fork's inherited history as first rebuilt: its parent's through the cut turn and the turn after it (if read), translated.
    // Memory only: a hooks reload loses it and the next step rebuilds. A reload keeps it, a running fork needs it.
    forkPrefixes: new Map<string, { messages: readonly ApiMessage[]; cut: number }>(),

    // Keeps an Agent call's note until its spawn takes it; the oldest goes when more than 64 are kept.
    note(id: string, note: CallNote) {
      s.calls.set(id, note)
      const [oldest] = s.calls.keys()
      if (s.calls.size > CALLS_MAX && oldest !== undefined) s.calls.delete(oldest)
    },

    // Forgets what a subagent's finished turn leaves: its route, offered tools, tool pool, last step, prompt
    // size, blind handback, translated calls, and any step recorded for it that never ended (an aborted one).
    // Its route and translated calls stay in state, so a later message to it routes again.
    forget(agentId: string) {
      for (const m of [s.routes, s.offered, s.pools, s.lastSteps, s.promptTokens, s.blindHandbacks, s.translated, s.forkPrefixes]) m.delete(agentId)
      for (const key of s.steps.keys()) if (key.startsWith(`${agentId}:`)) s.steps.delete(key)
    },

    // Forgets what the config text decides, ahead of loading it again: the agent files read and the tool pools
    // drawn from them, the approvals told to the backend, the MCP schemas, the load notes and the tool report.
    // `loaded` is replaced by the load itself, so a step racing the reload keeps the config it started with.
    // Routes, pins, steps, offered sets, prompt sizes and last steps are what a running turn still needs, so
    // they stay.
    resetForReload() {
      s.agentFiles.clear()
      s.agentNotes.clear()
      s.pools.clear()
      s.approved.clear()
      s.mcpSchemas = {}
      s.notes = []
      s.toolReport = { schemaless: [], capped: [], long: [], cap: 0 }
    },
  }
  return s
}
export type Session = ReturnType<typeof createSession>
