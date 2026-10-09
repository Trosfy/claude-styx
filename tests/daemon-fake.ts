// styxd as the tests fake it beneath the engine: its process, which answers `ready <socket> <token>` and
// stays up until killed, and curl over its socket, whose calls run styxd's own step and status logic
// in-process. That logic runs key helpers through `helper` and sends its provider requests to `upstream`,
// which records them.
import type { ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'

import type { StepWire, Wire } from '../hooks/protocol'
import type { Cut } from '../styxd/errors'
import { createStepper } from '../styxd/step'
import type { Answer } from '../styxd/step'

// A provider request as styxd sends it, its body parsed.
export type Request = { url: string; headers: Record<string, string>; body: Record<string, unknown> }
// A provider's answer: its status (200 by default) and body pieces, then a cut of the body when `cut` names
// one, or (`hold`) no end until the request is cancelled; `refused` cuts the request before any answer.
export type Upstream = { status?: number; pieces?: string[]; cut?: Cut['kind']; hold?: boolean; refused?: Cut['kind'] }
export type DaemonOptions = {
  bun: string
  upstream(r: Request): Upstream
  helper(argv: string[]): { exitCode: number; stdout: string }
  log(text: string): void
  now: number
  styxd?: 'silent' | 'exits' // styxd never answers ready, or exits with a failure before it
  socketThrows?: string // curl over the socket fails after streaming what styxd wrote
}

const CUT_DETAIL: Readonly<Record<Cut['kind'], string>> = { connect: 'styx.invalid:443 ECONNREFUSED', 'connect-timeout': '', stall: '600', total: '1800', redirect: '302', reset: 'connection reset' }
const isSocketCall = (argv: readonly string[]) => argv[0] === '/usr/bin/curl' && argv.includes('--unix-socket')

export function fakeDaemon(o: DaemonOptions) {
  let live: { sock: string; token: string; stepper: ReturnType<typeof createStepper> } | undefined
  const d = {
    requests: [] as Request[], // the provider requests styxd sent
    wires: [] as Wire[], // what curl carried to styxd
    daemons: 0, // styxd processes started
    aborted: 0, // provider requests cancelled by their client going away
    // Ends the running styxd as a crash would; `socket` closes its socket alone, its process seen running.
    kill: (how?: 'socket') => void how,
    // A curl call of /status, answered as styxd would; undefined for any other command.
    run(argv: readonly string[], stdin: string | undefined): { exitCode: number; stdout: string; stderr: string } | undefined {
      if (!isSocketCall(argv)) return undefined
      const call = wire(stdin)
      if (!reaches(argv, call.token)) return { exitCode: 7, stdout: '', stderr: 'curl: (7) Failed to connect to styxd port 80\n' }
      return { exitCode: 0, stdout: JSON.stringify(live?.stepper.status(call)), stderr: '' }
    },
    // The stream of a spawn of styxd, or of curl over its socket; undefined for any other command.
    spawn(argv: readonly string[], input: string | undefined): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> | undefined {
      if (argv[0] === o.bun) return daemon()
      return isSocketCall(argv) ? call(argv, input) : undefined
    },
  }
  const wire = (input: string | undefined) => {
    const w = JSON.parse(input ?? '{}') as StepWire
    d.wires.push(w)
    return w
  }
  const reaches = (argv: readonly string[], token: string) => live !== undefined && argv[argv.indexOf('--unix-socket') + 1] === live.sock && token === live.token

  async function upstream(r: { url: string; headers: Record<string, string>; body: string }, signal: AbortSignal): Promise<Answer> {
    const req = { url: r.url, headers: r.headers, body: JSON.parse(r.body) as Record<string, unknown> }
    d.requests.push(req)
    const a = o.upstream(req)
    if (a.refused !== undefined) return { cut: { kind: a.refused, detail: CUT_DETAIL[a.refused] } }
    const cancelled = new Promise<void>(resolve => signal.addEventListener('abort', () => (d.aborted++, resolve()), { once: true }))
    const bytes = new TextEncoder()
    async function* body(): AsyncGenerator<Uint8Array, Cut | undefined> {
      for (const piece of a.pieces ?? []) yield bytes.encode(piece)
      if (a.hold === true) await cancelled
      return a.cut === undefined ? undefined : { kind: a.cut, detail: CUT_DETAIL[a.cut] }
    }
    return { status: a.status ?? 200, body: body(), cancel: () => {} }
  }

  async function* daemon(): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
    const n = ++d.daemons
    if (o.styxd === 'exits') return { code: 1, signal: null }
    let end: () => void = () => {}
    const killed = new Promise<void>(resolve => (end = resolve))
    if (o.styxd !== 'silent') {
      const run = async (argv: readonly string[]) => o.helper([...argv])
      live = { sock: `/tmp/styxd-${n}/d.sock`, token: `token-${n}`, stepper: createStepper({ post: upstream, run, now: () => o.now, log: o.log }) }
      d.kill = how => {
        live = undefined
        if (how !== 'socket') end()
      }
      yield { stream: 'stdout', text: `ready ${live.sock} ${live.token}\n` }
    }
    await killed
    return { code: 1, signal: null }
  }

  async function* call(argv: readonly string[], input: string | undefined): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
    const w = wire(input)
    if (live === undefined || !reaches(argv, w.token)) {
      yield { stream: 'stderr', text: 'curl: (7) Failed to connect to styxd port 80 after 0 ms: Could not connect to server\n' }
      return { code: 7, signal: null }
    }
    const ac = new AbortController()
    try {
      for await (const ev of live.stepper.step(w, ac.signal)) yield { stream: 'stdout', text: `${JSON.stringify(ev)}\n` }
      if (o.socketThrows !== undefined) throw new Error(o.socketThrows)
      return { code: 0, signal: null }
    } finally {
      ac.abort()
    }
  }

  return d
}
