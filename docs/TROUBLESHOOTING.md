# Troubleshooting

Every styx error is one line: what failed, then the fix. In the messages below, `<p>` is a provider id, `N` is a
number and `…` is text that varies. Messages that name `styx.json` show the file styx read, written here with the
default path; it follows `$CLAUDE_CONFIG_DIR` when that is set. Run commands that start with `bun run` in the `claude-styx` folder.

**First look.** `/styx` shows the state: providers (kind, address, key state, approved), aliases, routed subagents, the last
steps' timing and tokens, and a `next:` line naming the first fix. `claude --debug` logs one line per routed step:

```text
styx step <who> → <target> kind= http= effort= msgs= tools= bytes= ttfb= total= in= out= cache= wrote= reasoning= finish=
```

`ttfb` is milliseconds to the first byte and `total` the whole step. `in` and `out` are tokens (`in` counts the cached
ones). `cache` and `wrote` are the tokens read from and written to the provider's prompt cache. `effort=max→medium`
means the request asked for `max` and the model's map applied `medium`. `thinking=N` is the number of signed thinking
blocks the step kept for the next one. `note="thinking param left out: …"` means a tool turn's signed blocks were gone
(styxd restarted, for example), so that one request went without the `thinking` param ([Thinking](CONFIG.md#thinking)).

## Setup and the helper process

- **`styx: bun not found — install bun (https://bun.sh), then retry`** Install Bun. styx looks on `PATH` and in `~/.bun/bin`.
- **`styx: styxd did not start (see the debug log); run /styx reload, then retry`** styxd printed no ready line within 3 s.
  Run `bun styxd/main.ts` in the `claude-styx` folder to see why, then `/styx reload`.
- **`styx: styxd crashed twice; routed models paused until /styx reload`** styxd crashed twice within a minute. Read the
  debug log, fix the cause, run `/styx reload`.
- **`styx: styxd did not answer (curl exit N); run /styx reload, then retry`** The helper or its socket is gone. When the
  helper exits without answering and without crashing, styx starts it again and resends the step once; this message
  means that did not help, or curl failed in a way that does not allow a resend. Run `/styx reload`, and check that
  `/usr/bin/curl` exists.
- **`styx: styxd stopped during the step; retry`** The helper ended mid-answer, or crashed under the step. styx does not
  resend a step after a crash, so one step cannot crash the helper twice and pause routing. Retry.
- **`styx: styxd sent a reply styx could not read (see the debug log); run /styx reload, then retry`** The helper answered with
  something other than a stream of events; the debug log has its first line. The helper keeps running. Run `/styx reload`.
- **`styx: styxd refused a call without its token; run /styx reload`** The mod and the helper lost track of each
  other.
- **`styx: N routed steps are already in flight; retry when one ends`** The helper handles 16 at once.
- **`styx: internal error in styxd (see the debug log); retry`** A bug in styxd. The debug log has the first line of the error.
- **A key command never runs, or `/styx` says `not yet run`.** That is normal until the first routed step for an
  approved provider. `/styx` never runs it ([`auth`](CONFIG.md#providers)).

## The config file

- **`styx: routing off, config error: …`** Fix `~/.claude/styx.json`, then `/styx reload`. `/styx` lists every error.
  [CONFIG.md](CONFIG.md) explains each key.
- **`styx · routing off: no ~/.claude/styx.json`** Copy `example.styx.json` there and edit it.
- **`styx: can't switch to <arg>: config error, …`** The same, seen from `/model`. The native model is unchanged.
- **`styx: couldn't switch to <arg> (internal error; see the debug log). Native model unchanged`** A bug in styx's `/model`
  handling. Read the debug log, then retry.
- **`styx: provider "<p>" is not declared (declared: …)`**, **`styx: "<model>" is not declared under provider <p> (…)`**
  and **`styx: "<arg>" is not a styx alias or model`** The name does not match your file. Check the alias and the provider's models.
- **`providers.<p>.auth: missing; run bun run auth login <p>, …`** Every provider needs `auth.command`, or `"auth": "none"` for a
  server that checks no key. Run the command named, or set `"none"`.
- **`providers.<p>.auth: "none" is not allowed on a bedrock provider; Bedrock needs a key`** Bedrock authenticates every request with a key.
  Use `auth.command`.
- **`providers.<p>.apiKeyEnv: no longer read; …`** and **`providers.<p>.auth.env: not supported; …`** Keys come from a command
  only. Run `bun run auth login <p>`, and drop the old key.
- **`providers.<p>.baseUrl: must use https (plain http needs "allowHttp": true on the provider)`** Use https, or set `allowHttp`.
- **`providers.<p>.baseUrl: the host must be a DNS name …`** `localhost` is refused. Use `127.0.0.1` or a real host name.
- **`providers.<p>.<key>: unknown key`** A typo, or a key of another kind (`maxTokensParam` is `openai` only).
- **`…params.<key>: reserved; styx sets it`** Remove it. styx owns that body key.
- **`providers.<p>.baseUrl: <host> is not in the managed policy's sandbox.network.allowedDomains`** and **`… the managed policy
  denies WebFetch to <host>`** Your organization's policy excludes that host. Ask its admin, or use another provider.
- **`…: maxOutputTokens leaves no input budget inside contextWindow`** Lower `maxOutputTokens`, or raise `contextWindow`.

## Keys and approval

- **`styx: <p> key helper failed (exit N): keychain locked, or no key stored? Run bun run auth login <p>`** Unlock the
  Keychain, or store the key.
- **`styx: <p> key helper did not finish (…); unlock the keychain or fix auth.command, then retry`** The command could not start
  or ran past 10 s. Run it by hand and fix it.
- **`styx: <p> key helper printed no usable key (…); run bun run auth login <p>`** A key is 1 to 4096 visible ASCII characters,
  no spaces. Store it again.
- **`styx: provider <p> not approved; native model unchanged. Run /model <arg> again and choose Allow`** and
  **`styx: provider <p> is not approved; run /model <alias> to approve it. The step was not sent`** Approve the provider:
  run `/model <alias>` and choose **Allow**. [Security](../README.md#security) says what an approval covers.
- **`styx agent: provider <p> is not approved; use Agent for a native model`** and **`styx agent: provider <p> is not approved; run
  /model <alias> once and choose Allow`** Run `/model <alias>` once and choose **Allow**, then ask again. A subagent gets
  the second form, because only main can show the approval prompt.
- **`styx: <p> not approved — run /model <alias> to approve it`** The helper was not told of the approval. Run `/model <alias>`.
- **`styx: <p> rejected its key (HTTP 401); store a valid one with bun run auth login <p>, then retry`** The key is wrong or
  expired. Store a new one.
- **`styx: <p> HTTP 403: …; ask the <p> admin for access, or store another key with bun run auth login <p>`** The key may not
  use that route.
- **`styx: <p> wants a key (HTTP 401) but auth is "none"; run bun run auth login <p> and set auth.command, then retry`** The
  server checks a key after all. Run the command named, then set `providers.<p>.auth` to the `command` line it prints
  (`--write-config` does it for you). A 403 from a keyless provider gives the same fix.
- **`styx: your key for <p> can't use <model>; allowed: …`** Pick an allowed model, or ask the gateway's admin for access.
- **A short-term key stops working after a while.** The key command must mint a new one, and `ttlSeconds` must be below
  the key's life ([`auth`](CONFIG.md#providers)).

## The provider and the network

- **`styx: <p> could not connect within 15 s; check the network or VPN, then retry`** and
  **`styx: <p> could not connect (…); check the network or VPN, then retry`** The address is not reachable. Check the VPN
  and `baseUrl`.
- **`styx: <p> stalled (no data for N s); retry`** Nothing arrived for 600 s (less with a small `timeoutMs`). Retry.
- **`styx: <p> timed out after N s; retry, or raise providers.<p>.timeoutMs`** The whole step ran past its bound.
- **`styx: <p> answered with a redirect (HTTP N), which styx does not follow; set providers.<p>.baseUrl to the URL it redirects to`**
  Put the final URL in `baseUrl`.
- **`styx: <p> request failed (…); retry, or see the debug log`** A transport fault.
- **`styx: <p> HTTP 429: …; rate limited: wait, then retry`**, **`… HTTP 5xx …; the provider failed: retry, or pick another
  model`**, **`… HTTP 404 …; check providers.<p>.baseUrl and the model id …`**, and **`… HTTP N …; check the params of <model> in
  styx.json`** The provider's own message follows the status code, and the fix follows the message.
- **`styx: <p> refused the request under its content policy (HTTP N): …`** Rephrase it, or use another model.
- **`styx: <p> blocked the request at its gateway (HTTP N, "…"), before the API answered; …`** An edge rule or firewall rejected
  it. Ask the platform team.
- **`styx: <p> response failed: …; retry, or see the debug log`** The provider sent an error in the stream.
- **`styx: <model> ended the step with no stop; retry`** The stream ended without a finish reason.
- **The first step is slow on a self-hosted model.** The model reads the whole prompt once, every tool definition included.
  Later steps reuse the server's cache.

## Context size

- **`styx: context ~Nk exceeds <target>'s Nk input budget; run /compact`** Compact the conversation. For
  `/model`, the message is **`styx: transcript ~Nk tokens exceeds …; run /compact, then /model <arg>`**. The budget is
  explained in [CONFIG.md](CONFIG.md#models).
- **`styx: tool schemas alone take ~Nk of <target>'s Nk input budget; set "tools": false on the model or use a larger one`**
  The tool definitions take more than half the model's input budget.

## Which subagents run on an alias

- `mcp__styx__agent` starts a subagent on the alias it names. A subagent on an alias starts its own subagents with the
  same tool: styx turns its `mcp__styx__agent` call into an `Agent` call before Claude Code sees it, so the new
  subagent belongs to the one that asked, runs in its permission mode and reports back to it.
- Your `/permissions` rules for `Agent` govern those calls, not the rules for `mcp__styx__agent`. Where Claude Code
  would ask about one of these calls with no rule or hook behind the question, styx allows it. A native `Agent` call
  with `subagent_type: "fork"` from a routed conversation is allowed the same way, because it runs on the parent's
  alias or is refused, never natively. Auto mode's check is that question, and a routed turn cannot get its verdict. A
  deny rule, an ask rule, a hook's ask and every other `Agent` call are untouched.
- A subagent that cannot call `Agent` natively (Explore and Plan), or whose definition leaves out the tool, is not
  offered `mcp__styx__agent`. A routed subagent's tools never exceed its caller's: one started by a subagent whose
  definition leaves out `Bash` has no `Bash` either.
- A plain `Agent` call follows its parent. While main is on an alias, an `Agent` call with no `model` runs on that
  alias. So does a custom agent whose file says `model: inherit` or has no `model`, and a subagent started by a routed
  subagent (unless that one works, or worked, in a worktree).
- Forks work only where Claude Code offers them. Where it does not, `Agent` says the fork type is not found.
- A fork runs on its parent's alias, or styx refuses it. A fork carries its parent's whole conversation, so under a
  routed main or a routed subagent it never runs natively and never on another alias. It is sent its parent's prompt
  (main's, or the one the parent subagent is sent). It takes its parent's effort, since Claude Code ignores a fork's
  own. Its tools never exceed its parent's, and the usual spawn depth applies.
- A fork is sent its parent's history up to and including the turn whose call started it, then its own turns. Claude
  Code saves a fork of main without main's history, so styx rebuilds that history from main's, cut at that call. A
  fork that styx cannot rebuild this way is not sent. styx keeps the rebuilt history for the fork's current run. A fork
  resumed after main was compacted, or after a hooks reload once main was compacted, cannot be rebuilt and fails with
  the inherited-history line below.
- Claude Code offers a fork no `SubagentHandback`, so styx offers it none. A fork's final message is its report, and
  styx tells a routed fork so.
- Claude Code 2.1.294 gives a subagent `SubagentHandback` only in auto permission mode; elsewhere a subagent's final
  text is its report, delivered under the engine's `[Subagent hand-back]` frame. styx offers the tool only when the
  engine's reminder that it delivers through it is in the subagent's transcript, stops offering it after the engine
  refuses a call of it, and lets any call of it through to the engine. A subagent on a model with `tools: false` is
  offered no tool at all; where the engine delivers through `SubagentHandback`, styx hands the subagent's final text back
  as that call.
- styx refuses a fork under a routed parent that it cannot run there: a fork started by a subagent that works in a
  worktree, a fork asked to be isolated, a fork that sets a `cwd`, a fork that is a teammate, a workflow agent or another plugin's spawn, and a
  fork whose parent's route styx cannot read. A fork whose first step comes before styx has claimed it is handed back,
  not run natively. A fork of a native parent stays native, and styx leaves it alone.
- Claude Code reads any spelling of `fork` as a fork, such as `Fork`, `FORK` or `for_k`. styx holds every such spelling
  to the fork rule.
- These stay native: a call that names a model or a `cwd`; an agent file with its own `model`; a teammate and a
  workflow agent; a custom agent whose definition styx cannot read (a plugin loaded with `--plugin-dir`, an
  `--agents` or SDK agent) or finds in two files; a built-in type that two agent files name; and the type styx cannot
  run itself (`comment-thread-analyst`, which builds its prompt from the thread).
- A built-in type runs on the prompt styx wrote for it. One agent file whose `name:` is the built-in type (for example
  `name: Explore`) is used instead, with its `model`, `isolation` and `tools`, as for a custom agent. Two files with
  that name leave the type native, the same rule as for a custom type.
- styx finds an agent by the `name:` in its file, whatever the file is called, in `.claude/agents`, `~/.claude/agents`
  and installed plugins. In `.claude/agents` and `~/.claude/agents`, Claude Code needs both `name:` and `description:`.
  It skips a file without either, so styx skips it too and `/styx` says so. Both ignore a file there with no
  frontmatter, and say nothing of it. A plugin's agent file needs neither field. Its name falls back to the file name,
  and its description to a default. `/styx` also lists each built-in type that runs on an agent file, with the file, and
  each file styx cannot read, since that file may define a built-in type under a name styx cannot see.
- The call's `effort` applies first, then the agent file's, then your session's. A fork takes its parent's.
- An `Agent` call with `isolation: "worktree"`, or an agent file that says `isolation: worktree`, works in the
  worktree Claude Code makes for it, and its prompt names that directory. It stays native if none is made.
- `mcp__styx__agent` reads `subagent_type` as Claude Code reads an `Agent` call's. Another case of a known type runs as
  that type, so `explore` runs as `Explore`. A spelling that matches two agent types when case is ignored is refused.
- When you name the alias through `mcp__styx__agent`, styx runs the type on it when it can reproduce the type.
  Built-in types run on styx's own prompts and `claude` on the main prompt, unless one agent file names the type. A
  custom type with no definition styx reads runs as general-purpose, and `/styx` notes each fallback. A type that two
  files name, a built-in type whose one agent file styx cannot read, `comment-thread-analyst`, an isolation other than
  a worktree, and a start from a subagent that works in a worktree are refused. The same call gets the same answer
  from a native main and from a routed conversation. `subagent_type: "fork"` runs on its caller's model: name that
  alias or none. Any other alias, and a native caller, are refused.

## Routing and subagents

- **`styx: <target> is not available (…); the step was not sent. Fix ~/.claude/styx.json, run /styx reload, or pick another model`**
  and **`styx: <target> is not configured in this session; run /styx reload`** The config changed under a routed turn.
- **`styx: the transcript of <who> is unreadable (…); the step was not sent; retry`** and **`styx: internal error on <target>; …`**
  Retry, or look in the debug log.
- **`styx: <tool> is not available to the <type> subagent`** A routed Explore or Plan asked for a tool its type lacks, such as
  `Write`. The guard denied it. Use a type that has the tool.
- **`styx: could not check <tool> for this subagent, so it was denied; retry, or see the debug log`** Retry.
- **`The server-side auto mode classifier gave no verdict for Agent …`** Claude Code's own message, seen with
  `defaultMode: auto` when a routed main calls `Agent`. The classifier's verdict comes with an Anthropic response, and
  a routed turn has none. Allowing `Agent` does not skip it. Use another permission mode, or `mcp__styx__agent`: styx
  allows the `Agent` calls it makes from that tool, and a plain `Agent` call with `subagent_type: "fork"` from a
  routed conversation, as [Which subagents run on an alias](#which-subagents-run-on-an-alias) describes.
- **`styx: left <alias> (<provider>/<model>)`** Not an error. You picked a native model, so the main conversation is native.
  `/model <alias>` returns.
- **`styx agent: unavailable (…); use Agent`** styx has no valid config. Fix `~/.claude/styx.json` and run `/styx reload`, or
  use the native `Agent` tool.
- **`styx agent: model is required; valid: …`** The call named no model. Name one of the listed models. In a routed
  conversation the line adds that a fork may leave the model out, since a fork runs on that conversation's model.
- **`styx agent: unknown model "…"; valid: …`** The call named a model that is not in the list. Name a listed one.
- **`styx agent: unsupported parameter(s) …; use Agent for them`**, **`styx agent: invalid input: …`** and
  **`styx agent: isolation "…" is not available through styx; …`** Use the supported parameters (`description`,
  `prompt`, `subagent_type`, `model`, `effort`, `name`, `isolation` set to `"worktree"`, `run_in_background`).
- **`styx agent: not available from a native subagent or from inside a spawn; use Agent here`** A subagent on a native model
  starts subagents with `Agent`. One on an alias uses `mcp__styx__agent`, which styx makes an `Agent` call.
- **`styx agent: not offered to the <type> subagent; use a tool it has`** A routed subagent called the styx agent tool, which its
  step did not offer: its type cannot call `Agent` (Explore and Plan), its definition leaves the tool out, or the tool list
  has no `Agent`. Start subagents from a conversation that has the tool.
- **`styx agent: the subagent on <alias> was still starting, so this step was not run; retry`** Starting a subagent on an
  alias took longer than styx waits (5 s). styx handed that subagent's step back instead of running it on Claude Code's
  model. Ask again.
- **`styx: could not check this Agent call, so it was denied; retry, or see the debug log`** styx's own check of an `Agent`
  call failed. Retry.
- **`styx agent: <alias> is not a native alias the Agent tool takes (…); use one of those, or a styx alias`** A subagent can
  name a native model only by `opus`, `sonnet`, `haiku` or `fable`, not by an alias to a full model id.
- **`styx agent: <type> <reason>, so styx cannot run it on <alias>; use another subagent_type or a native model`** styx
  cannot reproduce that agent type on an alias; see [Which subagents run on an alias](#which-subagents-run-on-an-alias).
  `claude --debug` logs which reason applies.
- **`styx agent: a fork runs on its parent's model, and this conversation is native; to fork natively use Agent`** A
  native conversation asked styx for a fork. Fork with `Agent`, and the fork stays native.
- **`styx agent: a fork runs on its parent's model (<alias>), not on <model>; omit model, or name <alias>`** A routed
  conversation asked for a fork on another model (any spelling of `fork` counts; see
  [Which subagents run on an alias](#which-subagents-run-on-an-alias)).
  Leave the model out, or name the conversation's own alias.
- **`styx agent: a fork cannot be isolated through styx; omit isolation`** A fork works in its parent's directory. Leave
  `isolation` out.
- **`styx agent: this fork could not be made an Agent call, so it did not start (see the debug log); retry, or fork with Agent`**
  styx could not turn a routed conversation's fork call into the `Agent` call that runs it on that alias. Retry, or
  call `Agent` with `subagent_type: "fork"`.
- **`styx: this fork was refused: <reason>; a fork runs only on its parent's model, never natively under a routed parent`**
  A fork under a routed parent could not run on that parent's alias, so styx stopped it. The reason names one of the
  refusals in [Which subagents run on an alias](#which-subagents-run-on-an-alias), or a request for another alias than
  its parent's. When the fork had already started, this line is its report. Fork without those options, or use another
  `subagent_type`.
- **`styx: this fork of a conversation on <alias> was still being claimed, so its step was not run natively; retry`**
  Claiming the fork took longer than styx waits (5 s). styx answered its step with this line rather than run the
  parent's conversation on Claude Code's model. Ask again.
- **`styx: the route of the parent of this fork cannot be read; the step was not sent; retry`** A routed fork's step
  needs its parent's prompt, and styx could not read the parent's route. Retry.
- **`styx: this fork's inherited history could not be read, so the step was not sent; use another subagent_type than fork`**
  styx could not rebuild the history the fork inherited. The turn whose call started the fork is gone from its
  parent's history (a compaction), the fork's route has no record of that call (a fork started before an upgrade), or
  the joined messages do not pair each tool call with its result. A request without that history would answer as if
  the conversation had not happened, so styx does not send it. Give the task to another `subagent_type`.
- **`styx agent: subagent_type "<type>" matches more than one agent type (…); name one of them exactly`** Two agent
  types differ only in case. Name the one you mean with its exact spelling.
- **`styx agent: the engine started <type> as <other>, so styx did not run it on <alias>; retry`** A hook changed the
  type of a subagent `mcp__styx__agent` started. The subagent hands this back as its report. Ask again.
- **`styx agent: <reason>, so styx did not run the subagent on <alias>; retry, or use a native model`** A subagent styx started
  could not be run on the model asked for: Claude Code started it on another model, a hook changed its type, or no
  worktree was made for an isolated one. The subagent hands this back as its report. Ask again, or use a native model.
- **`styx agent: <alias> is not configured any more, so the subagent did not start; …`** The config changed between the call
  and the start of its subagent. Fix `~/.claude/styx.json` and ask again.
- **`styx agent: run_in_background false needs a conversation that styx routes; omit it, and the subagent runs in the background`**
  Only a call from main or a subagent on an alias can wait for the subagent's report.
- **`styx agent: effort cannot be set for a native model through styx; …`** Omit `effort` for a native model.
- **`styx agent: isolation "worktree" needs a git work tree, and … is not inside one; omit isolation`**, **`… needs a commit to
  start from …`** and **`styx agent: git worktree add failed: …`** Run in a git repository with a commit, or omit `isolation`.
- **`styx agent: the subagent did not start; retry, or use Agent`** and **`styx agent: internal error (see the debug log); use Agent`**
  Retry, or use the native Agent tool.
- **`styx: kept worktree <path> (branch <b>) of subagent <who>: <why>; merge <b> or remove the worktree`** The subagent left changes
  there, or styx found no `trash` command to move the worktree with. Review them. styx never removes a worktree that has
  changes, and it moves a clean one to the Trash.

## Notes in `/styx`

- **`schemas: generated on <old> · engine <new> · regenerate with bun scripts/gen-schemas.ts`** Claude Code was updated. styx still
  runs. Tools whose schemas it lacks are sent with a permissive schema.
- `~/.cache/styx/agents/` is left over from older versions of styx. styx no longer reads it, and you may remove it.
- **`tools dropped (cap N)`** The provider's `maxTools` cut some tools. Raise `maxTools`, or load fewer MCP tools.
- **`tools dropped (name over 64 chars)`** The API's tool-name rule (64 characters of letters, digits, `_` and `-`) refuses
  those names. Rename the tool in its MCP server.

## What differs from native

- **Caching.** Every step resends the whole context. On the `anthropic` and `bedrock` kinds, a model with `cache` marks it for the
  provider's prompt cache ([Prompt cache](CONFIG.md#prompt-cache)). On the `openai` kind, caching is up to the provider.
- **Reasoning.** It shows live and is not saved in the transcript. Where an endpoint hides it, nothing shows while it thinks.
  styxd keeps Claude's signed thinking for the next step of a tool turn ([Thinking](CONFIG.md#thinking)).
- **Tools.** A routed model sees the same tools as the session, less the main-only ones for a subagent. An MCP tool not yet
  loaded with ToolSearch is not sent until it is.
- **Content.** A document is sent as a placeholder, and an image only to a model with `vision`.
- **The picker and labels.** The `/model` picker does not list aliases. There is no per-message "answered by" label. `/cost`
  prices routed tokens as an unknown model.
- **Not supported.** Interleaved tool-call fragments, and providers that demand a fixed tool-call id shape.

## Remove styx

First remove the stored keys: `bun run auth logout <p>` in the `claude-styx` folder, or
`security delete-generic-password -s styx -a <p>` on macOS. Then run `claude plugin uninstall styx@claude-styx` and
`claude plugin marketplace remove claude-styx`, and trash the `claude-styx` folder, `~/.claude/styx.json` and
`~/.cache/styx/`. Apart from installing the mod, styx changes no Claude Code settings. Its approvals sit in the mod's
own store under `~/.claude`.
