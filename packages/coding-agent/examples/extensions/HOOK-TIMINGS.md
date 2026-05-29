# Hook Timings: pi vs Claude Code

Side-by-side reference for building a harness that spans both runtimes.

---

## Lifecycle map

```
                     pi                          Claude Code
                     ──                          ───────────
session open         session_start               SessionStart
                     resources_discover          (no equivalent — use SessionStart)

user submits         input                       UserPromptSubmit
                     before_agent_start          (no equivalent — closest is UserPromptSubmit)

llm call starts      context                     (no equivalent)
                     before_provider_request     (no equivalent)
                     agent_start                 (no equivalent)
                     turn_start                  (no equivalent)

llm streaming        message_start               (no equivalent)
                     message_update              (no equivalent)
                     message_end                 (no equivalent)
                     after_provider_response     (no equivalent)

tool gate            tool_call                   PreToolUse / PermissionRequest
tool result          tool_result                 PostToolUse / PostToolUseFailure
tool streaming       tool_execution_start/       (no equivalent)
                     tool_execution_update/
                     tool_execution_end

turn done            turn_end                    (no equivalent)
                     agent_end                   Stop

model changed        model_select                (no equivalent)

compact              session_before_compact      PreCompact
                     session_compact             (no equivalent)

fork/branch          session_before_fork         (no equivalent)
                     session_before_tree         (no equivalent)
                     session_tree                (no equivalent)

session switch       session_before_switch       (no equivalent)

subagent             (no equivalent)             SubagentStart / SubagentStop

agent team           (no equivalent)             TeammateIdle / TaskCompleted

worktree             (no equivalent)             WorktreeCreate / WorktreeRemove

config               (no equivalent)             ConfigChange

notification         (no equivalent)             Notification

session close        session_shutdown            SessionEnd
```

---

## Full event tables

### pi events (TypeScript ExtensionAPI)

| event | fires when | can return | notes |
|---|---|---|---|
| `resources_discover` | after session_start | `{ skillPaths, promptPaths, themePaths }` | add skill dirs dynamically |
| `session_start` | startup / reload / new / resume / fork | — | `event.reason` tells why |
| `session_before_switch` | before switching session file | `{ cancel }` | |
| `session_before_fork` | before forking | `{ cancel, skipConversationRestore }` | |
| `session_before_compact` | before context compaction | `{ cancel, compaction }` | can provide custom compaction result |
| `session_compact` | after compaction | — | |
| `session_before_tree` | before tree navigation | `{ cancel, summary, customInstructions }` | |
| `session_tree` | after tree navigation | — | |
| `session_shutdown` | quit / reload / new / resume / fork | — | runtime teardown |
| `input` | raw user input received | `{ action: "continue" \| "transform" \| "handled" }` | can rewrite or swallow input |
| `before_agent_start` | after submit, before LLM | `{ systemPrompt, message }` | **inject lessons here** |
| `context` | before each LLM call | `{ messages }` | mutate the messages array |
| `before_provider_request` | raw payload to provider | `payload` replacement | provider-specific |
| `after_provider_response` | raw response received | — | status + headers only |
| `agent_start` | agent loop starts | — | |
| `turn_start` | each LLM turn starts | — | `event.turnIndex` |
| `message_start` | message begins streaming | — | |
| `message_update` | token arrives | — | `event.assistantMessageEvent` |
| `message_end` | message complete | `{ message }` | can replace the finalized message |
| `tool_call` | before tool executes | `{ block, reason }` | mutate `event.input` in place to patch args |
| `tool_result` | after tool executes | `{ content, details, isError }` | can rewrite result |
| `tool_execution_start` | execution begins | — | |
| `tool_execution_update` | streaming tool output | — | |
| `tool_execution_end` | execution ends | — | |
| `turn_end` | LLM turn complete | — | `event.message` + `event.toolResults` |
| `agent_end` | all turns done | — | `event.messages` = full turn |
| `model_select` | model changed | — | `event.source`: set / cycle / restore |
| `thinking_level_select` | thinking level changed | — | |
| `user_bash` | user runs `!cmd` | `{ operations, result }` | can intercept ! commands |

**Blocking in pi:** return `{ block: true, reason }` from `tool_call`. No exit codes — TypeScript returns.

---

### Claude Code events (shell hooks, stdin JSON)

| event | fires when | can block | can inject | notes |
|---|---|---|---|---|
| `SessionStart` | session begins or resumes | no | yes — `additionalContext` | `source`: startup / resume |
| `UserPromptSubmit` | user sends a message | yes — exit 2 | yes — `additionalContext` | can also return `"decision": "block"` with reason |
| `PreToolUse` | before any tool call | yes — exit 2 or `permissionDecision: "deny"` | no | can return `updatedInput` to patch tool args |
| `PermissionRequest` | permission dialog about to appear | yes — auto-allow/deny | no | return `"decision": "allow"/"deny"` |
| `PostToolUse` | after tool succeeds | no | yes — `additionalContext` to Claude | tool already ran |
| `PostToolUseFailure` | after tool fails | no | yes | use for recovery context |
| `Notification` | system notification | no | no | types: permission_prompt, idle_prompt, auth_success, elicitation_dialog |
| `Stop` | Claude finishes a turn | yes — return `"decision": "block"` with reason | no | **check `stop_hook_active`** to prevent infinite loop |
| `SubagentStart` | subagent spawned | yes | no | |
| `SubagentStop` | subagent finishes | yes | no | check `stop_hook_active` |
| `TeammateIdle` | agent team member idle | yes | no | give it more work or let it idle |
| `TaskCompleted` | task marked complete | yes | no | quality gate: block premature completion |
| `PreCompact` | before `/compact` or auto-compact | no | no | archive transcript before it is lost; `trigger`: manual / auto |
| `ConfigChange` | settings.json changes mid-session | no | no | |
| `WorktreeCreate` | worktree being created | — | — | **replaces** default git behavior if hook exists |
| `WorktreeRemove` | worktree being removed | — | — | **replaces** default git behavior if hook exists |
| `SessionEnd` | session terminates | no | no | `reason`: exit / clear / logout / prompt_input_exit / other |

**Blocking in Claude Code:** exit code `2` + write reason to stderr. Or return `{ "decision": "block", "reason": "..." }` JSON on stdout.

**Inject context in Claude Code:** return JSON with `hookSpecificOutput.additionalContext` (string).

---

## Key differences

| concern | pi | Claude Code |
|---|---|---|
| language | TypeScript | shell (bash / node / python) |
| blocking mechanism | return `{ block: true }` | exit 2 or JSON decision |
| lesson injection | `before_agent_start` → return `{ systemPrompt }` | `UserPromptSubmit` → `additionalContext` |
| always-apply lessons | `session_start` → `{ systemPrompt }` | `SessionStart` → `additionalContext` |
| per-tool lessons | `tool_call` → mutate `event.input` | `PreToolUse` → `updatedInput` |
| quality gate | `agent_end` or `tool_result` | `Stop` (check `stop_hook_active`) |
| persist findings on stop | `agent_end` | `Stop` |
| preserve context before compact | `session_before_compact` | `PreCompact` |
| prompt mutation | `input` → `{ action: "transform" }` | `UserPromptSubmit` → prompt replacement |
| context window inject | `context` → mutate messages array | no direct equivalent |
| system prompt replace | `before_agent_start` → `{ systemPrompt }` | no equivalent (additionalContext only appends) |
| session branching | `session_before_fork` / `session_before_tree` | no equivalent |
| agent teams | no equivalent | `SubagentStart/Stop`, `TeammateIdle`, `TaskCompleted` |
| worktrees | no equivalent | `WorktreeCreate/Remove` (replace defaults) |

---

## Harness mapping

For a harness loop that works across both runtimes:

| harness concern | pi hook | Claude Code hook |
|---|---|---|
| load workflow state on open | `session_start` → inject task context | `SessionStart` → `additionalContext` |
| inject lessons on user turn | `before_agent_start` → `{ systemPrompt }` | `UserPromptSubmit` → `additionalContext` |
| inject lessons per tool | `tool_call` | `PreToolUse` |
| block unsafe operations | `tool_call` → `{ block: true }` | `PreToolUse` → exit 2 |
| guard generated files | `tool_call` on Edit/Write | `PreToolUse` on Edit/Write with path check |
| enforce quality on stop | `agent_end` | `Stop` (with `stop_hook_active` guard) |
| track subagent work | — | `SubagentStop` → update progress.md |
| teammate assignment | — | `TeammateIdle` |
