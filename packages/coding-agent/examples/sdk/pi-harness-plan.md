# Plan: pi Harness Automation

Closes the gap between pi's `lesson-inject.ts` and Claude Code's missing parallel
automations. Implements the five-part proposal from memory obs #253, plus the CC
lesson injection hook.

**Start each phase fresh.** Every phase includes its own doc references.
Read them before writing any code.

---

## Phase 0: Documentation Discovery (DONE — session context)

Sources consulted this session:

| artifact | path | what it provides |
|---|---|---|
| pi hook types | `packages/coding-agent/src/core/extensions/types.ts` | Full ExtensionEventMap, all event shapes and return types |
| pi extension examples | `examples/extensions/*.ts` | Working patterns to copy |
| dot-core hooks | `~/.local/src/dot-skogai/plugins/dot-core/hooks/` | CC hook shell patterns |
| dot-core lesson_matcher | `hooks/lesson_matcher.py` | Lesson matching CLI (session-start / prompt / tool modes) |
| dot-core hooks.json | `hooks.json` | CC registration format |
| HOOK-TIMINGS.md | `examples/extensions/HOOK-TIMINGS.md` | Side-by-side timing reference |
| pi CLAUDE.md | `/home/skogix/.local/src/pi/CLAUDE.md` | Policy: models.generated.ts, npm run check |
| CC settings | `~/.claude/settings.json` | Current hooks and permissions |

**Allowed APIs confirmed:**

pi:
- `pi.on("tool_call", handler)` → return `{ block: true, reason }` to block; mutate `event.input` to patch args
- `pi.on("before_agent_start", handler)` → return `{ systemPrompt }` to replace
- `pi.on("session_start", handler)` → no return, use for caching

Claude Code:
- `PreToolUse` stdin JSON → `permissionDecision: "deny"` + `permissionDecisionReason` to block
- `PreToolUse` → return `updatedInput` to patch tool args
- `PostToolUse` → return `hookSpecificOutput.additionalContext` to inject feedback
- `UserPromptSubmit` → return `hookSpecificOutput.additionalContext` to inject
- `SessionStart` → return `hookSpecificOutput.additionalContext` to inject at session open
- `Stop` → return `{ "decision": "block", "reason": "..." }` to force continuation; ALWAYS check `stop_hook_active`

**Anti-patterns confirmed:**
- Do NOT edit `models.generated.ts` directly — use `generate-models.ts` script
- Do NOT use `git add -A` or `git add .` in pi
- Stop hook MUST check `stop_hook_active` or infinite loop

---

## Phase 1: CC hooks for pi monorepo

**What:** Two PostToolUse / PreToolUse hooks wired into
`~/.local/src/pi/.claude/settings.json` that enforce CLAUDE.md policy mechanically.

**Hook 1 — PreToolUse guard on `models.generated.ts`**

Copy pattern from: `dot-core/hooks/pre-tool-use.sh` (blocking pattern) and
`HOOK-TIMINGS.md` (PreToolUse permissionDecision shape).

Script location: `~/.local/src/pi/.claude/hooks/guard-generated.sh`

Input fields needed:
```json
{ "tool_name": "Edit|Write", "tool_input": { "file_path": "..." } }
```

Output to block:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Edit generate-models.ts script instead of models.generated.ts directly"
  }
}
```

**Hook 2 — PostToolUse auto npm run check**

Copy pattern from: `dot-core/hooks/post-tool-use.sh` (output format) and
`packages/coding-agent/CLAUDE.md` (check command: `npm run check`).

Script location: `~/.local/src/pi/.claude/hooks/auto-check.sh`

Only fire when: `tool_name` is `Edit` or `Write` AND `file_path` ends in `.ts`
AND does NOT match `*.generated.ts`.

Output: `additionalContext` with check result summary (pass/fail + last 5 lines).

**Registration** (add to `~/.local/src/pi/.claude/settings.json` hooks):
```json
{
  "PreToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": ".claude/hooks/guard-generated.sh", "timeout": 5 }] }],
  "PostToolUse": [{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": ".claude/hooks/auto-check.sh", "timeout": 90, "statusMessage": "Running biome + tsc..." }] }]
}
```

**Verification checklist:**
- [ ] `echo '{"tool_name":"Edit","tool_input":{"file_path":"/path/models.generated.ts"}}' | bash guard-generated.sh` → exits with deny decision
- [ ] `echo '{"tool_name":"Edit","tool_input":{"file_path":"/path/foo.ts"}}' | bash guard-generated.sh` → exits 0, no output
- [ ] Edit a real `.ts` file in pi → auto-check fires, output appears in session
- [ ] BATS test covering both cases (copy test structure from `dot-core/tests/pre-tool-use/pre-tool-use.bats`)

---

## Phase 2: CC lesson injection hook

**What:** Wire `dot-core/hooks/lesson_matcher.py` as a `UserPromptSubmit` +
`SessionStart` hook into `~/.local/src/pi/.claude/settings.json`.

The matcher already supports all three modes. The only new work is a thin shell wrapper.

**Script location:** `~/.local/src/pi/.claude/hooks/lesson-inject.sh`

Copy `user-prompt-submit.sh` from `dot-core/hooks/` as the template, strip
skogparse and user-context sections, keep only the lesson_matcher call:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MATCHER="$HOME/.local/src/dot-skogai/plugins/dot-core/hooks/lesson_matcher.py"

input=$(cat)
event=$(echo "$input" | jq -r '.hook_event_name')

if [[ "$event" == "SessionStart" ]]; then
  ctx=$(python3 "$MATCHER" --mode session-start 2>/dev/null || true)
elif [[ "$event" == "UserPromptSubmit" ]]; then
  prompt=$(echo "$input" | jq -r '.prompt // ""')
  ctx=$(python3 "$MATCHER" --mode prompt --text "$prompt" 2>/dev/null || true)
else
  exit 0
fi

[[ -n "$ctx" ]] && jq -n --arg c "$ctx" --arg e "$event" \
  '{"hookSpecificOutput":{"hookEventName":$e,"additionalContext":$c}}'

exit 0
```

**Registration:**
```json
{
  "SessionStart":       [{ "hooks": [{ "type": "command", "command": ".claude/hooks/lesson-inject.sh", "timeout": 10, "statusMessage": "Loading lessons..." }] }],
  "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": ".claude/hooks/lesson-inject.sh", "timeout": 10, "statusMessage": "Matching lessons..." }] }]
}
```

**Verification checklist:**
- [ ] `echo '{"hook_event_name":"SessionStart","session_id":"test"}' | bash lesson-inject.sh` → JSON or empty (both valid)
- [ ] `echo '{"hook_event_name":"UserPromptSubmit","session_id":"test","prompt":"git commit workflow"}' | bash lesson-inject.sh` → injects git-workflow lesson body
- [ ] `echo '{"hook_event_name":"UserPromptSubmit","session_id":"test","prompt":"hello world"}' | bash lesson-inject.sh` → no output
- [ ] Exits 0 when `lesson_matcher.py` is absent (fail-open, `|| true` guard)

---

## Phase 3: pi-scout subagent

**What:** A read-only pi recon agent usable from the subagent extension.

**File:** `~/.pi/agent/agents/pi-scout.md`

Copy frontmatter pattern from:
`examples/extensions/subagent/agents/scout.md`

```markdown
---
name: pi-scout
description: Read-only scout for the pi monorepo. Finds patterns, traces call chains, and returns compressed findings across 4 packages (tui → ai → agent → coding-agent).
tools: read, grep, find, ls
model: claude-haiku-4-5
---

You are a read-only scout for the pi monorepo. Never create or edit files.

Build order: tui → ai → agent → coding-agent (each package depends on prior).

TypeScript rules (erasable-only): no enum, no namespace, no parameter properties,
no dynamic await import(), no import= / export=, no any unless unavoidable.

Return compressed findings: file paths, line numbers, key symbols. No prose padding.
```

**Verification checklist:**
- [ ] `discoverAgents("~/.pi/agent", "user")` lists pi-scout
- [ ] `subagent({ agent: "pi-scout", task: "find AgentMessage type definition" })` returns file:line
- [ ] Scout does NOT attempt any Edit/Write/Bash tool calls

---

## Phase 4: pi-harness skill

**What:** A Claude Code skill that sets up and enforces the three-file-to-disk
workflow for pi development tasks, matching the SkogAI bootstrap-spine pattern.

**Pattern to copy from:**
- `~/skogai/plans/bootstrap-spine/task_plan.md` — three-file structure
- `dot-core/scripts/templates/workflow/*.md.tpl` — template format
- `dot-core/scripts/workflow-memory.sh` — init logic

**Files to create:**

```
~/.claude/skills/pi-harness/
  SKILL.md
  workflows/
    start-task.md
    resume-task.md
  templates/
    task_plan.md.tpl
    findings.md.tpl
    progress.md.tpl
```

`SKILL.md` frontmatter:
```yaml
---
name: pi-harness
description: Three-file task workflow for pi development. Use when starting a new pi feature, debugging across packages, or planning changes that touch the tui→ai→agent→coding-agent build chain.
---
```

`task_plan.md.tpl` pi-specific sections beyond the base template:
- `## Packages affected` (tui / ai / agent / coding-agent checkboxes)
- `## Build order concern` (which packages need rebuild)
- `## Check command` (always `npm run check` from repo root)
- `## Forbidden` (models.generated.ts direct edits, git add -A)

**Verification checklist:**
- [ ] `/pi-harness` resolves in Claude Code session
- [ ] Running the skill creates three files in `plans/<task-slug>/`
- [ ] `resume-task.md` workflow successfully reconstructs task state from files alone

---

## Phase 5: context7 MCP

**What:** Add context7 MCP server for live npm package docs.

```bash
claude mcp add context7 -- npx -y @upstash/context7-mcp
```

**Verification checklist:**
- [ ] `claude mcp list` shows context7
- [ ] Query about `TypeBox Type.Object` returns live signature, not hallucinated shape
- [ ] At least one pi provider package (anthropic, openai, @mistralai/mistralai) resolves docs

---

## Phase 6: Verification pass

Run from `~/.local/src/pi/`:

```bash
# Hook 1 — guard fires on generated file
echo '{"tool_name":"Edit","tool_input":{"file_path":"packages/ai/src/models.generated.ts"}}' \
  | bash .claude/hooks/guard-generated.sh | jq .hookSpecificOutput.permissionDecision
# expected: "deny"

# Hook 1 — guard passes on normal file
echo '{"tool_name":"Edit","tool_input":{"file_path":"packages/ai/src/models.ts"}}' \
  | bash .claude/hooks/guard-generated.sh
# expected: no output, exit 0

# Lesson inject — match
echo '{"hook_event_name":"UserPromptSubmit","session_id":"test","prompt":"git commit without staging everything"}' \
  | bash .claude/hooks/lesson-inject.sh | jq -r '.hookSpecificOutput.additionalContext' | head -5

# Lesson inject — no match
echo '{"hook_event_name":"UserPromptSubmit","session_id":"test","prompt":"what is 2+2"}' \
  | bash .claude/hooks/lesson-inject.sh
# expected: no output

# BATS (copy from dot-core pattern)
bats .claude/tests/

# context7
claude mcp list | grep context7
```

**All phases green = harness complete.**

---

## Open questions (decide before Phase 1)

1. **Hook scope**: Project-local (`.claude/` in pi repo) or user-global (`~/.claude/`)? Project-local fires only when working in pi — recommended.
2. **auto-check timeout**: `npm run check` can take 30–60s cold. Use 90s or run only `biome check` (fast) as the PostToolUse hook and gate full `tsc` to a manual trigger?
3. **lesson-inject coupling**: Wrapper script references `dot-core` path directly. If dot-core moves, it breaks. Consider copying `lesson_matcher.py` into `.claude/hooks/` instead.
