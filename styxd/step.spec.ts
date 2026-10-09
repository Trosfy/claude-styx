// One step inside styxd over a faked transport: the steps it refuses before sending, the provider request
// (URL, headers, User-Agent, key), one 401/403 retry with a fresh key before any event, the failure texts,
// tool-call ids given back only to the provider that made them, the stats that end every step, and the one
// debug line, which never holds the key or a body.
import { expect, test } from 'bun:test'

import { fingerprint, parseConfig } from '../hooks/config'
import type { Config, ProviderConfig } from '../hooks/config'
import type { StepEvent, StepRequest, StepWire } from '../hooks/protocol'
import { CODECS } from './codecs'
import type { Cut } from './errors'
import { remoteIds } from './history'
import { assembler, createStepper } from './step'
import type { Answer, UpstreamRequest } from './step'

const KEY = 'sk-styx-test-0123456789abcdef'
const UA = 'claude-code/2.1.292 (cli)'
const helper = (name: string) => ['/usr/bin/security', 'find-generic-password', '-s', 'styx', '-a', name, '-w']
const MODEL = { contextWindow: 100_000, maxOutputTokens: 8000, effort: { low: { reasoning_effort: 'low' }, high: { reasoning_effort: 'high' } } }
const CONFIG = JSON.stringify({
  providers: {
    acme: { kind: 'openai', baseUrl: 'https://styx.invalid/v1', auth: { command: helper('acme') }, headers: { 'User-Agent': 'evil/1', 'X-Tag': 'styx' }, models: { m: MODEL } },
    other: { kind: 'openai', baseUrl: 'https://other.invalid/v1', auth: { command: helper('other') }, models: { m: MODEL } },
    claude: { kind: 'anthropic', baseUrl: 'https://claude.invalid', auth: { command: helper('claude') }, models: { m: MODEL } },
    free: { kind: 'openai', baseUrl: 'https://free.invalid/v1', auth: 'none', models: { m: MODEL } },
    freecl: { kind: 'anthropic', baseUrl: 'https://freecl.invalid', auth: 'none', models: { m: MODEL } },
  },
})
const providers = (parseConfig(CONFIG).config as Config).providers
const fp = (id: string) => fingerprint(providers[id] as ProviderConfig)
const REQ: StepRequest = { target: 'acme/m', system: 'SYS', tools: [], transcript: [{ role: 'user', content: 'hi' }], effort: 'high', who: 'main' }
const wire = (req: Partial<StepRequest> = {}, approved = [fp('acme'), fp('other'), fp('claude'), fp('free'), fp('freecl')], userAgent: string | undefined = UA): StepWire => ({
  token: 't',
  configText: CONFIG,
  approved,
  ...(userAgent === undefined ? {} : { userAgent }),
  req: { ...REQ, ...req },
})
const sse = (...events: unknown[]) => events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
const OK = sse({ choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }, '[DONE]')

type Reply = { status?: number; body?: string; cut?: Cut; before?: Cut }
// A stepper whose provider answers `replies` in turn (the last one again after), whose helper prints a key
// numbered by its run, and whose log and requests are recorded.
function fake(replies: Reply[] = [{}]) {
  const h = { posts: [] as UpstreamRequest[], runs: [] as string[][], logs: [] as string[], aborted: 0, cancelled: 0, onPost: undefined as (() => void) | undefined }
  const post = async (r: UpstreamRequest, signal: AbortSignal): Promise<Answer> => {
    const reply = replies[Math.min(h.posts.length, replies.length - 1)] as Reply
    h.posts.push(r)
    h.onPost?.()
    if (reply.before !== undefined) return { cut: reply.before }
    signal.addEventListener('abort', () => void h.aborted++)
    const bytes = new TextEncoder().encode(reply.body ?? OK)
    async function* body(): AsyncGenerator<Uint8Array, Cut | undefined> {
      for (let at = 0; at < bytes.length; at += 64) yield bytes.subarray(at, at + 64)
      return reply.cut
    }
    return { status: reply.status ?? 200, body: body(), cancel: () => void h.cancelled++ }
  }
  const run = async (argv: readonly string[]) => (h.runs.push([...argv]), { exitCode: 0, stdout: `${KEY}-${h.runs.length}\n` })
  return { h, s: createStepper({ post, run, now: () => 0, log: line => void h.logs.push(line) }) }
}
async function events(s: ReturnType<typeof createStepper>, w: StepWire = wire(), signal = new AbortController().signal) {
  const out: StepEvent[] = []
  for await (const ev of s.step(w, signal)) out.push(ev)
  return out
}
const errorOf = (evs: readonly StepEvent[]) => (evs.find(e => e.type === 'error') as { text: string } | undefined)?.text

test('the request goes to baseUrl with the codec path, the key as a bearer header, and the User-Agent exactly as the mod sent it', async () => {
  const { h, s } = fake()
  const evs = await events(s)
  expect(evs.map(e => e.type)).toEqual(['text', 'usage', 'stop', 'stats'])
  const r = h.posts[0] as UpstreamRequest
  expect(r.url).toBe('https://styx.invalid/v1/chat/completions')
  expect(r.headers).toEqual({ 'content-type': 'application/json', 'x-tag': 'styx', 'user-agent': UA, authorization: `Bearer ${KEY}-1` })
  expect(JSON.parse(r.body)).toMatchObject({ model: 'm', reasoning_effort: 'high', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }] })
  expect([r.stallS, r.totalS, r.allowHttp]).toEqual([600, 1800, false])
  const { h: bare, s: s2 } = fake()
  const { userAgent, ...unnamed } = wire()
  await events(s2, unnamed)
  expect(bare.posts[0]?.headers['user-agent']).toBe('claude-code')
  expect(JSON.stringify([...h.posts, ...bare.posts].map(p => p.headers))).not.toContain('Bun/')
})

test('a keyless step sends no authorization or x-api-key header and runs no helper, on the bearer and the x-api-key kinds alike', async () => {
  const { h, s } = fake()
  expect((await events(s, wire({ target: 'free/m' }))).map(e => e.type)).toEqual(['text', 'usage', 'stop', 'stats'])
  await events(s, wire({ target: 'freecl/m' }))
  expect(h.runs).toEqual([])
  expect(h.posts.map(p => p.url)).toEqual(['https://free.invalid/v1/chat/completions', 'https://freecl.invalid/v1/messages'])
  for (const p of h.posts) expect(Object.keys(p.headers).filter(k => /^(authorization|x-api-key)$/.test(k))).toEqual([])
  expect(h.posts[0]?.headers).toEqual({ 'content-type': 'application/json', 'user-agent': UA })
})

test('an unapproved keyless provider is refused before anything is sent, even when other providers are approved', async () => {
  const { h, s } = fake()
  const evs = await events(s, wire({ target: 'free/m' }, [fp('acme'), fp('freecl')]))
  expect(errorOf(evs)).toBe('styx: free not approved — run /model <alias> to approve it')
  expect([h.runs, h.posts]).toEqual([[], []])
})

test('a keyless provider answering 401 or 403 is not retried, runs no helper, and the line names the fix', async () => {
  for (const [status, text] of [
    [401, 'styx: free wants a key (HTTP 401) but auth is "none"; run bun run auth login free and set auth.command, then retry'],
    [403, 'styx: free HTTP 403: nope; ask the free admin for access; if it wants a key, run bun run auth login free and set auth.command (auth is "none")'],
  ] as const) {
    const { h, s } = fake([{ status, body: '{"error":{"message":"nope"}}' }])
    expect(errorOf(await events(s, wire({ target: 'free/m' })))).toBe(text)
    expect(errorOf(await events(s, wire({ target: 'free/m' })))).toBe(text)
    expect([h.runs.length, h.posts.length]).toEqual([0, 2])
  }
})

test('a step for an unconfigured target or an unapproved provider runs no helper and sends nothing', async () => {
  const { h, s } = fake()
  const refused = (text: string) => [
    { type: 'error', kind: 'request', text },
    { type: 'stats', ttfbMs: null, totalMs: expect.any(Number), reqBytes: 0, in: null, out: null, finish: 'error' },
  ]
  expect<unknown>(await events(s, wire({ target: 'acme/gone' }))).toEqual(refused('styx: acme/gone is not configured in this session; run /styx reload'))
  expect<unknown>(await events(s, wire({}, []))).toEqual(refused('styx: acme not approved — run /model <alias> to approve it'))
  expect<unknown>(await events(s, { ...wire(), configText: '{ broken' })).toEqual(refused('styx: acme/m is not configured in this session; run /styx reload'))
  expect([h.runs, h.posts]).toEqual([[], []])
})

test('a rejected cached key is fetched again and the request retried once, before any event; a fresh key rejected is not retried', async () => {
  for (const status of [401, 403]) {
    const { h, s } = fake([{}, { status, body: '{"error":{"message":"expired"}}' }, {}])
    await events(s)
    const evs = await events(s)
    expect(evs.map(e => e.type)).toEqual(['text', 'usage', 'stop', 'stats'])
    expect(h.runs).toHaveLength(2)
    expect(h.posts.map(p => p.headers['authorization'])).toEqual([`Bearer ${KEY}-1`, `Bearer ${KEY}-1`, `Bearer ${KEY}-2`])
  }
  const { h, s } = fake([{ status: 401, body: '{"error":{"message":"bad key"}}' }, {}])
  expect(errorOf(await events(s))).toBe('styx: acme rejected its key (HTTP 401); store a valid one with bun run auth login acme, then retry')
  expect([h.runs.length, h.posts.length]).toEqual([1, 1])
  await events(s)
  expect(h.runs).toHaveLength(2)
  const twice = fake([{}, { status: 401 }])
  await events(twice.s)
  expect(errorOf(await events(twice.s))).toMatch(/^styx: acme rejected its key \(HTTP 401\)/)
  expect([twice.h.runs.length, twice.h.posts.length]).toEqual([2, 3])
})

test('an HTTP error, a cut before any answer and a cut mid-stream each end the step with one request error and stats', async () => {
  const cases: [Reply, string][] = [
    [{ status: 502, body: '{"error":{"message":"bad gateway"}}' }, 'styx: acme HTTP 502: bad gateway; the provider failed: retry, or pick another model'],
    [{ before: { kind: 'connect-timeout', detail: '' } }, 'styx: acme could not connect within 15 s; check the network or VPN, then retry'],
    [{ before: { kind: 'redirect', detail: '301' } }, 'styx: acme answered with a redirect (HTTP 301), which styx does not follow; set providers.acme.baseUrl to the URL it redirects to'],
    [{ body: sse({ choices: [{ index: 0, delta: { content: 'par' } }] }), cut: { kind: 'stall', detail: '600' } }, 'styx: acme stalled (no data for 600 s); retry'],
  ]
  for (const [reply, text] of cases) {
    const { h, s } = fake([reply])
    const evs = await events(s)
    expect(evs.filter(e => e.type === 'error')).toEqual([{ type: 'error', kind: 'request', text }])
    expect(evs.at(-1)).toMatchObject({ type: 'stats', in: null, out: null, finish: 'error' })
    expect(h.logs.at(-1)).toContain(`finish=error error=${JSON.stringify(text)}`)
  }
})

test('a tool-call id goes back as the provider own id to that provider only; another provider gets the minted id', async () => {
  const call = sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'functions.Read:0', type: 'function', function: { name: 'Read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })
  const { h, s } = fake([{ body: call }, {}])
  const minted = ((await events(s)).find(e => e.type === 'tool_use') as { id: string }).id
  const transcript: StepRequest['transcript'] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: minted, name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: minted, content: 'x' }] },
  ]
  await events(s, wire({ transcript }))
  await events(s, wire({ target: 'other/m', transcript }))
  const ids = h.posts.slice(1).map(p => (JSON.parse(p.body) as { messages: { tool_calls?: { id: string }[] }[] }).messages[2]?.tool_calls?.[0]?.id)
  expect(ids).toEqual(['functions.Read:0', minted])
})

test('stats end every step; the one debug line per step holds no key and no body, and names an effort mapped to another level', async () => {
  const { h, s } = fake()
  const evs = await events(s, wire({ effort: 'max', transcript: [{ role: 'user', content: `secret prompt ${KEY}` }] }))
  expect(evs.at(-1)).toMatchObject({ type: 'stats', reqBytes: (new TextEncoder().encode(h.posts[0]?.body).length), in: 10, out: 2, finish: 'stop' })
  expect(h.logs).toEqual([expect.stringMatching(/^styx step main → acme\/m kind=openai http=200 effort=max→high msgs=1 tools=0 bytes=\d+ ttfb=\d+ total=\d+ in=10 out=2 cache=0 wrote=0 reasoning=- finish=stop$/)])
  expect(h.logs.join('\n')).not.toContain(KEY)
  expect(h.logs.join('\n')).not.toContain('secret prompt')
})

test('a step whose client goes away stops reading, cancels its request and yields nothing more', async () => {
  const { h, s } = fake([{ body: sse(...Array.from({ length: 40 }, () => ({ choices: [{ index: 0, delta: { content: 'word ' } }] }))) }])
  const ac = new AbortController()
  const seen: StepEvent[] = []
  for await (const ev of s.step(wire(), ac.signal)) {
    seen.push(ev)
    ac.abort()
  }
  expect(seen).toHaveLength(1)
  expect(h.aborted).toBe(1)
  expect(h.logs.at(-1)).toContain('finish=aborted')
})

test('the request a rejected cached key got is cancelled before the retry, and one whose client left before it answered is cancelled unread', async () => {
  const rejected = fake([{}, { status: 401, body: '{"error":{"message":"expired"}}' }, {}])
  await events(rejected.s)
  await events(rejected.s)
  expect(rejected.h.cancelled).toBe(1)
  const { h, s } = fake()
  const ac = new AbortController()
  h.onPost = () => ac.abort()
  expect(await events(s, wire(), ac.signal)).toEqual([])
  expect(h.cancelled).toBe(1)
  expect(h.logs.at(-1)).toContain('finish=aborted')
})

test('a request cut because the client went away is no failure: no error event, no error in the debug line', async () => {
  const { h, s } = fake([{ before: { kind: 'reset', detail: 'AbortError: The operation was aborted.' } }])
  const ac = new AbortController()
  h.onPost = () => ac.abort()
  expect(await events(s, wire(), ac.signal)).toEqual([])
  expect(h.logs).toEqual([expect.stringMatching(/finish=aborted$/)])
})

test('status reads each provider key state from the request approvals, running nothing', async () => {
  const { h, s } = fake()
  await events(s)
  expect(s.status(wire())).toEqual([
    { provider: 'acme', key: 'cached' },
    { provider: 'other', key: 'not-run' },
    { provider: 'claude', key: 'not-run' },
    { provider: 'free', key: 'none' },
    { provider: 'freecl', key: 'none' },
  ])
  expect(s.status(wire({}, []))).toEqual([
    { provider: 'acme', key: 'not-run' },
    { provider: 'other', key: 'not-run' },
    { provider: 'claude', key: 'not-run' },
    { provider: 'free', key: 'none' },
    { provider: 'freecl', key: 'none' },
  ])
  expect(h.runs).toHaveLength(1)
})

// A provider of the anthropic kind whose model thinks (a manual budget) and caches for five minutes.
const THINKING_CONFIG = JSON.stringify({
  providers: { cl: { kind: 'anthropic', baseUrl: 'https://cl.invalid', auth: { command: helper('cl') }, models: { m: { contextWindow: 100_000, maxOutputTokens: 8000, cache: '5m', params: { thinking: { type: 'enabled', budget_tokens: 2048 } } }, n: { contextWindow: 100_000, maxOutputTokens: 8000 } } } },
})
const CL = fingerprint(((parseConfig(THINKING_CONFIG).config as Config).providers['cl']) as ProviderConfig)
const thinkingWire = (req: Partial<StepRequest>): StepWire => ({ token: 't', configText: THINKING_CONFIG, approved: [CL], req: { ...REQ, target: 'cl/m', ...req } })
const THINKING_TURN = sse(
  { type: 'message_start', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 90 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'RED' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_remote', name: 'Read', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
)
const TEXT_TURN = sse(
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
)
const bodyOf = (r: UpstreamRequest | undefined) => JSON.parse(r?.body ?? '{}') as { thinking?: unknown; messages: { role: string; content: ({ type: string } & Record<string, unknown>)[] }[] }
const afterTool = (id: string): StepRequest['transcript'] => [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] },
]

test("a tool turn's signed thinking comes back first in its assistant turn on the next step, with the thinking param kept", async () => {
  const { h, s } = fake([{ body: THINKING_TURN }, { body: TEXT_TURN }])
  const first = await events(s, thinkingWire({ tools: [{ name: 'Read', description: 'r', schema: {} }] }))
  const id = (first.find(e => e.type === 'tool_use') as { id: string }).id
  expect(first.filter(e => e.type === 'thinking')).toEqual([{ type: 'thinking', text: 'hmm' }])
  expect(first.find(e => e.type === 'stats')).toMatchObject({ in: 100, out: 7, finish: 'tool_use' })
  expect(first.find(e => e.type === 'usage')).toMatchObject({ in: 10, cacheRead: 0, cacheWrite: 90 })
  await events(s, thinkingWire({ transcript: afterTool(id) }))
  const sent = bodyOf(h.posts[1])
  expect(sent.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 })
  expect(sent.messages[1]?.content).toEqual([
    { type: 'thinking', thinking: 'hmm', signature: 'SIG' },
    { type: 'redacted_thinking', data: 'RED' },
    { type: 'tool_use', id: 'toolu_remote', name: 'Read', input: {} },
  ])
  expect(h.logs[0]).toContain(' thinking=2')
  expect(h.logs[1]).not.toContain('note=')
})

test('a tool turn whose thinking styxd no longer holds (a restart, or another model wrote it) goes out without the thinking param, with one note in the debug line, and the step still runs', async () => {
  const id = 'toolu_styx_gone'
  const restarted = fake([{ body: TEXT_TURN }])
  expect((await events(restarted.s, thinkingWire({ transcript: afterTool(id) }))).map(e => e.type)).toEqual(['text', 'usage', 'stop', 'stats'])
  const sent = bodyOf(restarted.h.posts[0])
  expect('thinking' in sent).toBe(false)
  expect(sent.messages[1]?.content.map(b => b.type)).toEqual(['tool_use'])
  expect(restarted.h.logs).toEqual([expect.stringContaining('note="thinking param left out: the signed blocks of this tool turn are not held"')])
  // The thinking of model m is not given to model n of the same provider.
  const { h, s } = fake([{ body: THINKING_TURN }, { body: TEXT_TURN }])
  const minted = ((await events(s, thinkingWire({}))).find(e => e.type === 'tool_use') as { id: string }).id
  await events(s, thinkingWire({ target: 'cl/n', transcript: afterTool(minted) }))
  expect(bodyOf(h.posts[1]).messages[1]?.content.map(b => b.type)).toEqual(['tool_use'])
  // A turn after the tool turn is not one in progress: its thinking is not asked for.
  const later = [...afterTool(id), { role: 'assistant' as const, content: 'done' }, { role: 'user' as const, content: 'again' }]
  const next = fake([{ body: TEXT_TURN }])
  await events(next.s, thinkingWire({ transcript: later }))
  expect(bodyOf(next.h.posts[0]).thinking).toEqual({ type: 'enabled', budget_tokens: 2048 })
  expect(next.h.logs[0]).not.toContain('note=')
})

test('a turn that called a tool without thinking is not a lost turn: the next step keeps the thinking param', async () => {
  const calls = THINKING_TURN.replace(/data: \{"type":"content_block_start","index":[01],.*?\n\n/gs, '').replace(/data: \{"type":"content_block_(delta|stop)","index":[01],.*?\n\n/gs, '')
  const { h, s } = fake([{ body: calls }, { body: TEXT_TURN }])
  const first = await events(s, thinkingWire({}))
  expect(first.map(e => e.type)).toContain('tool_use')
  await events(s, thinkingWire({ transcript: afterTool((first.find(e => e.type === 'tool_use') as { id: string }).id) }))
  expect(bodyOf(h.posts[1]).thinking).toEqual({ type: 'enabled', budget_tokens: 2048 })
  expect(bodyOf(h.posts[1]).messages[1]?.content.map(b => b.type)).toEqual(['tool_use'])
  expect(h.logs.join('\n')).not.toMatch(/note=| thinking=/)
})

const thinkingBlock = (index: number, text: string, signature: string) => [
  { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: text } },
  { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } },
  { type: 'content_block_stop', index },
]

test('thinking interleaved with text and a call, [T1, A, T2, B], is sent back in that order on the next step', async () => {
  const turn = sse(
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    ...thinkingBlock(0, 'one', 'S1'),
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'A' } },
    { type: 'content_block_stop', index: 1 },
    ...thinkingBlock(2, 'two', 'S2'),
    { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_remote', name: 'Read', input: {} } },
    { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 3 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
  )
  const { h, s } = fake([{ body: turn }, { body: TEXT_TURN }])
  const first = await events(s, thinkingWire({ tools: [{ name: 'Read', description: 'r', schema: {} }] }))
  const id = (first.find(e => e.type === 'tool_use') as { id: string }).id
  const transcript: StepRequest['transcript'] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'text', text: 'A' }, { type: 'tool_use', id, name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }] },
  ]
  await events(s, thinkingWire({ transcript }))
  expect(bodyOf(h.posts[1]).messages[1]?.content).toEqual([
    { type: 'thinking', thinking: 'one', signature: 'S1' },
    { type: 'text', text: 'A' },
    { type: 'thinking', thinking: 'two', signature: 'S2' },
    { type: 'tool_use', id: 'toolu_remote', name: 'Read', input: {} },
  ])
})

test('the debug line counts thinking blocks only when they are kept: not for a turn with no calls, nor for a step that failed', async () => {
  const think = [{ type: 'message_start', message: { usage: { input_tokens: 10 } } }, ...thinkingBlock(0, 'hm', 'S')]
  const answered = fake([{ body: sse(...think, { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } }, { type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }) }])
  expect((await events(answered.s, thinkingWire({}))).map(e => e.type)).toContain('stop')
  expect(answered.h.logs[0]).not.toContain('thinking=')
  const cut = fake([{ body: sse(...think, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_remote', name: 'Read', input: {} } }) }])
  expect(errorOf(await events(cut.s, thinkingWire({})))).toContain('the stream ended inside a tool call')
  expect(cut.h.logs[0]).not.toContain('thinking=')
})

test('a finish reason carrying a newline and a forged step line is one debug line, with the placeholder token in the line and the stats', async () => {
  const forged = 'stop\nstyx step main → acme/m kind=openai http=200 finish=stop'
  const { h, s } = fake([{ body: sse({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: forged }] }, '[DONE]') }])
  const evs = await events(s)
  expect(evs.at(-1)).toMatchObject({ type: 'stats', finish: 'other' })
  expect(evs.find(e => e.type === 'stop')).toEqual({ type: 'stop', reason: 'end_turn' })
  expect(h.logs.join('\n').split('\n')).toEqual([expect.stringMatching(/ finish=other note="finish_reason \\"other\\" read as end_turn"$/)])
})

test('a finish reason is read as a lowercase token of at most 64 characters, any other text as other; every known one still maps to its stop', () => {
  for (const [kind, codec] of Object.entries(CODECS)) {
    const end = (reason: string) => {
      const asm = assembler(codec, 'p', remoteIds())
      asm.feed([{ t: 'finish', reason }])
      return asm.end(providers['acme'] as ProviderConfig)
    }
    for (const [reason, stop] of Object.entries(codec.stops)) expect(end(reason), `${kind} ${reason}`).toEqual({ events: [{ type: 'stop', reason: stop }], finish: reason })
    expect(end('Tool_Use').finish).toBe('tool_use')
    expect(end('a'.repeat(64)).finish).toBe('a'.repeat(64))
    for (const hostile of ['', 'a'.repeat(65), 'a b', 'stop\nstyx step forged', 'stop\r', 'stop\u2028x', 'tool\u0000use', 'stöp', '\u001b[31mred', 'x'.repeat(1 << 20)]) {
      expect(end(hostile), `${kind} ${JSON.stringify(hostile.slice(0, 20))}`).toMatchObject({ events: [{ type: 'stop', reason: 'end_turn' }], finish: 'other' })
    }
  }
})

test('an in-stream error of a megabyte of whitespace ends the step at once with one response error on one line', async () => {
  const { h, s } = fake([{ body: sse({ error: { message: ' '.repeat(1 << 20) } }) }])
  const started = performance.now()
  const evs = await events(s)
  expect(performance.now() - started).toBeLessThan(2000)
  const text = errorOf(evs) as string
  expect(text).toMatch(/^styx: acme response failed: .*; retry, or see the debug log$/)
  expect(text.length).toBeLessThan(500)
  expect(h.logs.join('\n').split('\n')).toHaveLength(1)
})

// A provider that keeps sending valid data (2000 more chunks) after `opening`, counting those read past it
// and the requests cancelled.
function endless(opening: string[]) {
  const h = { after: 0, cancelled: 0 }
  const more = sse({ choices: [{ index: 0, delta: { content: 'x' } }] })
  const post = async (): Promise<Answer> => {
    async function* body(): AsyncGenerator<Uint8Array, Cut | undefined> {
      for (const piece of opening) yield new TextEncoder().encode(piece)
      for (let i = 0; i < 2000; i++) {
        h.after++
        yield new TextEncoder().encode(more)
      }
      return undefined
    }
    return { status: 200, body: body(), cancel: () => void h.cancelled++ }
  }
  return { h, s: createStepper({ post, run: async () => ({ exitCode: 0, stdout: '' }), now: () => 0, log: () => {} }) }
}

for (const [why, opening, said] of [
  ['an in-stream error', [sse({ error: { message: 'boom' } })], 'boom'],
  ['a line over 16 MiB', ['data: ', ...Array<string>(17).fill('a'.repeat(1 << 20))], 'a line over 16 MiB'],
  ['a tool call whose arguments are not an object', [sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'Read', arguments: '[1]' } }] }, finish_reason: 'tool_calls' }] })], 'not a JSON object'],
] as const) {
  test(`after ${why} the step cancels the request and reads none of the rest of the body, and ends with its one error`, async () => {
    const { h, s } = endless([...opening])
    const evs = await events(s, wire({ target: 'free/m' }))
    expect(h.after).toBe(0)
    expect(h.cancelled).toBe(1)
    expect(evs.map(e => e.type)).toEqual(['error', 'stats'])
    expect(errorOf(evs)).toContain(said)
    expect(evs.at(-1)).toMatchObject({ type: 'stats', finish: 'error' })
  })
}

test('the U+2028, U+2029 and bidirectional control characters of a provider text are escaped in the debug line, so it stays one line in order', async () => {
  const tricky = 'a\u2028b\u2029c\u202ed\u202ce\u2066f\u2069g'
  const { h, s } = fake([{ body: sse({ error: { message: tricky } }) }])
  expect(errorOf(await events(s))).toContain('a\u2028b')
  const line = h.logs.join('\n')
  expect(line).toContain('error="styx: acme response failed: a\\u2028b\\u2029c\\u202ed\\u202ce\\u2066f\\u2069g;')
  expect(line).not.toMatch(/[\u2028\u2029\u202a-\u202e\u2066-\u2069]/)
  expect(line.split('\n')).toHaveLength(1)
})
