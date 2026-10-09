// Stand-ins for the engine beneath styx, shared by the hook-level tests: a filesystem holding the config
// and any further files, the store, settings, the session, a fixed clock, the native turn.step and /model,
// git, trash, uname and the bun lookup via process.run (any of them answered by `run` instead), and styxd:
// its process (it answers ready and stays up until `kill`) and curl over its socket, whose calls run
// styxd's own step and status logic in-process. That logic runs the key helper (`run` and `keyFails`
// answer it) and sends its provider requests to `upstream`, which records them. Every call is recorded.
import type { AgentSpawnInput, On, PromptComposeInput, SessionUsage, ToolInfo, ToolSpec, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { MainPin, Route } from '../types'
import { fakeDaemon } from './daemon-fake'
import type { Request, Upstream } from './daemon-fake'
import { dirEntries } from './dirs'
import { SSE } from './fixtures/data.gen'
import { HANDBACK_REMINDER } from './fixtures/handback'

export { HANDBACK_REMINDER }
export const HOME = '/home/u'
export const CWD = '/w'
export const TRASH = '/opt/bin/trash'
export const BUN = '/opt/bin/bun'
export const ORIGIN = 'https://styx.invalid'
// What $.clock.now() answers: noon, local time, on 2026-10-07.
export const NOW = new Date(2026, 9, 7, 12).getTime()
// The acme provider's credential helper, and the key it prints.
export const HELPER = ['/usr/bin/security', 'find-generic-password', '-s', 'styx', '-a', 'acme', '-w']
export const KEY = 'sk-styx-test-0123456789abcdef'
export const TRUSTED = { [`trust:openai|${ORIGIN}|cmd:${JSON.stringify(HELPER)}`]: true }
const GPT = {
  contextWindow: 1_050_000,
  maxInputTokens: 922_000,
  maxOutputTokens: 128_000,
  maxTokensParam: 'max_completion_tokens',
  effort: { low: { reasoning_effort: 'low' }, medium: { reasoning_effort: 'medium' }, high: { reasoning_effort: 'high' } },
}
export const CONFIG_OBJECT = {
  providers: {
    acme: {
      kind: 'openai',
      baseUrl: `${ORIGIN}/v1`,
      auth: { command: HELPER },
      models: { 'model-a': GPT, 'model-b': GPT, small: { contextWindow: 128_000, maxOutputTokens: 8000, maxTokensParam: 'max_tokens' } },
    },
  },
  aliases: {
    fast: { target: 'acme/model-a', note: 'cheap, fast explorer for read-only sweeps' },
    strong: { target: 'acme/model-b', note: 'strong generalist' },
  },
}
export const CONFIG = JSON.stringify(CONFIG_OBJECT)

// A plain-http provider (allowHttp) behind a dotted alias; its model takes `max_tokens` and effort levels up to medium.
export const LOCAL_ORIGIN = 'http://styx.invalid:8080'
export const LOCAL_HELPER = ['/usr/bin/security', 'find-generic-password', '-s', 'styx', '-a', 'local', '-w']
export const LOCAL_CONFIG = JSON.stringify({
  providers: {
    local: {
      kind: 'openai',
      baseUrl: `${LOCAL_ORIGIN}/v1`,
      allowHttp: true,
      auth: { command: LOCAL_HELPER },
      models: {
        'model-v1': {
          contextWindow: 327_680,
          maxInputTokens: 262_144,
          maxOutputTokens: 65_536,
          maxTokensParam: 'max_tokens',
          effort: { low: { reasoning_effort: 'low' }, medium: { reasoning_effort: 'medium' } },
        },
      },
    },
  },
  aliases: { 'model.v1-mini': { target: 'local/model-v1', note: 'a dotted alias on a plain-http provider' } },
})
export const LOCAL_TRUSTED = { [`trust:openai|${LOCAL_ORIGIN}|cmd:${JSON.stringify(LOCAL_HELPER)}`]: true }

export type Git = { exitCode: number; stdout: string; stderr: string }
// A tool as `tool.register` hands it on, less `isDeferred`: 2.1.292 types the event `Required<ToolSpec>` without it,
// and 2.1.293 as a spec with an optional `isDeferred`, so no `Required<ToolSpec>` takes both.
type Registered = Required<Pick<ToolSpec, 'name' | 'description' | 'inputSchema'>>
export type WorldOptions = {
  config?: string | null | (() => string | null) // null: no config file; a function is read at each load
  store?: Record<string, unknown> | 'fails'
  policy?: Record<string, unknown> | 'fails'
  keyFails?: boolean // every credential helper exits 1
  mainClear?: 'fails' | (() => Promise<void>) // writes that clear the `main` state key are refused, or wait on the function
  picker?: string | (() => string) // what the native bare /model (the picker) answers; a function is called as it runs
  version?: string
  usageTokens?: number
  mcpTools?: { name: string; isLoaded: boolean }[]
  tools?: ToolInfo[] | (() => ToolInfo[])
  messages?: unknown | ((agentId: string | undefined) => unknown)
  compose?: 'throws'
  pinRead?: 'fails'
  answer?: string | null // null: the dialog is dismissed
  cwd?: string
  git?: (args: readonly string[]) => Git | undefined
  // Answers a process.run first: a result (stdout and stderr default to empty), undefined to leave it to the
  // defaults below, or a throw, which rejects the call.
  run?: (argv: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string } | undefined
  trash?: string | null
  upstream?: (req: Request) => Upstream
  bun?: string | null // the bun the lookup finds; null: none
  styxd?: 'silent' | 'exits' // styxd never answers ready, or exits with a failure before it
  socketThrows?: string // curl over styxd's socket fails after streaming what styxd wrote (daemon-fake.ts)
  routes?: Record<string, Route>
  translated?: Record<string, Record<string, string>> // the translated calls kept in state, by `main` or agentId
  pin?: MainPin
  mcpFile?: string
  files?: Record<string, string> // further files, by absolute path (their directories exist and list them)
  env?: Record<string, string> // further environment variables; CLAUDE_CONFIG_DIR moves the config file to <dir>/styx.json
  clock?: 'mocked' // the test answers $.clock itself (mock.clock)
  spawn?: ((e: AgentSpawnInput) => { model: string } | { deny: string } | Promise<{ model: string } | { deny: string }>) | 'unanswered'
}

export function world(on: On, o: WorldOptions = {}) {
  const daemon = fakeDaemon({
    bun: o.bun ?? BUN,
    upstream: r => o.upstream?.(r) ?? { pieces: [SSE['model-a-step2.sse'] as string] },
    helper: argv => (w.runs.push(argv), command(argv)),
    log: text => void w.debug.push(text),
    now: NOW,
    ...(o.styxd === undefined ? {} : { styxd: o.styxd }),
    ...(o.socketThrows === undefined ? {} : { socketThrows: o.socketThrows }),
  })
  const w = {
    debug: [] as string[],
    transcript: [] as string[],
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    registered: [] as Registered[],
    commands: [] as string[],
    asks: [] as string[],
    native: [] as string[],
    nativeSteps: [] as TurnStepInput[],
    composes: [] as PromptComposeInput[],
    runs: [] as string[][], // every command run: by the engine, and the key helper styxd runs
    processes: [] as { argv: readonly string[]; env?: Record<string, string>; input?: string }[], // every spawn
    requests: daemon.requests, // the provider requests styxd sent
    wires: daemon.wires, // what curl carried to styxd
    get daemons() {
      return daemon.daemons // styxd processes started
    },
    get aborted() {
      return daemon.aborted // provider requests cancelled by their client going away
    },
    kill: (how?: 'socket') => daemon.kill(how), // ends the running styxd; `socket` closes its socket alone
    spawns: [] as Record<string, unknown>[],
    invalidated: [] as string[],
    reads: [] as (string | undefined)[],
    fsReads: [] as string[],
    stateSets: [] as { key: string; id?: string; value: unknown }[],
    routeReads: [] as (string | undefined)[], // the agentId of every read of a `routed` state member
  }
  const config = () => (typeof o.config === 'function' ? o.config() : o.config === undefined ? CONFIG : o.config)
  const file = (path: string) => (o.files !== undefined && Object.hasOwn(o.files, path) ? o.files[path] : undefined)
  if (o.store === 'fails') {
    on('store.get', () => ({ deny: 'store unavailable' }))
    on('store.set', () => ({ deny: 'store unavailable' }))
  } else mock.store(on, o.store ?? TRUSTED)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  mock.env(on, { HOME, CLAUDE_CODE_ENTRYPOINT: 'cli', ...o.env })
  const configPath = `${o.env?.['CLAUDE_CONFIG_DIR'] || `${HOME}/.claude`}/styx.json`
  on('fs.exists', ($, e) => ({
    value:
      file(e.path) !== undefined ||
      dirEntries(o.files ?? {}, e.path) !== undefined ||
      (e.path === configPath && config() !== null) ||
      (e.path.endsWith('/hooks/schemas.mcp.gen.json') && o.mcpFile !== undefined),
  }))
  on('fs.list', ($, e) => ({ value: (dirEntries(o.files ?? {}, e.path) ?? []).map(entry => ({ ...entry, size: 0, mtimeMs: 0, isLink: false })) }))
  on('fs.read', ($, e) => (w.fsReads.push(e.path), { value: file(e.path) ?? (e.path.endsWith('/hooks/schemas.mcp.gen.json') ? (o.mcpFile as string) : (config() as string)) }))
  if (o.clock !== 'mocked') {
    on('clock.now', () => ({ value: NOW }))
    // A wait that ends only when its caller gives it up: nothing a test runs waits on real time.
    on('clock.sleep', ($, e, next) => new Promise(resolve => next.signal.addEventListener('abort', () => resolve({ value: undefined }), { once: true })))
  }
  on('settings.read', () => (o.policy === 'fails' ? { deny: 'policy unavailable' } : { value: o.policy ?? {} }))
  on('session.version', () => ({ value: { version: o.version ?? '2.1.292' } }))
  on('session.cwd', () => ({ value: o.cwd ?? CWD }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits: [], context: { tokens: o.usageTokens, window: 200_000, breakdown: { mcpTools: o.mcpTools ?? [] } } } as unknown as SessionUsage,
  }))
  on('session.messages', ($, e) => {
    const agentId = (e as { agentId?: string }).agentId
    w.reads.push(agentId)
    const m = typeof o.messages === 'function' ? (o.messages as (a: string | undefined) => unknown)(agentId) : o.messages
    return { value: (m ?? [{ role: 'user', content: agentId === undefined ? [{ type: 'text', text: 'hi' }] : [{ type: 'text', text: 'hi' }, HANDBACK_REMINDER] }]) as never }
  })
  on('tool.list', () => ({
    value: (typeof o.tools === 'function' ? o.tools() : o.tools) ?? [
      { name: 'Read', description: 'Reads a file', mcp: false },
      { name: 'Agent', description: 'Starts a subagent', mcp: false },
      { name: 'mcp__styx__agent', description: 'advert', mcp: true },
    ],
  }))
  on('tool.register', ($, e) => (w.registered.push(e), { value: { tool: `mcp__styx__${e.name}` } }))
  on('command.register', ($, e) => (w.commands.push(e.name), { value: { command: e.name } }))
  on('ui.log', ($, e) => ((e.to === 'debug' ? w.debug : w.transcript).push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (w.toasts.push(e.text), { value: undefined }))
  on('ui.status', ($, e) => (w.statuses.push(e.text), { value: undefined }))
  on('ui.invalidate', ($, e) => (w.invalidated.push(e.event), { value: undefined }))
  on('state.set', async ($, e, next) => {
    if (e.key === 'main' && e.value === null && o.mainClear === 'fails') return { deny: 'state unavailable' }
    if (e.key === 'main' && e.value === null && typeof o.mainClear === 'function') await o.mainClear()
    w.stateSets.push({ key: e.key, ...(e.id === undefined ? {} : { id: e.id }), value: e.value })
    return next(e)
  })
  on('state.get', ($, e, next) => {
    if (e.key === 'routed') w.routeReads.push(e.id)
    if (e.key === 'routed' && e.id !== undefined && o.routes?.[e.id] !== undefined) return { value: { value: o.routes[e.id], version: 1 } }
    if (e.key === 'translated' && e.id !== undefined && o.translated?.[e.id] !== undefined) return { value: { value: o.translated[e.id], version: 1 } }
    if (e.key === 'mainPin' && o.pinRead === 'fails') return { deny: 'state unavailable' }
    if (e.key === 'mainPin' && o.pin !== undefined) return { value: { value: o.pin, version: 1 } }
    return next(e)
  })
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
    w.asks.push(e.questions.map(q => q.question).join(' | '))
    if (o.answer === null) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: Object.fromEntries(e.questions.map(q => [q.question, o.answer ?? 'Allow'])) } }
  })
  const picker = () => (typeof o.picker === 'function' ? o.picker() : o.picker)
  on('command.run', ($, e) => (w.native.push(`/${e.command} ${e.args}`), { text: e.args === '' && o.picker !== undefined ? picker() : `native /${e.command} ${e.args}` }))
  on('classic.PostModelSwitch', () => ({}))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.compose', ($, e) => {
    w.composes.push(e)
    if (o.compose === 'throws') throw new Error('compose unavailable')
    return { sections: [{ id: 'intro', text: 'SYSTEM PROMPT', scope: 'shared' }] }
  })
  on('turn.step', async function* ($, e) {
    w.nativeSteps.push(e)
    yield { kind: 'text', index: 0, text: 'native' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'native', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  const answer = o.spawn
  if (answer !== 'unanswered') {
    on('agent.spawn', async ($, e) => (w.spawns.push(e as unknown as Record<string, unknown>), (await answer?.(e)) ?? { model: e.model ?? 'inherit' }))
  }
  // A command as the engine or styxd runs it: a result, or a throw for one that cannot start.
  const command = (argv: string[]): { exitCode: number; stdout: string; stderr: string } => {
    const custom = o.run?.(argv)
    if (custom !== undefined) return { stdout: '', stderr: '', ...custom }
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })
    const fail = { exitCode: 1, stdout: '', stderr: '' }
    if (argv[0] === '/bin/sh' && argv[2] === 'command -v trash') return o.trash === null ? fail : ok(`${o.trash ?? TRASH}\n`)
    if (argv[0] === '/bin/sh' && argv[2]?.startsWith('command -v bun')) return o.bun === null ? fail : ok(`${o.bun ?? BUN}\n`)
    if (argv[0] === '/usr/bin/security') return o.keyFails === true ? fail : ok(`${KEY}\n`)
    if (argv[0] === '/usr/bin/uname') return ok('Darwin\n')
    if (argv[0] === 'git') return o.git?.(argv.slice(1)) ?? defaultGit(argv.slice(1))
    return ok()
  }

  on('process.run', ($, e) => {
    const argv = [...e.argv]
    w.runs.push(argv)
    return { value: { ...(daemon.run(argv, e.init?.stdin) ?? command(argv)), isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* ($, e) {
    w.processes.push({ argv: e.argv, ...(e.env === undefined ? {} : { env: e.env }), ...(e.input === undefined ? {} : { input: e.input }) })
    const child = daemon.spawn(e.argv, e.input)
    return { value: child === undefined ? { code: 0, signal: null } : yield* child } as never
  })
  return w
}

// git as a clean repository at CWD whose HEAD is `base0`.
function defaultGit(args: readonly string[]): Git {
  const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })
  if (args.includes('--show-toplevel')) return ok(`${CWD}\n`)
  if (args.includes('--verify')) return ok('base0\n')
  if (args.includes('rev-list')) return ok('0\n')
  return ok()
}

export const start = ($: Engine) => $.session.start({ cwd: CWD, surface: null, isInteractive: true })
export const model = ($: Engine, args: string) => $.command.run({ command: 'model', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
export const styx = ($: Engine, args = '') => $.command.run({ command: 'styx', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

// Reads a turn.step stream to its end: its chunks and the generator's return value.
export async function step($: Engine, e: Partial<TurnStepInput> & Pick<TurnStepInput, 'turnId' | 'index'>) {
  const stream = $.turn.step({ model: 'claude-opus-5-5', messageCount: 1, ...e })
  const chunks: TurnStepChunk[] = []
  for (;;) {
    const next = await stream.next()
    if (next.done) return { chunks, result: next.value as TurnStepResult }
    chunks.push(next.value)
  }
}

export const sse = (...events: unknown[]) => events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
