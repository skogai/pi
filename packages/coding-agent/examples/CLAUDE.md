# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This directory contains two categories of examples for `@earendil-works/pi-coding-agent`:

- **`sdk/`** — Programmatic usage via `createAgentSession()`. Numbered `01`–`13`, each building on the previous. Start here to understand how to embed the agent as a library.
- **`extensions/`** — Extension plugins that hook into a running `pi` session via `ExtensionAPI`. Cover the full surface area: lifecycle hooks, custom tools, commands, custom UI, git integration, custom providers, and more.

## Running Examples

```bash
# SDK examples (from packages/coding-agent)
npx tsx examples/sdk/01-minimal.ts

# Load an extension into a live pi session
pi --extension examples/extensions/permission-gate.ts

# Auto-load on every session (drop into extensions dir)
cp examples/extensions/permission-gate.ts ~/.pi/agent/extensions/
```

## Extension Structure

Every extension exports a default function receiving `ExtensionAPI`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => { /* ... */ });
  pi.registerTool({ ... });
  pi.registerCommand("cmd", { handler: async (args, ctx) => { ... } });
}
```

Key imports:
- `@earendil-works/pi-coding-agent` — `ExtensionAPI`, `ExtensionContext`, `defineTool`, `SessionManager`, `createAgentSession`, etc.
- `@earendil-works/pi-ai` — `Type` (TypeBox re-export), `StringEnum`, `getModel`
- `@earendil-works/pi-tui` — TUI primitives (`Text`, `matchesKey`, `truncateToWidth`)

## Key Patterns

**Tool parameters — use `StringEnum` for string unions** (required for Google API compatibility):

```typescript
import { StringEnum } from "@earendil-works/pi-ai";

// Correct
action: StringEnum(["list", "add", "remove"] as const)

// Wrong — breaks with Google
action: Type.Union([Type.Literal("list"), Type.Literal("add")])
```

**State persistence — store in `details`, not external files.** Tool result `details` are part of the session tree, so state survives branching and forking:

```typescript
// Save state
return {
  content: [{ type: "text", text: "Done" }],
  details: { items: [...state], nextId },
};

// Reconstruct on session start
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.toolName === "my_tool") {
      state = entry.message.details;  // last entry wins
    }
  }
});
```

**Key bindings — never hardcode strings in `matchesKey`; add defaults to `DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`.** For ad-hoc UI components inside an extension (e.g. overlays, game loops), `matchesKey(data, "escape")` is fine since it is local to the component, not a globally configurable action.

**Custom UI components** implement `render(width: number): string[]` and `handleInput(data: string): void`. Register via `ctx.ui.setFooter()`, `ctx.ui.setHeader()`, `ctx.ui.setOverlay()`, or `ctx.ui.setEditorComponent()`.

**Extensions with npm dependencies** go in their own subdirectory with a `package.json` (see `with-deps/`, `sandbox/`, `custom-provider-anthropic/`, `custom-provider-gitlab-duo/`). They use `jiti` for module resolution and must declare their deps.

**Blocking tool calls** — return `{ block: true, reason: "..." }` from a `tool_call` hook to prevent execution.

**Sequential tool execution** — set `executionMode: "sequential"` on a tool when it shares mutable state with other tools (see `tic-tac-toe.ts`).

## TypeScript

Same erasable TypeScript rules apply as the rest of the monorepo (no `enum`, `namespace`, parameter properties, inline imports). See the root `CLAUDE.md` for the full list.
