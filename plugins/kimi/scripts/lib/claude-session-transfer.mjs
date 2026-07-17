import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";

export const TRANSCRIPT_PATH_ENV = "KIMI_COMPANION_TRANSCRIPT_PATH";
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

const DEFAULT_MAX_TRANSCRIPT_BYTES = 64 * 1024;
const MAX_TEXT_BLOCK_CHARS = 4000;
const MAX_TOOL_BLOCK_CHARS = 1000;

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  const requestedPath = options.source || process.env[TRANSCRIPT_PATH_ENV];
  if (!requestedPath) {
    throw new Error("Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.");
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  let source;
  let projects;
  try {
    source = fs.realpathSync(sourcePath);
    projects = fs.realpathSync(CLAUDE_PROJECTS_DIR);
  } catch {
    throw new Error(`Claude session file not found: ${sourcePath}`);
  }
  const relative = path.relative(projects, source);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Kimi can import Claude sessions only from ${CLAUDE_PROJECTS_DIR}: ${source}`);
  }
  return source;
}

function truncateText(text, maxChars) {
  const value = String(text ?? "");
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n[... truncated ${value.length - maxChars} chars]`;
}

function stringifyToolValue(value) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderContentBlock(block) {
  if (!block || typeof block !== "object") {
    return null;
  }
  if (block.type === "text") {
    return truncateText(block.text, MAX_TEXT_BLOCK_CHARS);
  }
  if (block.type === "tool_use") {
    return `[tool_use: ${block.name ?? "unknown"}] ${truncateText(stringifyToolValue(block.input), MAX_TOOL_BLOCK_CHARS)}`;
  }
  if (block.type === "tool_result") {
    return `[tool_result] ${truncateText(stringifyToolValue(block.content), MAX_TOOL_BLOCK_CHARS)}`;
  }
  return null;
}

function extractTurnText(entry) {
  const content = entry?.message?.content;
  if (typeof content === "string") {
    return truncateText(content, MAX_TEXT_BLOCK_CHARS);
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content.map(renderContentBlock).filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : null;
}

function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

export function compressClaudeTranscript(sourcePath, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
  const turns = [];
  let lines;
  try {
    lines = fs.readFileSync(sourcePath, "utf8").split("\n");
  } catch {
    throw new Error(`Claude session file not found: ${sourcePath}`);
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (entry?.type !== "user" && entry?.type !== "assistant") {
      continue;
    }
    const text = extractTurnText(entry);
    if (!text) {
      continue;
    }
    const label = entry.type === "user" ? "User" : "Assistant";
    turns.push(`## ${label}\n${text}`);
  }

  if (turns.length === 0) {
    throw new Error(`Claude session transcript has no user or assistant messages: ${sourcePath}`);
  }

  const selected = [turns[0]];
  let usedBytes = byteLength(turns[0]);
  let omitted = 0;
  for (let index = turns.length - 1; index >= 1; index -= 1) {
    const turnBytes = byteLength(turns[index]);
    if (usedBytes + turnBytes > maxBytes) {
      omitted += 1;
      continue;
    }
    selected.splice(1, 0, turns[index]);
    usedBytes += turnBytes;
  }

  if (omitted > 0) {
    selected.splice(1, 0, `[... ${omitted} earlier turn(s) omitted to fit the transfer budget ...]`);
  }
  return selected.join("\n\n");
}
