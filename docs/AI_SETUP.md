# Set up styx (a guide for the AI assistant)

The README's paste prompt sends you here: "Set up styx for me: follow docs/AI_SETUP.md in this folder." You are an AI
coding assistant, and the user wants styx, a Claude Code mod, running with a provider they choose. Work through the
steps in order. Stop at each **Ask** and wait for the answer. Background: [README](../README.md),
[CONFIG.md](CONFIG.md), [PROVIDERS.md](PROVIDERS.md).

## Rules

- **Never handle a key.** Do not ask the user to paste a key into the chat. Do not write one into a file, a command line or
  an environment variable. The user types it into a hidden prompt (step 6).
- **Send nothing to a provider without a yes.** `bun scripts/styxd-smoke.ts` and any `curl` to an endpoint run the key
  command and send a prompt. Ask first, every time.
- **Only you edit `styx.json`.** Leave Claude Code's settings and permissions alone. Suggest rules, never add them.
- **You cannot approve a provider.** The user chooses **Allow** in the prompt styx shows (step 8).
- **Read before you write.** If `styx.json` exists, read it and add to it. Never replace it.

## 1. Check the machine

Run these and report any that fail.

```sh
claude --version        # styx needs 2.1.292 or later; /styx says when its tool schemas are stale
bun --version           # 1.3.11 is tested; styx needs bun to run its helper process
uname -s                # Darwin: Keychain at /usr/bin/security. Linux: also run: command -v secret-tool
ls /usr/bin/curl        # the mod reaches its helper process through this curl
```

If Bun is missing, tell the user to install it from bun.sh. Do not pipe a download into a shell without asking.

## 2. Find the folder

You should be in the `claude-styx` folder, the one that holds `.claude-plugin/plugin.json` and `styxd/main.ts`. If you
are not, find it. Note its absolute path for step 7.

## 3. Ask what to route to

**Ask** in one message:

- Which provider: OpenAI, OpenRouter, the Anthropic API, Amazon Bedrock, or an OpenAI-compatible server (a local Ollama
  or vLLM, or a gateway)?
- Its base URL, and one or more model ids.
- Each model's context window and maximum output tokens. Copy them from the provider's model list. Do not guess them.
- A short alias for each model (`/model <alias>` is what they will type).

Pick the kind with the [README's table](../README.md#which-provider-kind-should-i-pick), and the recipe in
[PROVIDERS.md](PROVIDERS.md). A plain `http://` address needs `"allowHttp": true`. Confirm it is a private network (a
VPN, a LAN or loopback) before you set it. Tell the user the provider's status from the table at the top of
PROVIDERS.md.

## 4. Write the config

The file is `styx.json` in `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Start from `example.styx.json` and the recipe. The
example is an OpenAI provider with the alias `gpt` for the model `gpt-5`, and it needs no edit for that model. For
another model or provider, set:

- the provider id (lowercase letters, digits, dashes) and its `kind` and `baseUrl`;
- `auth.command`, with the same provider id as the Keychain account: `["/usr/bin/security", "find-generic-password", "-s",
  "styx", "-a", "<provider id>", "-w"]` on macOS;
- each model's limits, an `effort` map only if the provider takes one, and `cache` for Claude on the `anthropic` or
  `bedrock` kind;
- an `aliases` entry for each alias.

## 5. Check the config without calling anything

Run this in the `claude-styx` folder. It reads the file and prints every error, or `styx.json: ok`.

```sh
bun -e 'import { parseConfig } from "./hooks/config.ts"; const p = `${process.env.CLAUDE_CONFIG_DIR || process.env.HOME + "/.claude"}/styx.json`; const r = parseConfig(await Bun.file(p).text()); console.log(r.errors.length ? r.errors.join("\n") : "styx.json: ok")'
```

Fix what it prints and run it again. It does not check an organization's managed policy; styx does that when it loads.

## 6. Store the key

**Ask** the user to run this in their own terminal window, in the `claude-styx` folder, and to say when it is done:

```sh
bun run auth login <provider id>
```

It asks for the key without echoing it, stores it in the Keychain (`secret-tool` on Linux) and reads it back. The
example's key command works on macOS only, so on Linux have the user add `--write-config`, which writes the matching
`secret-tool` command into `providers.<provider id>.auth`. On a machine with neither keyring, it prints `auth.command`
lines for `pass` and `op read`, and you put one in the config instead. A server that checks no key (a local Ollama)
needs none: set `"auth": "none"` in its provider and skip this step.

Then confirm it exists without reading it:

```sh
bun run auth list <provider id>
```

## 7. Install the mod

The current session did not load styx. Installing it changes Claude Code's settings, so the user runs these commands
themselves, using the absolute path from step 2:

```sh
claude plugin marketplace add /absolute/path/to/claude-styx
claude plugin install styx@claude-styx
```

Claude Code then loads styx from that folder in every new session, but not in this one. Tell the user to start a new
Claude Code session (or run `/reload-plugins`) before step 8. If styx is already loaded, `/styx reload` re-reads the
config. These are the install commands from step 1 of the README's
[Quickstart](../README.md#quickstart), with your absolute path filled in.

## 8. First use

Tell the user to type `/model <alias>` (`/model gpt` for the example). styx asks them to approve the provider. The prompt
shows the address and the key command word for word. They read it and choose **Allow**. Then `/styx` shows the provider
as approved, and the status line shows `<alias> · <provider>` (`gpt · openai` for the example). `/model opus` goes back
to Claude.

**Ask** before any live test. A short prompt such as "say hi" sends the conversation to the provider.

## 9. Report

Say what you wrote and where, that styx loads in every new Claude Code session, how to switch and return, and that a
routed turn sends its prompts, files and tool output to the provider. Point at [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
for any `styx:` error line.

You are done when `styx.json` validates, the key is stored, the mod is installed, and nothing went to a provider the
user did not allow.
