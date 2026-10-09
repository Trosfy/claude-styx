# Config reference

styx reads one file, `styx.json`, from Claude Code's configuration directory: `$CLAUDE_CONFIG_DIR` when that is set
and not empty, else `~/.claude`. It reads the plugin list (`plugins/installed_plugins.json`) and your agents
(`agents/`) from the same directory. `/styx reload` re-reads the file. Provider recipes: [PROVIDERS.md](PROVIDERS.md).

**Validation is all-or-nothing.** Any error turns routing off. One toast names the first error, and `/styx` lists all
of them with the next step. While the file is broken, `/model <alias>` (for an alias the file or the last good config
declares) and `/model <provider>/<model>` answer with the error. They never reach the native `/model`. A turn that was
already routed gets the error text and is not sent anywhere else.

## The shipped example

[`example.styx.json`](../example.styx.json) is an OpenAI setup on your own API key: one provider, `openai`, with the
model `gpt-5`, and one alias, `gpt`. It validates as shipped. Its contents, effort map included, are the
[OpenAI recipe](PROVIDERS.md#openai). Its key command reads the Keychain item that `bun run auth login openai` stores.
On Linux, `bun run auth login openai --write-config` replaces it with the `secret-tool` form ([Keys](PROVIDERS.md#keys)).

## Top-level keys

| Key | Meaning |
| --- | --- |
| `providers` | A map of provider id to provider. |
| `aliases` | A map of alias to target. |
| `version` | Optional. Must be `1`. |
| `$schema` | Accepted for your editor and ignored. |

Any other key is an error.

## Providers

A provider id starts with a lowercase letter and holds lowercase letters, digits and dashes, at most 32 characters.
`native` is not allowed.

| Key | Needed | Meaning |
| --- | --- | --- |
| `kind` | yes | `openai`, `anthropic` or `bedrock`. |
| `baseUrl` | yes | The endpoint's base URL. See below. |
| `auth` | yes | The key command `{ "command": [...], "ttlSeconds": 300 }`, or `"none"` for a server that checks no key. See below. |
| `models` | yes | A map of model id to model. At least one. |
| `allowHttp` | no | `true` allows an `http:` `baseUrl` for this provider only. Default `false`. |
| `headers` | no | Extra request headers. Names holding `auth`, `key`, `token`, `secret`, `password`, `credential`, `cookie`, `session` or `signature` (any case) are refused. Values are printable ASCII. |
| `params` | no | Body keys merged into every request. |
| `timeoutMs` | no | A positive integer, at most 2,147,483,647 (about 24 days). See "Timeouts" below the table. |
| `maxTools` | no | A positive integer. Default `128`. Tools past the cap are dropped, and `/styx` lists them. |
| `streamUsage` | no | `openai` kind only. Default `true`: sends `stream_options.include_usage`. |
| `authHeader` | no | `anthropic` kind only: `bearer` or `x-api-key`. Default `x-api-key`. The other kinds send `Authorization: Bearer`. |

A key that belongs to another kind is an error (`providers.<id>.<key>: unknown key`). `apiKeyEnv` was retired: it
gets an error that names `bun run auth login <id>`.

**`baseUrl`.** It must be an `https` URL. An `http` URL needs `allowHttp: true`. The URL must not have credentials, a
query, a fragment, a backslash, whitespace, or any of `[ ] { }` (URL templates and IPv6 literals are not supported). The host must be a DNS name
with at least two labels, or an IPv4 address: `127.0.0.1` is fine and `localhost` is refused. A port is fine.
Trailing slashes are dropped. styx requests `<baseUrl>` plus the kind's path:

| Kind | Path added |
| --- | --- |
| `openai` | `/chat/completions` |
| `anthropic` | `/v1/messages` (and the header `anthropic-version: 2023-06-01`) |
| `bedrock` | `/model/<model id, URL-encoded>/converse-stream` |

**`auth`.** The key always comes from a command. There is no environment-variable form (`auth.env` is an error).

- `command` is a non-empty list of strings. The first is an absolute path: nothing expands `~` or searches `PATH`.
  No entry may hold a control character.
- styx runs it with no shell, its stdin closed and a 10 s limit. Its trimmed output is the key: 1 to 4096 visible
  ASCII characters, no spaces. The key is never logged.
- It runs only after you approved the provider, and only when a step needs a key. Startup and `/styx` run nothing.
- `ttlSeconds` is a positive integer, default `300`: how long styxd keeps the key in memory. When the provider
  answers a cached key with 401 or 403, styx drops it, runs the command once more and retries before any output.
- Examples: [Keychain, `secret-tool`, `pass`, `op read`](PROVIDERS.md#keys).
- `"auth": "none"` is for a server that checks no key (a local Ollama or vLLM). styx runs no command and sends no
  `Authorization` or `x-api-key` header. You still approve the provider once, and a changed `auth` (command to
  `"none"`, or back) asks again. Over plain http the prompt warns that anyone on the path can read or alter prompts
  and answers. `bedrock` always needs a key, so `"none"` is an error there. The spelling is exact: `"None"` is an error,
  and a token never goes in `styx.json`. A server that turns out to want a key answers 401, and styx says so.

**Timeouts.** Without `timeoutMs`, a request is cut when no data arrives for 600 s (the stall window) or after 1,800 s
in all. With `timeoutMs`, the whole-request bound is that many milliseconds and the stall window is the smaller of 600 s
and `timeoutMs`. Connecting is bounded at 15 s.

## Models

A model id is any non-empty string, sent to the provider as it is. It may hold `/` or `:` (`openai/gpt-4.1`,
`openai.gpt-oss-120b-1:0`).

| Key | Needed | Meaning |
| --- | --- | --- |
| `contextWindow` | yes | A positive integer: the model's window in tokens. |
| `maxOutputTokens` | yes | A positive integer. |
| `maxInputTokens` | no | A positive integer, at most `contextWindow`. |
| `effort` | no | A map of level to body params. See [Effort](#effort). |
| `cache` | no | `anthropic` and `bedrock` kinds: `"5m"` or `"1h"`, how long the provider keeps the prompt cached. Absent is off. See [Prompt cache](#prompt-cache). The `openai` kind caches on its own and refuses the key. |
| `tools` | no | Default `true`. `false` sends no tools, `SubagentHandback` included ([how such a subagent reports](TROUBLESHOOTING.md#which-subagents-run-on-an-alias)). |
| `vision` | no | Default `true`. `false` turns images into a text note. |
| `params` | no | Body keys merged into every request to this model. |
| `headers` | no | Extra headers for this model. They win over the provider's. |
| `maxTokensParam` | no | `openai` kind only: `max_tokens` or `max_completion_tokens`. Without it, no max-tokens key is sent. |
| `systemRole` | no | `openai` kind only: `system` (default), `developer`, or `user` (sent as a first message that starts "System instructions:"). |
| `parallelToolCalls` | no | `openai` and `anthropic` kinds. Default `true`. `false` sends `parallel_tool_calls: false` (openai) or `disable_parallel_tool_use` (anthropic). |

The `anthropic` and `bedrock` kinds always send `maxOutputTokens` as the max-tokens value.

**Input budget.** The budget is the smaller of `maxInputTokens` (when set) and `contextWindow` minus `maxOutputTokens`.
The subtraction applies when the request carries a max-tokens value: always for `anthropic` and `bedrock`, and for
`openai` only with `maxTokensParam`. `/model <alias>` is refused above 0.85 of the budget. A step above 0.95 is not
sent: the error says `run /compact`. A conversation's size is the prompt its last routed response reported, while its
transcript has not shrunk since. Otherwise it is an estimate: the request's characters divided by 3.5. A model that
leaves no budget is a config error.

## Request bodies

Each request body is built in this order, and a later step wins. A `null` value deletes the key at any step.

1. The kind's base: the max-tokens key, and the no-parallel-calls flag when it is off.
2. The provider's `params`.
3. The model's `params`.
4. An alias's `params`, when the request goes through an alias that has them. See [Aliases](#aliases).
5. The applied `effort` level's params. An alias's `effort` map replaces the model's whole.
6. styx's own keys, which `params` may not set:

| Kind | Keys styx sets (refused in `params`) |
| --- | --- |
| `openai` | `model`, `messages`, `tools`, `stream`, `stream_options`, `n`, `tool_choice`, `functions`, `function_call` |
| `anthropic` | `model`, `messages`, `system`, `tools`, `tool_choice`, `stream`, `max_tokens` |
| `bedrock` | `messages`, `system`, `toolConfig` |

For `bedrock` the base is `inferenceConfig.maxTokens`, so a `params` entry such as `inferenceConfig.temperature`
merges into it.

## Prompt cache

`cache` on a model of the `anthropic` or `bedrock` kind asks the provider to cache the start of every request. styx puts the
marks where the prefix stops changing. It uses four at most, the providers' limit:

| Kind | Marks | Body field |
| --- | --- | --- |
| `anthropic` | the system prompt, the last tool, the last block of the last two user turns | `cache_control: { "type": "ephemeral", "ttl": "5m" }` (or `"1h"`, the model's `cache` value) |
| `bedrock` | after the system prompt, after the tools, at the end of the last two user turns | `{ "cachePoint": { "type": "default" } }`, with `"ttl": "1h"` for `1h` |

The second user turn from the end holds the mark the previous step wrote. Marking it again lets this step read that
cache even after a step with so many parallel tool calls that the new mark sits more than 20 blocks (the providers'
look-back) past the old one.

A prefix under the model's minimum is not cached, and the request still succeeds. The minimum is 512 tokens for
Sonnet 5.5 and 4,096 for Haiku 4.5 (Bedrock model cards). Tokens read from and written to the cache show in the debug
line as `cache=` and `wrote=`. A model with no `cache` key gets no marks. Changing the effort or the thinking settings
between requests starts a new cache.

## Thinking

Claude takes its thinking settings as body params, so they are config like effort:

| Kind | Where | Example |
| --- | --- | --- |
| `anthropic` | top level of the body | `"thinking": { "type": "adaptive" }`, `"output_config": { "effort": "high" }` |
| `bedrock` | inside `additionalModelRequestFields` | `"additionalModelRequestFields": { "thinking": { "type": "adaptive" }, "output_config": { "effort": "high" } }` |

Claude Sonnet 5.5 and Opus 5.5 think adaptively without a `thinking` param, and their `output_config.effort` takes
`low`, `medium`, `high`, `xhigh` or `max`. On the Claude API they omit the thinking text by default: only the signature
arrives, so nothing shows while they think. `"thinking": { "type": "adaptive", "display": "summarized" }` asks for a
summary. Through Bedrock Converse, a live run with `display: "summarized"` still showed no thinking text, though the
signed block arrived and was carried over. Claude Haiku 4.5 has no effort and takes
`"thinking": { "type": "enabled", "budget_tokens": 4096 }`. The budget must be below `maxOutputTokens`, and validation
checks that wherever the budget is set: model, effort level, provider or alias params.

styx keeps each signed (or redacted) thinking block of a turn that called tools. On the next step it sends them back
in that turn, as the providers require, each in the place it came (`[thinking, text, thinking, call]` goes back as
sent). styxd holds them in memory for the model that wrote them, for the latest 256 calls or 8 MiB, whichever is less.
styxd stays up 65 idle minutes, not 10, when a model or alias sets `"cache": "1h"`, so the signed thinking it holds
outlives the cache.

When a tool turn's blocks are missing (styxd restarted, or another model made the turn) and the request asks for
thinking (`"type": "enabled"` or `"adaptive"`), that one request goes out without the `thinking` param. The step does
not fail, and the debug line says `note="thinking param left out: …"`. A model that thinks by default keeps thinking,
and `"type": "disabled"` is sent as written. A thinking block with no signature (a gateway's model may send one) is
shown and not kept.

## Effort

`effort` maps a level (`low`, `medium`, `high`, `xhigh`, `max`) to a params object. The level in use is, in order, the
`effort` of a `mcp__styx__agent` call or a plain `Agent` call, the `effort` in a custom agent's definition file, then
your session's. styx applies that level when the model declares it. Otherwise it applies the nearest declared level
below it, or the nearest above when none is below. A model with no `effort` map gets none.

To cap effort, declare levels only up to `medium`. Every higher request then resolves to `medium`.

For Claude the level's params carry the provider's own effort field. On the `anthropic` kind:

```json
"effort": { "low":  { "thinking": { "type": "adaptive" }, "output_config": { "effort": "low" } },
            "high": { "thinking": { "type": "adaptive" }, "output_config": { "effort": "high" } } }
```

On the `bedrock` kind the same objects sit inside `additionalModelRequestFields`. Check which levels a model takes in its
model card (`xhigh` and `max` are not on every model); an unsupported level is the provider's error, not styx's.

## Aliases

An alias is a name for a target. It starts with a lowercase letter and holds lowercase letters, digits, dashes and dots,
at most 64 characters, so it can be a model's own name (`gpt-5`). It has no `/`, no leading dot and no `..`.
`fable`, `opus`, `sonnet`, `haiku`, `default`, `inherit` and `native` are taken.

- The value is `"provider/model"` or `{ "target": "provider/model", "note": "..." }`. A note is one line of at most 120
  characters. It shows in the `/model` completions and in the styx agent tool's description.
- An object value may also carry a model's request keys: `params`, `effort`, `cache` and `headers`. They apply only to
  requests made through the alias, so one model can have several aliases that ask for different things. Direct
  `provider/model` targets keep the model's own. Params are checked like the model's: the same reserved keys for the
  target's kind, and the same `cache` rule. `params` merge in the order above and `null` deletes a key at any layer;
  `headers` merge over the model's; `effort` and `cache` replace the model's, and `"cache": null` on an alias turns off
  the cache its model sets. A `native/` target takes none of them.
- A route keeps the name it was made with: `/model <alias>`, the styx agent tool and a plain `Agent` call under a routed
  parent store the alias, and each step resolves it again, so the alias's params, effort map, cache and headers are on
  every request made through it.
- `provider/model` works wherever an alias does. It splits at the first `/`, so `openrouter/openai/gpt-4.1` is provider
  `openrouter`, model `openai/gpt-4.1`.
- `native/<model>` names a native model. `/model native/sonnet` switches to it, and an alias may target it.
- A target must name a declared provider and model, or validation fails with the path.

```json
"aliases": {
  "sonnet55-fast": { "target": "bedrock/global.anthropic.claude-sonnet-5-5",
                     "effort": { "low": { "additionalModelRequestFields": { "thinking": { "type": "adaptive" }, "output_config": { "effort": "low" } } } } },
  "sonnet55-deep": { "target": "bedrock/global.anthropic.claude-sonnet-5-5", "cache": "1h",
                     "effort": { "high": { "additionalModelRequestFields": { "thinking": { "type": "adaptive" }, "output_config": { "effort": "high" } } } } }
}
```

Both aliases name one model. The first always asks for low effort and does not cache (the model has no `cache`); the
second asks for high effort and caches for an hour. A level an alias does not declare resolves to the nearest it does.

## Managed policy

styx reads Claude Code's managed policy settings when it loads the config.

- A provider whose host `sandbox.network.allowedDomains` leaves out is a config error.
- So is a provider whose host a `permissions.deny` rule names: `WebFetch`, `WebFetch(domain:<host>)`, or a wildcard such as
  `WebFetch(domain:*.example.com)`.
- Managed settings that cannot be read are a config error, so no host goes unchecked. No managed settings is no error.
- A policy that only allows (`permissions.allow` rules, no deny) is not read as excluding other hosts.

styx's requests do not go through WebFetch. They leave from the helper process, so styx checks the policy itself, once,
when it loads the config.

## Development

Generators, the smoke script and the test gates are in [CONTRIBUTING.md](../CONTRIBUTING.md).
