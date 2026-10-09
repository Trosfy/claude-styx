// One routed step inside styxd: the target resolved from the config the request carries, the key (whose
// approval check this is), the request encoded by its kind's codec, the answer decoded into StepEvents (a
// tool call only whole and parsed), and one debug line. Pure over a port: main.ts owns the transport.
import { isObject, own, parseConfig } from '../hooks/config'
import type { Config, ProviderConfig } from '../hooks/config'
import { resolve } from '../hooks/names'
import { mintToolId } from '../hooks/protocol'
import type { ProviderStatus, StepEvent, StepWire, Usage, Wire } from '../hooks/protocol'
import { coalesce } from '../hooks/step'
import { createKeys } from './auth'
import type { Runner } from './auth'
import { parseJson } from './codec'
import type { Codec, Decoded } from './codec'
import { CODECS } from './codecs'
import { cutText, ERROR_TEXT_MAX, errorDetail, httpErrorText, logJson, oneLine } from './errors'
import type { Cut } from './errors'
import { normalize, remoteIds, thinkingStore } from './history'
import type { Placed } from './history'

// A provider request as the transport sends it: the stall window and the whole-request bound in seconds.
export type UpstreamRequest = { url: string; allowHttp: boolean; headers: Record<string, string>; body: string; stallS: number; totalS: number }
// The provider's answer: its status, its body's bytes as they come (ending with how the body was cut,
// undefined when it ended), and `cancel`, which ends the request whether or not the body was read; or how
// the request was cut before any answer.
type Reply = { status: number; body: AsyncGenerator<Uint8Array, Cut | undefined>; cancel(): void }
export type Answer = Reply | { cut: Cut }
export type Env = {
  post(r: UpstreamRequest, signal: AbortSignal): Promise<Answer>
  run: Runner
  now(): number
  log(line: string): void
}

const DEFAULT_TOTAL_S = 1800
// A finish reason as the short lowercase token the debug line, the stats and /styx may show; any other text reads as `other`.
const finishToken = (reason: string) => reason.toLowerCase().match(/^[a-z0-9_.-]{1,64}$/)?.[0] ?? 'other'

// Decoded events as StepEvents: a tool call gets a minted id (its own id remembered for `provider`) once its
// input parses as an object. The first error ends the reading (`failed`); `end` gives the usage and one stop, or
// one error, and the finish reason as a token; `turn` gives the calls minted and the thinking blocks read, each
// with the number of text blocks (a run of text deltas is one, as the mod builds them) and calls before it.
export function assembler(codec: Codec, provider: string, ids: ReturnType<typeof remoteIds>, mint = mintToolId) {
  let failure: string | undefined
  let finish: string | undefined
  let usage: Usage | undefined
  let before = 0
  let inText = false
  const turn = { calls: [] as string[], blocks: [] as Placed[] }
  return {
    feed(ds: readonly Decoded[]): StepEvent[] {
      const out: StepEvent[] = []
      for (const d of ds) {
        if (failure !== undefined) break
        if (d.t === 'text' || d.t === 'thinking') {
          if (d.t === 'text' && !inText) before++
          inText = d.t === 'text'
          out.push({ type: d.t, text: d.text })
        } else if (d.t === 'sealed') turn.blocks.push({ at: before, block: d.block })
        else if (d.t === 'usage') usage = { in: d.in, out: d.out, cacheRead: d.cacheRead, cacheWrite: d.cacheWrite, ...(d.reasoning === undefined ? {} : { reasoning: d.reasoning }) }
        else if (d.t === 'finish') finish = finishToken(d.reason)
        else if (d.t === 'error') failure = d.message
        else {
          const input = typeof d.args === 'string' ? parseJson(d.args.trim() === '' ? '{}' : d.args) : d.args
          if (d.name === '') failure = 'a tool call arrived with no name'
          else if (!isObject(input)) failure = `the ${d.name} call's arguments are not a JSON object`
          else {
            const id = mint()
            if (d.id !== undefined) ids.remember(provider, id, d.id)
            turn.calls.push(id)
            before++
            inText = false
            out.push({ type: 'tool_use', id, name: d.name, input })
          }
        }
      }
      return out
    },
    // `cut` is the transport's failure text, when the response was cut short.
    end(p: ProviderConfig, cut?: string): { events: StepEvent[]; finish: string; note?: string } {
      if (cut !== undefined) return { events: [{ type: 'error', kind: 'request', text: cut }], finish: 'error' }
      if (failure !== undefined) {
        const text = `styx: ${p.id} response failed: ${oneLine(errorDetail(failure).message, 300)}; retry, or see the debug log`
        return { events: [{ type: 'error', kind: 'response', text }], finish: 'error' }
      }
      const reason = own(codec.stops, finish ?? 'stop')
      const events: StepEvent[] = [...(usage === undefined ? [] : [{ type: 'usage' as const, ...usage }]), { type: 'stop', reason: reason ?? 'end_turn' }]
      return { events, finish: finish ?? 'none', ...(reason === undefined ? { note: `finish_reason "${finish}" read as end_turn` } : {}) }
    },
    failed: () => failure !== undefined,
    usage: () => usage,
    turn: () => turn,
  }
}

// The provider's error body, its first 4 KiB, as text; the request ends with it.
async function errorBody({ body, cancel }: Reply): Promise<string> {
  let text = ''
  for await (const piece of body) if ((text += new TextDecoder().decode(piece)).length >= ERROR_TEXT_MAX) break
  cancel()
  return text.slice(0, ERROR_TEXT_MAX)
}

export function createStepper(env: Env) {
  const keys = createKeys(env.run, env.now)
  const ids = remoteIds()
  const thinking = thinkingStore()
  let memo: { text: string; config: Config | undefined } | undefined
  const configOf = (text: string) => (memo?.text === text ? memo : (memo = { text, config: parseConfig(text).config })).config

  async function* step(w: StepWire, signal: AbortSignal): AsyncGenerator<StepEvent, void> {
    const req = w.req
    const started = performance.now()
    let ttfbMs: number | null = null
    let reqBytes = 0
    let http = '-'
    let effort = '-'
    let notes = ''
    const config = configOf(w.configText)
    const t = config === undefined ? undefined : resolve(config, req.target)
    // The step's events end with one stop or error and the stats; the debug line goes out with the stats.
    const close = (events: StepEvent[], finish: string, u?: Usage, extra = ''): StepEvent[] => {
      const st: StepEvent = {
        type: 'stats',
        ttfbMs,
        totalMs: Math.round(performance.now() - started),
        reqBytes,
        in: u === undefined ? null : u.in + u.cacheRead + u.cacheWrite,
        out: u?.out ?? null,
        ...(u?.reasoning === undefined ? {} : { reasoning: u.reasoning }),
        finish,
      }
      const error = events.find(e => e.type === 'error')
      env.log(
        `styx step ${req.who} → ${t?.kind === 'remote' ? t.target : req.target} kind=${t?.kind === 'remote' ? t.provider.kind : '-'} http=${http} effort=${effort} msgs=${req.transcript.length} tools=${req.tools.length} bytes=${reqBytes} ttfb=${ttfbMs ?? '-'} total=${st.totalMs} in=${st.in ?? '-'} out=${st.out ?? '-'} cache=${u?.cacheRead ?? '-'} wrote=${u?.cacheWrite ?? '-'} reasoning=${u?.reasoning ?? '-'} finish=${finish}${notes}${extra}${error?.type === 'error' ? ` error=${logJson(error.text)}` : ''}`,
      )
      return [...events, st]
    }
    const refuse = (text: string) => close([{ type: 'error', kind: 'request', text }], 'error')
    if (t?.kind !== 'remote') return yield* refuse(`styx: ${req.target} is not configured in this session; run /styx reload`)
    const { provider: p, model: m } = t
    const owner = `${p.id}/${m.id}`
    const approved = new Set(w.approved)
    keys.prune(approved)
    const codec = CODECS[p.kind]
    let key = await keys.get(p, approved)
    if ('error' in key) return yield* refuse(key.error)
    const enc = codec.encode({ system: req.system, messages: normalize(req.transcript, m.vision, ids.of(p.id), thinking.sealed(owner)), tools: req.tools, ...(req.effort === undefined ? {} : { effort: req.effort }) }, p, m)
    // The applied level, after the one asked for when the model declares another nearest it.
    effort = typeof req.effort === 'string' && enc.effort !== req.effort && enc.effort !== 'none' ? `${req.effort}→${enc.effort}` : enc.effort
    reqBytes = new TextEncoder().encode(enc.body).length
    if (enc.lost) notes = ' note="thinking param left out: the signed blocks of this tool turn are not held"'
    const configured = Object.fromEntries(Object.entries({ ...p.headers, ...m.headers }).map(([k, v]) => [k.toLowerCase(), v]))
    const headers = { 'content-type': 'application/json', ...enc.headers, ...configured, 'user-agent': w.userAgent ?? 'claude-code' }
    const stallS = Math.max(1, Math.floor(Math.min(600, (p.timeoutMs ?? 600_000) / 1000)))
    const totalS = p.timeoutMs === undefined ? DEFAULT_TOTAL_S : Math.ceil(p.timeoutMs / 1000)
    const post = (k: string | null) => env.post({ url: `${p.baseUrl}${enc.path}`, allowHttp: p.allowHttp, headers: { ...headers, ...(k === null ? {} : p.authHeader === 'x-api-key' ? { 'x-api-key': k } : { authorization: `Bearer ${k}` }) }, body: enc.body, stallS, totalS }, signal)
    let answer = await post(key.key)
    // A rejected key is fetched again; a cached one is retried once at once, before any event.
    for (let retried = false; 'status' in answer && (answer.status === 401 || answer.status === 403); retried = true) {
      keys.drop(p)
      if (retried || !key.cached) break
      answer.cancel()
      key = await keys.get(p, approved)
      if ('error' in key) return yield* refuse(key.error)
      answer = await post(key.key)
    }
    // A cut made by the client going away is no failure.
    if ('cut' in answer) return signal.aborted ? void close([], 'aborted') : yield* refuse(cutText(p, answer.cut))
    http = String(answer.status)
    if (answer.status < 200 || answer.status > 299) return yield* refuse(httpErrorText(p, answer.status, await errorBody(answer), m.id))
    const decoder = codec.decoder()
    const asm = assembler(codec, p.id, ids)
    let cut: Cut | undefined
    while (!signal.aborted && !asm.failed()) {
      const piece = await answer.body.next()
      if (piece.done) {
        cut = piece.value
        break
      }
      ttfbMs ??= Math.round(performance.now() - started)
      yield* coalesce(asm.feed(decoder.feed(piece.value)))
    }
    if (asm.failed() || signal.aborted) answer.cancel()
    if (signal.aborted) return void close([], 'aborted')
    const tail = cut === undefined ? asm.feed(decoder.end()) : []
    const end = asm.end(p, cut === undefined ? undefined : cutText(p, cut))
    // The thinking blocks of a turn that made calls are kept for its next step.
    const { calls, blocks } = asm.turn()
    if (end.finish !== 'error' && calls.length > 0) {
      thinking.seal(owner, calls, blocks)
      if (blocks.length > 0) notes += ` thinking=${blocks.length}`
    }
    yield* coalesce(tail)
    yield* close(end.events, end.finish, end.finish === 'error' ? undefined : asm.usage(), end.note === undefined ? '' : ` note=${logJson(end.note)}`)
  }

  // Each provider's key state, after forgetting those no longer approved; runs nothing.
  function status(w: Wire): ProviderStatus[] {
    keys.prune(new Set(w.approved))
    return keys.status(configOf(w.configText))
  }

  return { step, status, config: configOf }
}
