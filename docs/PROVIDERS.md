# Provider cookbook

You bring the API key, and styx routes to the provider. Each recipe is one entry under `providers` in
`~/.claude/styx.json`, plus an alias if you want a short name. Every key is explained in [CONFIG.md](CONFIG.md). Model
ids and limits change: copy them from the provider's current model list, not from here.

| Recipe | Kind | Status |
| --- | --- | --- |
| [OpenAI](#openai) | `openai` | the shipped example; the `openai` kind was used live on a self-hosted gateway and on Bedrock's OpenAI endpoint, not run against OpenAI itself |
| [OpenRouter](#openrouter) | `openai` | same code path; not run against OpenRouter |
| [Anthropic API](#anthropic-api) | `anthropic` | tested offline and live on a gateway's Messages endpoint; not run against api.anthropic.com |
| [Amazon Bedrock](#amazon-bedrock) | `openai` or `bedrock` | live-tested (Claude, GPT, Kimi, Grok) |
| [Any OpenAI-compatible endpoint](#any-openai-compatible-endpoint) | `openai` | used live on a self-hosted gateway; Ollama and vLLM not run |

Claude on the `anthropic` and `bedrock` kinds takes `thinking` and effort params and a `cache` key. styx sends the
signed thinking blocks of a tool turn back with the tool results. See [Thinking](CONFIG.md#thinking) and
[Prompt cache](CONFIG.md#prompt-cache).

## Keys

Every provider needs an `auth.command`: a command whose output is the key. The simplest is the Keychain item that
`bun run auth login <provider>` writes. Run it in the `claude-styx` folder.

```sh
bun run auth login openai                  # asks for the key (hidden), stores it, reads it back, prints the auth line
bun run auth login openai --write-config   # the same, and writes that line into providers.openai (already in styx.json)
bun run auth list openai                   # says whether the item exists; never prints the key
bun run auth logout openai                 # removes the item; styx.json is left as it is
```

- On macOS the command is `/usr/bin/security find-generic-password -s styx -a <provider> -w`. The key reaches
  `security` on stdin, never on a command line. A key holding `"` or `\` is refused, with the way to store it by hand.
- On Linux the command is `secret-tool lookup service styx provider <provider>`, with `secret-tool`'s absolute path.
  With no `secret-tool`, `login` prints lines for `pass` and `op read` and exits 1.
- Any other store works if its command has an absolute path and prints the key.

```json
"auth": { "command": ["/usr/bin/pass", "show", "styx/openai"] }
```

```json
"auth": { "command": ["/usr/bin/jq", "-er", ".openai.key", "/path/to/opencode/auth.json"], "ttlSeconds": 600 }
```

Nothing expands `~` or searches `PATH`: write the full path (`command -v pass` prints it). A server that checks no key
(a local Ollama) takes `"auth": "none"` in place of the command. styx then sends no key and runs nothing.

## OpenAI

This is the provider in `example.styx.json`. OpenAI's reasoning models reject `max_tokens`, so the model sets
`"maxTokensParam": "max_completion_tokens"`. Leave `maxTokensParam` out to send neither. The `effort` map sends
`reasoning_effort`, and a session at `xhigh` or `max` resolves to `high`.

```json
"openai": { "kind": "openai", "baseUrl": "https://api.openai.com/v1",
            "auth": { "command": ["/usr/bin/security","find-generic-password","-s","styx","-a","openai","-w"] },
            "models": {
              "gpt-5": { "contextWindow": 400000, "maxInputTokens": 272000, "maxOutputTokens": 128000,
                         "maxTokensParam": "max_completion_tokens",
                         "effort": { "low":    { "reasoning_effort": "low" },
                                     "medium": { "reasoning_effort": "medium" },
                                     "high":   { "reasoning_effort": "high" } } } } }
```

```json
"aliases": { "gpt": { "target": "openai/gpt-5", "note": "OpenAI GPT-5 on your own API key" } }
```

## OpenRouter

Model ids look like `vendor/name`, and that works as a model key.

```json
"openrouter": { "kind": "openai", "baseUrl": "https://openrouter.ai/api/v1",
                "auth": { "command": ["/usr/bin/security", "find-generic-password", "-s", "styx", "-a", "openrouter", "-w"] },
                "models": { "openai/gpt-4.1": { "contextWindow": 1047576, "maxOutputTokens": 32768, "maxTokensParam": "max_tokens" } } }
```

An alias splits at the first `/` only, so `openrouter/openai/gpt-4.1` is provider `openrouter`, model `openai/gpt-4.1`.

```json
"aliases": { "gpt41": "openrouter/openai/gpt-4.1" }
```

## Anthropic API

Native turns use your Claude login and need no styx. Use this recipe to route to the Anthropic API on another API key,
such as a different organization's.

```json
"anthropic": { "kind": "anthropic", "baseUrl": "https://api.anthropic.com",
               "auth": { "command": ["/usr/bin/security", "find-generic-password", "-s", "styx", "-a", "anthropic", "-w"] },
               "models": { "claude-sonnet-5-5": { "contextWindow": 1000000, "maxOutputTokens": 64000, "cache": "5m",
                                                  "effort": { "low":  { "thinking": { "type": "adaptive" }, "output_config": { "effort": "low" } },
                                                              "high": { "thinking": { "type": "adaptive" }, "output_config": { "effort": "high" } } } } } }
```

The key goes in the `x-api-key` header, and every request carries `anthropic-version: 2023-06-01`. Set
`"authHeader": "bearer"` for a gateway that wants a Bearer token. The `baseUrl` has no `/v1`: styx adds `/v1/messages`.
The `anthropic` kind has been run live against a gateway's Messages endpoint and against recorded Messages streams, not
against api.anthropic.com.

## Amazon Bedrock

Live-tested on 2026-10-07 with a long-term API key. Each row streamed a counting answer in full. In the region tested,
these models were reachable only through `global.` inference profiles. If a request fails, `claude --debug`
shows the `styx step` line with the HTTP status.

| Family | Model id (global inference profile) | `bedrock` kind | `openai` kind |
| --- | --- | --- | --- |
| Claude Sonnet 5.5, Sonnet 4.6, Opus 5.5, Haiku 4.5 | `global.anthropic.claude-sonnet-5-5`, `…-sonnet-4-6`, `…-opus-5-5`, `…-haiku-4-5-20251001-v1:0` | works | not offered by AWS |
| GPT-5.6 Luna | `global.openai.gpt-5.6-luna` | works (recommended: one provider for every family) | works |
| GPT-6 Luna, Sol | `global.openai.gpt-6-luna`, `global.openai.gpt-6-sol` | works | 403 on the account tested (a Marketplace entitlement for the `/openai/v1` path) |
| Kimi K3 | `global.moonshotai.kimi-k3` | works | works (AWS recommends this kind for multi-turn) |
| Grok 4.7 | `global.xai.grok-4.7` | works | works |

Tool loops (two steps, a tool result between them) were run on 2026-10-08 against Claude Sonnet 5.5 and Haiku 4.5 with
thinking on, the prompt cache on, and the signed thinking carried over. Both steps answered 200, and the second read the
first's cache.

Bedrock accepts an API key as `Authorization: Bearer`, which is how the `bedrock` kind sends it. A short-term key lasts at most
12 hours, so set `ttlSeconds` below the key's life and use a key command that mints a fresh one. A long-term key is an IAM
service credential. The region is part of the `baseUrl`; there is no `region` key.

**GPT on the `bedrock` kind.** Measured on GPT-5.6 Luna, 2026-10-08:

- Effort goes in `additionalModelRequestFields.reasoning.effort` (`none`, `low`, `medium`, `high`, `xhigh`, `max`;
  `minimal` is refused). `reasoning_effort` is an unknown parameter on Converse. Reasoning tokens are not reported
  separately on this path.
- Caching is implicit. Repeated prefixes read from cache with no markers, and the cache is shared with the `openai`
  kind. Do not set `cache` on a GPT model: Bedrock answers an explicit `cachePoint` with HTTP 403 ("did not allow
  prompt caching"). `cache` is for Claude.

```json
"global.openai.gpt-5.6-luna": { "contextWindow": 1050000, "maxInputTokens": 922000, "maxOutputTokens": 128000,
  "effort": { "low":   { "additionalModelRequestFields": { "reasoning": { "effort": "low" } } },
              "xhigh": { "additionalModelRequestFields": { "reasoning": { "effort": "xhigh" } } } } }
```

**Claude: the `bedrock` kind.** styx streams the Converse API (`ConverseStream`). It posts to
`<baseUrl>/model/<model id>/converse-stream` and encodes the id, so `:` becomes `%3A`. Use the model id or inference
profile id from the Bedrock console. The kind always sends `maxOutputTokens` as the max-tokens value.

```json
"bedrock": { "kind": "bedrock", "baseUrl": "https://bedrock-runtime.us-east-1.amazonaws.com",
             "auth": { "command": ["/usr/bin/security", "find-generic-password", "-s", "styx", "-a", "bedrock", "-w"], "ttlSeconds": 3000 },
             "models": { "global.anthropic.claude-sonnet-5-5": { "contextWindow": 1000000, "maxOutputTokens": 32000, "cache": "5m",
                                                                  "effort": { "low":  { "additionalModelRequestFields": { "thinking": { "type": "adaptive" }, "output_config": { "effort": "low" } } },
                                                                              "high": { "additionalModelRequestFields": { "thinking": { "type": "adaptive" }, "output_config": { "effort": "high" } } } } } } }
```

Claude Haiku 4.5 thinks only with a budget: `"additionalModelRequestFields": { "thinking": { "type": "enabled", "budget_tokens": 4096 } }`.
Its cache needs a prefix of 4,096 tokens or more.

**Non-Claude models: the `openai` kind.** bedrock-runtime has an OpenAI-compatible endpoint, which AWS recommends.
`https://bedrock-mantle.<region>.api.aws/v1` is the other one. Claude is not on Chat Completions.

```json
"bedrock-oss": { "kind": "openai", "baseUrl": "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
                 "auth": { "command": ["/usr/bin/security", "find-generic-password", "-s", "styx", "-a", "bedrock-oss", "-w"], "ttlSeconds": 3000 },
                 "models": { "openai.gpt-oss-120b-1:0": { "contextWindow": 128000, "maxOutputTokens": 32768, "maxTokensParam": "max_tokens" } } }
```

The limits above are placeholders. Copy each model's limits from its Bedrock model card. Extra Converse fields go in `params`
(for example `additionalModelRequestFields`). `messages`, `system` and `toolConfig` are styx's own and are refused there.

## Any OpenAI-compatible endpoint

A local server (Ollama, vLLM) or a gateway in front of other models (a LiteLLM proxy, say) works with the `openai`
kind. Point `baseUrl` at the server's `/v1`. For a gateway that also serves the Messages API, the `anthropic` kind
works too (see [Anthropic API](#anthropic-api)).

Ollama and vLLM serve `/v1/chat/completions` over plain http, so the provider needs `allowHttp`. The address must be a
DNS name or an IP: `127.0.0.1`, or a LAN or VPN name, never `localhost`.

```json
"ollama": { "kind": "openai", "baseUrl": "http://127.0.0.1:11434/v1", "allowHttp": true,
            "auth": "none",
            "models": { "your-model:8b": { "contextWindow": 32768, "maxOutputTokens": 8192, "maxTokensParam": "max_tokens" } } }
```

- Use your server's model id (`ollama list` prints Ollama's). Set `contextWindow` to what the server loads: Ollama's
  `num_ctx`, vLLM's `--max-model-len`. Ollama's default is small.
- vLLM needs `--reasoning-parser` for a reasoning model, or its `<think>` text arrives as ordinary text. With
  `--api-key` it checks a key: use an `auth.command` (`bun run auth login vllm`) in place of `"none"`.
- `"none"` sends no key, so over plain http the approval prompt warns that anyone on the path can read or alter
  prompts and answers. A gateway on a private network also takes `allowHttp`; its approval prompt warns that the key
  and your data travel unencrypted ([`auth`](CONFIG.md#providers)).
- A gateway key limited to some models answers the others with one line that lists the models it may use.
- The first step on a self-hosted model is slower: see
  [TROUBLESHOOTING.md](TROUBLESHOOTING.md#the-provider-and-the-network).
