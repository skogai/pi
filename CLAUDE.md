# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Pi is an extensible coding agent harness — a monorepo containing an interactive CLI coding agent (`pi`), its underlying agent runtime, a unified multi-provider LLM API, and a terminal UI library.

## Commands

```bash
npm install --ignore-scripts   # Install deps; never run lifecycle scripts
npm run build                  # Build all packages in dependency order (tui → ai → agent → coding-agent)
npm run check                  # Biome format/lint + pinned-dep check + TS import check + shrinkwrap check + type check
./test.sh                      # Run tests, skipping LLM-dependent ones (recommended)
./pi-test.sh                   # Run pi from sources (works from any directory)
```

Run a single test (from the relevant package root):
```bash
node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

**Do not** run `npm run build` or `npm test` unless explicitly requested. Never run the full vitest suite directly — use `./test.sh` instead.

After any code change (not docs): run `npm run check` in full. Fix all errors, warnings, and infos before committing.

## Architecture

Four workspace packages under `packages/`:

| Package | npm name | Role |
|---|---|---|
| `tui` | `@earendil-works/pi-tui` | Terminal UI with differential rendering; keybindings, autocomplete |
| `ai` | `@earendil-works/pi-ai` | Unified LLM API over 20+ providers (Anthropic, OpenAI, Google, Bedrock, Mistral, …); streaming, OAuth, model registry |
| `agent` | `@earendil-works/pi-agent-core` | Agent runtime: `agentLoop()` (low-level event loop) and `Agent` class (state, steering, follow-up queues, tool execution) |
| `coding-agent` | `@earendil-works/pi-coding-agent` | CLI entry point, session management, four core tools (read/write/edit/bash), extensions API, skills, prompt templates, themes |

**Build order matters**: `tui` and `ai` have no internal deps; `agent` depends on `ai`; `coding-agent` depends on all three.

The agent loop is event-based. `packages/agent/src/agent-loop.ts` drives tool execution turns; `packages/agent/src/agent.ts` wraps it with the higher-level `Agent` class. The CLI in `packages/coding-agent/src/cli.ts` wires up the TUI, providers, and extensions.

Sessions are stored as JSONL trees with compaction for context-window management. The coding agent runs in modes: interactive (default), print (`-p`), JSON, and RPC.

Extensions are TypeScript plugins that add tools, slash commands, UI, and themes. Pi Packages bundle extensions, skills, prompts, and themes and can be sourced from npm or git (see `.pi/`).

## TypeScript Conventions

This repo uses **erasable TypeScript** (Node strip-only mode). The following constructs are **forbidden** in `packages/*/src`, `packages/*/test`, and `packages/coding-agent/examples`:

- `enum` — use `as const` objects instead
- `namespace` / `module`
- Parameter properties (constructor shorthand)
- `import =` / `export =`
- Dynamic `await import()` or inline type imports — top-level imports only
- `any` unless absolutely unavoidable

Use explicit field declarations with constructor assignments, not parameter properties.

## Key Rules (from AGENTS.md)

**Models file**: Never edit `packages/ai/src/models.generated.ts` directly. Update `packages/ai/scripts/generate-models.ts` instead.

**Key bindings**: Never hardcode key checks like `matchesKey(keyData, "ctrl+x")`. Add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`.

**Dependencies**: Direct external deps are pinned to exact versions. Install with `npm install --ignore-scripts`. The pre-commit hook blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set. If `packages/coding-agent/npm-shrinkwrap.json` needs regeneration: `node scripts/generate-coding-agent-shrinkwrap.mjs` (new lifecycle-script deps require an explicit allowlist entry — never add silently).

**Ad-hoc scripts**: Write to `/tmp`, run, edit, remove. Do not embed multi-line scripts in bash commands.

## Git Safety

Multiple pi sessions may run concurrently in the same working directory. Violating these rules destroys other sessions' work:

- Stage only the files you changed: `git add <path1> <path2>` — never `git add -A` or `git add .`
- Never run: `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git commit --no-verify`
- Never force push
- If a rebase conflict is in a file you did not modify, abort and ask the user
- `packages/ai/src/models.generated.ts` may always be included alongside your staged files

Never commit unless the user explicitly asks.

## Testing

- Tests live in `packages/*/test/` and `packages/coding-agent/test/suite/`
- `packages/coding-agent/test/suite/` uses `harness.ts` with a faux provider — no real API calls or keys
- Issue regressions: `packages/coding-agent/test/suite/regressions/<issue-number>-<short-slug>.test.ts`
- If you create or modify a test file, run it and iterate until it passes

## Testing the TUI interactively

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p
tmux send-keys -t pi-test "your prompt here" Enter
tmux kill-session -t pi-test
```

## Changelogs

Each package has `packages/*/CHANGELOG.md`. All new entries go under `## [Unreleased]` using sections: `### Breaking Changes`, `### Added`, `### Changed`, `### Fixed`, `### Removed`. Released version sections are immutable. Read the full `[Unreleased]` section before appending — never duplicate subsections.

## Issues and PRs

- Add `pkg:*` labels for affected packages: `pkg:agent`, `pkg:ai`, `pkg:coding-agent`, `pkg:tui`
- Post comments via `gh issue/pr comment --body-file <tmpfile>` (never `--body` with multi-line markdown)
- Close issues in commits with `fixes #<number>` or `closes #<number>` per issue (do not share one keyword across multiple issue numbers)

## Versioning

Lockstep versioning: all packages share one version. `patch` = fixes + additions; `minor` = breaking changes. No major releases. See `AGENTS.md` for the full release procedure including the WebAuthn 2FA flow.
