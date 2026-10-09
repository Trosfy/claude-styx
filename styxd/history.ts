// The engine's transcript as every codec reads it: Messages-shaped, holding text, image, tool_use and
// tool_result blocks only. The engine's thinking is dropped, and the signed thinking blocks styxd kept for
// an assistant turn's tool calls are put back where they came in that turn; a tool_reference, document or
// other block is named as text; a tool_result whose tool_use the window does not hold is dropped;
// cache_control and every other field go; an image is a text note for a model without vision. Pure.
import { isObject } from '../hooks/config'
import type { ApiMessage } from '../hooks/protocol'
import { blocksOf, str } from '../hooks/transcript'

export type Text = { type: 'text'; text: string }
export type Image = { type: 'image'; source: { type: 'url'; url: string } | { type: 'base64'; media_type: string; data: string } }
type ToolUse = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
type ToolResult = { type: 'tool_result'; tool_use_id: string; content: (Text | Image)[]; is_error: boolean }
// A thinking block as the model sent it, to be sent back whole: its text and signature, or the data of a
// redacted one.
export type Thinking = { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string }
// A thinking block and its place in its turn: how many of the turn's text and tool_use blocks came before it.
export type Placed = { at: number; block: Thinking }
// `unsealed` marks an assistant turn with tool calls whose thinking blocks were asked for and not held.
export type Message = { role: 'user' | 'assistant'; content: (Text | Image | ToolUse | ToolResult | Thinking)[]; unsealed?: true }

// A text, image or other block as text or image; anything but text and an image (with vision) is named.
function part(b: Record<string, unknown>, vision: boolean): Text | Image {
  if (b['type'] === 'text') return { type: 'text', text: str(b['text']) }
  if (b['type'] === 'image') {
    if (!vision) return { type: 'text', text: '[image omitted: model has no vision]' }
    const s = isObject(b['source']) ? b['source'] : {}
    return { type: 'image', source: s['type'] === 'url' ? { type: 'url', url: str(s['url']) } : { type: 'base64', media_type: str(s['media_type']), data: str(s['data']) } }
  }
  if (b['type'] === 'document') return { type: 'text', text: '[document omitted]' }
  if (b['type'] === 'tool_reference') return { type: 'text', text: `[tool loaded: ${str(b['tool_name'])}]` }
  return { type: 'text', text: `[${str(b['type'])} block omitted]` }
}

// `content` with each thinking block placed after the blocks it came after; one placed past the end goes last.
const interleave = (content: Message['content'], held: readonly Placed[]): Message['content'] => [
  ...content.flatMap((b, i) => [...held.filter(p => p.at === i).map(p => p.block), b]),
  ...held.filter(p => p.at >= content.length).map(p => p.block),
]

// The transcript normalized. `remoteId` gives the provider's own id behind an id styx minted for one of its
// calls, which goes out in its place. `sealed`, when given, gives the thinking blocks of the turn that made a
// call; a turn with calls and none held is marked `unsealed`.
export function normalize(messages: readonly ApiMessage[], vision: boolean, remoteId: (id: string) => string | undefined, sealed?: (id: string) => readonly Placed[] | undefined): Message[] {
  const out: Message[] = []
  const seen = new Set<string>()
  for (const msg of messages) {
    const content: Message['content'] = []
    let call: string | undefined
    for (const b of blocksOf(msg)) {
      const type = b['type']
      if (type === 'thinking' || type === 'redacted_thinking') continue
      if (msg.role === 'assistant') {
        if (type === 'text') content.push({ type: 'text', text: str(b['text']) })
        else if (type === 'tool_use') {
          const id = str(b['id'])
          seen.add(id)
          call ??= id
          content.push({ type: 'tool_use', id: remoteId(id) ?? id, name: str(b['name']), input: isObject(b['input']) ? b['input'] : {} })
        }
      } else if (type === 'tool_result') {
        const id = str(b['tool_use_id'])
        if (!seen.has(id)) continue
        const raw = b['content']
        const parts = (typeof raw === 'string' ? [{ type: 'text', text: raw }] : Array.isArray(raw) ? raw : []).filter(isObject).map(c => part(c, vision))
        content.push({ type: 'tool_result', tool_use_id: remoteId(id) ?? id, content: parts, is_error: b['is_error'] === true })
      } else content.push(part(b, vision))
    }
    const blocks = call === undefined ? undefined : sealed?.(call)
    if (content.length > 0) out.push({ role: msg.role, content: blocks === undefined ? content : interleave(content, blocks), ...(call !== undefined && sealed !== undefined && blocks === undefined ? { unsealed: true as const } : {}) })
  }
  return out
}

// A map of the latest 256 entries within `limit` summed `size`; a key is set once.
function recent<V>(size: (v: V) => number, limit: number) {
  const map = new Map<string, V>()
  let total = 0
  return {
    get: (key: string) => map.get(key),
    set(key: string, v: V) {
      map.set(key, v)
      total += size(v)
      for (const [oldest, gone] of map) if (map.size > 256 || total > limit) (map.delete(oldest), (total -= size(gone)))
    },
  }
}

// The provider's own id behind each tool call styx minted, the latest 256, given back only to the provider
// that made it (another kind may reject its form).
export function remoteIds() {
  const ids = recent<{ provider: string; id: string }>(() => 0, Infinity)
  return {
    remember: (provider: string, minted: string, id: string) => ids.set(minted, { provider, id }),
    of: (provider: string) => (minted: string) => {
      const hit = ids.get(minted)
      return hit?.provider === provider ? hit.id : undefined
    },
  }
}

const THINKING_MAX_BYTES = 8 * 1024 * 1024
const bytesOf = (blocks: readonly Placed[]) => blocks.reduce((n, { block: b }) => n + (b.type === 'thinking' ? b.thinking.length + b.signature.length : b.data.length), 0)

// The thinking blocks of the turn that made each tool call styx minted (none, when the model did not think),
// the latest 256 calls within 8 MiB (counted once per call), given back only to the model that wrote them.
export function thinkingStore() {
  const turns = recent<{ owner: string; blocks: readonly Placed[] }>(t => bytesOf(t.blocks), THINKING_MAX_BYTES)
  return {
    seal: (owner: string, calls: readonly string[], blocks: readonly Placed[]) => calls.forEach(c => turns.set(c, { owner, blocks })),
    sealed: (owner: string) => (minted: string) => {
      const hit = turns.get(minted)
      return hit?.owner === owner ? hit.blocks : undefined
    },
  }
}
