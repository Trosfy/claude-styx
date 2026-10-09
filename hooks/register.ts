// Styx: routes the main conversation (`/model <alias>`) and subagents (the `mcp__styx__agent` tool) to
// remote providers, answering their turn.step requests itself through the backend. Native requests pass
// through untouched. The composition root, and the one module that talks to the engine (`$`): it builds the
// small ports each module works through and wires the modules to the engine's events. The logic lives in
// load, routing, pool, leave, spawn, inherit, trust, worktree, prompts and ui, over one Session of memory.
import type { CommandRunResult, EngineInterface, Register } from 'claude-code'

import { createBackend } from './backend'
import type { Host } from './backend'
import { typeahead } from './advert'
import { own } from './config'
import { dropCall, inheritSpawn, noteCall, routedFork } from './inherit'
import type { InheritPort } from './inherit'
import { ended, leftNote } from './leave'
import { reload } from './load'
import type { LoadPort, ReloadPort } from './load'
import { guard, guardFailed } from './pool'
import type { PromptsPort } from './prompts'
import type { Backend } from './protocol'
import { modelCommand, modelFailed, modelSwitched, stepFailed, turnStep, WRAPPER } from './routing'
import type { ModelPort, RouteStore, Say, Sleeper, StepIo, Transcripts } from './routing'
import { createSession } from './session'
import type { Session } from './session'
import { AGENT_INTERNAL, agentCall, completed, translatedOf, untranslated } from './spawn'
import type { AgentPort, AgentTypes } from './spawn'
import { isTrusted } from './trust'
import type { TrustPort } from './trust'
import { report, showStatus } from './ui'
import type { ReportPort, StatusPort } from './ui'
import { findTrash } from './worktree'
import type { WorktreePort } from './worktree'

const MAIN = { plugin: 'styx', key: 'main' } as const
const MAIN_PIN = { plugin: 'styx', key: 'mainPin' } as const
const ROUTED = { plugin: 'styx', key: 'routed' } as const
const TRANSLATED = { plugin: 'styx', key: 'translated' } as const

// --- ports: each module's view of `$` ------------------------------------------------------------------

const debug = ($: EngineInterface, text: string) => $.ui.log(text, { to: 'debug' })
const say = ($: EngineInterface): Say => ({ toast: text => $.ui.toast(text), debug: text => debug($, text) })
const statusPort = ($: EngineInterface): StatusPort => ({ status: text => $.ui.status(text) })

// Claude Code's configuration directory: $CLAUDE_CONFIG_DIR when set and not empty, else $HOME/.claude.
async function configDir($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
}

// A command run to its end; one that cannot start answers exit code 127 with the reason as stderr.
const run = ($: EngineInterface) => async (argv: readonly string[], opts?: { timeoutMs?: number }) => {
  try {
    return await $.process.run(argv, opts)
  } catch (err) {
    return { exitCode: 127, stdout: '', stderr: String(err) }
  }
}

// The host the backend works through.
const host = ($: EngineInterface, s: Session): Host => ({
  run: (argv, init) => $.process.run(argv, init),
  spawn: req => $.process.spawn(req),
  sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
  debug: text => debug($, text),
  root: $.plugin.root,
  userAgent: s.userAgent,
})

const loadPort = ($: EngineInterface): LoadPort => ({
  configDir: () => configDir($),
  home: async () => (await $.env.get('HOME').catch(() => undefined)) ?? '',
  exists: path => $.fs.exists(path),
  read: async path => String(await $.fs.read(path)),
  policy: () => $.settings.read({ source: 'policy' }),
})

// The engine's version, or undefined when it cannot be read.
async function engineVersion($: EngineInterface): Promise<string | undefined> {
  try {
    return (await $.session.version()).version
  } catch {
    return undefined
  }
}

const reloadPort = ($: EngineInterface): ReloadPort => ({
  ...loadPort($),
  pluginRoot: $.plugin.root,
  version: () => engineVersion($),
  entrypoint: () => $.env.get('CLAUDE_CODE_ENTRYPOINT').catch(() => undefined),
  registerAgentTool: async (description, inputSchema) => void (await $.tool.register({ name: 'agent', description, inputSchema })),
  toast: text => $.ui.toast(text),
})

const trustPort = ($: EngineInterface): TrustPort => ({
  trusted: async key => (await $.store.get(key)) === true,
  remember: key => $.store.set(key, true),
  ask: (question, options) => $.ui.ask(question, { header: 'styx', options: [...options] }),
})

const worktreePort = ($: EngineInterface): WorktreePort => ({
  run: run($),
  cwd: () => $.session.cwd(),
  toast: text => $.ui.toast(text),
  log: text => $.ui.log(text),
  debug: text => debug($, text),
})

const promptsPort = ($: EngineInterface): PromptsPort => ({
  compose: async (model, tools) => (await $.prompt.compose({ model, tools: [...tools] })).sections,
  cwd: () => $.session.cwd(),
  configDir: () => configDir($),
  exists: path => $.fs.exists(path),
  read: async path => String(await $.fs.read(path)),
  listDir: async dir => ((await $.fs.exists(dir)) ? $.fs.list(dir) : []),
  run: run($),
  now: () => $.clock.now(),
  debug: text => debug($, text),
})

const routeStore = ($: EngineInterface): RouteStore => ({
  main: async () => (await $.state.get(MAIN)).value,
  setMain: async target => void (await $.state.set(MAIN, target)),
  pin: async () => (await $.state.get(MAIN_PIN)).value,
  setPin: async pin => void (await $.state.set(MAIN_PIN, pin)),
  route: async agentId => (await $.state.get({ ...ROUTED, id: agentId })).value,
  setRoute: async (agentId, route) => void (await $.state.set({ ...ROUTED, id: agentId }, route)),
  translated: async who => (await $.state.get({ ...TRANSLATED, id: who })).value,
  setTranslated: async (who, calls) => void (await $.state.set({ ...TRANSLATED, id: who }, calls)),
})

// The agent type the engine lists a subagent as, which it started it as.
const agentTypes = ($: EngineInterface): AgentTypes => ({ agentType: async agentId => (await $.agent.list()).find(a => a.id === agentId)?.type })

const inheritPort = ($: EngineInterface): InheritPort => ({
  ...promptsPort($),
  ...routeStore($),
  ...agentTypes($),
})

const sleeper = ($: EngineInterface): Sleeper => ({ sleep: (ms, signal) => $.clock.sleep(ms, { signal }) })

const transcripts = ($: EngineInterface): Transcripts => ({
  transcript: agentId => (agentId === undefined ? $.session.messages({ as: 'api' }) : $.session.messages({ as: 'api', agentId })) as ReturnType<Transcripts['transcript']>,
})

const stepIo = ($: EngineInterface): StepIo => ({
  ...say($),
  ...promptsPort($),
  ...transcripts($),
  trusted: trustPort($).trusted,
  list: () => $.tool.list(),
  loadedMcp: async () => new Set(((await $.session.usage({ breakdown: 'summary' })).context.breakdown?.mcpTools ?? []).filter(m => m.isLoaded).map(m => m.name)),
})

const modelPort = ($: EngineInterface): ModelPort => ({
  ...trustPort($),
  ...statusPort($),
  debug: text => debug($, text),
  setMain: routeStore($).setMain,
  contextTokens: async () => (await $.session.usage()).context.tokens ?? 0,
})

const agentPort = ($: EngineInterface): AgentPort => ({
  ...trustPort($),
  ...promptsPort($),
  ...worktreePort($),
  ...agentTypes($),
  route: routeStore($).route,
  setRoute: routeStore($).setRoute,
  spawn: args => $.agent.spawn(args),
})

const reportPort = ($: EngineInterface, backend: Backend): ReportPort => ({
  engineModel: async () => {
    try {
      return await $.session.model()
    } catch {
      return 'unknown'
    }
  },
  keys: () => backend.status(),
  trusted: p => isTrusted(trustPort($), p),
})

// --- hooks -----------------------------------------------------------------------------------------------

export const register: Register = on => {
  const s = createSession()
  const backend = createBackend()

  on('session.start', async ($, e, next) => {
    const b = backend(host($, s))
    await reload(reloadPort($), s, b)
    await $.command.register({ name: 'styx', description: 'Show styx routing, providers, aliases and gaps; `/styx reload` re-reads styx.json', argumentHint: '[reload]' })
    s.trashPath = await findTrash(worktreePort($))
    debug($, `styx trash: ${s.trashPath ?? 'none'}`)
    s.main = (await $.state.get(MAIN)).value ?? null
    showStatus(statusPort($), s)
    const started = await next(e)
    // The backend sets its styxd-spawning loop going here, in the hook the session outlives: a styxd spawned
    // while a step runs would die with that step.
    await b.start()
    return started
  })

  on('tool.describe', { tool: 'mcp__styx__agent' }, ($, e) => ({ ...e, isDeferred: false }))

  // A routed conversation's call is made an Agent call at its step (routing.ts); this answers the rest. A hook-spawned
  // subagent's call raises the event beneath this hook (re-entry), where nothing can be read: its answer is the reason the step left it.
  on('tool.call', { tool: 'mcp__styx__agent' }, ($, e) => agentCall(agentPort($), s, e)).catch(($, e, next) =>
    next.error.kind === 're-entry'
      ? String(e.tool) === WRAPPER
        ? untranslated(s, e)
        : next(e)
      : { deny: AGENT_INTERNAL },
  )

  // A plain Agent call under a routed parent: its effort and worktree isolation are kept, and its spawn claims the parent's route.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    noteCall(s, e)
    const done = await next(e)
    dropCall(s, e, done)
    return done
  })
  on('agent.spawn', ($, e, next) => inheritSpawn(inheritPort($), s, e, next.origin.plugin, next))

  // A routed turn has no classifier verdict for auto mode, so an Agent call styx made of a routed model's styx agent
  // call is allowed where the engine would ask with no rule or hook behind the question. A deny, an ask a rule
  // or a hook made, and every other Agent call, stand.
  // A call whose note a reload took is known by the record in state. A native Agent fork call from a routed
  // conversation is allowed too: its spawn claims the parent's target or refuses, never native.
  on('tool.check', { tool: 'Agent' }, async ($, e, next) => {
    const verdict = await next(e)
    const plainAsk = verdict.decision === 'ask' && verdict.rule === undefined && verdict.hook === undefined
    if (!plainAsk) return verdict
    const id = String(e.tool_use_id)
    const made = s.calls.get(id)?.target !== undefined || own(await translatedOf({ ...say($), ...routeStore($) }, s, e.agentId ?? 'main'), id) !== undefined
    const fork = made ? undefined : await routedFork(routeStore($), s, e)
    if (fork !== undefined) debug($, `styx check ${id}: a fork of ${e.agentId ?? 'main'} on ${fork} is allowed where auto mode would ask; its spawn is claimed on ${fork} or refused`)
    return made || fork !== undefined ? { ...verdict, decision: 'allow' } : verdict
  }).catch(($, e, next) => (next.called ? next(e) : { decision: 'deny', reason: 'styx: could not check this Agent call, so it was denied; retry, or see the debug log' }))

  on('tool.call', async ($, e, next) => (await guard({ ...stepIo($), ...routeStore($) }, s, e)) ?? next(e)).catch(($, e, next) => (next.called ? next(e) : (guardFailed(s, e) ?? next(e))))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) await completed({ ...worktreePort($), ...routeStore($) }, s, e.agentId)
    return done
  })

  on('turn.step', async function* ($, e, next) {
    return yield* turnStep({ ...stepIo($), ...routeStore($), ...sleeper($), ...agentTypes($) }, s, backend(host($, s)), e, next.signal, () => next(e))
  }).catch(async function* ($, e, next) {
    if (next.called) return yield* next(e)
    return yield* stepFailed({ ...say($), ...transcripts($) }, s, e, next.error, () => next(e))
  })

  // The engine shows a command's text under the mod's name ("styx: …"), so the text drops its own prefix.
  const asCommand = (r: CommandRunResult): CommandRunResult => (r.text?.startsWith('styx: ') ? { ...r, text: r.text.slice(6) } : r)
  on('command.run', { command: 'model' }, async ($, e, next) => asCommand(await modelCommand(modelPort($), s, e, next)))
    .catch(async ($, e, next) => asCommand(await modelFailed(s, e, next.called, next)))

  on('command.run', { command: 'styx' }, async ($, e) => {
    if (e.args.trim() === 'reload') {
      await reload(reloadPort($), s, backend(host($, s)))
      $.ui.invalidate('tool.describe')
      showStatus(statusPort($), s)
    }
    for (const line of await report(reportPort($, backend(host($, s))), s)) $.ui.log(line)
    return {}
  })

  on('prompt.autocomplete', async ($, e, next) => {
    const r = await next(e)
    const rows = s.loaded.config === undefined ? [] : typeahead(s.loaded.config, e.text, e.start, e.token)
    return rows.length === 0 ? r : { suggestions: [...r.suggestions, ...rows] }
  })

  // /clear and a resume end the conversation without a session.start, so the notes owed for it end with it.
  on('session.end', ($, e, next) => (ended(s), next(e)))

  // The first main prompt after a route was left tells native Claude which turns another model answered.
  on('prompt.submit', ($, e, next) => leftNote(s, e, next)).catch(($, e, next) => next(e))

  // A switch made outside /model (the /config Model row, the SDK) leaves styx too.
  on('classic.PostModelSwitch', async ($, e, next) => {
    await modelSwitched({ ...routeStore($), ...say($), ...statusPort($) }, s, e.source)
    return next(e)
  })
}
