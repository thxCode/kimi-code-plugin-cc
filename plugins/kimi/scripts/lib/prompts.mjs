import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function loadPromptTemplate(rootDir, name) {
  const promptPath = path.join(rootDir, "prompts", `${name}.md`);
  return fs.readFileSync(promptPath, "utf8");
}

export function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : "";
  });
}

/**
 * Best-effort read of Claude Code's configured response language (the
 * top-level `language` field in settings.json). Project-local settings win
 * over project settings, which win over user settings — mirroring Claude
 * Code's own precedence. Returns null when no language is configured.
 *
 * The review prompts are fixed English templates over an English git diff,
 * so without this signal Kimi has no way to know which language the user
 * expects the findings in.
 *
 * @param {string} [workspaceRoot]
 * @returns {string | null}
 */
export function readClaudeConfiguredLanguage(workspaceRoot) {
  const candidates = [];
  if (workspaceRoot) {
    candidates.push(
      path.join(workspaceRoot, ".claude", "settings.local.json"),
      path.join(workspaceRoot, ".claude", "settings.json")
    );
  }
  candidates.push(path.join(os.homedir(), ".claude", "settings.json"));

  for (const candidate of candidates) {
    let settings = null;
    try {
      settings = JSON.parse(fs.readFileSync(candidate, "utf8"));
    } catch {
      continue; // Missing or unreadable settings file — try the next scope.
    }
    const language = typeof settings?.language === "string" ? settings.language.trim() : "";
    if (language) {
      return language;
    }
  }
  return null;
}
