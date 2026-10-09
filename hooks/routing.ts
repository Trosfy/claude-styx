// Which model answers: main's per-turn pin and /model, each subagent's route, the remote step (the request
// it builds, its guards, its events as chunks, a styx agent call among them made an Agent call), and the
// failures that end a step. Pure over ports.
import type { CommandRunInput, CommandRunResult, ToolInfo, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code'

import type { Effort, MainPin, Route } from '../types'
import { FORK_REPORT, HANDBACK_TOOL, isFork } from './agents'
import { FORK_HISTORY, forkHistory, forkParent } from './fork'
import { advert, agentSchema } from './advert'
import { EFFORTS, inputBudget, isObject } from './config'
import type { Config, Target } from './config'
import { switched } from './leave'
import { explain, isStyxShaped, resolve } from './names'
import { poolOf } from './pool'
import { definitionOf, systemFor, withIdentity } from './prompts'
import type { PromptsPort } from './prompts'
import type { ApiMessage, Backend, RemoteTool, StepRequest } from './protocol'
import { firstLine, redact } from './redact'
import { SCHEMAS } from './schemas.gen'
import type { Assembler, Session, StepRecord } from './session'
import { translatedOf, translateUse, unclaimedFork, unstarted } from './spawn'
import type { AgentTypes } from './spawn'
import { createAssembler } from './step'
import { firstUserText, handbackState, withoutTool, withTask, withTranslated } from './transcript'
import { approve, ensureTrust, isTrusted } from './trust'
import type { TrustPort } from './trust'
import { labelOf, showStatus, shownTarget } from './ui'
import type { StatusPort } from './ui'

export const WRAPPER = 'mcp__styx__agent'
// Half of HookBudget.ms (10_000): both the module-promise await and $.clock.sleep spend the hook's budget.
const SPAWN_WAIT_MS = 5000
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

type Remote = Extract<Target, { kind: 'remote' }>
type StepResult = AsyncGenerator<TurnStepChunk, TurnStepResult>

export type Say = { toast(text: string): void; debug(text: string): void }
// What routing keeps in the engine's state: main's target and its pin for a turn, each subagent's route, and
// the Agent calls styx made of each conversation's styx agent calls (`who`: main, or an agentId).
export type RouteStore = {
  main(): Promise<string | null | undefined>
  setMain(target: string | null): Promise<void>
  pin(): Promise<MainPin | null | undefined>
  setPin(pin: MainPin): Promise<void>
  route(agentId: string): Promise<Route | undefined>
  setRoute(agentId: string, route: Route): Promise<void>
  translated(who: string): Promise<Readonly<Record<string, string>> | undefined>
  setTranslated(who: string, calls: Readonly<Record<string, string>>): Promise<void>
}
// The tools main has, and which of its MCP tools are loaded.
type ToolSource = { list(): Promise<readonly ToolInfo[]>; loadedMcp(): Promise<ReadonlySet<string>> }
// A conversation's transcript in the Messages API's form (main's, or an agent's), or why it cannot be read.
export type Transcripts = { transcript(agentId: string | undefined): Promise<readonly ApiMessage[] | { deny: string }> }
export type Sleeper = { sleep(ms: number, signal: AbortSignal): Promise<void> }
export type StepIo = Say & ToolSource & Transcripts & PromptsPort & Pick<TrustPort, 'trusted'>

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const stepKey = (e: Pick<TurnStepInput, 'agentId' | 'turnId' | 'index'>) => `${e.agentId ?? 'main'}:${e.turnId}:${e.index}`

// The alias names /model keeps from the native command while the config is broken: the last valid
// config's, and the broken file's own.
const knownAliases = (s: Session) => [...s.goodAliases, ...(s.loaded.declared ?? [])]

// --- main and subagent routes ----------------------------------------------------------------------------

// Selects main's target (null: native); when the target changes, forgets main's last remote prompt size and
// notes a route left (leave.ts).
// A selection holds once written. A clear holds in memory first, then in state, then on the status line;
// a rejected write of it is logged, not thrown: main stays native in this session, though a new session
// may read the old target back.
async function setMain(io: Pick<RouteStore, 'setMain'> & Pick<Say, 'debug'> & StatusPort, s: Session, target: string | null) {
  if (s.main === null && target === null) return
  if (target !== s.main) s.promptTokens.delete('main')
  if (target !== null) await io.setMain(target)
  switched(s, target)
  s.main = target
  if (target === null) {
    try {
      await io.setMain(null)
    } catch (err) {
      io.debug(`styx: could not persist clearing main (${String(err)}); main is native in this session`)
    }
  }
  showStatus(io, s)
}

// The main conversation's route for this step: fixed per turn at its first step and persisted, so a later
// selection or a reload never changes a turn already under way.
async function mainRoute(io: Pick<RouteStore, 'main' | 'pin' | 'setPin'>, s: Session, e: TurnStepInput): Promise<string | null> {
  if (s.pin?.turnId === e.turnId) return s.pin.target
  const persisted = await io.pin()
  if (persisted?.turnId === e.turnId) return (s.pin = persisted).target
  if (e.index > 0) return null
  if (s.main === undefined) s.main = (await io.main()) ?? null
  s.pin = { turnId: e.turnId, target: s.main }
  if (s.main !== null) s.routedTurns++
  await io.setPin(s.pin)
  return s.pin.target
}

// A subagent's route: memory, else (while a styx spawn is in flight) a bounded wait, else the persisted one; else, when
// the wait ran out with a spawn asked for on a styx target (or a fork under a routed parent) still starting, a route
// that refuses.
async function subRoute(io: Pick<RouteStore, 'route'> & Sleeper & AgentTypes & Pick<Say, 'debug'>, s: Session, agentId: string, signal: AbortSignal): Promise<Route | undefined> {
  const hit = s.routes.get(agentId)
  if (hit !== undefined) return hit
  let timedOut = false
  if (s.pendingSpawns.size > 0) {
    const ac = new AbortController()
    const outcome = await Promise.race([
      Promise.allSettled([...s.pendingSpawns]).then(() => 'settled'),
      io.sleep(SPAWN_WAIT_MS, AbortSignal.any([ac.signal, signal])).then(
        () => 'timeout',
        () => 'aborted',
      ),
    ])
    ac.abort()
    const after = s.routes.get(agentId)
    io.debug(`styx spawn-wait ${agentId} outcome=${outcome} routed=${after !== undefined}`)
    if (after !== undefined) return after
    timedOut = outcome === 'timeout'
  }
  const persisted = await io.route(agentId)
  if (persisted !== undefined) s.routes.set(agentId, persisted)
  return persisted ?? (timedOut ? (unstarted(s, agentId) ?? (await unclaimedFork(io, s, agentId))) : undefined)
}

// --- remote steps ----------------------------------------------------------------------------------------

// The tool names the `tool_reference` blocks of a transcript load: what ToolSearch returned to its caller.
function referencedTools(messages: readonly ApiMessage[]): Set<string> {
  const names = new Set<string>()
  const scan = (block: unknown) => {
    if (!isObject(block)) return
    if (block['type'] === 'tool_reference' && typeof block['tool_name'] === 'string') names.add(block['tool_name'])
    else if (block['type'] === 'tool_result' && Array.isArray(block['content'])) block['content'].forEach(scan)
  }
  for (const m of messages) if (typeof m.content !== 'string') m.content.forEach(scan)
  return names
}

// The tools a remote request offers: the non-MCP and loaded MCP tools `offered` keeps, the styx agent tool
// when the loop may call both Agent (which its calls become) and the tool itself (the tool list holds them
// and `offered` keeps them), and SubagentHandback to a subagent unless `noHandback` (a fork, which Claude Code offers
// none; a subagent the engine did not say it delivers through it; one the engine refused it; inside the cap). Each goes with its generated
// schema or a permissive one. An MCP tool is loaded when main's usage says so (`mainMcp`: main, or a fork of main,
// whose tools are main's: `$.tool.list()` and the usage are main's) or when the transcript sent holds a
// `tool_reference` to it, which is how a subagent loads one.
async function toolSet(io: ToolSource, s: Session, config: Config, t: Remote, isSub: boolean, mainMcp: boolean, noHandback: boolean, offered: (name: string) => boolean, referenced: ReadonlySet<string>): Promise<RemoteTool[]> {
  const handback = { name: HANDBACK_TOOL.name, description: HANDBACK_TOOL.description, schema: HANDBACK_TOOL.schema }
  // A model without tools is offered none, SubagentHandback included: its text-only end is handed back by styx (step.ts).
  if (!t.model.tools) return []
  const listed = await io.list()
  const loadedMcp = new Set([...(mainMcp ? await io.loadedMcp() : []), ...referenced])
  const tools: RemoteTool[] = []
  const seen = new Set<string>([HANDBACK_TOOL.name])
  const schemaless: string[] = []
  const long: string[] = []
  const wrapped = listed.some(x => x.name === 'Agent') && offered('Agent') && offered(WRAPPER)
  for (const tool of listed) {
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    if (tool.name === WRAPPER) {
      if (wrapped) tools.push({ name: WRAPPER, description: advert(config), schema: agentSchema(config, SCHEMAS['Agent'] ?? {}) })
      continue
    }
    if (!offered(tool.name)) continue
    if (tool.mcp && !loadedMcp.has(tool.name)) continue
    if (!TOOL_NAME_RE.test(tool.name)) {
      long.push(tool.name)
      continue
    }
    const schema = SCHEMAS[tool.name] ?? s.mcpSchemas[tool.name]
    if (schema === undefined) schemaless.push(tool.name)
    tools.push({ name: tool.name, description: tool.description, schema: schema ?? { type: 'object' } })
  }
  const cap = t.provider.maxTools
  const hands = isSub && !noHandback
  const room = hands ? cap - 1 : cap
  const kept = tools.slice(0, Math.max(0, room))
  s.toolReport = { schemaless, capped: tools.slice(Math.max(0, room)).map(x => x.name), long, cap }
  if (hands && cap > 0) kept.push(handback)
  return kept
}

// The tool that delivers a subagent step's failure as its report: SubagentHandback, when the step's request
// offers it (`offered`) and the subagent's transcript (`read`, else read here) says the engine delivers
// through it and shows no call of it refused since, so a run hands back at most once. A transcript that cannot be
// read cannot show a refusal, so styx's own record stands in: the first failure of a turn is handed back, and
// the failure of a later step of that turn, which the engine only runs after refusing the call, is not.
// Undefined for main and otherwise: the failure is then answered as text.
async function handbackFor(io: Transcripts, s: Session, e: TurnStepInput, offered: boolean, read?: unknown): Promise<string | undefined> {
  if (e.agentId === undefined || !offered) return undefined
  let messages: unknown
  try {
    messages = read ?? (await io.transcript(e.agentId))
  } catch {}
  if (Array.isArray(messages)) return handbackState(messages as ApiMessage[], HANDBACK_TOOL.name) === 'offered' ? HANDBACK_TOOL.name : undefined
  if (s.blindHandbacks.get(e.agentId) === e.turnId) return undefined
  s.blindHandbacks.set(e.agentId, e.turnId)
  return HANDBACK_TOOL.name
}

// Answers a step with `text` in place of a response, after whatever `assembler` has yielded: as text, or
// as one call of `handback` when it names one and no tool call was yielded.
async function* failStep(e: TurnStepInput, assembler: Assembler, text: string, handback?: string): StepResult {
  const end = assembler.end({ failure: text, ...(handback === undefined ? {} : { handback }) })
  yield* end.chunks
  return { turnId: e.turnId, index: e.index, answer: end.answer, toolUses: end.toolUses, stopReason: end.stopReason, usage: null }
}

async function* remoteStep(io: StepIo & Pick<RouteStore, 'route' | 'translated' | 'setTranslated'>, s: Session, backend: Backend, e: TurnStepInput, target: string, route: Route | undefined, signal: AbortSignal): StepResult {
  const key = stepKey(e)
  const record: StepRecord = { target }
  s.steps.set(key, record)
  const who = e.agentId ?? 'main'
  // A failure before the request is sent; a subagent's goes back through `handback` when it names one, and
  // is toasted (a main step's text is the answer already).
  const fail = async function* (text: string, handback: string | undefined) {
    s.steps.delete(key)
    if (e.agentId !== undefined) io.toast(text)
    return yield* failStep(e, createAssembler(target), text, handback)
  }
  // A fork is offered no SubagentHandback, so its failures are answered as text, its final message.
  const fork = isFork(route?.type)
  // A subagent styx started but could not run on the styx model its caller asked for hands that back as its report.
  if (route?.refused !== undefined) return yield* fail(route.refused, await handbackFor(io, s, e, !fork))
  const snap = s.loaded
  const t = snap.config === undefined ? undefined : resolve(snap.config, target)
  if (snap.config === undefined || t?.kind !== 'remote') {
    return yield* fail(
      `styx: ${target} is not available (${snap.errors[0] ?? 'no longer configured'}); the step was not sent. Fix ${snap.path}, run /styx reload, or pick another model`,
      await handbackFor(io, s, e, !fork),
    )
  }
  if (!(await isTrusted(io, t.provider))) {
    return yield* fail(`styx: provider ${t.provider.id} is not approved; run /model ${labelOf(snap.config, target)} to approve it. The step was not sent`, await handbackFor(io, s, e, !fork))
  }
  await approve(s, backend, t.provider)
  // A custom agent type's subagent gets its definition's prompt and tools, and so does a built-in type's that one
  // agent file names; any other built-in type's gets the prompt styx writes for it and the tools its type allows;
  // main the composed prompt; a fork its parent's prompt. Each names the routed model.
  const isSub = e.agentId !== undefined
  const read = await io.transcript(e.agentId)
  const forkBase = fork && route !== undefined ? await forkParent(io, s, route) : undefined
  if (fork && forkBase === undefined) return yield* fail(`styx: the route of the parent of this fork cannot be read; the step was not sent; retry`, undefined)
  // What the prompt is the prompt of: the route itself, or for a fork its parent's (undefined: main).
  const shape = forkBase === undefined ? route : forkBase.route
  const def = isSub ? await definitionOf(io, s, shape?.type) : undefined
  // Main keeps its own tools; only a subagent is cut from them: by its type, and by the subagent that started it.
  const pool = e.agentId === undefined ? () => true : await poolOf(io, s, e.agentId)
  // A fork is sent its parent's history joined to its own (fork.ts), told there how it reports; a fork whose history
  // cannot be rebuilt whole is not sent. The tool_reference blocks of that history load MCP tools.
  const history =
    'deny' in read
      ? undefined
      : fork && route !== undefined
        ? await forkHistory(io, s, who, route, read, WRAPPER, [FORK_REPORT])
        : withTranslated(e.agentId === undefined ? read : withTask(read, route?.prompt), await translatedOf(io, s, who), WRAPPER)
  const referenced = history === undefined ? new Set<string>() : referencedTools(history)
  // A subagent is offered SubagentHandback only while the engine's transcript says it delivers through it (in 2.1.294,
  // only in auto permission mode) and no call of it has been refused since; else its final text is its report. A
  // `tools: false` subagent is offered none: styx hands its final text back as the call (`synth`).
  const synth = isSub && !fork && !t.model.tools
  const state = !isSub ? 'unsaid' : 'deny' in read ? 'offered' : handbackState(read, HANDBACK_TOOL.name)
  if (isSub && !fork && state !== 'offered' && (s.offered.get(who)?.has(HANDBACK_TOOL.name) ?? true)) io.debug(`styx: ${who} is offered no SubagentHandback (${state === 'unsaid' ? 'the engine did not say it delivers through it; its final text is its report' : 'the engine refused a call of it'})`)
  const tools = await toolSet(io, s, snap.config, t, isSub, !isSub || (fork && forkBase?.route === undefined), fork || state !== 'offered', pool, referenced)
  const names = tools.map(x => x.name)
  if (e.agentId !== undefined) s.offered.set(e.agentId, new Set(names))
  const prompt = await systemFor(io, s, { def, route: shape, fork: forkBase !== undefined, engineModel: e.model, target: t.target, model: t.model.id, provider: t.provider.id, tools: names })
  const handback = await handbackFor(io, s, e, names.includes(HANDBACK_TOOL.name) || synth, read)
  if ('deny' in read) return yield* fail(`styx: the transcript of ${who} is unreadable (${read.deny}); the step was not sent; retry`, handback)
  if (history === undefined) return yield* fail(FORK_HISTORY, handback)
  const messages = withIdentity(t.model.tools ? history : withoutTool(history, HANDBACK_TOOL.name), t.model.id, t.provider.id)
  io.debug(
    `styx req ${who} msgs=${messages.length} firstUser=${JSON.stringify(redact(firstUserText(messages)).slice(0, 60))} tools=${tools.length}[${tools
      .slice(0, 8)
      .map(x => x.name)
      .join('|')}]`,
  )
  // The styx agent call's effort, else the level a custom agent's definition declares, else the step's own.
  const declared = def?.effort !== undefined && EFFORTS.includes(def.effort as Effort) ? (def.effort as Effort) : undefined
  const effort = route?.effort ?? declared ?? e.effort
  const req: StepRequest = { target, system: prompt.text, tools, transcript: messages, ...(effort === undefined ? {} : { effort }), who }
  const budget = inputBudget(t.model, t.provider.kind)
  // The last response's prompt size counts while the transcript has not shrunk since (a /compact shrinks it);
  // else the request's own size.
  const last = s.promptTokens.get(who)
  const estimate = last !== undefined && e.messageCount >= last.messageCount ? last.tokens : Math.ceil(JSON.stringify(req).length / 3.5)
  if (estimate > 0.95 * budget) {
    const toolTokens = Math.ceil(JSON.stringify(tools).length / 3.5)
    return yield* fail(
      toolTokens > 0.5 * budget
        ? `styx: tool schemas alone take ~${k(toolTokens)} of ${target}'s ${k(budget)} input budget; set "tools": false on the model or use a larger one`
        : `styx: context ~${k(estimate)} exceeds ${target}'s ${k(budget)} input budget; run /compact`,
      handback,
    )
  }
  const assembler = createAssembler(t.target)
  record.assembler = assembler
  for await (const ev of backend.step(req, signal)) {
    if (ev.type === 'stats') {
      s.lastSteps.delete(who)
      s.lastSteps.set(who, { target, stats: ev, prompt: prompt.source })
    }
    yield* assembler.feed(ev.type === 'tool_use' && ev.name === WRAPPER ? await translateUse(io, s, who, target, ev, names.includes(WRAPPER)) : ev)
  }
  // A subagent offered SubagentHandback hands a request failure back as its report, so its run ends with
  // the failure delivered rather than re-asked; after a refused handback it answers text, and the run ends.
  const end = assembler.end({ ...(handback === undefined ? {} : { handback }), ...(synth ? { deliver: true } : {}) })
  if (end.delivered === true) io.debug(`styx: ${who} ended on text; styx handed it back as one ${HANDBACK_TOOL.name} call (tools: false)`)
  const stop = end.chunks.pop() as TurnStepChunk
  yield* end.chunks
  const u = end.usage
  if (u !== null) s.promptTokens.set(who, { tokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, messageCount: e.messageCount })
  if (end.failure !== undefined && e.agentId !== undefined) io.toast(firstLine(end.failure))
  const result: TurnStepResult = { turnId: e.turnId, index: e.index, answer: end.answer, toolUses: end.toolUses, stopReason: end.stopReason, usage: end.usage }
  yield stop
  s.steps.delete(key)
  return result
}

// A turn.step: native when no styx target holds it, else the remote step. `native` is the step beneath.
export async function* turnStep(io: StepIo & Pick<RouteStore, 'main' | 'pin' | 'setPin' | 'route' | 'translated' | 'setTranslated'> & Sleeper & AgentTypes, s: Session, backend: Backend, e: TurnStepInput, signal: AbortSignal, native: () => StepResult): StepResult {
  const route = e.agentId === undefined ? undefined : await subRoute(io, s, e.agentId, signal)
  const target = e.agentId === undefined ? await mainRoute(io, s, e) : (route?.target ?? null)
  if (target === null) return yield* native()
  return yield* remoteStep(io, s, backend, e, target, route, signal)
}

// A turn.step whose hook failed (`error`): a step styx routes is answered with the internal-error text,
// handed back when it is a subagent's, and never passed to another model; any other goes on beneath.
export async function* stepFailed(io: Say & Transcripts, s: Session, e: TurnStepInput, error: { kind: string; message?: string }, native: () => StepResult): StepResult {
  const key = stepKey(e)
  const record = s.steps.get(key)
  const target = record?.target ?? (e.agentId !== undefined ? (s.routes.get(e.agentId)?.target ?? null) : s.pin?.turnId === e.turnId ? s.pin.target : (s.main ?? null))
  try {
    io.debug(`styx: turn.step ${key} failed (${error.kind}: ${error.message ?? ''}); ${target === null ? 'passed to the native model' : `answered with the internal-error text for ${target}`}`)
  } catch {}
  if (target === null) return yield* native()
  s.steps.delete(key)
  const handback = await handbackFor(io, s, e, !isFork(s.routes.get(e.agentId ?? '')?.type))
  return yield* failStep(e, record?.assembler ?? createAssembler(target), `styx: internal error on ${target}; the step was not sent to another model (see the debug log)`, handback)
}

// --- /model ----------------------------------------------------------------------------------------------

export type ModelPort = TrustPort & Pick<RouteStore, 'setMain'> & Pick<Say, 'debug'> & StatusPort & { contextTokens(): Promise<number> }

// /model: a styx alias or `provider/model` selects main's target, one line and no toast; any other argument
// goes to the native command (`next`), and leaves styx when styx held main.
export async function modelCommand(io: ModelPort, s: Session, e: CommandRunInput, next: (e: CommandRunInput) => Promise<CommandRunResult>): Promise<CommandRunResult> {
  const withLine = (text: string | undefined, line: string) => (text ? `${text}\n${line}` : line)
  const leaving = () => (s.main ? `styx: left ${shownTarget(s.loaded.config, s.main)}` : undefined)
  // The native /model with `args`, then main cleared; its output says so when styx held main.
  const native = async (args: string) => {
    const left = leaving()
    const r = await next({ ...e, args })
    await setMain(io, s, null)
    return left === undefined ? r : { ...r, text: withLine(r.text, left) }
  }
  const arg = e.args.trim()
  if (arg === '') {
    // The picker. Its pick lands after `next(e)` resolves, so styx leaves before opening it: a pick, an
    // unchanged pick and Esc all leave styx alike, and /model <alias> returns to the alias.
    const left = leaving()
    if (left !== undefined) await setMain(io, s, null)
    const r = await next(e)
    return left === undefined ? r : { ...r, text: withLine(r.text, left) }
  }
  const snap = s.loaded
  if (snap.missing || !isStyxShaped(snap.config, arg, knownAliases(s))) return native(e.args)
  if (snap.config === undefined && arg.startsWith('native/') && arg.length > 'native/'.length) return native(arg.slice('native/'.length))
  if (snap.config === undefined) return { text: `styx: can't switch to ${arg}: config error, ${snap.errors[0]}. Native model unchanged; fix ${snap.path}, then run /styx reload` }
  const t = resolve(snap.config, arg)
  if (t === undefined) return { text: explain(snap.config, arg) }
  if (t.kind === 'native') return native(t.model)
  if (!(await ensureTrust(io, t.provider))) return { text: `styx: provider ${t.provider.id} not approved; native model unchanged. Run /model ${arg} again and choose Allow` }
  const context = Math.max(await io.contextTokens(), s.promptTokens.get('main')?.tokens ?? 0)
  const budget = inputBudget(t.model, t.provider.kind)
  if (context > 0.85 * budget) return { text: `styx: transcript ~${k(context)} tokens exceeds ${t.target}'s ${k(budget)} input budget; run /compact, then /model ${arg}` }
  await setMain(io, s, t.label)
  return { text: `Set model to ${t.label === t.target ? t.target : `${t.label} (${t.target})`}` }
}

// When /model fails inside styx: a styx-shaped argument is answered, the native command not run; any other
// goes on beneath (`next`), and so does a failure after `next` was called.
export function modelFailed(s: Session, e: CommandRunInput, called: boolean, next: (e: CommandRunInput) => Promise<CommandRunResult>): Promise<CommandRunResult> | CommandRunResult {
  return called || s.loaded.missing || !isStyxShaped(s.loaded.config, e.args.trim(), knownAliases(s))
    ? next(e)
    : { text: `styx: couldn't switch to ${e.args.trim()} (internal error; see the debug log). Native model unchanged` }
}

// A model switch made outside /model (the /config Model row, the SDK) leaves styx too: main is cleared, and
// the status line says so.
export async function modelSwitched(io: Pick<RouteStore, 'setMain'> & Pick<Say, 'debug'> & StatusPort, s: Session, source: string) {
  if ((source === 'command' || source === 'picker' || source === 'sdk') && s.main) await setMain(io, s, null)
}
