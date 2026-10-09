<h1 align="center">styx</h1>

<p align="center"><b>Bring your own API key to Claude Code, and keep your Claude subscription</b><br>
Claude Code 2.1.292 or later (tested on 2.1.293) and Bun · macOS or Linux · MIT license</p>

styx is a Claude Code mod, a plugin built on Claude Code's function hooks. Your Claude login and subscription keep
serving native turns. With your own API key for OpenAI, OpenRouter, the Anthropic API, Amazon Bedrock or any
OpenAI-compatible endpoint (a local Ollama or vLLM included), you can send the main conversation (`/model <alias>`) or
a subagent to that provider. Claude Code still runs your tools, and the key stays in your OS keyring.

## Quickstart

1. Install the mod. Clone this repository into a folder you will keep, since Claude Code loads styx from there. You
   do not need `bun install`; the dev dependencies are for contributors. To update, run `git pull` in the folder, then
   `/reload-plugins`.

   ```sh
   git clone https://github.com/Trosfy/claude-styx.git /path/to/claude-styx
   claude plugin marketplace add /path/to/claude-styx
   claude plugin install styx@claude-styx
   ```

2. Copy the example config. It defines one provider, `openai`, and one alias, `gpt`. (The folder is
   `$CLAUDE_CONFIG_DIR` when that is set.)

   ```sh
   cd /path/to/claude-styx
   cp example.styx.json ~/.claude/styx.json
   ```

3. Store your key. In the same folder, run the command below. It asks for the key without echoing it, stores it in
   the macOS Keychain (`secret-tool` on Linux) and reads it back. On Linux, add `--write-config` so it also writes the
   matching key command into your config.

   ```sh
   bun run auth login openai
   ```

4. Start a new Claude Code session, or run `/reload-plugins`.
5. Type `/model gpt`. The first time, styx asks you to approve the provider's address and key command. Choose
   **Allow**. The status line then reads `gpt · openai`. Type `/model opus` (or any native model) to go back.

For another provider, edit the config. [docs/PROVIDERS.md](docs/PROVIDERS.md) has a recipe for each one, and
[docs/CONFIG.md](docs/CONFIG.md) explains every key.

### Let your AI set it up

Start Claude Code in the `claude-styx` folder and paste this:

```text
Set up styx for me: follow docs/AI_SETUP.md in this folder.
```

The assistant checks for Bun, writes a `styx.json` for the provider you describe and gives you the command that
stores your key. You type the key yourself, so the assistant never sees it, and only you can approve a provider.
[docs/AI_SETUP.md](docs/AI_SETUP.md) has the steps it follows.

## What does it do?

- It moves the main conversation. `/model gpt` runs the next turns on `openai/gpt-5`, billed to your API key.
  `/model opus` moves back, and the conversation comes with you.
- It runs subagents on another model, through the `mcp__styx__agent` tool. Explore, Plan and general-purpose get
  prompts that styx wrote for them (they are in `hooks/agents.ts`; Anthropic did not write them). To use your own
  prompt for one, add an agent file whose `name:` is the type, for example `name: Explore`, and styx uses that file
  instead (a file styx cannot read keeps the type off the alias). Your custom agents keep their own files. Each
  subagent names the routed model as its identity, not Claude.
- It keeps your tools local. Tool calls run in Claude Code and go through the usual permission checks; only the model
  runs elsewhere. styx never reroutes your Claude login or its traffic.
- It keeps keys out of Claude Code. A credential helper (the macOS Keychain, say) hands the key to a helper process;
  [Security](#security) says where the key never goes.

## What you need

| | |
| --- | --- |
| Claude Code | 2.1.292 or later. The tool schemas (`hooks/schemas.gen.ts`, generated from the types Claude Code writes beside the mod) are for 2.1.293; on another build `/styx` says when they are stale. |
| Bun | 1.3.11 tested. The helper process runs on it. styx needs no packages at run time. |
| A provider | An endpoint that speaks one of the [three kinds](#which-provider-kind-should-i-pick), a model id and an API key. |
| A keyring | The macOS Keychain, or `secret-tool` on Linux. Any command that prints the key also works (`pass`, `op read`). |
| System | macOS or Linux, with `/usr/bin/curl`. Optional: `git` and `trash`, for subagents that work in a git worktree. |

## Which provider kind should I pick?

A provider's `kind` is the protocol it speaks. If you are unsure, pick `openai`, which most endpoints speak.

| Kind | Pick it for | styx calls | Status |
| --- | --- | --- | --- |
| `openai` | OpenAI, OpenRouter, Ollama, vLLM, other OpenAI-compatible servers and gateways, Bedrock's non-Claude models | `<baseUrl>/chat/completions` | used live on a self-hosted gateway and on Bedrock's OpenAI endpoint; not yet run against OpenAI itself |
| `anthropic` | The Anthropic API, a gateway's `/v1/messages` | `<baseUrl>/v1/messages` | live-tested on a gateway; not yet run against api.anthropic.com |
| `bedrock` | Amazon Bedrock: Claude, GPT, Kimi, Grok | `<baseUrl>/model/<id>/converse-stream` | live-tested on all four; tool loops tested on Claude |

Recipes with the URLs: [docs/PROVIDERS.md](docs/PROVIDERS.md).

## Using it

- Switch the main conversation with `/model <alias>`. Tab completes your aliases. `/model opus` (or any native model)
  switches back. A bare `/model` opens the picker and leaves styx. When you leave a route that answered turns, styx
  tells the native model which turns were answered elsewhere, so it does not read them as its own.
- Start a subagent by asking for it by alias ("run an Explore agent on gpt"). Claude calls `mcp__styx__agent`, the
  subagent runs in the background, and its report arrives as a message. Add `isolation: "worktree"` to give it a git
  worktree of its own. While main is native, allow `mcp__styx__agent` in `/permissions` to skip the dialog.
- While main runs on an alias, a plain `Agent` call with no `model` runs on that alias too, as Claude Code runs a
  subagent on its parent's model; some calls stay native. Forks work where Claude Code offers them, auto mode
  included: a fork of a routed parent runs on its parent's alias or styx refuses it, and a fork of a native parent
  stays native. [Which subagents run on an alias](docs/TROUBLESHOOTING.md#which-subagents-run-on-an-alias) has the
  rules.
- `/styx` shows the state: providers (kind, address, key state, approved), aliases with their effort levels, routed
  subagents, and each recent step's time and tokens. `/styx reload` re-reads `styx.json`.
- A routed request uses your session's effort, mapped to the nearest level the model declares
  ([Effort](docs/CONFIG.md#effort)). Claude models on the `anthropic` and `bedrock` kinds can also use the prompt cache
  and think with signed blocks carried across tool calls ([Thinking](docs/CONFIG.md#thinking)).

Every styx error is one line that ends with its fix, and `/styx` names the next step when something is wrong.
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) lists each message and explains the `styx step` line that
`claude --debug` logs.

## How does it work?

<p align="center"><img src="docs/media/how-it-works.svg" width="860" alt="A Claude Code turn that names a styx alias goes through the styx mod to styxd, which calls an openai, anthropic or bedrock provider with your API key from the Keychain. A turn on a native model goes straight from Claude Code to Anthropic on your Claude subscription, unchanged."></p>

- The mod decides. A native turn passes through unchanged. When `/model` or the styx agent tool names an alias,
  the mod builds the prompt (the main conversation's own, read from the session with the model's identity
  rewritten; a subagent's as [What does it do?](#what-does-it-do) says) and hands the turn to styxd.
- styxd talks to the provider. It is one helper process per session, started when the session starts (if your config
  declares a provider) and again on use after it exits. It encodes the request for the provider's kind, runs the key
  command, streams the answer back and reports timing and usage. It is ready in about 20 ms and idles at about 20 MB
  (macOS footprint, Bun 1.3.11). It exits after 10 idle minutes (65 when a model or alias
  sets `"cache": "1h"`; see [Thinking](docs/CONFIG.md#thinking)), or when Claude Code does.
- Native requests change in one way: they carry the `mcp__styx__agent` tool definition. That costs one prompt-cache
  miss when styx loads, and another each time the config changes.

## Security

- Keys come from a credential helper only. No key is in the config, the environment, a command line or a log.
  `bun run auth login` passes the key on stdin to the Keychain (`secret-tool` on Linux).
- You approve each provider once. The prompt shows the address and the key command word for word. The approval covers
  kind, address and command, so changing any of them asks again. Until you approve, styx runs no command and sends
  nothing.
- Plain http is opt-in. Set `"allowHttp": true` on that provider only. The prompt warns that the key and your data
  travel unencrypted unless the network is private. Redirects are never followed.
- The helper's socket is private. It sits in a folder only you can open, and every call carries a random token that is
  never in a command line, the environment or a file.
- A routed turn sends everything in it to that endpoint: prompts, files the model reads, tool output. Route only to
  endpoints you may send that data to.
- styx allows some `Agent` calls where Claude Code would ask with no rule or hook behind the question: the ones it
  makes from a routed model's `mcp__styx__agent` call, and a plain `Agent` fork of a routed conversation, which runs
  on its parent's alias or is refused, never natively. Your deny rules, ask rules and hooks still apply. [Which
  subagents run on an alias](docs/TROUBLESHOOTING.md#which-subagents-run-on-an-alias) has the details.
- Limit: Claude Code's Bash tool can read your Keychain item, as it can read any same-user store. Use scoped keys (a
  key limited to the models you route to, where your provider offers that) and deny `security find-generic-password`
  in `/permissions`.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Credits and license

styx is open source under the [MIT License](LICENSE). Its config shape follows OpenCode's provider model. Claude Code
belongs to Anthropic, and styx is an independent mod. styx reads nothing from the Claude Code binary. Each prompt and
tool text it sends a model comes from one of four places: styx itself; you (an agent file's body); the running
session, read through Claude Code's function hooks (the main conversation's prompt, the transcript, the tools'
descriptions); or the types Claude Code writes beside the mod for its authors, from which `hooks/schemas.gen.ts` (the
input schemas of Claude Code's tools) is generated. Where styx must recognise one of Claude Code's own lines, such as
the model notice it rewrites or the report reminder it reads, it matches the words that identify the line.

To remove styx, follow [Remove styx](docs/TROUBLESHOOTING.md#remove-styx). To work on styx itself, see
[CONTRIBUTING.md](CONTRIBUTING.md).
