// styx's key store: `bun run auth login|logout <provider> [--write-config] | list [provider]` in the repo (package.json
// maps `auth` to this file). login reads the key from stdin (a hidden prompt on a terminal), never argv, stores it in
// the macOS Keychain (service styx, account <provider>) or with secret-tool, reads it back, and prints the auth.command
// line for styx.json (--write-config writes it); with no keyring it prints that line for `pass` and `op read`, and
// exits 1. list never prints a key.
import { readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { isUsableKey } from '../styxd/auth'

// Runs a command with `input` on its stdin, no shell; one that cannot start answers exit code 127.
export type Run = (argv: readonly string[], input?: string) => Promise<{ exitCode: number; stdout: string }>
export type Io = { platform: string; which(name: string): string | undefined; run: Run; readKey(): Promise<string>; configPath: string; out(line: string): void; err(line: string): void }
// A keyring as its commands: `find` exits 0 when an item exists, `read` prints the key (the auth.command), `add` stores
// a key from stdin (undefined when it cannot be passed safely), `del` removes the item.
type Store = { name: string; find(p: string): string[]; read(p: string): string[]; add(p: string, key: string): { argv: string[]; input: string } | undefined; del(p: string): string[] }

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/ // config.ts's provider ids
const SECURITY = '/usr/bin/security'
const item = (p: string) => [SECURITY, 'find-generic-password', '-s', 'styx', '-a', p]
// `security -i` splits a line on spaces, reads `"` as quoting and `\` as an escape: a key holding either is
// refused, and every other character stays literal inside the double quotes.
const keychain: Store = {
  name: 'macOS Keychain',
  find: item,
  read: p => [...item(p), '-w'],
  add: (p, key) => (/["\\]/.test(key) ? undefined : { argv: [SECURITY, '-i'], input: `add-generic-password -U -s styx -a "${p}" -l "styx ${p}" -w "${key}"\n` }),
  del: p => [SECURITY, 'delete-generic-password', '-s', 'styx', '-a', p],
}
const secretTool = (bin: string): Store => {
  const look = (p: string) => [bin, 'lookup', 'service', 'styx', 'provider', p]
  return { name: 'secret-tool', find: look, read: look, add: (p, key) => ({ argv: [bin, 'store', `--label=styx ${p}`, 'service', 'styx', 'provider', p], input: key }), del: p => [bin, 'clear', 'service', 'styx', 'provider', p] }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const line = (command: readonly string[]) => `  "auth": { "command": ${JSON.stringify(command)} }`
const providersOf = (config: Record<string, unknown>): Record<string, unknown> => (isObject(config['providers']) ? config['providers'] : {})

// The config file as an object; {} when it is missing or not JSON.
function readConfig(path: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isObject(raw) ? raw : {}
  } catch {
    return {}
  }
}

// Rewrites providers.<id>.auth as `command` (and the ttlSeconds it had), dropping a retired apiKeyEnv; the
// file is replaced through a symlink and keeps its mode.
function writeAuth(path: string, config: Record<string, unknown>, id: string, command: readonly string[]): string {
  const { apiKeyEnv: _retired, auth, ...rest } = providersOf(config)[id] as Record<string, unknown>
  const ttlSeconds = isObject(auth) ? auth['ttlSeconds'] : undefined
  const next = { ...config, providers: { ...providersOf(config), [id]: { ...rest, auth: { command, ...(ttlSeconds === undefined ? {} : { ttlSeconds }) } } } }
  const target = realpathSync(path)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: statSync(target).mode & 0o777 })
  renameSync(tmp, target)
  return target
}

export async function cli(args: readonly string[], io: Io): Promise<number> {
  const [cmd, p, ...extra] = args.filter(a => !a.startsWith('--'))
  const write = args.includes('--write-config')
  // Nothing typed is echoed: an argument given by mistake could be a key.
  const usage = (why: string) => (io.err(`styx auth: ${why}\nusage: bun run auth login|logout <provider> [--write-config] | list [provider]  (run it in the claude-styx folder; the key comes from stdin, never argv)`), 2)
  if (extra.length > 0 || args.some(a => a.startsWith('--') && a !== '--write-config')) return usage('unexpected arguments')
  if (cmd !== 'login' && cmd !== 'logout' && cmd !== 'list') return usage('expected login, logout or list')
  if (write && cmd !== 'login') return usage('--write-config belongs to login')
  if (p === undefined ? cmd !== 'list' : !ID_RE.test(p)) return usage('a provider id is lowercase letters, digits and dashes')

  const tool = io.platform === 'linux' ? io.which('secret-tool') : undefined
  const store = io.platform === 'darwin' ? keychain : tool === undefined ? undefined : secretTool(tool)
  if (store === undefined) {
    io.err(`styx auth: no keyring here (no macOS Keychain, no secret-tool)${cmd === 'login' ? `; keep the key in your own tool and set, under providers.${p} in ${io.configPath}:` : `; nothing to ${cmd}`}`)
    if (cmd === 'login') for (const argv of [[io.which('pass') ?? '/usr/bin/pass', 'show', `styx/${p}`], [io.which('op') ?? '/usr/local/bin/op', 'read', `op://Private/styx ${p}/credential`]]) io.out(line(argv))
    return 1
  }
  const config = readConfig(io.configPath)
  if (cmd === 'list') {
    const names = p === undefined ? Object.keys(providersOf(config)) : [p]
    if (names.length === 0) return io.err(`styx auth: no providers in ${io.configPath}; name one: list <provider>`), 1
    for (const n of names) io.out(`${n}: ${(await io.run(store.find(n))).exitCode === 0 ? 'item' : 'no item'} in the ${store.name}`)
    return 0
  }
  const id = p as string
  if (cmd === 'logout') {
    const gone = (await io.run(store.del(id))).exitCode === 0
    io.out(gone ? `${id}: item removed from the ${store.name}; auth.command in ${io.configPath} is unchanged` : `${id}: no item in the ${store.name}`)
    return gone ? 0 : 1
  }

  // login: the config is checked before anything is stored, so a failure leaves nothing half done.
  if (write && !isObject(providersOf(config)[id])) return io.err(`styx auth: providers.${id} is not in ${io.configPath} (or the file is missing or not JSON); copy example.styx.json there and add it first`), 1
  const key = (await io.readKey()).trim()
  if (!isUsableKey(key)) return io.err('styx auth: the key must be 1 to 4096 visible ASCII characters with no spaces; nothing stored'), 1
  const add = store.add(id, key)
  if (add === undefined) return io.err(`styx auth: a key holding " or \\ would be misread by security -i; store it with "${SECURITY} add-generic-password -U -s styx -a ${id} -w" (it prompts); nothing stored`), 1
  const added = await io.run(add.argv, add.input)
  if (added.exitCode !== 0) return io.err(`styx auth: the ${store.name} refused the key (exit ${added.exitCode}); unlock it, then retry`), 1
  const back = await io.run(store.read(id))
  if (back.exitCode !== 0 || back.stdout.trim() !== key) return io.err(`styx auth: stored, but reading ${id} back did not give the same key (exit ${back.exitCode}); run logout ${id}, then login again`), 1
  io.out(`${id}: key stored in the ${store.name} (service styx, account ${id}) and read back intact`)
  if (!write) return io.out(`set, under providers.${id} in ${io.configPath} (or rerun with --write-config):\n${line(store.read(id))}`), 0
  io.out(`wrote providers.${id}.auth.command to ${writeAuth(io.configPath, config, id, store.read(id))}`)
  return 0
}

// The key from stdin; on a terminal, one line typed with echo off.
export async function readKey(): Promise<string> {
  if (!process.stdin.isTTY) return await Bun.stdin.text()
  const echo = (on: boolean) => Bun.spawnSync(['/bin/stty', on ? 'echo' : '-echo'], { stdin: 'inherit' })
  process.once('SIGINT', () => (echo(true), process.exit(130)))
  process.stderr.write('Key (hidden): ')
  echo(false)
  try {
    for await (const typed of console) return typed
    return ''
  } finally {
    echo(true)
    process.stderr.write('\n')
  }
}

export const run: Run = async (argv, input) => {
  try {
    const child = Bun.spawn([...argv], { stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input), stdout: 'pipe', stderr: 'ignore' })
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return { exitCode, stdout }
  } catch {
    return { exitCode: 127, stdout: '' }
  }
}

if (import.meta.main) {
  const configPath = join(process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude'), 'styx.json')
  process.exit(await cli(process.argv.slice(2), { platform: process.platform, which: n => Bun.which(n) ?? undefined, run, readKey, configPath, out: console.log, err: console.error }))
}
