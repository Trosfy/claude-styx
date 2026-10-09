// Styx's config (styx.json in Claude Code's config directory): parsing, all-or-nothing validation, model-name resolution, and the
// pure texts and schemas derived from a config. No I/O.
import type { Effort } from '../types'

export type JsonSchema = Readonly<Record<string, unknown>>
type Json = Record<string, unknown>

export type ModelConfig = {
  id: string
  contextWindow: number
  maxInputTokens?: number
  maxOutputTokens: number
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens'
  systemRole: 'system' | 'developer' | 'user'
  effort?: Partial<Record<Effort, Json>>
  // How long the prompt cache lives, on the kinds that take cache points; absent is off.
  cache?: Cache
  tools: boolean
  parallelToolCalls: boolean
  vision: boolean
  params: Json
  // Body params an alias lays over `params`, kept apart so a null deletes a key from every layer below it.
  overrides?: Json
  headers: Record<string, string>
}

// A prompt-cache lifetime: five minutes or one hour.
export type Cache = '5m' | '1h'
// The provider protocols: Chat Completions, the Anthropic Messages API, and Amazon Bedrock Converse.
export type Kind = 'openai' | 'anthropic' | 'bedrock'
// A provider's key source: a credential helper run with no shell, whose standard output is the key, kept
// for ttlSeconds; or "none", for a server that checks no key (no authorization header is sent).
export type Auth = { command: readonly string[]; ttlSeconds: number } | 'none'

export type ProviderConfig = {
  id: string
  kind: Kind
  baseUrl: string
  origin: string
  allowHttp: boolean
  auth: Auth
  // How the key is sent: `Authorization: Bearer`, or Anthropic's `x-api-key`.
  authHeader: 'bearer' | 'x-api-key'
  headers: Record<string, string>
  params: Json
  timeoutMs?: number
  streamUsage: boolean
  maxTools: number
  models: Readonly<Record<string, ModelConfig>>
}

// An alias names a target and may carry the keys a model takes for a request (see REQUEST_KEYS), which apply
// only to requests made through the alias.
// An alias's `cache` key, when present, replaces its model's: absent `cache` there means the cache is off.
export type Alias = { target: string; note?: string; params?: Json; effort?: ModelConfig['effort']; cache?: Cache; headers?: Record<string, string> }
export type Config = { providers: Readonly<Record<string, ProviderConfig>>; aliases: Readonly<Record<string, Alias>> }

// What a model name names: a native model (passed to the engine) or a declared remote one. A remote
// target's `label` is the name it was asked for (an alias or `provider/model`), which routes keep and steps
// send, so that an alias's overlay is applied again at each step; `target` is the `provider/model` it names.
export type Target =
  | { kind: 'native'; model: string; label: string }
  | { kind: 'remote'; provider: ProviderConfig; model: ModelConfig; target: string; label: string }

// What each kind adds to the common provider and model keys, the request body keys styx sets (refused in
// params), whether its requests always carry a max-tokens value, and whether it takes cache points (the
// others cache on their own).
type KindSpec = { providerKeys: readonly string[]; modelKeys: readonly string[]; reservedParams: readonly string[]; sendsMaxTokens: boolean; cache: boolean }
export const KINDS: Readonly<Record<Kind, KindSpec>> = {
  openai: {
    providerKeys: ['streamUsage'],
    modelKeys: ['maxTokensParam', 'systemRole', 'parallelToolCalls'],
    reservedParams: ['model', 'messages', 'tools', 'stream', 'stream_options', 'n', 'tool_choice', 'functions', 'function_call'],
    sendsMaxTokens: false,
    cache: false,
  },
  anthropic: {
    providerKeys: ['authHeader'],
    modelKeys: ['parallelToolCalls'],
    reservedParams: ['model', 'messages', 'system', 'tools', 'tool_choice', 'stream', 'max_tokens'],
    sendsMaxTokens: true,
    cache: true,
  },
  bedrock: { providerKeys: [], modelKeys: [], reservedParams: ['messages', 'system', 'toolConfig'], sendsMaxTokens: true, cache: true },
}

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
// The native Agent tool's `model` values.
export const NATIVE_MODELS: readonly string[] = ['fable', 'haiku', 'opus', 'sonnet']

const ID_RE = /^[a-z][a-z0-9-]{0,31}$/
// An alias may carry dots (`model.v1-mini`), but never `/` (that splits provider/model), a leading dot or `..`.
export const ALIAS_RE = /^(?!.*\.\.)[a-z][a-z0-9.-]{0,63}$/
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const SECRET_HEADER_RE = /auth|key|token|secret|password|credential|cookie|session|signature/i
const HEADER_VALUE_RE = /^[\x20-\x7e]*$/
// A DNS host name: two or more ASCII labels of letters, digits and dashes, no label starting or ending with
// a dash, and no trailing dot.
const HOST_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/
export const RESERVED_ALIASES = new Set(['fable', 'opus', 'sonnet', 'haiku', 'default', 'inherit', 'native'])
const PROVIDER_KEYS = ['kind', 'baseUrl', 'allowHttp', 'auth', 'headers', 'params', 'timeoutMs', 'maxTools', 'models']
// The keys a model and an alias share: what a request is built from.
const REQUEST_KEYS = ['params', 'effort', 'cache', 'headers']
const MODEL_KEYS = ['contextWindow', 'maxInputTokens', 'maxOutputTokens', 'tools', 'vision', ...REQUEST_KEYS]
const KEY_TTL_S = 300
// The longest timer a runtime takes (2^31 - 1 ms); a longer one fires at once.
export const MAX_TIMEOUT_MS = 2 ** 31 - 1

export const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
// A map's own entry: a name such as `toString` or `constructor` is never read from the prototype.
export const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
const isKind = (v: unknown): v is Kind => typeof v === 'string' && Object.hasOwn(KINDS, v)

// Unknown keys of `obj`, each reported with its path.
function allowKeys(obj: Json, keys: readonly string[], path: string, errors: string[]) {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) errors.push(`${path}.${k}: unknown key`)
}

function params(v: unknown, kind: Kind, path: string, errors: string[]): Json {
  if (v === undefined) return {}
  if (!isObject(v)) return errors.push(`${path}: must be an object`), {}
  for (const k of KINDS[kind].reservedParams) if (k in v) errors.push(`${path}.${k}: reserved; styx sets it`)
  return v
}

// An effort map: each level (low to max) with the body params it applies.
function effortMap(v: unknown, kind: Kind, path: string, errors: string[]): Partial<Record<Effort, Json>> | undefined {
  if (v === undefined) return undefined
  if (!isObject(v)) return errors.push(`${path}: must be an object`), undefined
  allowKeys(v, EFFORTS, path, errors)
  const levels: Partial<Record<Effort, Json>> = {}
  for (const level of EFFORTS) {
    if (!(level in v)) continue
    if (!isObject(v[level])) errors.push(`${path}.${level}: must be an object of params`)
    else levels[level] = params(v[level], kind, `${path}.${level}`, errors)
  }
  return levels
}

// A prompt-cache lifetime; absent is off. A kind that caches on its own takes none. An alias (`off`) may
// give null, which turns off the cache its model sets and is read as an absent lifetime.
function cacheOf(v: unknown, kind: Kind, path: string, errors: string[], off: boolean): Cache | undefined {
  if (v === undefined) return undefined
  if (!KINDS[kind].cache) errors.push(`${path}: not supported on the ${kind} kind (it caches on its own)`)
  else if (v === null && off) return undefined
  else if (v !== '5m' && v !== '1h') errors.push(`${path}: must be "5m" or "1h"${off ? ' (null turns the model\'s cache off)' : ''}`)
  return v as Cache
}

// A `thinking.budget_tokens` in `p` (Bedrock's additionalModelRequestFields hold it too) counts toward the
// response's max tokens, so it must be below `max`.
function thinkingBudget(p: Json, max: number, path: string, errors: string[]) {
  const nested = p['additionalModelRequestFields']
  for (const holder of [p, isObject(nested) ? nested : {}]) {
    const t = holder['thinking']
    const budget = isObject(t) ? t['budget_tokens'] : undefined
    if (typeof budget === 'number' && budget >= max) errors.push(`${path}.thinking.budget_tokens: ${budget} must be below maxOutputTokens (${max})`)
  }
}

// The request keys of a model or an alias, checked the same way for both; `max` is the model's
// maxOutputTokens, and a `cache` key is kept only when given (an alias's replaces its model's).
function requests(v: Json, kind: Kind, path: string, errors: string[], max: number, alias = false) {
  const effort = effortMap(v['effort'], kind, `${path}.effort`, errors)
  const p = params(v['params'], kind, `${path}.params`, errors)
  thinkingBudget(p, max, `${path}.params`, errors)
  for (const [level, lp] of Object.entries(effort ?? {})) thinkingBudget(lp, max, `${path}.effort.${level}`, errors)
  return { effort, params: p, ...('cache' in v ? { cache: cacheOf(v['cache'], kind, `${path}.cache`, errors, alias) } : {}), headers: headers(v['headers'], `${path}.headers`, errors) }
}

function headers(v: unknown, path: string, errors: string[]): Record<string, string> {
  if (v === undefined) return {}
  if (!isObject(v)) return errors.push(`${path}: must be an object`), {}
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(v)) {
    if (!HEADER_NAME_RE.test(name)) errors.push(`${path}.${name}: not a header name`)
    else if (SECRET_HEADER_RE.test(name)) errors.push(`${path}.${name}: auth-bearing headers are not allowed; the key comes from auth.command`)
    else if (typeof value !== 'string' || !HEADER_VALUE_RE.test(value)) errors.push(`${path}.${name}: must be printable ASCII text`)
    else out[name] = value
  }
  return out
}

function bool(v: unknown, fallback: boolean, path: string, errors: string[]): boolean {
  if (v === undefined) return fallback
  if (typeof v !== 'boolean') errors.push(`${path}: must be true or false`)
  return v === true
}

// The provider's credential helper: an argv whose first entry is an absolute path (nothing expands `~` or
// searches PATH), shown verbatim when the provider is approved; or "none". The approval, not this check, is
// what stands between an edited config and a helper run.
function auth(id: string, v: Json, path: string, errors: string[]): Auth {
  const login = `bun run auth login ${id}, which stores the key in the keychain and writes "auth": { "command": [...] }`
  const a = v['auth']
  if (v['apiKeyEnv'] !== undefined) errors.push(`${path}.apiKeyEnv: no longer read; keys come from a credential helper. Run ${login} in its place`)
  else if (a === undefined) errors.push(`${path}.auth: missing; run ${login}, or set "auth": "none" for a server that checks no key`)
  if (a === undefined) return { command: [], ttlSeconds: KEY_TTL_S }
  if (a === 'none') return a
  if (!isObject(a)) return errors.push(`${path}.auth: must be { "command": ["/absolute/helper", ...] } or "none"`), { command: [], ttlSeconds: KEY_TTL_S }
  for (const k of Object.keys(a)) {
    if (k === 'env') errors.push(`${path}.auth.env: not supported; keys come from "command" (run ${login})`)
    else if (k !== 'command' && k !== 'ttlSeconds') errors.push(`${path}.auth.${k}: unknown key`)
  }
  const { command, ttlSeconds } = a
  const argv = Array.isArray(command) && command.every(s => typeof s === 'string') ? (command as string[]) : undefined
  if (argv === undefined || argv.length === 0) errors.push(`${path}.auth.command: must be a non-empty list of strings`)
  else if (!(argv[0] as string).startsWith('/')) errors.push(`${path}.auth.command: the first entry must be an absolute path (no shell expands ~ or searches PATH)`)
  else if (argv.some(s => /\p{Cc}/u.test(s))) errors.push(`${path}.auth.command: must not contain control characters`)
  if (ttlSeconds !== undefined && !isCount(ttlSeconds)) errors.push(`${path}.auth.ttlSeconds: must be a positive integer`)
  return { command: argv ?? [], ttlSeconds: (ttlSeconds as number | undefined) ?? KEY_TTL_S }
}

function model(id: string, kind: Kind, v: unknown, path: string, errors: string[]): ModelConfig | undefined {
  if (!isObject(v)) return errors.push(`${path}: must be an object`), undefined
  const spec = KINDS[kind]
  allowKeys(v, [...MODEL_KEYS, ...spec.modelKeys], path, errors)
  // A key of another kind is reported above and read as absent.
  const mine = (k: string) => (spec.modelKeys.includes(k) ? v[k] : undefined)
  const { contextWindow, maxInputTokens, maxOutputTokens } = v
  const maxTokensParam = mine('maxTokensParam')
  const systemRole = mine('systemRole')
  if (!isCount(contextWindow)) errors.push(`${path}.contextWindow: must be a positive integer`)
  if (!isCount(maxOutputTokens)) errors.push(`${path}.maxOutputTokens: must be a positive integer`)
  if (maxInputTokens !== undefined && (!isCount(maxInputTokens) || (isCount(contextWindow) && maxInputTokens > contextWindow))) {
    errors.push(`${path}.maxInputTokens: must be a positive integer no larger than contextWindow`)
  }
  if (maxTokensParam !== undefined && maxTokensParam !== 'max_tokens' && maxTokensParam !== 'max_completion_tokens') {
    errors.push(`${path}.maxTokensParam: must be max_tokens or max_completion_tokens`)
  }
  if (systemRole !== undefined && systemRole !== 'system' && systemRole !== 'developer' && systemRole !== 'user') {
    errors.push(`${path}.systemRole: must be system, developer or user`)
  }
  const out: ModelConfig = {
    id,
    contextWindow: contextWindow as number,
    ...(maxInputTokens === undefined ? {} : { maxInputTokens: maxInputTokens as number }),
    maxOutputTokens: maxOutputTokens as number,
    ...(maxTokensParam === undefined ? {} : { maxTokensParam: maxTokensParam as ModelConfig['maxTokensParam'] & string }),
    systemRole: (systemRole as ModelConfig['systemRole'] | undefined) ?? 'system',
    tools: bool(v['tools'], true, `${path}.tools`, errors),
    parallelToolCalls: bool(mine('parallelToolCalls'), true, `${path}.parallelToolCalls`, errors),
    vision: bool(v['vision'], true, `${path}.vision`, errors),
    ...requests(v, kind, path, errors, isCount(maxOutputTokens) ? maxOutputTokens : Infinity),
  }
  if (isCount(contextWindow) && isCount(maxOutputTokens) && inputBudget(out, kind) <= 0) {
    errors.push(`${path}: maxOutputTokens leaves no input budget inside contextWindow`)
  }
  return out
}

function provider(id: string, v: unknown, path: string, errors: string[]): ProviderConfig | undefined {
  if (!ID_RE.test(id) || id === 'native') errors.push(`${path}: provider ids are lowercase letters, digits and dashes (not "native")`)
  if (!isObject(v)) return errors.push(`${path}: must be an object`), undefined
  const { kind: rawKind, baseUrl, timeoutMs, maxTools, models } = v
  if (!isKind(rawKind)) errors.push(`${path}.kind: must be "openai", "anthropic" or "bedrock"`)
  // An unknown kind's keys are checked as openai's.
  const kind = isKind(rawKind) ? rawKind : 'openai'
  const spec = KINDS[kind]
  // A retired apiKeyEnv is reported by auth(), with what replaced it.
  allowKeys(v, [...PROVIDER_KEYS, ...spec.providerKeys, 'apiKeyEnv'], path, errors)
  const allowHttp = bool(v['allowHttp'], false, `${path}.allowHttp`, errors)
  let origin = ''
  let base = ''
  if (typeof baseUrl !== 'string') errors.push(`${path}.baseUrl: must be ${allowHttp ? 'an http or https' : 'an https'} URL`)
  else if (/[\\\s]/.test(baseUrl)) errors.push(`${path}.baseUrl: must not contain a backslash or whitespace`)
  else if (/[[\]{}]/.test(baseUrl)) errors.push(`${path}.baseUrl: must not contain [, ], { or } (URL templates and IPv6 literals are not supported)`)
  else {
    let url: URL | undefined
    try {
      url = new URL(baseUrl)
    } catch {
      errors.push(`${path}.baseUrl: not a URL`)
    }
    if (url !== undefined) {
      const plain = url.protocol === 'http:'
      if (url.protocol !== 'https:' && !(plain && allowHttp)) errors.push(`${path}.baseUrl: must use https${plain ? ' (plain http needs "allowHttp": true on the provider)' : ''}`)
      else if (!HOST_RE.test(url.hostname)) errors.push(`${path}.baseUrl: the host must be a DNS name (letters, digits and dashes, with no trailing dot)`)
      if (url.username !== '' || url.password !== '') errors.push(`${path}.baseUrl: must not carry credentials`)
      if (/[?#]/.test(baseUrl)) errors.push(`${path}.baseUrl: must not carry a query or fragment`)
      origin = url.origin
      // The parsed URL, serialized: curl requests exactly the URL whose origin the approval names.
      base = url.href.replace(/\/+$/, '')
    }
  }
  const key = auth(id, v, path, errors)
  if (key === 'none' && kind === 'bedrock') errors.push(`${path}.auth: "none" is not allowed on a bedrock provider; Bedrock needs a key`)
  // An anthropic provider sends `x-api-key` unless it names bearer (a gateway, bedrock-mantle); the others
  // send bearer.
  const authHeader = spec.providerKeys.includes('authHeader') ? v['authHeader'] : undefined
  if (authHeader !== undefined && authHeader !== 'bearer' && authHeader !== 'x-api-key') errors.push(`${path}.authHeader: must be "bearer" or "x-api-key"`)
  if (timeoutMs !== undefined && !(isCount(timeoutMs) && timeoutMs <= MAX_TIMEOUT_MS)) errors.push(`${path}.timeoutMs: must be a positive integer of at most ${MAX_TIMEOUT_MS}`)
  if (maxTools !== undefined && !isCount(maxTools)) errors.push(`${path}.maxTools: must be a positive integer`)
  const out: Record<string, ModelConfig> = {}
  if (!isObject(models)) errors.push(`${path}.models: must be a map of model ids`)
  else {
    if (Object.keys(models).length === 0) errors.push(`${path}.models: declares no models`)
    for (const [mid, m] of Object.entries(models)) {
      if (mid === '') errors.push(`${path}.models: a model id is empty`)
      const parsed = model(mid, kind, m, `${path}.models.${mid}`, errors)
      if (parsed !== undefined) out[mid] = parsed
    }
  }
  const shared = params(v['params'], kind, `${path}.params`, errors)
  thinkingBudget(shared, Math.min(...Object.values(out).map(m => m.maxOutputTokens)), `${path}.params`, errors)
  return {
    id,
    kind,
    baseUrl: base,
    origin,
    allowHttp,
    auth: key,
    authHeader: (authHeader as ProviderConfig['authHeader'] | undefined) ?? (kind === 'anthropic' ? 'x-api-key' : 'bearer'),
    headers: headers(v['headers'], `${path}.headers`, errors),
    params: shared,
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
    streamUsage: bool(spec.providerKeys.includes('streamUsage') ? v['streamUsage'] : undefined, true, `${path}.streamUsage`, errors),
    maxTools: (maxTools as number | undefined) ?? 128,
    models: out,
  }
}

// Parses and validates a config file's text. Any error leaves `config` undefined: styx routes nothing.
export function parseConfig(text: string): { config?: Config; errors: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { errors: [`not JSON: ${String(err)}`] }
  }
  const errors: string[] = []
  if (!isObject(raw)) return { errors: ['the config must be a JSON object'] }
  allowKeys(raw, ['$schema', 'version', 'providers', 'aliases'], '$', errors)
  if (raw['version'] !== undefined && raw['version'] !== 1) errors.push('version: unsupported (styx reads version 1)')
  const providers: Record<string, ProviderConfig> = {}
  if (raw['providers'] !== undefined && !isObject(raw['providers'])) errors.push('providers: must be an object')
  for (const [id, p] of Object.entries(isObject(raw['providers']) ? raw['providers'] : {})) {
    const parsed = provider(id, p, `providers.${id}`, errors)
    if (parsed !== undefined) providers[id] = parsed
  }
  const aliases: Record<string, Alias> = {}
  const partial: Config = { providers, aliases: {} }
  if (raw['aliases'] !== undefined && !isObject(raw['aliases'])) errors.push('aliases: must be an object')
  for (const [name, a] of Object.entries(isObject(raw['aliases']) ? raw['aliases'] : {})) {
    const path = `aliases.${name}`
    if (!ALIAS_RE.test(name)) errors.push(`${path}: alias names start with a lowercase letter and hold lowercase letters, digits, dashes and dots (no "..", at most 64 characters)`)
    if (RESERVED_ALIASES.has(name)) errors.push(`${path}: "${name}" is a built-in model name`)
    const alias = typeof a === 'string' ? { target: a } : isObject(a) ? a : undefined
    if (alias === undefined) {
      errors.push(`${path}: must be "provider/model" or { target, note }`)
      continue
    }
    if (isObject(a)) allowKeys(a, ['target', 'note', ...REQUEST_KEYS], path, errors)
    const { target, note } = alias as Json
    if (note !== undefined && (typeof note !== 'string' || note.length > 120 || /[\r\n]/.test(note))) {
      errors.push(`${path}.note: must be one line of at most 120 characters`)
    }
    if (typeof target !== 'string') {
      errors.push(`${path}.target: must be "provider/model"`)
      continue
    }
    const why = undeclared(partial, target)
    if (why !== undefined) errors.push(`${path} → ${why}`)
    // The request keys are checked against the kind and the output limit of the model the alias targets.
    const slash = target.indexOf('/')
    const host = why === undefined ? own(providers, target.slice(0, slash)) : undefined
    const set = REQUEST_KEYS.some(k => k in alias)
    if (set && why === undefined && host === undefined) errors.push(`${path}: ${REQUEST_KEYS.join(', ')} need a provider/model target, not a native one`)
    const max = host === undefined ? Infinity : (own(host.models, target.slice(slash + 1))?.maxOutputTokens ?? Infinity)
    aliases[name] = { target, ...(typeof note === 'string' ? { note } : {}), ...(set && host !== undefined ? requests(alias as Json, host.kind, path, errors, max, true) : {}) }
  }
  return errors.length > 0 ? { errors } : { config: { providers, aliases }, errors }
}

// Why `name` (`provider/model`) is not a declared target, or undefined when it is one.
export function undeclared(config: Config, name: string): string | undefined {
  const slash = name.indexOf('/')
  if (slash <= 0) return `"${name}" is not provider/model`
  const [pid, mid] = [name.slice(0, slash), name.slice(slash + 1)]
  if (pid === 'native') return mid === '' ? `"${name}" names no model` : undefined
  const p = own(config.providers, pid)
  const declared = Object.keys(config.providers).join(', ') || 'none'
  if (p === undefined) return `provider "${pid}" is not declared (declared: ${declared})`
  if (own(p.models, mid) === undefined) return `"${mid}" is not declared under provider ${pid} (declared: ${Object.keys(p.models).join(', ')})`
  return undefined
}

// The trust-on-first-use identity of a provider: an approval covers exactly this kind, origin and helper
// argv (or "none"), so any change to the helper asks again.
export const fingerprint = (p: ProviderConfig) => `${p.kind}|${p.origin}|${p.auth === 'none' ? 'none' : `cmd:${JSON.stringify(p.auth.command)}`}`

// The tokens a request may carry: the input cap, and no more than the window leaves after a sent max-tokens
// value (always sent by the anthropic and bedrock kinds; by openai when maxTokensParam names its key).
export function inputBudget(m: Pick<ModelConfig, 'contextWindow' | 'maxInputTokens' | 'maxOutputTokens' | 'maxTokensParam'>, kind: Kind): number {
  return Math.min(m.maxInputTokens ?? Infinity, m.contextWindow - (KINDS[kind].sendsMaxTokens || m.maxTokensParam ? m.maxOutputTokens : 0))
}
