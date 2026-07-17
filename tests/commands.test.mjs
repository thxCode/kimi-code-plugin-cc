import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "kimi");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Kimi's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/kimi-companion\.mjs" review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Kimi review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /return Kimi's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/kimi-companion\.mjs" adversarial-review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Kimi adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /uses the same review target selection as `\/kimi:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("continue is not exposed as a user-facing command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ]);
});

test("rescue command absorbs continue semantics", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/kimi-rescue.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/kimi-cli-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Kimi's output verbatim/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  // Regression for #234: `Skill(kimi:rescue)` from the main agent recursed
  // because rescue.md named the routing with ambiguous prose ("Route this
  // request to the `kimi:kimi-rescue` subagent") while running under
  // `context: fork` — forked general-purpose subagents do not expose the
  // `Agent` tool, so the fork fell back to `Skill` and re-entered this
  // command. Pin the explicit transport and the inline (no-fork) execution.
  assert.match(rescue, /subagent_type: "kimi:kimi-rescue"/);
  assert.match(rescue, /do not call `Skill\(kimi:kimi-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <model\|highspeed>/);
  assert.match(rescue, /--thinking <on\|off>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Kimi session/);
  assert.match(rescue, /Start a new Kimi session/);
  assert.match(rescue, /run the `kimi:kimi-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(rescue, /`--model` and `--thinking` are runtime-selection flags/i);
  assert.match(rescue, /Leave `--thinking` unset unless the user explicitly asks to turn thinking on or off/i);
  assert.match(rescue, /If they ask for `highspeed`, map it to `kimi-code\/kimi-for-coding-highspeed`/i);
  assert.match(rescue, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /If the user chooses continue, add `--resume`/i);
  assert.match(rescue, /If the user chooses a new session, add `--fresh`/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the Kimi companion stdout verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(rescue, /return that command's stdout as-is/i);
  assert.match(rescue, /Leave `--resume` and `--fresh` in the forwarded request/i);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /prefer foreground for a small, clearly bounded rescue request/i);
  assert.match(agent, /If the user did not explicitly choose `--background` or `--wait` and the task looks complicated, open-ended, multi-step, or likely to keep Kimi running for a long time, prefer background execution/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Leave `--thinking` unset unless the user explicitly requests thinking on or off/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /If the user asks for `highspeed`, map that to `--model kimi-code\/kimi-for-coding-highspeed`/i);
  assert.match(agent, /If the user asks for a concrete model name such as `k2\.7`, pass it through with `--model`/i);
  assert.match(agent, /Return the stdout of the `kimi-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call fails or Kimi cannot be invoked, return nothing/i);
  assert.match(agent, /k3-prompting/);
  assert.match(agent, /only to tighten the user's request into a better Kimi prompt/i);
  assert.match(agent, /Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/i);
  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /use the `k3-prompting` skill to rewrite the user's request into a tighter Kimi prompt/i);
  assert.match(runtimeSkill, /That prompt drafting is the only Claude-side work allowed/i);
  assert.match(runtimeSkill, /Leave `--thinking` unset unless the user explicitly requests a specific thinking mode/i);
  assert.match(runtimeSkill, /Leave model unset by default/i);
  assert.match(runtimeSkill, /Map `highspeed` to `--model kimi-code\/kimi-for-coding-highspeed`/i);
  assert.match(runtimeSkill, /If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only/i);
  assert.match(runtimeSkill, /Strip it before calling `task`/i);
  assert.match(runtimeSkill, /`--thinking`: accepted values are `on`, `off`/i);
  assert.match(runtimeSkill, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(runtimeSkill, /If the Bash call fails or Kimi cannot be invoked, return nothing/i);
  assert.match(readme, /`kimi:kimi-rescue` subagent/i);
  assert.match(readme, /if you do not pass `--model` or `--thinking`, Kimi chooses its own defaults/i);
  assert.match(readme, /--model k2\.7 --thinking on/i);
  assert.match(readme, /`highspeed` maps to `kimi-code\/kimi-for-coding-highspeed`/i);
  assert.match(readme, /continue a previous Kimi task/i);
  assert.match(readme, /### `\/kimi:setup`/);
  assert.match(readme, /### `\/kimi:review`/);
  assert.match(readme, /### `\/kimi:adversarial-review`/);
  assert.match(readme, /uses the same review target selection as `\/kimi:review`/i);
  assert.match(readme, /--base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /### `\/kimi:rescue`/);
  assert.match(readme, /### `\/kimi:transfer`/);
  assert.match(readme, /### `\/kimi:status`/);
  assert.match(readme, /### `\/kimi:result`/);
  assert.match(readme, /### `\/kimi:cancel`/);
});

test("transfer, result, and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const transfer = read("commands/transfer.md");
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/kimi-result-handling/SKILL.md");

  assert.match(transfer, /disable-model-invocation:\s*true/);
  assert.match(transfer, /kimi-companion\.mjs" transfer "\$ARGUMENTS"/);
  assert.match(transfer, /kimi -r <session-id>/);
  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /kimi-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /kimi-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Kimi run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Kimi was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/kimi-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/k3-prompting/SKILL.md");
  const promptRecipes = read("skills/k3-prompting/references/kimi-prompt-recipes.md");

  assert.match(runtimeSkill, /kimi-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptRecipes, /Kimi task prompts/i);
  assert.match(promptRecipes, /Use these as starting templates for Kimi task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command can offer Kimi install and still points users to kimi login", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /https:\/\/moonshotai\.github\.io\/kimi-code\//);
  assert.doesNotMatch(setup, /npm install/);
  assert.match(setup, /kimi-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(readme, /!kimi login/);
  assert.match(readme, /offers the official install instructions/i);
  assert.match(readme, /\/kimi:setup --enable-review-gate/);
  assert.match(readme, /\/kimi:setup --disable-review-gate/);
});

test("plugin surface uses kimi terminology without codex leftovers", () => {
  const surfaces = [
    ...fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).map((name) => path.join("commands", name)),
    ...fs.readdirSync(path.join(PLUGIN_ROOT, "agents")).map((name) => path.join("agents", name)),
    ...fs.readdirSync(path.join(PLUGIN_ROOT, "prompts")).map((name) => path.join("prompts", name)),
    path.join("hooks", "hooks.json")
  ];

  for (const relativePath of surfaces) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /codex/i, `${relativePath} must not mention codex`);
    assert.doesNotMatch(source, /--effort/, `${relativePath} must use --thinking, not --effort`);
    assert.doesNotMatch(source, /gpt-5/i, `${relativePath} must not mention gpt-5 models`);
    assert.doesNotMatch(source, /\bspark\b/i, `${relativePath} must use the highspeed alias, not spark`);
  }
});
