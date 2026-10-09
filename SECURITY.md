# Security policy

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not
open a public issue. Include the styx commit, `claude --version`, `bun --version`, and the steps that reproduce it.

Fixes land on `main`; there are no maintained release branches.

## Scope

These are in scope:

- The key command (`auth.command`): how styx runs it, caches its output, and keeps the key out of argv, logs and the
  agent's environment.
- The approval prompt: any way to route a conversation to a provider, base URL or key command the user did not approve.
- The helper's socket and token: any way for another process to reach the helper or replay a call.
- Upstream requests: TLS and `allowHttp` handling, redirects, and what styx sends a provider beyond the conversation.

These are out of scope:

- What a provider does with the data you choose to send it.
- Claude Code's own Bash tool reading a same-user keyring item (a documented limit; see the README's
  [Security](README.md#security) section).
