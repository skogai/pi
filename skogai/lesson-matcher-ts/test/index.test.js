import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { discoverLessons, formatOutput, matchLessons, parseLesson, scoreKeywords, scoreTools, } from "../src/index.js";
const ALWAYS_APPLY_LESSON = `---
match:
  keywords: ["guardrail", "safety"]
always_apply: true
---

# Always Active Guardrail

Body.`;
const GIT_LESSON = `---
match:
  keywords: ["git", "commit", "workflow"]
---

# Git Workflow

Stage only intended files.`;
const DEPRECATED_LESSON = `---
match:
  keywords: ["old", "legacy"]
status: deprecated
---

# Deprecated Lesson

skip.`;
const BASH_LESSON = `---
match:
  keywords: ["shell"]
  tools: ["shell", "bash"]
---

# Shell Best Practices

Use shell safely.`;
function makeLessonDir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-matcher-"));
    fs.writeFileSync(path.join(d, "always.md"), ALWAYS_APPLY_LESSON);
    fs.writeFileSync(path.join(d, "git.md"), GIT_LESSON);
    fs.writeFileSync(path.join(d, "deprecated.md"), DEPRECATED_LESSON);
    fs.writeFileSync(path.join(d, "bash.md"), BASH_LESSON);
    fs.writeFileSync(path.join(d, "README.md"), "skip");
    return d;
}
describe("parsing", () => {
    it("parses frontmatter", () => {
        const { meta, body } = parseLesson(GIT_LESSON);
        expect(meta.match?.keywords).toContain("git");
        expect(body).toContain("Git Workflow");
    });
});
describe("matching", () => {
    it("scores keywords", () => {
        expect(scoreKeywords(["git"], "use git workflow")).toBeGreaterThan(0);
    });
    it("scores tools", () => {
        expect(scoreTools(["bash"], "Bash")).toBe(2);
    });
    it("filters deprecated and matches prompt/tool", () => {
        const dir = makeLessonDir();
        const lessons = discoverLessons([dir]);
        const promptResults = matchLessons(lessons, { mode: "prompt", text: "git commit workflow" });
        expect(promptResults[0]?.title).toBe("Git Workflow");
        expect(promptResults.map((x) => x.title)).not.toContain("Deprecated Lesson");
        const toolResults = matchLessons(lessons, { mode: "tool", tool: "bash" });
        expect(toolResults.map((x) => x.title)).toContain("Shell Best Practices");
    });
    it("session-start uses always_apply and max 3", () => {
        const dir = makeLessonDir();
        fs.writeFileSync(path.join(dir, "a2.md"), ALWAYS_APPLY_LESSON.replace("Always Active Guardrail", "A2"));
        fs.writeFileSync(path.join(dir, "a3.md"), ALWAYS_APPLY_LESSON.replace("Always Active Guardrail", "A3"));
        fs.writeFileSync(path.join(dir, "a4.md"), ALWAYS_APPLY_LESSON.replace("Always Active Guardrail", "A4"));
        const lessons = discoverLessons([dir]);
        const results = matchLessons(lessons, { mode: "session-start" });
        expect(results.length).toBeLessThanOrEqual(3);
        expect(results.every((r) => r.alwaysApply)).toBe(true);
    });
});
describe("output and cli", () => {
    it("formats output", () => {
        const out = formatOutput([{ title: "x", body: "# X", score: 1, alwaysApply: false, path: "x" }]);
        expect(out).toContain("# X");
    });
    it("cli exits 0 and prints matches", () => {
        const dir = makeLessonDir();
        const env = { ...process.env, LESSON_DIRS: dir };
        const stdout = execFileSync("npx", ["tsx", "src/index.ts", "--mode", "prompt", "--text", "git"], {
            cwd: "/tmp/lesson-matcher-ts",
            env,
            encoding: "utf8",
        });
        expect(stdout).toContain("Git Workflow");
    });
    it("works against live lessons directory", () => {
        const liveDir = "/tmp/lesson-matcher-ts/lessons";
        if (!fs.existsSync(liveDir)) {
            return;
        }
        const lessons = discoverLessons([liveDir]);
        expect(lessons.length).toBeGreaterThan(0);
        const out = execFileSync("npx", ["tsx", "src/index.ts", "--mode", "prompt", "--text", "git worktree add"], {
            cwd: "/tmp/lesson-matcher-ts",
            env: { ...process.env, LESSON_DIRS: liveDir },
            encoding: "utf8",
        });
        expect(out.length).toBeGreaterThan(0);
    });
});
