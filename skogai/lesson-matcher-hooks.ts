import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  discoverLessons,
  formatOutput,
  getLessonDirs,
  matchLessons,
} from "./lesson-matcher-ts/src/index.js";

function extractLatestUserText(ctx: ExtensionContext): string {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    if (entry.message.role !== "user") continue;
    const parts = entry.message.content;
    const text = parts
      .filter(
        (part): part is { type: "text"; text: string } => part.type === "text",
      )
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  return "";
}

type LessonMode = "session-start" | "prompt" | "tool";

function buildContext(mode: LessonMode, text?: string, tool?: string): string {
  const lessons = discoverLessons(getLessonDirs());
  const results = matchLessons(lessons, { mode, text, tool });
  return formatOutput(results);
}

function parseLessonCommand(args: string): {
  mode: LessonMode;
  text?: string;
  tool?: string;
} {
  const trimmed = args.trim();
  if (!trimmed) return { mode: "session-start" };

  const [first, ...rest] = trimmed.split(/\s+/);
  if (first === "session-start") return { mode: "session-start" };
  if (first === "prompt") return { mode: "prompt", text: rest.join(" ") };
  if (first === "tool") {
    const [tool, ...textParts] = rest;
    return { mode: "tool", tool, text: textParts.join(" ") };
  }

  return { mode: "prompt", text: trimmed };
}

export default function lessonMatcherHooks(pi: ExtensionAPI): void {
  pi.registerCommand("lesson", {
    description: "Show lessons matching text, a tool, or session-start context",
    handler: async (args, ctx) => {
      const options = parseLessonCommand(args);
      const injected = buildContext(options.mode, options.text, options.tool);
      if (!injected) {
        ctx.ui.notify("No matching lessons", "info");
        return;
      }

      pi.sendMessage({
        customType: "lesson-matcher",
        content: injected,
        display: true,
        details: options,
      });
    },
  });

  pi.on("before_agent_start", async (event) => {
    const injected = buildContext("prompt", event.prompt);
    if (!injected) return;

    return {
      message: {
        customType: "lesson-matcher",
        content: injected,
        display: false,
      },
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const userText = extractLatestUserText(ctx);
    const injected = buildContext("tool", userText, event.toolName);
    if (!injected) return;

    pi.sendMessage(
      {
        customType: "lesson-matcher",
        content: injected,
        display: false,
      },
      { deliverAs: "steer" },
    );
  });
}
