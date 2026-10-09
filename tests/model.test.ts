// Session start, switching the main conversation (/model), trust on first use, the switch guard,
// PostModelSwitch, the /model typeahead and /styx.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { typeahead } from '../hooks/advert'
import { parseConfig } from '../hooks/config'
import { STAMP } from '../hooks/schemas.gen'
import type { Config } from '../hooks/config'
import { CONFIG, CONFIG_OBJECT, HELPER, LOCAL_CONFIG, LOCAL_HELPER, LOCAL_ORIGIN, LOCAL_TRUSTED, model, ORIGIN, start, step, world } from './world'

const brokenConfig = JSON.stringify({ ...CONFIG_OBJECT, aliases: { strong: 'acme9/model-b' } })
const NONE_CONFIG = JSON.stringify({ ...CONFIG_OBJECT, providers: { acme: { ...CONFIG_OBJECT.providers.acme, auth: 'none' } } })

test('session.start registers the styx agent tool and /styx, and a healthy config makes no toast', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.registered.map(t => t.name)).toEqual(['agent'])
  const schema = w.registered[0]?.inputSchema as { properties: { model: { enum: string[] } } }
  expect(schema.properties.model.enum).toContain('strong')
  expect(w.registered[0]?.description).toContain('- strong: acme/model-b — strong generalist')
  expect(w.commands).toEqual(['styx'])
  expect(w.toasts).toEqual([])
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('with no config file styx registers no tool, toasts nothing, and leaves /model alone', async ($, on) => {
  const w = world(on, { config: null })
  await start($)
  expect(w.registered).toEqual([])
  expect(w.toasts).toEqual([])
  expect(await model($, 'strong')).toMatchObject({ text: 'native /model strong' })
})

test('a broken config disables routing: one toast, alias-shaped /model args answered, native ones passed', async ($, on) => {
  const w = world(on, { config: brokenConfig })
  await start($)
  expect(w.registered).toEqual([])
  expect(w.toasts).toEqual(['styx: routing off, config error: aliases.strong → provider "acme9" is not declared (declared: acme). Fix ~/.claude/styx.json, then run /styx reload'])
  expect(await model($, 'strong')).toEqual({
    text: 'can\'t switch to strong: config error, aliases.strong → provider "acme9" is not declared (declared: acme). Native model unchanged; fix ~/.claude/styx.json, then run /styx reload',
  })
  expect(await model($, 'opus')).toMatchObject({ text: 'native /model opus' })
  expect(await model($, 'native/sonnet')).toMatchObject({ text: 'native /model sonnet' })
  expect(await model($, 'opusplan')).toMatchObject({ text: 'native /model opusplan' })
  expect(w.native).toEqual(['/model opus', '/model sonnet', '/model opusplan'])
})

test('after a reload breaks the config, the last valid aliases are still answered and other names pass', async ($, on) => {
  let text = CONFIG
  const w = world(on, { config: () => text })
  await start($)
  text = JSON.stringify({ providers: 5 })
  await $.command.run({ command: 'styx', args: 'reload', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(await model($, 'strong')).toEqual({ text: "can't switch to strong: config error, providers: must be an object. Native model unchanged; fix ~/.claude/styx.json, then run /styx reload" })
  expect(await model($, 'opusplan')).toMatchObject({ text: 'native /model opusplan' })
  expect(w.native).toEqual(['/model opusplan'])
})

test('/model strong selects the styx target in one line, without the native command, with a status line and no toast', async ($, on) => {
  const w = world(on, { usageTokens: 84_000 })
  await start($)
  expect(await model($, 'strong')).toEqual({ text: 'Set model to strong (acme/model-b)' })
  expect(w.native).toEqual([])
  expect(w.statuses.at(-1)).toBe('strong · acme')
  expect(w.toasts).toEqual([])
  expect(w.stateSets).toContainEqual({ key: 'main', value: 'strong' })
  expect(await model($, 'acme/model-a')).toEqual({ text: 'Set model to acme/model-a' })
  expect(w.statuses.at(-1)).toBe('fast · acme')
  expect(await model($, 'acme/small')).toEqual({ text: 'Set model to acme/small' })
  expect(w.statuses.at(-1)).toBe('acme/small · acme')
})

test('/model strong runs no key helper; a routed step whose helper fails answers one line naming the fix, and sends nothing', async ($, on) => {
  const w = world(on, { keyFails: true })
  await start($)
  expect(await model($, 'strong')).toEqual({ text: 'Set model to strong (acme/model-b)' })
  expect(w.stateSets).toContainEqual({ key: 'main', value: 'strong' })
  expect(w.runs.filter(r => r[0] === HELPER[0])).toEqual([])
  const s = await step($, { turnId: 'k', index: 0 })
  const text = 'styx: acme key helper failed (exit 1): keychain locked, or no key stored? Run bun run auth login acme'
  expect(s.result).toMatchObject({ answer: text, stopReason: 'end_turn', usage: null })
  expect(w.runs.filter(r => r[0] === HELPER[0])).toEqual([HELPER])
  expect(w.toasts).toEqual([])
  expect(w.requests).toEqual([])
})

test('prototype names are no styx targets: acme/toString is undeclared, and constructor goes to the native /model', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await model($, 'acme/toString')).toEqual({ text: '"toString" is not declared under provider acme (declared: model-a, model-b, small)' })
  expect(await model($, 'constructor')).toMatchObject({ text: 'native /model constructor' })
  expect(w.stateSets.some(s => s.key === 'main')).toBe(false)
})

test('a refused write clearing main still leaves main native, and the native command runs once', async ($, on) => {
  const w = world(on, { mainClear: 'fails' })
  await start($)
  await model($, 'strong')
  expect(await model($, 'opus')).toMatchObject({ text: `native /model opus\n${LEFT_STRONG}` })
  expect(w.native).toEqual(['/model opus'])
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.debug.some(l => l.startsWith('styx: could not persist clearing main'))).toBe(true)
  expect((await step($, { turnId: 'n', index: 0 })).result.answer).toBe('native')
})

test('a clear of main holds in memory before its state write lands: a turn starting during the write is native', async ($, on) => {
  let release = () => {}
  let entered = () => {}
  const writing = new Promise<void>(resolve => (entered = resolve))
  const w = world(on, { mainClear: () => (entered(), new Promise<void>(resolve => (release = resolve))) })
  await start($)
  await model($, 'strong')
  const switching = model($, 'opus')
  await writing
  expect((await step($, { turnId: 'during', index: 0 })).result.answer).toBe('native')
  release()
  expect(await switching).toEqual({ text: `native /model opus\n${LEFT_STRONG}` })
  expect(w.requests).toEqual([])
})

// The leave line, as the native command's output carries it. Alone it is the whole /model result, which
// the engine shows under the mod's name, so it drops its own prefix there (`LEFT_STRONG_ALONE`).
const LEFT_STRONG = 'styx: left strong (acme/model-b)'
const LEFT_STRONG_ALONE = 'left strong (acme/model-b)'

test('a bare /model while styx holds main leaves styx before the picker opens, even when the picker answers nothing', async ($, on) => {
  let atPicker: { main: unknown; status: string | undefined } | undefined
  const w = world(on, { picker: () => ((atPicker = { main: w.stateSets.at(-1), status: w.statuses.at(-1) }), '') })
  await start($)
  await model($, 'strong')
  expect(await model($, '')).toEqual({ text: LEFT_STRONG_ALONE })
  expect(atPicker).toEqual({ main: { key: 'main', value: null }, status: undefined })
  expect((await step($, { turnId: 'p', index: 0 })).result.answer).toBe('native')
  expect(w.requests).toEqual([])
})

for (const picked of ['Set model to `Opus 5.5` and saved as your default for new sessions', 'Kept model as Opus 5.5']) {
  test(`a bare /model leaves styx whatever the picker then says: ${picked}`, async ($, on) => {
    const w = world(on, { picker: picked })
    await start($)
    await model($, 'strong')
    expect(await model($, '')).toEqual({ text: `${picked}\n${LEFT_STRONG}` })
    expect(w.stateSets.filter(s => s.key === 'main')).toEqual([
      { key: 'main', value: 'strong' },
      { key: 'main', value: null },
    ])
    expect(await model($, 'strong')).toEqual({ text: 'Set model to strong (acme/model-b)' })
  })
}

test('a bare /model with styx not holding main is the native picker, untouched', async ($, on) => {
  const w = world(on, { picker: 'Kept model as Opus 5.5' })
  await start($)
  expect(await model($, '')).toEqual({ text: 'Kept model as Opus 5.5' })
  expect(w.stateSets.some(s => s.key === 'main')).toBe(false)
})

test('a picker switch while styx holds main clears main once, its PostModelSwitch finding it clear', async ($, on) => {
  const w = world(on, { picker: '' })
  await start($)
  await model($, 'strong')
  await model($, '')
  await $.classic.PostModelSwitch({
    from_model: 'opus',
    to_model: 'sonnet',
    requested_model: null,
    source: 'picker',
    context_tokens: 0,
    prompt_cache_warm: false,
    cache_ttl: '1h',
    estimated_cache_write_usd: 0,
  } as never)
  expect(w.stateSets.filter(s => s.key === 'main')).toEqual([
    { key: 'main', value: 'strong' },
    { key: 'main', value: null },
  ])
  expect(w.toasts.filter(t => t.startsWith('styx: left'))).toEqual([])
})

test('/model opus while styx holds main runs the native command, then clears main and the status line', async ($, on) => {
  const w = world(on)
  await start($)
  await model($, 'strong')
  expect(await model($, 'opus')).toEqual({ text: `native /model opus\n${LEFT_STRONG}` })
  expect(w.native).toEqual(['/model opus'])
  expect(w.statuses.at(-1)).toBeUndefined()
  expect(w.stateSets.at(-1)).toEqual({ key: 'main', value: null })
  expect(await model($, 'opus')).toEqual({ text: 'native /model opus' })
  expect((await step($, { turnId: 'after-opus', index: 0 })).result.answer).toBe('native')
  expect(w.toasts).toEqual([])
})

test('/model native/opus hands opus to the native command and clears main after it ran', async ($, on) => {
  const w = world(on)
  await start($)
  await model($, 'strong')
  expect(await model($, 'native/opus')).toEqual({ text: `native /model opus\n${LEFT_STRONG}` })
  expect(w.native).toEqual(['/model opus'])
  expect(w.stateSets.at(-1)).toEqual({ key: 'main', value: null })
})

test('an undeclared provider/model is named; a bare /model opens the native picker', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await model($, 'acme/gpt-6')).toEqual({ text: '"gpt-6" is not declared under provider acme (declared: model-a, model-b, small)' })
  expect(await model($, '')).toMatchObject({ text: 'native /model ' })
  expect(w.native).toEqual(['/model '])
})

test('the switch guard refuses past 0.85 of the input budget, using the larger of usage and the last remote prompt', async ($, on) => {
  const w = world(on, { usageTokens: 310_000 })
  await start($)
  expect(await model($, 'acme/small')).toEqual({ text: "transcript ~310k tokens exceeds acme/small's 120k input budget; run /compact, then /model acme/small" })
  expect(w.stateSets.some(s => s.key === 'main')).toBe(false)
  expect(await model($, 'strong')).toEqual({ text: 'Set model to strong (acme/model-b)' })
})

test('the first routed use asks once; Allow persists, and later uses do not ask', async ($, on) => {
  const w = world(on, { store: {} })
  await start($)
  expect(await model($, 'strong')).toEqual({ text: 'Set model to strong (acme/model-b)' })
  expect(w.asks).toEqual([`Route styx requests to ${ORIGIN}, with the key printed by ${JSON.stringify(HELPER)}?`])
  await model($, 'fast')
  expect(w.asks).toHaveLength(1)
})

test('a provider switched from a helper to none asks again, names that no key is sent, and its steps carry no key and run no helper', async ($, on) => {
  const w = world(on, { config: NONE_CONFIG })
  await start($)
  expect(await model($, 'strong')).toEqual({ text: 'Set model to strong (acme/model-b)' })
  expect(w.asks).toEqual([`Route styx requests to ${ORIGIN}, sending no key?`])
  await model($, 'fast')
  expect(w.asks).toHaveLength(1)
  await step($, { turnId: 'k1', index: 0 })
  expect(w.requests).toHaveLength(1)
  expect(Object.keys(w.requests[0]!.headers)).not.toContain('authorization')
  expect(Object.keys(w.requests[0]!.headers)).not.toContain('x-api-key')
  expect(w.runs.filter(argv => argv[0] === HELPER[0])).toEqual([])
})

test('the trust prompt for a plain-http provider says the key and data travel unencrypted, and approval is per http origin', async ($, on) => {
  const w = world(on, { config: LOCAL_CONFIG, store: {} })
  await start($)
  expect(await model($, 'model.v1-mini')).toEqual({ text: 'Set model to model.v1-mini (local/model-v1)' })
  expect(w.asks).toEqual([
    `Plain http: the API key and your data travel unencrypted unless the network itself is private or encrypted. Route styx requests to ${LOCAL_ORIGIN}, with the key printed by ${JSON.stringify(LOCAL_HELPER)}?`,
  ])
  expect(await model($, 'local/model-v1')).toEqual({ text: 'Set model to local/model-v1' })
  expect(w.asks).toHaveLength(1)
})

test('a dotted alias switches main end to end: the status line, the state, the leave line, the typeahead and the picker leave', async ($, on) => {
  const w = world(on, { config: LOCAL_CONFIG, store: LOCAL_TRUSTED })
  await start($)
  expect(w.toasts).toEqual([])
  expect((w.registered[0]?.inputSchema as { properties: { model: { enum: string[] } } }).properties.model.enum).toContain('model.v1-mini')
  expect(await model($, 'model.v1-mini')).toEqual({ text: 'Set model to model.v1-mini (local/model-v1)' })
  expect(w.native).toEqual([])
  expect(w.statuses.at(-1)).toBe('model.v1-mini · local')
  expect(w.stateSets).toContainEqual({ key: 'main', value: 'model.v1-mini' })
  expect(w.toasts).toEqual([])
  expect(await model($, 'opus')).toEqual({ text: 'native /model opus\nstyx: left model.v1-mini (local/model-v1)' })
  expect(w.statuses.at(-1)).toBeUndefined()
  const config = parseConfig(LOCAL_CONFIG).config as Config
  expect(typeahead(config, '/model model.v1-m', 7, 'model.v1-m')).toEqual([
    { text: 'model.v1-mini', description: 'a dotted alias on a plain-http provider (local/model-v1)' },
  ])
})

test('a dotted alias is kept from the native /model while the config is broken', async ($, on) => {
  const broken = JSON.stringify({ ...JSON.parse(LOCAL_CONFIG), version: 2 })
  const w = world(on, { config: broken })
  await start($)
  expect(await model($, 'model.v1-mini')).toEqual({
    text: "can't switch to model.v1-mini: config error, version: unsupported (styx reads version 1). Native model unchanged; fix ~/.claude/styx.json, then run /styx reload",
  })
  expect(w.native).toEqual([])
})

for (const answer of ['Keep native', 'Allow it', null]) {
  test(`answering ${JSON.stringify(answer)} to the trust dialog leaves the provider unapproved`, async ($, on) => {
    const w = world(on, { store: {}, answer })
    await start($)
    expect(await model($, 'strong')).toEqual({ text: 'provider acme not approved; native model unchanged. Run /model strong again and choose Allow' })
    expect(w.stateSets.some(s => s.key === 'main')).toBe(false)
  })
}

test('an approval for another key helper does not cover a changed fingerprint', async ($, on) => {
  const w = world(on, { store: { [`trust:openai|${ORIGIN}|cmd:["/usr/bin/other"]`]: true }, answer: 'Keep native' })
  await start($)
  expect(await model($, 'strong')).toEqual({ text: 'provider acme not approved; native model unchanged. Run /model strong again and choose Allow' })
  expect(w.asks).toHaveLength(1)
})

test('when the /model hook fails, its .catch answers a styx-shaped argument and the native command does not run', async ($, on) => {
  const w = world(on, { store: 'fails' })
  await start($)
  expect(await model($, 'strong')).toEqual({ text: "couldn't switch to strong (internal error; see the debug log). Native model unchanged" })
  expect(w.native).toEqual([])
})

test('a /model result never opens with "styx: " (the engine adds the mod name), and a native reply passes through as it is', async ($, on) => {
  world(on, { store: {}, answer: 'Keep native', picker: 'Kept model as Opus 5.5' })
  await start($)
  const refused = await model($, 'strong')
  expect(refused.text).toBe('provider acme not approved; native model unchanged. Run /model strong again and choose Allow')
  expect(refused.text?.startsWith('styx: ')).toBe(false)
  expect(await model($, 'opus')).toEqual({ text: 'native /model opus' })
  expect(await model($, '')).toEqual({ text: 'Kept model as Opus 5.5' })
})

test('PostModelSwitch clears main for command, picker and sdk switches, not auto or resume', async ($, on) => {
  const w = world(on)
  await start($)
  const raise = (source: 'command' | 'picker' | 'sdk' | 'auto' | 'resume') =>
    $.classic.PostModelSwitch({
      from_model: 'opus',
      to_model: 'sonnet',
      requested_model: null,
      source,
      context_tokens: 0,
      prompt_cache_warm: false,
      cache_ttl: '1h',
      estimated_cache_write_usd: 0,
    } as never)
  for (const source of ['auto', 'resume'] as const) {
    await model($, 'strong')
    await raise(source)
    expect(w.statuses.at(-1), source).toBe('strong · acme')
  }
  for (const source of ['command', 'picker', 'sdk'] as const) {
    await model($, 'strong')
    await raise(source)
    expect(w.statuses.at(-1), source).toBeUndefined()
  }
  expect(w.toasts).toEqual([])
})

test('the /model typeahead offers styx aliases and models for the argument token only', () => {
  const config = parseConfig(CONFIG).config as Config
  expect(typeahead(config, '/model st', 7, 'st')).toEqual([{ text: 'strong', description: 'strong generalist (acme/model-b)' }])
  expect(typeahead(config, '/model ', 7, '').map(s => s.text)).toEqual(['acme/model-a', 'acme/model-b', 'acme/small', 'fast', 'strong'])
  expect(typeahead(config, '/model acme/s', 7, 'acme/s')).toEqual([{ text: 'acme/small', description: 'styx model' }])
  const bare = parseConfig(JSON.stringify({ ...CONFIG_OBJECT, aliases: { quick: 'acme/small' } })).config as Config
  expect(typeahead(bare, '/model q', 7, 'q')).toEqual([{ text: 'quick', description: '(acme/small)' }])
  expect(typeahead(config, 'say h', 4, 'h')).toEqual([])
})

const styx = ($: Engine) => $.command.run({ command: 'styx', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

test('/styx prints main, two aligned tables (providers with kind, key and approval; aliases), and its gaps through the log, with no model-facing text', async ($, on) => {
  const w = world(on, { version: STAMP.engineVersion })
  await start($)
  await model($, 'strong')
  expect((await styx($)).text).toBeUndefined()
  expect(w.transcript).toEqual([
    'styx · main: strong → acme/model-b',
    '  PROVIDER  KIND    ORIGIN                KEY              APPROVED',
    '  acme      openai  https://styx.invalid  cmd not yet run  yes',
    '  ALIAS   TARGET        EFFORT           NOTE',
    '  fast    acme/model-a  low medium high  cheap, fast explorer for read-only sweeps',
    '  strong  acme/model-b  low medium high  strong generalist',
    '  routed subagents: none',
    `  schemas: generated on ${STAMP.engineVersion} · OK`,
    '  worktree cleanup: to the Trash (/opt/bin/trash)',
  ])
})

test('/styx ends with one next step for the first thing wrong: no config, a broken one, a failed key helper', async ($, on) => {
  let text: string | null = null
  const w = world(on, { config: () => text, keyFails: true })
  const nextStep = async () => {
    w.transcript.length = 0
    await styx($)
    return w.transcript.filter(l => l.startsWith('  next: '))
  }
  await start($)
  expect(w.transcript).toEqual([])
  expect(await nextStep()).toEqual(['  next: copy example.styx.json to ~/.claude/styx.json and fill it in, then run /styx reload'])
  expect(w.transcript[0]).toBe('styx · routing off: no ~/.claude/styx.json')
  text = JSON.stringify({ providers: 5 })
  await $.command.run({ command: 'styx', args: 'reload', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(await nextStep()).toEqual(['  next: fix ~/.claude/styx.json (errors above), then run /styx reload'])
  expect(w.transcript.slice(0, 2)).toEqual(['styx · routing off: ~/.claude/styx.json has errors', '  providers: must be an object'])
  text = CONFIG
  await $.command.run({ command: 'styx', args: 'reload', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await model($, 'strong')
  await step($, { turnId: 'k', index: 0 })
  expect(await nextStep()).toEqual(['  next: acme key helper failed (exit 1): keychain locked, or no key stored? Run bun run auth login acme'])
  expect(w.transcript).toContain('  acme      openai  https://styx.invalid  cmd failed  yes')
})

test('/styx names the approval step when the provider is not approved', async ($, on) => {
  const w = world(on, { store: {} })
  await start($)
  await styx($)
  expect(w.transcript.at(-1)).toBe('  next: run /model fast once to approve acme')
})

test('/styx reload re-reads the config, re-registers the tool and drops the cached description', async ($, on) => {
  const w = world(on)
  await start($)
  await $.command.run({ command: 'styx', args: 'reload', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(w.registered.map(t => t.name)).toEqual(['agent', 'agent'])
  expect(w.registered[0]).toEqual(w.registered[1])
  expect(w.invalidated).toEqual(['tool.describe'])
})

test('a schema stamp from another engine version, and a malformed MCP schema file, are reported by /styx and toasted never', async ($, on) => {
  const w = world(on, { version: '2.1.300', mcpFile: '[1, 2]' })
  await start($)
  expect(w.toasts).toEqual([])
  await styx($)
  expect(w.transcript).toContain(`  schemas: generated on ${STAMP.engineVersion} · engine 2.1.300 · regenerate with bun scripts/gen-schemas.ts`)
  expect(w.transcript).toContain('  MCP schemas: hooks/schemas.mcp.gen.json is not a JSON object; MCP tools go out permissive')
  expect(w.transcript.at(-1)).toBe('  next: regenerate the tool schemas with bun scripts/gen-schemas.ts')
})

test('a managed policy allow-list that excludes the provider host is a config error', async ($, on) => {
  const w = world(on, { policy: { sandbox: { network: { allowedDomains: ['api.anthropic.com'] } } } })
  await start($)
  expect(w.registered).toEqual([])
  expect(w.toasts).toEqual([
    "styx: routing off, config error: providers.acme.baseUrl: styx.invalid is not in the managed policy's sandbox.network.allowedDomains. Fix ~/.claude/styx.json, then run /styx reload",
  ])
})

test('unreadable managed policy settings are a config error: no host goes unchecked', async ($, on) => {
  const w = world(on, { policy: 'fails' })
  await start($)
  expect(w.registered).toEqual([])
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/^styx: routing off, config error: the managed policy settings are unreadable \(.+\), so no provider host can be checked against them\. Fix ~\/\.claude\/styx\.json, then run \/styx reload$/)
})

test('a managed WebFetch deny with a wildcard domain covering the provider host is a config error', async ($, on) => {
  const w = world(on, { policy: { permissions: { deny: ['WebFetch(domain:*.invalid)'] } } })
  await start($)
  expect(w.registered).toEqual([])
  expect(w.toasts).toEqual(['styx: routing off, config error: providers.acme.baseUrl: the managed policy denies WebFetch to styx.invalid. Fix ~/.claude/styx.json, then run /styx reload'])
})

test('tool.describe puts the styx agent tool in front with its registered description and leaves Agent untouched', async ($, on) => {
  world(on)
  on('tool.describe', ($, e) => ({ description: `${e.description} (beneath)` }))
  expect(await $.tool.describe({ tool: 'mcp__styx__agent', description: 'advert', provider: { plugin: 'styx', tier: 'user' } })).toMatchObject({ description: 'advert', isDeferred: false })
  expect(await $.tool.describe({ tool: 'Agent', description: 'native', provider: { plugin: 'engine', tier: 'core' } })).toEqual({ description: 'native (beneath)' })
})

test('a custom CLAUDE_CONFIG_DIR is the path the routing-off messages name, and ~ stands for the home directory under it', async ($, on) => {
  const w = world(on, { env: { CLAUDE_CONFIG_DIR: '/cfg' }, config: JSON.stringify({ providers: 5 }) })
  await start($)
  expect(w.toasts).toEqual(['styx: routing off, config error: providers: must be an object. Fix /cfg/styx.json, then run /styx reload'])
  await styx($)
  expect(w.transcript.slice(0, 2)).toEqual(['styx · routing off: /cfg/styx.json has errors', '  providers: must be an object'])
  expect(w.transcript.at(-1)).toBe('  next: fix /cfg/styx.json (errors above), then run /styx reload')
})

test('a config directory under the home directory is shown with ~', async ($, on) => {
  const w = world(on, { env: { CLAUDE_CONFIG_DIR: '/home/u/work/claude' }, config: null })
  await start($)
  await styx($)
  expect(w.transcript[0]).toBe('styx · routing off: no ~/work/claude/styx.json')
})

test('with a custom config directory, /model on a known alias after the config breaks names that file', async ($, on) => {
  let text = CONFIG
  const w = world(on, { env: { CLAUDE_CONFIG_DIR: '/cfg' }, config: () => text })
  await start($)
  text = JSON.stringify({ providers: 5 })
  await $.command.run({ command: 'styx', args: 'reload', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(await model($, 'strong')).toEqual({ text: "can't switch to strong: config error, providers: must be an object. Native model unchanged; fix /cfg/styx.json, then run /styx reload" })
  expect(w.toasts.at(-1)).toContain('Fix /cfg/styx.json')
})
