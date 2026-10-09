// The one-line texts of failed provider requests: what failed, why, and what to do. Every provider text in
// them is redacted and cut short. Pure.
import type { ProviderConfig } from '../hooks/config'
import { firstLine, redact } from '../hooks/redact'

// How a request ended without a usable response: no connection (refused, unresolved, or none within the
// connect timeout), silence past the stall window, the whole-request bound, a redirect, or a transport fault.
export type Cut = { kind: 'connect' | 'connect-timeout' | 'stall' | 'total' | 'redirect' | 'reset'; detail: string }

export const CONNECT_TIMEOUT_S = 15
export const ERROR_TEXT_MAX = 4096 // the most kept of a provider's error text: an error body's start, or a decoder's failure
const MODEL_NAME_RE = /^[A-Za-z0-9._:/@-]{1,128}$/

// Text on one line, at most `max` characters, redacted. Linear: it reads only its first 4 × `max` characters, less the token that cut splits (a token that ends exactly at the cut is whole, and stays).
export function oneLine(text: string, max = 200): string {
  let end = Math.min(text.length, max * 4)
  while (end < text.length && end > 0 && !/\s/.test(text.charAt(end - 1)) && !/\s/.test(text.charAt(end))) end--
  return redact(text.slice(0, end).split('\n').map(l => l.trim()).filter(Boolean).join(' ')).slice(0, max)
}

// A string as JSON for a debug line, with U+2028, U+2029 and the bidi controls (U+202A–U+202E, U+2066–U+2069) as \u escapes.
export const logJson = (text: string) => JSON.stringify(text).replace(/[\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

// A provider's error, read from an error body or an in-stream `error` value: its `error.message` (or
// `message`, `detail`) and `error.type` (or `code`) when it is JSON, else its first line.
export function errorDetail(error: unknown): { message: string; type: string } {
  let v: unknown = error
  if (typeof error === 'string') {
    try {
      v = JSON.parse(error)
    } catch {
      return { message: firstLine(error), type: '' }
    }
  }
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
  const inner = typeof o['error'] === 'object' && o['error'] !== null ? (o['error'] as Record<string, unknown>) : typeof o['error'] === 'string' ? { message: o['error'] } : o
  const text = (x: unknown) => (typeof x === 'string' ? x : typeof x === 'number' ? String(x) : '')
  const message = text(inner['message']) || text(o['message']) || text(o['detail']) || (typeof error === 'string' ? firstLine(error) : JSON.stringify(v))
  return { message, type: `${text(inner['type'])} ${text(inner['code'])}`.trim() }
}

// The models a gateway's key-access error (LiteLLM's format) names as allowed (`models=['a', 'b']`), when it names any.
const allowedModels = (message: string) =>
  (/models=\[([^\]]*)\]/.exec(message)?.[1] ?? '')
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(s => MODEL_NAME_RE.test(s) && !/^sk-/i.test(s))

// The text for an HTTP error status. An HTML page (an edge proxy or WAF answering before the API does) is
// named by its title; a key-access denial names the allowed models; a rejected key (a key wanted by
// a provider with auth "none"), a content-policy refusal, a rate limit and a server failure each say what to
// do; any other status shows the provider's own message with the fix for its class.
export function httpErrorText(p: ProviderConfig, status: number, body: string, model: string): string {
  if (/^\s*</.test(body) && /<(?:!doctype\s+html|html|head|body)\b/i.test(body.slice(0, 512))) {
    const raw = /<title>([^<]{1,80})<\/title>/i.exec(body)?.[1]
    const title = raw === undefined ? '' : oneLine(raw.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' '))
    return `styx: ${p.id} blocked the request at its gateway (HTTP ${status}${title ? `, "${title}"` : ''}), before the API answered; ask the ${p.id} platform team what their edge rule rejected`
  }
  const { message, type } = errorDetail(body)
  const said = oneLine(message, 300) || 'no error message'
  if (/key_model_access_denied/.test(type) || /not allowed to access model/i.test(message)) {
    const allowed = allowedModels(message)
    const shown = allowed.length > 12 ? `${allowed.slice(0, 12).join(', ')} (+${allowed.length - 12} more)` : allowed.join(', ')
    return `styx: your key for ${p.id} can't use ${model}${shown ? `; allowed: ${shown}` : ''}. Pick an allowed model, or ask the gateway's admin for access`
  }
  if (status === 401) return p.auth === 'none' ? `styx: ${p.id} wants a key (HTTP 401) but auth is "none"; run bun run auth login ${p.id} and set auth.command, then retry` : `styx: ${p.id} rejected its key (HTTP 401); store a valid one with bun run auth login ${p.id}, then retry`
  if (/policy|guardrail|content_filter|moderation/i.test(`${type} ${message}`)) return `styx: ${p.id} refused the request under its content policy (HTTP ${status}): ${said}. Rephrase it, or use another model`
  const fixes: Record<number, string> = {
    429: 'rate limited: wait, then retry',
    403: p.auth === 'none' ? `ask the ${p.id} admin for access; if it wants a key, run bun run auth login ${p.id} and set auth.command (auth is "none")` : `ask the ${p.id} admin for access, or store another key with bun run auth login ${p.id}`,
    404: `check providers.${p.id}.baseUrl and the model id ${model}`,
  }
  const fix = status >= 500 ? 'the provider failed: retry, or pick another model' : (fixes[status] ?? `check the params of ${model} in styx.json`)
  return `styx: ${p.id} HTTP ${status}: ${said}; ${fix}`
}

// The text for a request cut before a usable response ended, by how it was cut: the provider's id and the
// cut's detail.
const CUTS: Record<Cut['kind'], (id: string, detail: string) => string> = {
  'connect-timeout': id => `styx: ${id} could not connect within ${CONNECT_TIMEOUT_S} s; check the network or VPN, then retry`,
  connect: (id, d) => `styx: ${id} could not connect (${oneLine(d)}); check the network or VPN, then retry`,
  stall: (id, d) => `styx: ${id} stalled (no data for ${d} s); retry`,
  total: (id, d) => `styx: ${id} timed out after ${d} s; retry, or raise providers.${id}.timeoutMs`,
  redirect: (id, d) => `styx: ${id} answered with a redirect (HTTP ${d}), which styx does not follow; set providers.${id}.baseUrl to the URL it redirects to`,
  reset: (id, d) => `styx: ${id} request failed (${oneLine(d)}); retry, or see the debug log`,
}
export const cutText = (p: ProviderConfig, c: Cut) => CUTS[c.kind](p.id, c.detail)
