# Contributing to styx

This page covers developing styx, a Claude Code mod. The [README](README.md) covers what styx does and how to use it,
and [docs/CONFIG.md](docs/CONFIG.md) has every config key.

## Prerequisites

- Claude Code and Bun at the versions in the README's [What you need](README.md#what-you-need).
- Run `bun install` once to get the dev dependencies (`typescript`, `@types/bun`).

## The dev loop

Install the mod from your checkout, as in step 1 of the README's [Quickstart](README.md#quickstart). Claude Code
loads styx from that folder through the local marketplace. Edits apply at the next session, or when you run
`/reload-plugins`. To pick up a change to `styx.json` alone, `/styx reload` is enough.

## The gates

Run all of these before you send a change:

```sh
claude plugin validate .
claude plugin test .
bun run typecheck          # tsc for the mod, then for styxd and the scripts
bun run test:harness
bun run test:styxd
bun run check:test-data
bun run check:schemas
```

CI runs `check:test-data`, `test:styxd` and `test:harness` on macOS and Linux. The rest need the types Claude Code
writes beside an installed mod, so they run only on your machine.

## Regenerating files

- After a Claude Code upgrade, run `bun scripts/gen-schemas.ts`. It regenerates `hooks/schemas.gen.ts` from the types
  Claude Code writes beside the mod (and the git-ignored `hooks/schemas.mcp.gen.json` when MCP declarations are
  there). `/styx` says when the stamp is stale.
- After you edit `example.styx.json`, run `bun scripts/gen-test-data.ts`. It regenerates `tests/fixtures/data.gen.ts`
  from the recorded streams in `tests/fixtures/sse` and from the example, because the `claude plugin test` kit has no
  filesystem.
  `bun run check:test-data` fails when that file is stale.

## The smoke script

`bun scripts/styxd-smoke.ts <alias>` starts styxd and sends one real step to that alias's provider. It runs the
provider's key command and sends a short prompt, so use it on purpose. It ends with one line per step: HTTP status,
tokens in (not cached), out, read from and written to the cache, and how it ended.

- `--tool-loop` offers one fake tool (`get_time`), answers each call and sends the next step.
- `--effort <level>` sets the effort (default `low`).
- `--pad <n>` repeats a filler paragraph in the system prompt, to pass a model's cache minimum.
- `CLAUDE_CONFIG_DIR` picks the config, so you can point it at a scratch directory.
- It exits 1 when a step ends in an error, or when the model is still calling tools after five steps.

## Conventions

- Every behaviour fix ships with a test that fails before the fix and passes after it.
- No hooks module is over 400 lines (generated tables aside). styxd's production code stays within 1,320 lines in
  all. `styxd/budget.spec.ts` enforces both.
- Only `hooks/register.ts` touches the engine's `$` object. Other modules work through ports it passes in.
- Vendor quirks live in config, never in code branches that test for a vendor.
- No secrets in tests or fixtures.
- Clean room, as the README's [Credits and license](README.md#credits-and-license) states it. styx reads nothing
  from the Claude Code binary. A prompt or tool text that styx adds is written by styx, and the input schemas of Claude
  Code's tools come from `bun scripts/gen-schemas.ts` alone. Where code must recognise one of Claude Code's own lines,
  it matches the words that identify the line, and a fixture quotes no more of the line than the matcher needs
  (`tests/fixtures/handback.ts`).
- Commit messages follow Conventional Commits (`fix: …`, `feat: …`, `docs: …`).
