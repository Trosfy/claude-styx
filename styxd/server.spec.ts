// styxd end to end, as the mod runs it: `bun styxd/main.ts` answers `ready <socket> <token>` from a fresh
// 0700 directory; a call without the token is refused and sends nothing; a step goes in on curl's stdin and
// comes back one event per line, its provider request carrying the key and exactly the mod's
// User-Agent; killing curl cancels the provider request; the in-flight cap answers an error; status runs
// nothing; and styxd exits, removing its directory, on SIGTERM and when its parent goes away.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { fingerprint, parseConfig } from '../hooks/config'
import type { Config, ProviderConfig } from '../hooks/config'
import type { StepEvent } from '../hooks/protocol'

const MAIN = join(import.meta.dir, 'main.ts')
const KEY = 'sk-styx-e2e-0123456789abcdef'
const UA = 'claude-code/2.1.292 (cli)'
const seen: { path: string; ua: string | null; auth: string | null }[] = []
let cancelled = 0
const enc = new TextEncoder()
// The provider, on the IPv6 loopback that styx.localhost resolves to.
const provider = Bun.serve({
  hostname: '::1',
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const body = (await req.json()) as { model: string }
    seen.push({ path: new URL(req.url).pathname, ua: req.headers.get('user-agent'), auth: req.headers.get('authorization') })
    req.signal.addEventListener('abort', () => void cancelled++)
    if (body.model === 'slow') await Bun.sleep(1500)
    const chunk = (delta: Record<string, unknown>, extra = {}) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, ...extra }] })}\n\n`
    return new Response(
      new ReadableStream({
        async start(c) {
          c.enqueue(enc.encode(chunk({ content: 'hello' })))
          if (body.model === 'held') return void (await new Promise(() => {}))
          c.enqueue(enc.encode(chunk({ content: ' world' }, { finish_reason: 'stop' }) + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`))
          c.close()
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  },
})
const CONFIG = JSON.stringify({
  providers: {
    loc: {
      kind: 'openai',
      baseUrl: `http://styx.localhost:${provider.port}/v1`,
      allowHttp: true,
      auth: { command: ['/bin/echo', KEY] },
      models: { m: { contextWindow: 10_000, maxOutputTokens: 100 }, held: { contextWindow: 10_000, maxOutputTokens: 100 }, slow: { contextWindow: 10_000, maxOutputTokens: 100 } },
    },
  },
})
const APPROVED = [fingerprint((parseConfig(CONFIG).config as Config).providers['loc'] as ProviderConfig)]

type Styxd = { proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>; sock: string; token: string; dir: string; stderr: () => Promise<string>; closed: () => Promise<void> }
const running: Styxd[] = []
afterAll(() => {
  for (const d of running) d.proc.kill()
  void provider.stop(true)
})

// Starts styxd (through `/bin/sh -c` when `orphan`, which exits at once and leaves styxd to launchd) and
// reads its ready line.
async function startStyxd(orphan = false): Promise<Styxd> {
  const argv = orphan ? ['/bin/sh', '-c', `"${process.execPath}" "${MAIN}" &`] : [process.execPath, MAIN]
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const reader = proc.stdout.getReader()
  let out = ''
  while (!out.includes('\n')) {
    const r = await reader.read()
    if (r.done) throw new Error(`styxd ended before ready: ${out}`)
    out += new TextDecoder().decode(r.value)
  }
  const [word, sock, token] = out.trim().split(' ') as [string, string, string]
  expect(word).toBe('ready')
  // Resolves when styxd's stdout closes: when it has exited.
  const closed = async () => {
    while (!(await reader.read()).done);
  }
  const d = { proc, sock, token, dir: sock.slice(0, sock.lastIndexOf('/')), stderr: () => new Response(proc.stderr).text(), closed }
  running.push(d)
  return d
}

const curl = (d: Styxd, call: string, body: unknown) =>
  Bun.spawn(['/usr/bin/curl', '-q', '-sS', '-N', '-w', '\n%{http_code}', '--unix-socket', d.sock, '--data-binary', '@-', `http://styxd/${call}`], {
    stdin: enc.encode(JSON.stringify(body)),
    stdout: 'pipe',
    stderr: 'pipe',
  })
async function call(d: Styxd, path: string, body: unknown): Promise<{ status: string; lines: string[] }> {
  const out = await new Response(curl(d, path, body).stdout).text()
  const lines = out.split('\n')
  return { status: lines.pop() ?? '', lines: lines.filter(l => l !== '') }
}
const stepBody = (d: Styxd, model = 'm') => ({
  token: d.token,
  configText: CONFIG,
  approved: APPROVED,
  userAgent: UA,
  req: { target: `loc/${model}`, system: 'SYS', tools: [], transcript: [{ role: 'user', content: 'hi' }], who: 'main' },
})

test('styxd answers ready from a fresh 0700 directory it owns, with a 0600 socket under 100 bytes of path', async () => {
  const d = await startStyxd()
  const dir = statSync(d.dir)
  expect([dir.mode & 0o777, dir.uid]).toEqual([0o700, process.getuid?.() ?? -1])
  expect(statSync(d.sock).mode & 0o777).toBe(0o600)
  expect(d.sock.length).toBeLessThanOrEqual(100)
  expect(d.token).toMatch(/^[0-9a-f]{64}$/)
})

test('a call without the token, or with another, is refused with 401 and sends nothing', async () => {
  const d = await startStyxd()
  const before = seen.length
  for (const token of [undefined, 'x'.repeat(64), d.token.slice(0, 63)]) {
    const r = await call(d, 'step', { ...stepBody(d), token })
    expect(r.status).toBe('401')
    expect(r.lines.map(l => (JSON.parse(l) as StepEvent).type)).toEqual(['error', 'stats'])
  }
  expect((await call(d, 'status', { configText: CONFIG, approved: APPROVED })).status).toBe('401')
  expect(seen.length).toBe(before)
})

test('a step streams one event per line; the provider gets the key and exactly the User-Agent the mod sent; the log line holds no key', async () => {
  const d = await startStyxd()
  const r = await call(d, 'step', stepBody(d))
  expect(r.status).toBe('200')
  const events = r.lines.map(l => JSON.parse(l) as StepEvent)
  expect(events.flatMap(e => (e.type === 'text' ? [e.text] : [])).join('')).toBe('hello world')
  expect(events.filter(e => e.type !== 'text').slice(0, 2)).toEqual([
    { type: 'usage', in: 7, out: 2, cacheRead: 0, cacheWrite: 0 },
    { type: 'stop', reason: 'end_turn' },
  ])
  expect(events.at(-1)).toMatchObject({ type: 'stats', in: 7, out: 2, finish: 'stop' })
  expect(seen.at(-1)).toEqual({ path: '/v1/chat/completions', ua: UA, auth: `Bearer ${KEY}` })
  expect(JSON.parse((await call(d, 'status', { token: d.token, configText: CONFIG, approved: APPROVED })).lines[0] ?? '[]')).toEqual([{ provider: 'loc', key: 'cached' }])
  d.proc.kill('SIGTERM')
  const log = await d.stderr()
  expect(log).toMatch(/^styx step main → loc\/m kind=openai http=200 effort=none msgs=1 tools=0 bytes=\d+ ttfb=\d+ total=\d+ in=7 out=2 cache=0 wrote=0 reasoning=- finish=stop\n$/)
  expect(log).not.toContain(KEY)
})

test('killing curl mid-step cancels the provider request', async () => {
  const d = await startStyxd()
  const before = cancelled
  const c = curl(d, 'step', stepBody(d, 'held'))
  const reader = c.stdout.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  expect(JSON.parse(first.split('\n')[0] ?? '')).toEqual({ type: 'text', text: 'hello' })
  c.kill()
  for (let i = 0; i < 100 && cancelled === before; i++) await Bun.sleep(20)
  expect(cancelled).toBe(before + 1)
})

test('a client that goes away before the provider answers leaves one aborted step line and no failure in the log', async () => {
  const d = await startStyxd()
  const c = curl(d, 'step', stepBody(d, 'slow'))
  await Bun.sleep(300)
  c.kill()
  await c.exited
  await Bun.sleep(2200)
  d.proc.kill('SIGTERM')
  const log = await d.stderr()
  expect(log).toMatch(/^styx step main → loc\/slow kind=openai http=- .* finish=aborted\n$/)
  expect(log).not.toMatch(/failed inside styxd|error=/)
})

test('past 16 steps in flight a step is answered with one error line and stats', async () => {
  const d = await startStyxd()
  const held = Array.from({ length: 16 }, () => curl(d, 'step', stepBody(d, 'held')))
  for (const c of held) await c.stdout.getReader().read()
  const r = await call(d, 'step', stepBody(d))
  expect(r.lines.map(l => JSON.parse(l) as StepEvent)).toEqual([
    { type: 'error', kind: 'request', text: 'styx: 16 routed steps are already in flight; retry when one ends' },
    { type: 'stats', ttfbMs: null, totalMs: 0, reqBytes: 0, in: null, out: null, finish: 'error' },
  ])
  for (const c of held) c.kill()
})

test('styxd exits on SIGTERM and when its parent goes away, removing its directory', async () => {
  const d = await startStyxd()
  d.proc.kill('SIGTERM')
  expect(await d.proc.exited).toBe(0)
  expect(existsSync(d.dir)).toBe(false)
  const orphan = await startStyxd(true)
  await Promise.race([orphan.closed(), Bun.sleep(8000)])
  expect(existsSync(orphan.dir)).toBe(false)
}, 15_000)
