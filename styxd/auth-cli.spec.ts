// scripts/auth.ts, the key store CLI, over a fake `security` and a fake `secret-tool` behind its runner (the
// real Keychain is never touched): the key comes from stdin and appears in no argv or output, the line fed to
// `security -i` quotes the key so it reads back intact (a key holding `"` or `\` is refused), the key is read
// back to check it, the config changes only under --write-config, a missing keyring prints the `pass` and
// `op read` lines and exits 1, and list shows presence, never a value.
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseConfig } from '../hooks/config'
import { cli, run } from '../scripts/auth'
import type { Io } from '../scripts/auth'

const KEY = 'sk-styx-test-0123456789abcdef'
const SECURITY = '/usr/bin/security'
const TOOL = '/usr/bin/secret-tool'
const READ = [SECURITY, 'find-generic-password', '-s', 'styx', '-a', 'acme', '-w']
const LOOKUP = [TOOL, 'lookup', 'service', 'styx', 'provider', 'acme']
const PROVIDER = { kind: 'openai', baseUrl: 'https://styx.invalid/v1', auth: { command: ['/bin/true'], ttlSeconds: 60 }, models: { m: { contextWindow: 1000, maxOutputTokens: 100 } } }
const dirs: string[] = []
afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })))

// What `security -i` makes of a line (observed on macOS): spaces split it, `"` quotes, `\` escapes the next character.
function tokens(text: string): string[] {
  const out: string[] = []
  let cur: string | undefined
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (c === '\\') cur = (cur ?? '') + (text[++i] ?? '')
    else if (c === '"') ((quoted = !quoted), (cur ??= ''))
    else if (/\s/.test(c) && !quoted) (cur !== undefined && out.push(cur), (cur = undefined))
    else cur = (cur ?? '') + c
  }
  return cur === undefined ? out : [...out, cur]
}

type Call = { argv: readonly string[]; input?: string }
// A CLI run over a fake keyring (`items`: account → key) as `security` or `secret-tool` would keep it. `readBack`
// replaces what the key reads back as; `refuse` makes the store fail.
function world(o: { platform?: string; tool?: boolean; key?: string; config?: unknown; readBack?: string; refuse?: boolean; items?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'styx-auth-'))
  dirs.push(dir)
  const configPath = join(dir, 'styx.json')
  if (o.config !== undefined) writeFileSync(configPath, JSON.stringify(o.config))
  const items = { ...o.items }
  const h = { calls: [] as Call[], out: [] as string[], err: [] as string[], asked: 0, items }
  const answer = async (argv: readonly string[], input?: string) => {
    const [bin, verb] = argv
    const account = argv[argv.indexOf(bin === SECURITY ? '-a' : 'provider') + 1] ?? ''
    if (o.refuse && (verb === '-i' || verb === 'store')) return { exitCode: 51, stdout: '' }
    if (bin === SECURITY && verb === '-i') {
      const t = tokens((input ?? '').split('\n')[0] ?? '')
      const at = (flag: string) => t[t.indexOf(flag) + 1]
      if (t[0] !== 'add-generic-password' || t.length !== 10 || at('-s') !== 'styx' || at('-l') !== `styx ${at('-a')}`) return { exitCode: 2, stdout: '' }
      items[at('-a') as string] = at('-w') as string
      return { exitCode: 0, stdout: '' }
    }
    if (verb === 'store') return ((items[account] = input ?? ''), { exitCode: 0, stdout: '' })
    if (verb === 'delete-generic-password' || verb === 'clear') return { exitCode: account in items ? (delete items[account], 0) : 44, stdout: '' }
    if (!(account in items)) return { exitCode: bin === SECURITY ? 44 : 1, stdout: '' }
    const secret = o.readBack ?? (items[account] as string)
    return { exitCode: 0, stdout: bin === SECURITY ? (argv.includes('-w') ? `${secret}\n` : `keychain: "login"\n    "acct"<blob>="${account}"\n`) : secret }
  }
  const io: Io = {
    platform: o.platform ?? 'darwin',
    which: n => (n === 'secret-tool' ? (o.tool ? TOOL : undefined) : n === 'op' ? '/opt/homebrew/bin/op' : undefined),
    run: async (argv, input) => (h.calls.push({ argv, ...(input === undefined ? {} : { input }) }), answer(argv, input)),
    readKey: async () => (h.asked++, o.key ?? `${KEY}\n`),
    configPath,
    out: l => void h.out.push(l),
    err: l => void h.err.push(l),
  }
  return { h, io, dir, configPath, cli: (...args: string[]) => cli(args, io), said: () => [...h.out, ...h.err].join('\n') }
}

test('login on macOS stores the key through security -i, reads it back, and prints the auth.command line without writing the config', async () => {
  const w = world({ config: { providers: { acme: PROVIDER } } })
  const before = readFileSync(w.configPath, 'utf8')
  expect(await w.cli('login', 'acme')).toBe(0)
  expect(w.h.calls).toEqual([
    { argv: [SECURITY, '-i'], input: `add-generic-password -U -s styx -a "acme" -l "styx acme" -w "${KEY}"\n` },
    { argv: READ },
  ])
  expect(w.h.items).toEqual({ acme: KEY })
  expect(w.h.out.at(-1)).toContain(`  "auth": { "command": ${JSON.stringify(READ)} }`)
  expect(readFileSync(w.configPath, 'utf8')).toBe(before)
  for (const c of w.h.calls) expect(c.argv.join('\n')).not.toContain(KEY)
  expect(w.said()).not.toContain(KEY)
})

test('every character but " and \\ stays literal in the line security -i reads, so the key reads back intact', async () => {
  for (const key of ['sk-sp$ecial#;!&`~*?(){}[]<>|\'%^=+,:@/', '-dash-first', "it's", 'a=b', '$HOME', '${x}', '~/x', '*', '#hash']) {
    const w = world({ key })
    expect(await w.cli('login', 'acme')).toBe(0)
    expect(tokens(w.h.calls[0]?.input ?? '').at(-1)).toBe(key)
    expect(w.h.items).toEqual({ acme: key })
  }
})

test('a key holding " or \\ is refused before anything runs: security -i would read it as quoting or an escape', async () => {
  for (const key of ['sk-with"quote', 'sk-with\\backslash', 'sk-ends-with-backslash\\', 'sk-"', 'sk-\\"', 'sk-a\\"b']) {
    const naive = tokens(`add-generic-password -U -s styx -a "acme" -l "styx acme" -w "${key}"\n`)
    expect(naive.at(-1) === key && naive.length === 10).toBe(false)
    const w = world({ key })
    expect(await w.cli('login', 'acme')).toBe(1)
    expect(w.h.calls).toEqual([])
    expect(w.h.err.join('\n')).toContain('nothing stored')
    expect(w.said()).not.toContain(key)
  }
})

test('a key that is empty, holds a space, control or non-ASCII character, or is over 4 KiB is refused before anything runs; stdin whitespace is trimmed', async () => {
  for (const key of ['', ' \n', 'two words', 'a\tb', 'a\u0007b', 'a​b', 'sk-€', 'k'.repeat(4097)]) {
    const w = world({ key })
    expect(await w.cli('login', 'acme')).toBe(1)
    expect(w.h.calls).toEqual([])
    expect(w.h.err.join('\n')).toContain('nothing stored')
  }
  const w = world({ key: `\r\n  ${'k'.repeat(4096)} \r\n` })
  expect(await w.cli('login', 'acme')).toBe(0)
  expect(w.h.items).toEqual({ acme: 'k'.repeat(4096) })
})

test('a refused store, or a key that does not read back, fails with one line and no key in it', async () => {
  const refused = world({ refuse: true })
  expect(await refused.cli('login', 'acme')).toBe(1)
  expect(refused.h.err).toEqual(['styx auth: the macOS Keychain refused the key (exit 51); unlock it, then retry'])
  expect(refused.h.calls).toHaveLength(1)
  const differs = world({ readBack: 'sk-something-else' })
  expect(await differs.cli('login', 'acme')).toBe(1)
  expect(differs.h.err).toHaveLength(1)
  expect(differs.h.err[0]).toContain('reading acme back did not give the same key')
  expect(differs.h.out.join('\n')).not.toContain('key stored')
  for (const w of [refused, differs]) expect(w.said()).not.toContain(KEY)
})

test('login on Linux with secret-tool stores the key on its stdin and prints the lookup line', async () => {
  const w = world({ platform: 'linux', tool: true, config: { providers: { acme: PROVIDER } } })
  expect(await w.cli('login', 'acme')).toBe(0)
  expect(w.h.calls).toEqual([{ argv: [TOOL, 'store', '--label=styx acme', 'service', 'styx', 'provider', 'acme'], input: KEY }, { argv: LOOKUP }])
  expect(w.h.out.at(-1)).toContain(`  "auth": { "command": ${JSON.stringify(LOOKUP)} }`)
  for (const c of w.h.calls) expect(c.argv.join('\n')).not.toContain(KEY)
})

test('with no keyring, login prints the pass and op read lines, exits 1 and never reads the key; logout and list say there is nothing', async () => {
  for (const platform of ['linux', 'freebsd']) {
    const w = world({ platform })
    expect(await w.cli('login', 'acme')).toBe(1)
    expect(w.h.out).toEqual([`  "auth": { "command": ["/usr/bin/pass","show","styx/acme"] }`, `  "auth": { "command": ["/opt/homebrew/bin/op","read","op://Private/styx acme/credential"] }`])
    expect(w.h.err[0]).toContain('no keyring here')
    expect([w.h.asked, w.h.calls]).toEqual([0, []])
    for (const verb of ['logout', 'list']) {
      const v = world({ platform })
      expect(await v.cli(verb, 'acme')).toBe(1)
      expect([v.h.out, v.h.calls]).toEqual([[], []])
    }
  }
})

test('--write-config sets providers.<p>.auth.command, keeps ttlSeconds and the rest, drops apiKeyEnv, and leaves a config that validates', async () => {
  const w = world({ config: { aliases: { m: { target: 'acme/m' } }, providers: { acme: { ...PROVIDER, apiKeyEnv: 'OLD', auth: { env: 'OLD', ttlSeconds: 60 } }, other: PROVIDER } } })
  expect(await w.cli('login', 'acme', '--write-config')).toBe(0)
  const text = readFileSync(w.configPath, 'utf8')
  const parsed = parseConfig(text)
  expect(parsed.errors).toEqual([])
  expect(parsed.config?.providers['acme']?.auth).toEqual({ command: READ, ttlSeconds: 60 })
  expect(parsed.config?.providers['other']?.auth).toEqual(PROVIDER.auth)
  expect(Object.keys(JSON.parse(text).providers.acme)).toEqual(['kind', 'baseUrl', 'models', 'auth'])
  expect(parsed.config?.aliases['m']?.target).toBe('acme/m')
  expect(text.endsWith('}\n')).toBe(true)
  expect(w.h.out.at(-1)).toContain(`wrote providers.acme.auth.command to `)
  expect(w.said()).not.toContain(KEY)
})

test('--write-config turns a keyless provider ("auth": "none") into one with the key helper, as the keyless 401 line asks', async () => {
  const w = world({ config: { aliases: { m: { target: 'acme/m' } }, providers: { acme: { ...PROVIDER, auth: 'none' } } } })
  expect(parseConfig(readFileSync(w.configPath, 'utf8')).config?.providers['acme']?.auth).toBe('none')
  expect(await w.cli('login', 'acme', '--write-config')).toBe(0)
  const parsed = parseConfig(readFileSync(w.configPath, 'utf8'))
  expect(parsed.errors).toEqual([])
  expect(parsed.config?.providers['acme']?.auth).toEqual({ command: READ, ttlSeconds: 300 })
})

test('--write-config checks the config first: a missing file or provider stores nothing and never asks for the key', async () => {
  for (const config of [undefined, { providers: { other: PROVIDER } }, { providers: [] }]) {
    const w = world(config === undefined ? {} : { config })
    expect(await w.cli('login', 'acme', '--write-config')).toBe(1)
    expect([w.h.asked, w.h.calls]).toEqual([0, []])
    expect(w.h.err[0]).toContain('providers.acme is not in')
  }
  const broken = world()
  writeFileSync(broken.configPath, '{ not json')
  expect(await broken.cli('login', 'acme', '--write-config')).toBe(1)
  expect(readFileSync(broken.configPath, 'utf8')).toBe('{ not json')
})

test('--write-config rewrites through a symlink and keeps the file mode', async () => {
  const w = world()
  const real = join(w.dir, 'dotfiles-styx.json')
  writeFileSync(real, JSON.stringify({ providers: { acme: PROVIDER } }))
  chmodSync(real, 0o600)
  symlinkSync(real, w.configPath)
  expect(await w.cli('login', 'acme', '--write-config')).toBe(0)
  expect(lstatSync(w.configPath).isSymbolicLink()).toBe(true)
  expect(statSync(real).mode & 0o777).toBe(0o600)
  expect(parseConfig(readFileSync(real, 'utf8')).config?.providers['acme']?.auth).toMatchObject({ command: READ })
})

test('logout deletes the item through security or secret-tool, and says so when there is none', async () => {
  const mac = world({ items: { acme: KEY } })
  expect(await mac.cli('logout', 'acme')).toBe(0)
  expect(mac.h.calls).toEqual([{ argv: [SECURITY, 'delete-generic-password', '-s', 'styx', '-a', 'acme'] }])
  expect(mac.h.items).toEqual({})
  expect(await mac.cli('logout', 'acme')).toBe(1)
  expect(mac.h.out.at(-1)).toBe('acme: no item in the macOS Keychain')
  const linux = world({ platform: 'linux', tool: true, items: { acme: KEY } })
  expect(await linux.cli('logout', 'acme')).toBe(0)
  expect(linux.h.calls).toEqual([{ argv: [TOOL, 'clear', 'service', 'styx', 'provider', 'acme'] }])
})

test('list names each configured provider with or without an item, running only attribute lookups and printing no value', async () => {
  const w = world({ items: { acme: KEY }, config: { providers: { acme: PROVIDER, other: PROVIDER } } })
  expect(await w.cli('list')).toBe(0)
  expect(w.h.out).toEqual(['acme: item in the macOS Keychain', 'other: no item in the macOS Keychain'])
  expect(w.h.calls.map(c => c.argv)).toEqual([READ.slice(0, -1), [...READ.slice(0, 5), 'other']])
  expect(w.said()).not.toContain(KEY)
  const one = world({ platform: 'linux', tool: true, items: { acme: KEY } })
  expect(await one.cli('list', 'acme')).toBe(0)
  expect(one.h.out).toEqual(['acme: item in the secret-tool'])
  expect(one.said()).not.toContain(KEY)
  const none = world()
  expect(await none.cli('list')).toBe(1)
})

test('a misuse exits 2 with the usage and never echoes an argument: a key typed on the command line is not repeated', async () => {
  const cases = [['login', 'acme', KEY], ['login', 'acme', '--key', KEY], ['login'], ['login', 'Acme'], ['list', '--bogus'], ['logout', 'acme', '--write-config'], ['list', '--write-config'], ['frobnicate'], []]
  for (const args of cases) {
    const w = world()
    expect(await w.cli(...args)).toBe(2)
    expect(w.h.err.join('\n')).toContain('usage: bun run auth login|logout <provider>')
    expect(w.said()).not.toContain(KEY)
    expect([w.h.asked, w.h.calls]).toEqual([0, []])
  }
})

test('the real runner gives a command its stdin, returns stdout and the exit code, and answers 127 for one that cannot start; the script exits 2 on misuse', async () => {
  expect(await run(['/bin/cat'], 'a b\n$HOME')).toEqual({ exitCode: 0, stdout: 'a b\n$HOME' })
  expect(await run(['/bin/sh', '-c', 'exit 3'])).toEqual({ exitCode: 3, stdout: '' })
  expect(await run(['/no/such/tool'])).toEqual({ exitCode: 127, stdout: '' })
  const dir = mkdtempSync(join(tmpdir(), 'styx-auth-'))
  dirs.push(dir)
  const p = Bun.spawn([process.execPath, join(import.meta.dir, '..', 'scripts', 'auth.ts'), 'login', 'acme', KEY], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  expect(code).toBe(2)
  expect(out + err).not.toContain(KEY)
  expect(err).toContain('unexpected arguments')
})
