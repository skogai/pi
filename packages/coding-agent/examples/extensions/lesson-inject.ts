/**
 * Lesson Inject Extension
 *
 * Scans ~/.skogai/knowledge/lessons/ recursively for .md files whose YAML
 * frontmatter declares `match.keywords`. On each agent turn, keyword-matches
 * the user's prompt against those lists and injects the relevant lesson bodies
 * into the system prompt as an appended section.
 *
 * Lesson frontmatter expected shape:
 *
 *   ---
 *   match:
 *     keywords:
 *       - "trigger phrase"
 *       - "another trigger"
 *   status: active   # lessons with status != "active" are skipped
 *   ---
 *
 * Hook timing:
 *   session_start      → (re)scan the lessons directory
 *   before_agent_start → match + inject into systemPrompt for this turn only
 *
 * Usage:
 *   cp lesson-inject.ts ~/.pi/agent/extensions/
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────────────────

interface Lesson {
	filePath: string;
	/** Derived from filename without .md */
	name: string;
	keywords: string[];
	body: string;
}

// ── YAML frontmatter parser ────────────────────────────────────────────────
//
// Intentionally minimal — only extracts what this extension needs:
//   match.keywords  (list of strings)
//   status          (string)

interface ParsedFrontmatter {
	keywords: string[];
	status: string;
}

function parseFrontmatter(content: string): { meta: ParsedFrontmatter; body: string } {
	const empty: ParsedFrontmatter = { keywords: [], status: "active" };

	if (!content.startsWith("---\n")) return { meta: empty, body: content };

	const end = content.indexOf("\n---\n", 4);
	if (end === -1) return { meta: empty, body: content };

	const yaml = content.slice(4, end);
	const body = content.slice(end + 5);

	// status: active | deprecated | archived | automated
	const statusMatch = yaml.match(/^status:\s*(\S+)/m);
	const status = statusMatch ? statusMatch[1].trim() : "active";

	// match:
	//   keywords:
	//     - "phrase"
	const keywords: string[] = [];
	const keywordsSection = yaml.match(/keywords:\s*\n((?:[ \t]+-[^\n]*\n?)*)/m);
	if (keywordsSection) {
		for (const line of keywordsSection[1].split("\n")) {
			const m = line.match(/^\s+-\s+"?(.+?)"?\s*$/);
			if (m) keywords.push(m[1].trim());
		}
	}

	return { meta: { keywords, status }, body: body.trim() };
}

// ── Directory scanner ──────────────────────────────────────────────────────

function scanLessons(dir: string): Lesson[] {
	const lessons: Lesson[] = [];
	if (!fs.existsSync(dir)) return lessons;

	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			lessons.push(...scanLessons(fullPath));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			try {
				const content = fs.readFileSync(fullPath, "utf-8");
				const { meta, body } = parseFrontmatter(content);
				if (meta.status !== "active" || meta.keywords.length === 0) continue;
				lessons.push({
					filePath: fullPath,
					name: entry.name.replace(/\.md$/, ""),
					keywords: meta.keywords,
					body,
				});
			} catch {
				// skip unreadable files
			}
		}
	}

	return lessons;
}

// ── Matcher ────────────────────────────────────────────────────────────────

function matchLessons(lessons: Lesson[], prompt: string): Lesson[] {
	const lower = prompt.toLowerCase();
	return lessons.filter((lesson) => lesson.keywords.some((kw) => lower.includes(kw.toLowerCase())));
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function lessonInject(pi: ExtensionAPI) {
	const lessonsDir = path.join(os.homedir(), ".skogai", "knowledge", "lessons");
	let lessons: Lesson[] = [];

	// Scan on startup and on every reload so editing a lesson file takes effect
	// without restarting the session.
	pi.on("session_start", async () => {
		lessons = scanLessons(lessonsDir);
	});

	// before_agent_start fires after the user submits but before the LLM call.
	// Returning { systemPrompt } replaces the prompt for this turn only — later
	// turns re-fire the hook and re-match independently.
	pi.on("before_agent_start", async (event) => {
		if (lessons.length === 0) return;

		const matched = matchLessons(lessons, event.prompt);
		if (matched.length === 0) return;

		const injected = matched.map((l) => `### ${l.name}\n\n${l.body}`).join("\n\n---\n\n");

		return {
			systemPrompt:
				`${event.systemPrompt}\n\n` +
				`## Relevant Lessons\n\n` +
				`The following lessons from ~/.skogai/knowledge/lessons/ match this task. ` +
				`Apply them where appropriate.\n\n` +
				injected,
		};
	});
}
