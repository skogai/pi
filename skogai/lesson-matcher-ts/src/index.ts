#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";

type MatchBlock = {
  keywords?: string[];
  tools?: string[];
};

type LessonMeta = {
  match?: MatchBlock;
  always_apply?: boolean;
  status?: string;
};

type Lesson = {
  path: string;
  meta: LessonMeta;
  body: string;
  title: string;
  keywords: string[];
  tools: string[];
  alwaysApply: boolean;
  status: string;
};

type MatchResult = {
  title: string;
  body: string;
  score: number;
  alwaysApply: boolean;
  path: string;
};

const SKIP_FILENAMES = new Set(["README.md", "TEMPLATE.md"]);

function fallbackParseYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const m = line.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const indent = m[1]!.length;
    const key = m[2]!;
    const valueStr = m[3]!.trim();
    if (valueStr) {
      result[key] = parseValue(valueStr);
      i++;
      continue;
    }
    i++;
    const childLines: string[] = [];
    while (i < lines.length) {
      const cl = lines[i]!;
      if (!cl.trim() || cl.trim().startsWith("#")) {
        i++;
        continue;
      }
      const clIndent = cl.length - cl.trimStart().length;
      if (clIndent <= indent) break;
      childLines.push(cl);
      i++;
    }

    if (childLines.length > 0 && childLines[0]!.trim().startsWith("- ")) {
      const items: unknown[] = [];
      for (const cl of childLines) {
        const lm = cl.match(/^\s*-\s*(.*)$/);
        if (lm) items.push(parseValue(lm[1]!.trim()));
      }
      result[key] = items;
    } else {
      result[key] = fallbackParseYaml(childLines.join("\n"));
    }
  }

  return result;
}

function parseValue(s: string): unknown {
  const v = s.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1);
    const quoted = [...inner.matchAll(/"([^"]*)"/g)].map((x) => x[1] ?? "");
    if (quoted.length > 0) return quoted;
    return inner
      .split(",")
      .map((x) => x.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  if (v.toLowerCase() === "true") return true;
  if (v.toLowerCase() === "false") return false;
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

function parseYaml(text: string): Record<string, unknown> {
  try {
    return (yamlLoad(text) as Record<string, unknown>) ?? {};
  } catch {
    return fallbackParseYaml(text);
  }
}

export function parseLesson(content: string): { meta: LessonMeta; body: string } {
  if (!content.startsWith("---")) return { meta: {}, body: content };
  const end = content.indexOf("---", 3);
  if (end === -1) return { meta: {}, body: content };
  const fmText = content.slice(3, end).trim();
  const body = content.slice(end + 3).trim();
  return { meta: parseYaml(fmText) as LessonMeta, body };
}

export function extractTitle(body: string): string {
  for (const line of body.split("\n")) {
    const m = line.match(/^#\s+(.+)/);
    if (m) return m[1]!.trim();
  }
  return "Untitled";
}

function walkMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out.sort();
}

export function discoverLessons(dirs: string[]): Lesson[] {
  const lessons: Lesson[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const md of walkMarkdownFiles(dir)) {
      const name = path.basename(md);
      if (SKIP_FILENAMES.has(name)) continue;
      const real = fs.realpathSync(md);
      if (seen.has(real)) continue;
      seen.add(real);
      const content = fs.readFileSync(md, "utf8");
      const { meta, body } = parseLesson(content);
      const match = meta.match && typeof meta.match === "object" ? meta.match : {};
      lessons.push({
        path: md,
        meta,
        body,
        title: extractTitle(body),
        keywords: Array.isArray(match.keywords) ? match.keywords : [],
        tools: Array.isArray(match.tools) ? match.tools : [],
        alwaysApply: Boolean(meta.always_apply ?? false),
        status: meta.status ?? "active",
      });
    }
  }
  return lessons;
}

export function scoreKeywords(keywords: string[], text?: string): number {
  if (!text || keywords.length === 0) return 0;
  const t = text.toLowerCase();
  return keywords.reduce((sum, kw) => sum + (t.includes(kw.toLowerCase()) ? 1 : 0), 0);
}

export function scoreTools(tools: string[], tool?: string): number {
  if (!tool || tools.length === 0) return 0;
  const t = tool.toLowerCase();
  return tools.reduce((sum, x) => sum + (x.toLowerCase() === t ? 2 : 0), 0);
}

export function matchLessons(
  lessons: Lesson[],
  options: { text?: string; tool?: string; mode: "session-start" | "prompt" | "tool"; maxResults?: number },
): MatchResult[] {
  const maxResults = options.maxResults ?? { "session-start": 3, prompt: 3, tool: 2 }[options.mode];
  const results: MatchResult[] = [];
  for (const lesson of lessons) {
    if (lesson.status === "deprecated") continue;
    if (options.mode === "session-start") {
      if (lesson.alwaysApply) {
        results.push({ title: lesson.title, body: lesson.body, score: 1, alwaysApply: true, path: lesson.path });
      }
      continue;
    }
    if (options.mode === "prompt") {
      const s = scoreKeywords(lesson.keywords, options.text);
      if (s > 0) results.push({ title: lesson.title, body: lesson.body, score: s, alwaysApply: lesson.alwaysApply, path: lesson.path });
      continue;
    }
    let s = scoreTools(lesson.tools, options.tool);
    if (options.text) s += scoreKeywords(lesson.keywords, options.text);
    if (s > 0) results.push({ title: lesson.title, body: lesson.body, score: s, alwaysApply: lesson.alwaysApply, path: lesson.path });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

export function formatOutput(results: MatchResult[]): string {
  if (results.length === 0) return "";
  return results.map((x) => x.body).join("\n\n---\n\n");
}

export function getLessonDirs(): string[] {
  const envDirs = process.env.LESSON_DIRS ?? "";
  if (envDirs) return envDirs.split(":").filter(Boolean);
  const home = process.env.HOME ?? process.cwd();
  const cwd = process.cwd();
  return [
    path.join(home, ".skogai", "knowledge", "lessons"),
    path.join(home, ".config", "gptme", "lessons"),
    path.join(cwd, "lessons"),
    path.join(cwd, ".claude", "lessons"),
  ];
}

export function runCli(argv: string[]): { output: string; error?: string } {
  const modeIndex = argv.indexOf("--mode");
  if (modeIndex === -1 || !argv[modeIndex + 1]) {
    return { output: "", error: "missing --mode" };
  }
  const mode = argv[modeIndex + 1] as "session-start" | "prompt" | "tool";
  const textIndex = argv.indexOf("--text");
  const toolIndex = argv.indexOf("--tool");
  const text = textIndex !== -1 ? argv[textIndex + 1] : undefined;
  const tool = toolIndex !== -1 ? argv[toolIndex + 1] : undefined;

  try {
    const lessons = discoverLessons(getLessonDirs());
    const results = matchLessons(lessons, { mode, text, tool });
    return { output: formatOutput(results) };
  } catch (error) {
    return { output: "", error: `lesson_matcher error: ${String(error)}` };
  }
}

const scriptPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : undefined;
const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
const isMain = scriptPath === modulePath;
if (isMain) {
  const result = runCli(process.argv.slice(2));
  if (result.error) {
    console.error(result.error);
  }
  if (result.output) {
    console.log(result.output);
  }
  process.exit(0);
}
