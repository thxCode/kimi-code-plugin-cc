// End-to-end runtime suite: drives the real companion scripts and hooks
// against the fake `kimi acp` fixture (fake-kimi-fixture.mjs). Ported from the
// codex-plugin-cc runtime suite with the protocol mapping codex app-server ->
// kimi acp, thread -> session, turn/start -> session/prompt, turn/interrupt ->
// session/cancel, and --effort -> --thinking.
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeKimi } from "./fake-kimi-fixture.mjs";
import { initGitRepo, makeTempDir, run, scrubEnv } from "./helpers.mjs";
import { isOwnBrokerSession, readBrokerSession, readOwnBrokerSession, saveBrokerSession } from "../plugins/kimi/scripts/lib/broker-lifecycle.mjs";
import { terminateProcessTree } from "../plugins/kimi/scripts/lib/process.mjs";
import { resolveStateDir } from "../plugins/kimi/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "kimi");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "kimi-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");
const FOREIGN_BROKER_FIXTURE = path.join(ROOT, "tests", "fake-foreign-broker-fixture.mjs");

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

// Per-test isolation: a temp HOME (the fixture never touches HOME, so the
// companion's credentials check is controlled per test) and a temp
// CLAUDE_PLUGIN_DATA (state isolation). CLAUDE_PLUGIN_DATA is also set on the
// test process itself so in-process resolveStateDir/readBrokerSession calls
// resolve the same state dir as the spawned companion.
function makeTestEnv(t, binDir = null, extra = {}) {
  const home = makeTempDir();
  const pluginData = makeTempDir();
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  t.after(() => {
    if (previousPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  });
  const base = binDir ? buildEnv(binDir) : scrubEnv(process.env);
  return {
    home,
    pluginData,
    env: {
      ...base,
      HOME: home,
      CLAUDE_PLUGIN_DATA: pluginData,
      ...extra
    }
  };
}

// Kill the auto-spawned broker (and its upstream fake `kimi acp`) so the test
// run exits cleanly. SessionEnd is a safe no-op when no broker was started.
function scheduleBrokerCleanup(t, cwd, env) {
  t.after(() => {
    run("node", [SESSION_HOOK, "SessionEnd"], {
      cwd,
      env,
      input: JSON.stringify({ hook_event_name: "SessionEnd", cwd })
    });
  });
}

function writeKimiCredentials(home) {
  const credentialsDir = path.join(home, ".kimi-code", "credentials");
  fs.mkdirSync(credentialsDir, { recursive: true });
  fs.writeFileSync(path.join(credentialsDir, "kimi-code.json"), `${JSON.stringify({ token: "test-token" }, null, 2)}\n`, "utf8");
}

function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-kimi-state.json"), "utf8"));
}

function initRepoWithCommit(repo) {
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
}

function initRepoWithAppChange(repo, { initial = "export const value = 1;\n", changed = "export const value = 2;\n" } = {}) {
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), initial);
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), changed);
}

function writeWorkspaceState(stateDir, jobs, config = { stopReviewGate: false }) {
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({ version: 1, config, jobs }, null, 2)}\n`,
    "utf8"
  );
}

// --- setup -----------------------------------------------------------------

test("setup reports ready when fake kimi is installed and authenticated", (t) => {
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { home, env } = makeTestEnv(t, binDir);
  writeKimiCredentials(home);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.kimi.detail, /advanced runtime available/);
  assert.equal(payload.sessionRuntime.mode, "direct");
});

test("setup is ready without npm when Kimi is already installed and authenticated", (t) => {
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));
  const testEnv = makeTestEnv(t);
  writeKimiCredentials(testEnv.home);
  const env = { ...testEnv.env, PATH: binDir };

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.npm.available, false);
  assert.equal(payload.kimi.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("setup reports not logged in when the Kimi credentials file is missing", (t) => {
  const binDir = makeTempDir();
  installFakeKimi(binDir, "logged-out");
  const { env } = makeTestEnv(t, binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.auth.source, "acp");
  assert.equal(payload.auth.authMethod, "Login with Kimi account");
  assert.match(payload.auth.detail, /Not logged in/);
  assert.equal(payload.nextSteps.some((step) => step.includes("kimi login")), true);
});

test("setup trusts the Kimi credentials file even when initialize advertises login methods", (t) => {
  const binDir = makeTempDir();
  installFakeKimi(binDir, "logged-out");
  const { home, env } = makeTestEnv(t, binDir);
  writeKimiCredentials(home);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.source, "acp");
  assert.equal(payload.auth.authMethod, "Login with Kimi account");
  assert.match(payload.auth.detail, /Kimi credentials found \(unverified\)/);
});

// --- review ----------------------------------------------------------------

test("review renders an approve result from the prompt-driven review flow", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithAppChange(repo);

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Target: working tree diff/);
  assert.match(result.stdout, /Verdict: approve/);
  assert.match(result.stdout, /No material issues found/);
  assert.match(result.stdout, /No material findings/);

  const fakeState = readFakeState(binDir);
  assert.match(fakeState.lastPrompt.prompt, /performing a code review/);
  assert.match(fakeState.lastPrompt.prompt, /Target: working tree diff/);
});

test("review accepts the quoted raw argument style for built-in base-branch review", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithAppChange(repo);

  const result = run("node", [SCRIPT, "review", "--base main"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /branch diff against main|against main/i);
  assert.match(result.stdout, /No material issues found/);

  const fakeState = readFakeState(binDir);
  assert.match(fakeState.lastPrompt.prompt, /performing a code review/);
  assert.match(fakeState.lastPrompt.prompt, /Target: branch diff against main/);
});

test("review rejects focus text because it is adversarial-review only", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  initRepoWithCommit(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /does not support custom focus text/i);
  assert.match(result.stderr, /\/kimi:adversarial-review focus on auth/i);
});

test("review rejects staged-only scope", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  initRepoWithCommit(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "review", "--scope", "staged"], {
    cwd: repo,
    env
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("review degrades to raw-output rendering when Kimi returns invalid JSON", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir, "invalid-json");
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithAppChange(repo);

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /did not return valid structured JSON/);
  assert.match(result.stdout, /Parse error/);
  assert.match(result.stdout, /not valid json/);
});

test("review includes reasoning output when the acp server returns it", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir, "with-reasoning");
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reasoning:/);
  assert.match(result.stdout, /Reviewed the changed files and checked the likely regression paths/);
});

test("review logs reasoning summaries and review output to the job log", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir, "with-reasoning");
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Reviewed the changed files and checked the likely regression paths/);
  assert.match(log, /Review output/);
  assert.match(log, /No material issues found/);
});

test("review accepts --background while still running as a tracked review job", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.review, "Review");
  assert.match(launchPayload.kimi.stdout, /No material issues found/);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env
  });

  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /# Kimi Status/);
  assert.match(status.stdout, /Kimi Companion Review/);
  assert.match(status.stdout, /completed/);
});

// --- adversarial-review ----------------------------------------------------

test("adversarial review renders structured findings over a prompt-driven turn", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithAppChange(repo, {
    initial: "export const value = items[0];\n",
    changed: "export const value = items[0].id;\n"
  });

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.match(result.stdout, /Missing empty-state guard/);

  const fakeState = readFakeState(binDir);
  assert.match(fakeState.lastPrompt.prompt, /adversarial software review/);
});

test("adversarial review passes focus text through to the prompt", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithAppChange(repo, {
    initial: "export const value = items[0];\n",
    changed: "export const value = items[0].id;\n"
  });

  const result = run("node", [SCRIPT, "adversarial-review", "focus on the retry logic"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Missing empty-state guard/);

  const fakeState = readFakeState(binDir);
  assert.match(fakeState.lastPrompt.prompt, /adversarial software review/);
  assert.match(fakeState.lastPrompt.prompt, /User focus: focus on the retry logic/);
});

test("adversarial review approves cleanly when the fixture reports no findings", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir, "adversarial-clean");
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithAppChange(repo);

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verdict: approve/);
  assert.match(result.stdout, /No material findings/);
  assert.doesNotMatch(result.stdout, /Missing empty-state guard/);
});

test("adversarial review accepts the same base-branch targeting as review", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithAppChange(repo, {
    initial: "export const value = items[0];\n",
    changed: "export const value = items[0].id;\n"
  });

  const result = run("node", [SCRIPT, "adversarial-review", "--base", "main"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Branch diff against main|against main/i);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review asks Kimi to inspect larger diffs itself", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(repo, "src", name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "src/a.js", "src/b.js", "src/c.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = readFakeState(binDir);
  assert.match(fakeState.lastPrompt.prompt, /adversarial software review/);
  assert.match(fakeState.lastPrompt.prompt, /lightweight summary/i);
  assert.match(fakeState.lastPrompt.prompt, /read-only git commands/i);
  assert.doesNotMatch(fakeState.lastPrompt.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});

test("adversarial review rejects staged-only scope to match review target selection", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  initRepoWithCommit(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "adversarial-review", "--scope", "staged"], {
    cwd: repo,
    env
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

// --- task ------------------------------------------------------------------

test("write task output focuses on the Kimi result without generic follow-up hints", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");

  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastPrompt.mode, "yolo");
  assert.equal(fakeState.lastSetConfigOption.configId, "mode");
  assert.equal(fakeState.lastSetConfigOption.value, "yolo");
});

test("task runs without auth preflight so Kimi can refresh an expired session", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir, "refreshable-auth");
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const result = run("node", [SCRIPT, "task", "check refreshable auth"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task reports the actual Kimi auth error when the run is rejected", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir, "auth-run-fails");
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const result = run("node", [SCRIPT, "task", "check failed auth"], {
    cwd: repo,
    env
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication expired; run kimi login/);
});

test("task --write still completes when session/set_config_option fails", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir, "config-read-fails");
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
  assert.match(result.stderr, /failed to set "mode" to "yolo"/);
  assert.match(result.stderr, /set_config_option failed/);
});

test("task --wait is accepted and still runs in the foreground", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const result = run("node", [SCRIPT, "task", "--wait", "investigate the flaky test"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task --resume-last resumes the latest persisted task session", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");

  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.sessions.length, 1);
  assert.equal(fakeState.sessions[0].loaded, true);
  assert.equal(fakeState.lastPrompt.sessionId, fakeState.sessions[0].id);
  assert.equal(fakeState.lastPrompt.prompt, "follow up");
});

test("task --resume acts like --resume-last without leaking the flag into the prompt", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume", "follow up"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.sessions.length, 1);
  assert.equal(fakeState.lastPrompt.sessionId, fakeState.sessions[0].id);
  assert.equal(fakeState.lastPrompt.prompt, "follow up");
});

test("task --resume-last fails when no tracked task session exists", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  initRepoWithCommit(repo);

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /No previous Kimi task session was found for this repository\./);
});

test("task --resume-last refuses to continue while another task is still active", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir, { KIMI_COMPANION_SESSION_ID: "sess-current" });
  initRepoWithCommit(repo);

  const stateDir = resolveStateDir(repo);
  writeWorkspaceState(stateDir, [
    {
      id: "task-other-running",
      status: "running",
      title: "Kimi Companion Task",
      jobClass: "task",
      sessionId: "sess-other",
      summary: "Other session active task",
      updatedAt: "2026-03-24T20:05:00.000Z"
    }
  ]);

  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /Task task-other-running is still running\. Use \/kimi:status before continuing it\./);
});

test("task --fresh is treated as routing control and does not leak into the prompt", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastPrompt.prompt, "diagnose the flaky test");
});

test("task forwards model selection and thinking mode to the acp session", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const highspeed = run("node", [SCRIPT, "task", "--model", "highspeed", "--thinking", "off", "diagnose the failing test"], {
    cwd: repo,
    env
  });
  assert.equal(highspeed.status, 0, highspeed.stderr);
  let fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastPrompt.model, "kimi-code/kimi-for-coding-highspeed");
  assert.equal(fakeState.lastPrompt.thinking, "off");
  assert.equal(fakeState.lastSetConfigOption.configId, "thinking");
  assert.equal(fakeState.lastSetConfigOption.value, "off");

  const coding = run("node", [SCRIPT, "task", "--model", "k2.7", "diagnose the failing test again"], {
    cwd: repo,
    env
  });
  assert.equal(coding.status, 0, coding.stderr);
  fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastPrompt.model, "kimi-code/kimi-for-coding");

  const raw = run("node", [SCRIPT, "task", "--model", "kimi-code/k3", "diagnose the failing test once more"], {
    cwd: repo,
    env
  });
  assert.equal(raw.status, 0, raw.stderr);
  fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastSetConfigOption.configId, "model");
  assert.equal(fakeState.lastSetConfigOption.value, "kimi-code/k3");
  assert.equal(fakeState.lastPrompt.model, "kimi-code/k3");
});

test("task rejects an unsupported model before starting a session", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  initRepoWithCommit(repo);

  const result = run("node", [SCRIPT, "task", "--model", "bogus", "diagnose the failing test"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported model "bogus"\. Use one of: k3, k2\.7, highspeed/);
});

test("task logs reasoning summaries and assistant messages to the job log", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir, "with-reasoning");
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const result = run("node", [SCRIPT, "task", "investigate the failing test"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
  assert.match(log, /Assistant message/);
  assert.match(log, /Handled the requested task/);
});

test("task --background enqueues a detached worker and exposes per-job status", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir, "slow-task");
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
});

test("read-only task allows an execute-kind permission request", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir, "permission-request");
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const result = run("node", [SCRIPT, "task", "run the verification command"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastPermissionRequest.toolCall.kind, "execute");
  assert.equal(fakeState.lastPermissionRequest.outcome.outcome, "selected");
  assert.equal(fakeState.lastPermissionRequest.outcome.optionId, "allow_once");
});

test("read-only task rejects an edit-kind permission request", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir, "permission-request");
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const result = run("node", [SCRIPT, "task", "improve the parser"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastPermissionRequest.toolCall.kind, "edit");
  assert.equal(fakeState.lastPermissionRequest.outcome.outcome, "selected");
  assert.equal(fakeState.lastPermissionRequest.outcome.optionId, "reject_once");
});

// --- task-resume-candidate ---------------------------------------------------

test("task-resume-candidate returns the latest completed task session", (t) => {
  const workspace = makeTempDir();
  const { env } = makeTestEnv(t, null, { KIMI_COMPANION_SESSION_ID: "sess-current" });
  const stateDir = resolveStateDir(workspace);

  writeWorkspaceState(stateDir, [
    {
      id: "task-current",
      status: "completed",
      title: "Kimi Companion Task",
      jobClass: "task",
      sessionId: "session_current",
      summary: "Investigate the flaky test",
      completedAt: "2026-03-24T20:05:00.000Z",
      updatedAt: "2026-03-24T20:05:00.000Z"
    },
    {
      id: "task-older",
      status: "completed",
      title: "Kimi Companion Task",
      jobClass: "task",
      sessionId: "session_older",
      summary: "Old rescue run",
      completedAt: "2026-03-24T20:00:00.000Z",
      updatedAt: "2026-03-24T20:00:00.000Z"
    },
    {
      id: "review-latest",
      status: "completed",
      title: "Kimi Companion Review",
      jobClass: "review",
      sessionId: "session_review",
      summary: "Review main...HEAD",
      completedAt: "2026-03-24T20:10:00.000Z",
      updatedAt: "2026-03-24T20:10:00.000Z"
    }
  ]);

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.sessionId, "session_current");
});

// --- status / result / cancel ------------------------------------------------

test("status shows phases, hints, and the latest finished job", (t) => {
  const workspace = makeTempDir();
  const { env } = makeTestEnv(t);
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-live.log");
  fs.writeFileSync(
    logFile,
    [
      "[2026-03-18T15:30:00.000Z] Starting Kimi Companion Review.",
      "[2026-03-18T15:30:01.000Z] Session ready (session_1).",
      "[2026-03-18T15:30:02.000Z] Turn started.",
      "[2026-03-18T15:30:03.000Z] Reviewer started: current changes"
    ].join("\n"),
    "utf8"
  );

  writeWorkspaceState(stateDir, [
    {
      id: "review-live",
      kind: "review",
      kindLabel: "review",
      status: "running",
      title: "Kimi Companion Review",
      jobClass: "review",
      phase: "reviewing",
      sessionId: "session_1",
      summary: "Review working tree diff",
      logFile,
      createdAt: "2026-03-18T15:30:00.000Z",
      startedAt: "2026-03-18T15:30:01.000Z",
      updatedAt: "2026-03-18T15:30:03.000Z"
    },
    {
      id: "review-done",
      status: "completed",
      title: "Kimi Companion Review",
      jobClass: "review",
      sessionId: "session_done",
      summary: "Review main...HEAD",
      createdAt: "2026-03-18T15:10:00.000Z",
      startedAt: "2026-03-18T15:10:05.000Z",
      completedAt: "2026-03-18T15:11:10.000Z",
      updatedAt: "2026-03-18T15:11:10.000Z"
    }
  ]);

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active jobs:/);
  assert.match(result.stdout, /\| Job \| Kind \| Status \| Phase \| Elapsed \| Kimi Session ID \| Summary \| Actions \|/);
  assert.match(result.stdout, /\| review-live \| review \| running \| reviewing \| .* \| session_1 \| Review working tree diff \|/);
  assert.match(result.stdout, /`\/kimi:status review-live`<br>`\/kimi:cancel review-live`/);
  assert.match(result.stdout, /Live details:/);
  assert.match(result.stdout, /Latest finished:/);
  assert.match(result.stdout, /Progress:/);
  assert.match(result.stdout, /Session runtime: direct startup/);
  assert.match(result.stdout, /Phase: reviewing/);
  assert.match(result.stdout, /Kimi session ID: session_1/);
  assert.match(result.stdout, /Resume in Kimi: kimi -r session_1/);
  assert.match(result.stdout, /Session ready \(session_1\)\./);
  assert.match(result.stdout, /Reviewer started: current changes/);
  assert.match(result.stdout, /Duration: 1m 5s/);
  assert.match(result.stdout, /Kimi session ID: session_done/);
  assert.match(result.stdout, /Resume in Kimi: kimi -r session_done/);
});

test("status without a job id only shows jobs from the current Claude session", (t) => {
  const workspace = makeTempDir();
  const { env } = makeTestEnv(t, null, { KIMI_COMPANION_SESSION_ID: "sess-current" });
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const currentLog = path.join(jobsDir, "review-current.log");
  const otherLog = path.join(jobsDir, "review-other.log");
  fs.writeFileSync(currentLog, "[2026-03-18T15:30:00.000Z] Reviewer started: current changes\n", "utf8");
  fs.writeFileSync(otherLog, "[2026-03-18T15:31:00.000Z] Reviewer started: old changes\n", "utf8");

  writeWorkspaceState(stateDir, [
    {
      id: "review-current",
      kind: "review",
      kindLabel: "review",
      status: "running",
      title: "Kimi Companion Review",
      jobClass: "review",
      phase: "reviewing",
      sessionId: "sess-current",
      summary: "Current session review",
      logFile: currentLog,
      createdAt: "2026-03-18T15:30:00.000Z",
      updatedAt: "2026-03-18T15:30:00.000Z"
    },
    {
      id: "review-other",
      kind: "review",
      kindLabel: "review",
      status: "completed",
      title: "Kimi Companion Review",
      jobClass: "review",
      sessionId: "sess-other",
      summary: "Previous session review",
      logFile: otherLog,
      createdAt: "2026-03-18T15:20:00.000Z",
      startedAt: "2026-03-18T15:20:05.000Z",
      completedAt: "2026-03-18T15:21:00.000Z",
      updatedAt: "2026-03-18T15:21:00.000Z"
    }
  ]);

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...new Set(result.stdout.match(/review-(?:current|other)/g) ?? [])],
    ["review-current"]
  );
});

test("status preserves adversarial review kind labels", (t) => {
  const workspace = makeTempDir();
  const { env } = makeTestEnv(t);
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-adv.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Reviewer started: adversarial review\n", "utf8");

  writeWorkspaceState(stateDir, [
    {
      id: "review-adv-live",
      kind: "adversarial-review",
      status: "running",
      title: "Kimi Companion Adversarial Review",
      jobClass: "review",
      phase: "reviewing",
      sessionId: "session_adv_live",
      summary: "Adversarial review current changes",
      logFile,
      createdAt: "2026-03-18T15:30:00.000Z",
      updatedAt: "2026-03-18T15:30:00.000Z"
    },
    {
      id: "review-adv",
      kind: "adversarial-review",
      status: "completed",
      title: "Kimi Companion Adversarial Review",
      jobClass: "review",
      sessionId: "session_adv_done",
      summary: "Adversarial review working tree diff",
      createdAt: "2026-03-18T15:10:00.000Z",
      startedAt: "2026-03-18T15:10:05.000Z",
      completedAt: "2026-03-18T15:11:10.000Z",
      updatedAt: "2026-03-18T15:11:10.000Z"
    }
  ]);

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| review-adv-live \| adversarial-review \| running \| reviewing \|/);
  assert.match(result.stdout, /- review-adv \| completed \| adversarial-review \| Kimi Companion Adversarial Review/);
  assert.match(result.stdout, /Kimi session ID: session_adv_live/);
  assert.match(result.stdout, /Kimi session ID: session_adv_done/);
});

test("status --wait times out cleanly when a job is still active", (t) => {
  const workspace = makeTempDir();
  const { env } = makeTestEnv(t);
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Kimi Companion Task.\n", "utf8");
  fs.writeFileSync(
    path.join(jobsDir, "task-live.json"),
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Kimi Companion Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );

  writeWorkspaceState(stateDir, [
    {
      id: "task-live",
      status: "running",
      title: "Kimi Companion Task",
      jobClass: "task",
      summary: "Investigate flaky test",
      logFile,
      createdAt: "2026-03-18T15:30:00.000Z",
      startedAt: "2026-03-18T15:30:01.000Z",
      updatedAt: "2026-03-18T15:30:02.000Z"
    }
  ]);

  const result = run("node", [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  assert.equal(payload.waitTimedOut, true);
});

test("result returns the stored output for the latest finished job by default", (t) => {
  const workspace = makeTempDir();
  const { env } = makeTestEnv(t);
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-finished.json"),
    JSON.stringify(
      {
        id: "review-finished",
        status: "completed",
        title: "Kimi Companion Review",
        rendered: "# Kimi Review\n\nReviewed uncommitted changes.\nNo material issues found.\n",
        result: {
          kimi: {
            stdout: "Reviewed uncommitted changes.\nNo material issues found."
          }
        },
        sessionId: "session_review_finished"
      },
      null,
      2
    ),
    "utf8"
  );

  writeWorkspaceState(stateDir, [
    {
      id: "review-finished",
      status: "completed",
      title: "Kimi Companion Review",
      jobClass: "review",
      sessionId: "session_review_finished",
      summary: "Review working tree diff",
      createdAt: "2026-03-18T15:00:00.000Z",
      updatedAt: "2026-03-18T15:01:00.000Z"
    }
  ]);

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Reviewed uncommitted changes.\nNo material issues found.\n\nKimi session ID: session_review_finished\nResume in Kimi: kimi -r session_review_finished\n"
  );
});

test("result without a job id prefers the latest finished job from the current Claude session", (t) => {
  const workspace = makeTempDir();
  const { env } = makeTestEnv(t, null, { KIMI_COMPANION_SESSION_ID: "sess-current" });
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-current.json"),
    JSON.stringify(
      {
        id: "review-current",
        status: "completed",
        title: "Kimi Companion Review",
        sessionId: "session_current",
        result: {
          kimi: {
            stdout: "Current session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(jobsDir, "review-other.json"),
    JSON.stringify(
      {
        id: "review-other",
        status: "completed",
        title: "Kimi Companion Review",
        sessionId: "session_other",
        result: {
          kimi: {
            stdout: "Old session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  writeWorkspaceState(stateDir, [
    {
      id: "review-current",
      status: "completed",
      title: "Kimi Companion Review",
      jobClass: "review",
      sessionId: "sess-current",
      summary: "Current session review",
      createdAt: "2026-03-18T15:10:00.000Z",
      updatedAt: "2026-03-18T15:11:00.000Z"
    },
    {
      id: "review-other",
      status: "completed",
      title: "Kimi Companion Review",
      jobClass: "review",
      sessionId: "sess-other",
      summary: "Old session review",
      createdAt: "2026-03-18T15:20:00.000Z",
      updatedAt: "2026-03-18T15:21:00.000Z"
    }
  ]);

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Current session output.\n\nKimi session ID: session_current\nResume in Kimi: kimi -r session_current\n"
  );
});

test("result for a finished write-capable task returns the raw Kimi final response", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const taskRun = run("node", [SCRIPT, "task", "--write", "fix the flaky integration test"], {
    cwd: repo,
    env
  });
  assert.equal(taskRun.status, 0, taskRun.stderr);

  const result = run("node", [SCRIPT, "result"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);
  assert.match(result.stdout, /Kimi session ID: session_[a-f0-9-]+/i);
  assert.match(result.stdout, /Resume in Kimi: kimi -r session_[a-f0-9-]+/i);
});

test("cancel stops an active background job and marks it cancelled", async (t) => {
  const workspace = makeTempDir();
  const { env } = makeTestEnv(t);
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const logFile = path.join(jobsDir, "task-live.log");
  const jobFile = path.join(jobsDir, "task-live.json");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Kimi Companion Task.\n", "utf8");
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Kimi Companion Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );
  writeWorkspaceState(stateDir, [
    {
      id: "task-live",
      status: "running",
      title: "Kimi Companion Task",
      jobClass: "task",
      summary: "Investigate flaky test",
      pid: sleeper.pid,
      logFile,
      createdAt: "2026-03-18T15:30:00.000Z",
      startedAt: "2026-03-18T15:30:01.000Z",
      updatedAt: "2026-03-18T15:30:02.000Z"
    }
  ]);

  const cancelResult = run("node", [SCRIPT, "cancel", "task-live", "--json"], {
    cwd: workspace,
    env
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const cancelled = state.jobs.find((job) => job.id === "task-live");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pid, null);

  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "cancelled");
  assert.match(fs.readFileSync(logFile, "utf8"), /Cancelled by user/);
});

test("cancel without a job id ignores active jobs from other Claude sessions", (t) => {
  const workspace = makeTempDir();
  const { env } = makeTestEnv(t, null, { KIMI_COMPANION_SESSION_ID: "sess-current" });
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  writeWorkspaceState(stateDir, [
    {
      id: "task-other",
      status: "running",
      title: "Kimi Companion Task",
      jobClass: "task",
      sessionId: "sess-other",
      summary: "Other session run",
      updatedAt: "2026-03-24T20:05:00.000Z",
      logFile
    }
  ]);

  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = run("node", [SCRIPT, "cancel", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /No active Kimi jobs to cancel for this session\./);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "running");
});

test("cancel with a job id can still target an active job from another Claude session", (t) => {
  const workspace = makeTempDir();
  const { env } = makeTestEnv(t, null, { KIMI_COMPANION_SESSION_ID: "sess-current" });
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  writeWorkspaceState(stateDir, [
    {
      id: "task-other",
      status: "running",
      title: "Kimi Companion Task",
      jobClass: "task",
      sessionId: "sess-other",
      summary: "Other session run",
      updatedAt: "2026-03-24T20:05:00.000Z",
      logFile
    }
  ]);

  const cancel = run("node", [SCRIPT, "cancel", "task-other", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).jobId, "task-other");

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "cancelled");
});

test("cancel sends a session interrupt to the shared broker before killing a brokered task", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir, "interruptible-slow-task");
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  assert.ok(jobId);

  const stateDir = resolveStateDir(repo);
  const runningJob = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (job?.status === "running" && job.sessionId) {
      return job;
    }
    return null;
  }, { timeoutMs: 15000 });

  const cancelResult = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, "cancelled");
  assert.equal(cancelPayload.sessionInterruptAttempted, true);
  assert.equal(cancelPayload.sessionInterrupted, true);

  await waitFor(() => readFakeState(binDir).lastCancel ?? null);

  const fakeState = readFakeState(binDir);
  assert.deepEqual(fakeState.lastCancel, {
    sessionId: runningJob.sessionId
  });

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

// --- transfer ---------------------------------------------------------------

test("task auto-cancels a wedged turn that streams nothing and fails the job", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir, "wedged-task");
  const { env } = makeTestEnv(t, binDir, {
    KIMI_COMPANION_STALL_TIMEOUT_MS: "1500",
    KIMI_COMPANION_STALL_WARN_MS: "400"
  });
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const result = run("node", [SCRIPT, "task", "diagnose the wedged upstream"], {
    cwd: repo,
    env
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /stalled turn was cancelled/);

  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "failed");
  assert.equal(state.jobs[0].phase, "failed");

  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /No output from Kimi for/);
  assert.match(log, /stalled turn was cancelled/);

  // The watchdog cancels the upstream turn so it does not keep running.
  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.lastCancel?.sessionId, state.jobs[0].sessionId);
});

test("broker cancels the orphaned upstream turn when a streaming worker dies", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir, "interruptible-slow-task");
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the orphaned worker"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  assert.ok(jobId);

  const stateDir = resolveStateDir(repo);
  const runningJob = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (job?.status === "running" && job.sessionId && job.pid) {
      return job;
    }
    return null;
  }, { timeoutMs: 15000 });

  // Wait until the worker's prompt is actually streaming upstream, then kill
  // the worker process outright (no /kimi:cancel interrupt) so the broker
  // must clean up the orphaned turn on its own.
  await waitFor(() => {
    const fakeState = readFakeState(binDir);
    return fakeState.lastPrompt?.sessionId === runningJob.sessionId ? true : null;
  }, { timeoutMs: 15000 });
  terminateProcessTree(runningJob.pid);

  const cancel = await waitFor(() => readFakeState(binDir).lastCancel ?? null, { timeoutMs: 15000 });
  assert.equal(cancel.sessionId, runningJob.sessionId);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

// --- transfer ---------------------------------------------------------------

test("transfer seeds a Kimi session from the current Claude transcript", (t) => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sessionId = "sess-native-transfer";
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeKimi(binDir, "transfer");
  initGitRepo(repo);

  fs.writeFileSync(
    sourcePath,
    [
      { type: "custom-title", customTitle: "Native transfer" },
      { type: "user", cwd: repo, message: { role: "user", content: "Initial request" } },
      { type: "assistant", cwd: repo, message: { role: "assistant", content: "Initial answer" } },
      { type: "user", cwd: repo, message: { role: "user", content: "/kimi:transfer" } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8"
  );

  const { env } = makeTestEnv(t, binDir, {
    HOME: home,
    KIMI_COMPANION_TRANSCRIPT_PATH: sourcePath
  });
  scheduleBrokerCleanup(t, repo, env);

  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const canonicalSourcePath = fs.realpathSync(sourcePath);
  assert.match(payload.sessionId, /^session_/);
  assert.equal(payload.resumeCommand, `kimi -r ${payload.sessionId}`);
  assert.equal(payload.sourcePath, canonicalSourcePath);
  assert.equal(payload.claudeSessionId, sessionId);

  const fakeState = readFakeState(binDir);
  assert.match(fakeState.lastTransfer.prompt, /<transferred-transcript>/);
  assert.match(fakeState.lastTransfer.prompt, /## User\nInitial request/);
  assert.match(fakeState.lastTransfer.prompt, /## Assistant\nInitial answer/);
  assert.match(fakeState.lastTransfer.prompt, /\/kimi:transfer/);
});

test("transfer rejects sources outside the Claude projects directory", (t) => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sourcePath = path.join(home, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  installFakeKimi(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Outside source." } })}\n`,
    "utf8"
  );

  const { env } = makeTestEnv(t, binDir, { HOME: home });

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only from .*\.claude.*projects/);
});

// --- hooks -------------------------------------------------------------------

test("session start hook exports the Claude session id, transcript path, and plugin data dir", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "kimi-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, "session.jsonl");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...scrubEnv(process.env),
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: transcriptPath,
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  // The hook exports a kimi-specific plugin-data pointer, NOT the generic
  // CLAUDE_PLUGIN_DATA that sibling companion plugins race to overwrite.
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export KIMI_COMPANION_SESSION_ID='sess-current'\nexport KIMI_COMPANION_TRANSCRIPT_PATH='${transcriptPath}'\nexport KIMI_COMPANION_PLUGIN_DATA='${pluginDataDir}'\n`
  );
});

test("session end fully cleans up jobs for the ending session", async (t) => {
  const repo = makeTempDir();
  const { env } = makeTestEnv(t);
  initRepoWithCommit(repo);

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = path.join(jobsDir, "completed.log");
  const runningLog = path.join(jobsDir, "running.log");
  const otherSessionLog = path.join(jobsDir, "other.log");
  const completedJobFile = path.join(jobsDir, "review-completed.json");
  const runningJobFile = path.join(jobsDir, "review-running.json");
  const otherJobFile = path.join(jobsDir, "review-other.json");
  fs.writeFileSync(completedLog, "completed\n", "utf8");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  fs.writeFileSync(otherSessionLog, "other\n", "utf8");
  fs.writeFileSync(completedJobFile, JSON.stringify({ id: "review-completed" }, null, 2), "utf8");
  fs.writeFileSync(otherJobFile, JSON.stringify({ id: "review-other" }, null, 2), "utf8");

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  fs.writeFileSync(runningJobFile, JSON.stringify({ id: "review-running" }, null, 2), "utf8");

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  writeWorkspaceState(stateDir, [
    {
      id: "review-completed",
      status: "completed",
      title: "Kimi Companion Review",
      sessionId: "sess-current",
      logFile: completedLog,
      createdAt: "2026-03-18T15:30:00.000Z",
      updatedAt: "2026-03-18T15:31:00.000Z"
    },
    {
      id: "review-running",
      status: "running",
      title: "Kimi Companion Review",
      sessionId: "sess-current",
      pid: sleeper.pid,
      logFile: runningLog,
      createdAt: "2026-03-18T15:32:00.000Z",
      updatedAt: "2026-03-18T15:33:00.000Z"
    },
    {
      id: "review-other",
      status: "completed",
      title: "Kimi Companion Review",
      sessionId: "sess-other",
      logFile: otherSessionLog,
      createdAt: "2026-03-18T15:34:00.000Z",
      updatedAt: "2026-03-18T15:35:00.000Z"
    }
  ]);

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(otherSessionLog), true);
  assert.equal(fs.existsSync(otherJobFile), true);
  assert.deepEqual(
    fs.readdirSync(path.dirname(otherJobFile)).sort(),
    [path.basename(otherJobFile), path.basename(otherSessionLog)].sort()
  );

  await waitFor(() => {
    try {
      process.kill(sleeper.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(state.jobs.map((job) => job.id), ["review-other"]);
  const otherJob = state.jobs[0];
  assert.equal(otherJob.logFile, otherSessionLog);
});

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env,
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /Kimi stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const fakeState = readFakeState(binDir);
  assert.match(fakeState.lastPrompt.prompt, /Run a stop-gate review of the previous Claude turn\./);
  assert.match(fakeState.lastPrompt.prompt, /<task>/i);
  assert.match(fakeState.lastPrompt.prompt, /<compact_output_contract>/i);
  assert.match(fakeState.lastPrompt.prompt, /Only review the work from the previous Claude turn/i);
  assert.match(fakeState.lastPrompt.prompt, /I completed the refactor and updated the retry logic\./);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Kimi Companion Stop Gate Review/);
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", (t) => {
  const repo = makeTempDir();
  const { env } = makeTestEnv(t, null, { KIMI_COMPANION_SESSION_ID: "sess-current" });
  initRepoWithCommit(repo);

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const runningLog = path.join(jobsDir, "task-running.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");

  writeWorkspaceState(stateDir, [
    {
      id: "task-live",
      status: "running",
      title: "Kimi Companion Task",
      jobClass: "task",
      sessionId: "sess-current",
      logFile: runningLog,
      createdAt: "2026-03-18T15:32:00.000Z",
      updatedAt: "2026-03-18T15:33:00.000Z"
    }
  ]);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env,
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
  assert.match(blocked.stderr, /Kimi task task-live is still running/i);
  assert.match(blocked.stderr, /\/kimi:status/i);
  assert.match(blocked.stderr, /\/kimi:cancel task-live/i);
});

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir, "adversarial-clean");
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env,
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when Kimi is unavailable even if the review gate is enabled", (t) => {
  const repo = makeTempDir();
  const { pluginData } = makeTestEnv(t);
  initRepoWithCommit(repo);

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: {
      ...scrubEnv(process.env),
      CLAUDE_PLUGIN_DATA: pluginData
    }
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...scrubEnv(process.env),
      CLAUDE_PLUGIN_DATA: pluginData,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
  assert.match(allowed.stderr, /Kimi is not set up for the review gate/i);
  assert.match(allowed.stderr, /Run \/kimi:setup/i);
});

test("stop hook runs the actual task when auth status looks stale", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir, "refreshable-auth");
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env,
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /Kimi is not set up for the review gate/i);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Missing empty-state guard/i);
});

// --- shared broker ------------------------------------------------------------

test("commands lazily start and reuse one shared broker after first use", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = readBrokerSession(repo);
  if (!brokerSession) {
    return;
  }
  assert.ok(brokerSession.endpoint);

  const adversarial = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });
  assert.equal(adversarial.status, 0, adversarial.stderr);

  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.acpStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("setup checks auth over a direct acp connection without disturbing the shared broker", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { home, env } = makeTestEnv(t, binDir);
  writeKimiCredentials(home);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = readBrokerSession(repo);
  if (!brokerSession) {
    return;
  }

  const setup = run("node", [SCRIPT, "setup", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).ready, true);

  // The broker answers `initialize` locally with authMethods: [], so the auth
  // check deliberately spawns one direct `kimi acp` per setup call; the shared
  // broker and its single upstream stay untouched.
  const fakeState = readFakeState(binDir);
  assert.equal(fakeState.acpStarts, 2);
  assert.equal(readBrokerSession(repo).endpoint, brokerSession.endpoint);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("status reports shared session runtime when a lazy broker is active", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  if (!readBrokerSession(repo)) {
    return;
  }

  const result = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session runtime: shared session/);
});

test("setup and status honor --cwd when reading shared session runtime", (t) => {
  const targetWorkspace = makeTempDir();
  const invocationWorkspace = makeTempDir();
  const { env } = makeTestEnv(t);

  const brokerSessionDir = makeTempDir("kxc-");
  saveBrokerSession(targetWorkspace, {
    endpoint: `unix:${path.join(brokerSessionDir, "broker.sock")}`,
    pidFile: path.join(brokerSessionDir, "broker.pid"),
    logFile: path.join(brokerSessionDir, "broker.log"),
    sessionDir: brokerSessionDir,
    pid: null
  });

  const status = run("node", [SCRIPT, "status", "--cwd", targetWorkspace], {
    cwd: invocationWorkspace,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Session runtime: shared session/);

  const setup = run("node", [SCRIPT, "setup", "--cwd", targetWorkspace, "--json"], {
    cwd: invocationWorkspace,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.sessionRuntime.mode, "shared");
  assert.equal(payload.sessionRuntime.endpoint, `unix:${path.join(brokerSessionDir, "broker.sock")}`);
});

test("status ignores a cached broker session that belongs to a foreign plugin", (t) => {
  const targetWorkspace = makeTempDir();
  const invocationWorkspace = makeTempDir();
  const { env } = makeTestEnv(t);

  // Shaped exactly like a sibling plugin's broker session (Codex uses the
  // "cxc-" prefix) leaked into this state root.
  const foreignSessionDir = makeTempDir("cxc-");
  saveBrokerSession(targetWorkspace, {
    endpoint: `unix:${path.join(foreignSessionDir, "broker.sock")}`,
    pidFile: path.join(foreignSessionDir, "broker.pid"),
    logFile: path.join(foreignSessionDir, "broker.log"),
    sessionDir: foreignSessionDir,
    pid: null
  });

  const status = run("node", [SCRIPT, "status", "--cwd", targetWorkspace], {
    cwd: invocationWorkspace,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Session runtime: direct startup/);
});

test("isOwnBrokerSession only accepts sessions this plugin spawned", (t) => {
  const ownDir = makeTempDir("kxc-");
  const foreignDir = makeTempDir("cxc-");

  assert.equal(
    isOwnBrokerSession({
      endpoint: `unix:${path.join(ownDir, "broker.sock")}`,
      pidFile: path.join(ownDir, "broker.pid"),
      logFile: path.join(ownDir, "broker.log"),
      sessionDir: ownDir,
      pid: 1234
    }),
    true
  );
  // Sibling plugin's session (different temp-dir prefix).
  assert.equal(
    isOwnBrokerSession({
      endpoint: `unix:${path.join(foreignDir, "broker.sock")}`,
      sessionDir: foreignDir,
      pid: 1234
    }),
    false
  );
  // Endpoint living outside the recorded session dir.
  assert.equal(
    isOwnBrokerSession({ endpoint: "unix:/tmp/somewhere-else/broker.sock", sessionDir: ownDir }),
    false
  );
  // Hand-written or legacy sessions without a session dir are not provably ours.
  assert.equal(isOwnBrokerSession({ endpoint: "unix:/tmp/fake-broker.sock" }), false);
  assert.equal(isOwnBrokerSession(null), false);
  assert.equal(isOwnBrokerSession({}), false);

  const workspace = makeTempDir();
  makeTestEnv(t);
  saveBrokerSession(workspace, { endpoint: `unix:${path.join(foreignDir, "broker.sock")}`, sessionDir: foreignDir });
  assert.equal(readOwnBrokerSession(workspace), null);
  saveBrokerSession(workspace, {
    endpoint: `unix:${path.join(ownDir, "broker.sock")}`,
    sessionDir: ownDir,
    pid: null
  });
  assert.equal(readOwnBrokerSession(workspace)?.sessionDir, ownDir);
});

test("a foreign cached broker session is replaced, never reused, and its broker is left running", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  // The "foreign broker": a live process a torn-down session must not kill
  // (in the incident this was Codex's app-server broker, pid 49825).
  const foreignBroker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  foreignBroker.unref();
  t.after(() => {
    try {
      process.kill(-foreignBroker.pid, "SIGTERM");
    } catch {
      try {
        process.kill(foreignBroker.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const foreignSessionDir = makeTempDir("cxc-");
  fs.writeFileSync(path.join(foreignSessionDir, "broker.pid"), `${foreignBroker.pid}\n`, "utf8");
  saveBrokerSession(repo, {
    endpoint: `unix:${path.join(foreignSessionDir, "broker.sock")}`,
    pidFile: path.join(foreignSessionDir, "broker.pid"),
    logFile: path.join(foreignSessionDir, "broker.log"),
    sessionDir: foreignSessionDir,
    pid: foreignBroker.pid
  });

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  // The foreign broker process was NOT torn down or killed…
  assert.doesNotThrow(() => process.kill(foreignBroker.pid, 0));
  assert.equal(fs.existsSync(path.join(foreignSessionDir, "broker.pid")), true);

  // …and the poisoned record was replaced by our own freshly spawned broker.
  const brokerSession = readBrokerSession(repo);
  assert.ok(brokerSession);
  assert.equal(isOwnBrokerSession(brokerSession), true);
  assert.match(path.basename(brokerSession.sessionDir), /^kxc-/);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.doesNotThrow(() => process.kill(foreignBroker.pid, 0));
});

test("a broker that fails the Kimi handshake is rejected and the run falls back to direct", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeKimi(binDir);
  const { env } = makeTestEnv(t, binDir);
  scheduleBrokerCleanup(t, repo, env);
  initRepoWithCommit(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  // A live FOREIGN broker hiding behind an own-shaped session record: the
  // socket connect succeeds, so only the handshake can unmask it.
  const brokerSessionDir = makeTempDir("kxc-");
  const socketPath = path.join(brokerSessionDir, "broker.sock");
  const foreignBroker = spawn(process.execPath, [FOREIGN_BROKER_FIXTURE, socketPath], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  foreignBroker.unref();
  t.after(() => {
    try {
      process.kill(-foreignBroker.pid, "SIGTERM");
    } catch {
      try {
        process.kill(foreignBroker.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });
  await waitFor(() => fs.existsSync(socketPath) || null);

  saveBrokerSession(repo, {
    endpoint: `unix:${socketPath}`,
    pidFile: path.join(brokerSessionDir, "broker.pid"),
    logFile: path.join(brokerSessionDir, "broker.log"),
    sessionDir: brokerSessionDir,
    pid: foreignBroker.pid
  });

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  // The poisoned session record was cleared and no new broker was cached;
  // the review completed over a direct `kimi acp` connection instead.
  assert.equal(readBrokerSession(repo), null);
  assert.equal(readFakeState(binDir).acpStarts, 1);

  // The foreign broker was not killed either.
  assert.doesNotThrow(() => process.kill(foreignBroker.pid, 0));
});
