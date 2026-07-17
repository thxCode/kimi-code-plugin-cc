import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { scrubEnv, writeExecutable } from "./helpers.mjs";

// Behavior switches (second argument to installFakeKimi; overridable per
// process via the FAKE_KIMI_BEHAVIOR env var, which buildEnv passes through):
// - "review-ok" (default): authenticated; reviews approve, adversarial review
//   reports one finding, stop-gate BLOCKs, tasks return canned text.
// - "adversarial-clean": adversarial review approves and the stop-gate ALLOWs.
// - "invalid-json": review-class prompts return "not valid json" instead of
//   the structured review payload.
// - "with-reasoning": every prompt first streams an agent_thought_chunk.
// - "slow-task": prompt responses complete after a 400ms delay.
// - "interruptible-slow-task": prompt responses complete after 5000ms; a
//   session/cancel notification resolves the in-flight prompt with
//   stopReason "cancelled" instead.
// - "logged-out": initialize reports a non-empty authMethods list (the
//   logged-out signal; the companion's real check also looks for
//   ~/.kimi-code/credentials/kimi-code.json). Sessions and prompts still work.
// - "refreshable-auth": same authMethods signal as "logged-out"; prompts still
//   work so the CLI can refresh an expired session.
// - "auth-run-fails": logged-out authMethods AND session/new + session/load
//   fail with "authentication expired; run kimi login".
// - "config-read-fails": session/set_config_option fails (port of the source
//   fixture's config/read failure).
// - "permission-request": every prompt first emits a tool_call update and a
//   server->client session/request_permission request, then waits for the
//   client's answer before finishing the turn.
// - "transfer": prompts that look like a transferred Claude transcript
//   ("## User"/"## Assistant" blocks or "transferred Claude") are recorded in
//   state.lastTransfer and answered with a transfer acknowledgement.
export function installFakeKimi(binDir, behavior = "review-ok") {
  const statePath = path.join(binDir, "fake-kimi-state.json");
  const scriptPath = path.join(binDir, "kimi");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const readline = require("node:readline");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = process.env.FAKE_KIMI_BEHAVIOR || ${JSON.stringify(behavior)};
const interruptiblePrompts = new Map();
const pendingServerRequests = new Map();
let nextServerRequestId = 1;

const DEFAULT_MODEL = "kimi-code/k3";
const DEFAULT_THINKING = "on";
const DEFAULT_MODE = "default";

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return {
      nextSessionIndex: 1,
      acpStarts: 0,
      sessions: [],
      initializeParams: null,
      lastPrompt: null,
      lastSetConfigOption: null,
      lastCancel: null,
      lastPermissionRequest: null,
      lastTransfer: null
    };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function nowIso() {
  return new Date().toISOString();
}

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

function requiresLogin() {
  return BEHAVIOR === "logged-out" || BEHAVIOR === "refreshable-auth" || BEHAVIOR === "auth-run-fails";
}

function buildAuthMethods() {
  if (!requiresLogin()) {
    return [];
  }
  return [
    {
      id: "login",
      type: "terminal",
      name: "Login with Kimi account",
      description: "Open the device-code login flow in a terminal.",
      args: ["--login"],
      env: {},
      _meta: {
        "terminal-auth": {
          type: "terminal",
          label: "Login with Kimi account",
          command: "kimi",
          args: ["login"],
          env: {}
        }
      }
    }
  ];
}

function buildConfigOptions(session) {
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: session.config.model,
      options: [
        { value: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
        { value: "kimi-code/kimi-for-coding-highspeed", name: "K2.7 Coding Highspeed" },
        { value: "kimi-code/k3", name: "K3" }
      ]
    },
    {
      type: "select",
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      currentValue: session.config.thinking,
      options: [
        { value: "on", name: "Thinking On" },
        { value: "off", name: "Thinking Off" }
      ]
    },
    {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: session.config.mode,
      options: [
        { value: "default", name: "Default", description: "Manual approvals; tools execute normally." },
        { value: "plan", name: "Plan", description: "Read-only planning; no tool execution." },
        { value: "auto", name: "Auto", description: "Auto-approve safe operations." },
        { value: "yolo", name: "YOLO", description: "Auto-approve everything." }
      ]
    }
  ];
}

function ensureSession(state, sessionId) {
  const session = state.sessions.find((candidate) => candidate.id === sessionId);
  if (!session) {
    throw new Error("unknown session " + sessionId);
  }
  return session;
}

function classifyPrompt(prompt) {
  if (
    prompt.includes("Run a stop-gate review of the previous Claude turn.") ||
    (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn."))
  ) {
    return "stop-gate";
  }
  if (prompt.includes("adversarial software review")) {
    return "adversarial-review";
  }
  if (prompt.includes("performing a code review")) {
    return "review";
  }
  if (BEHAVIOR === "transfer" && (prompt.includes("## User") || prompt.includes("## Assistant") || /transferred Claude/i.test(prompt))) {
    return "transfer";
  }
  return "task";
}

function structuredReviewPayload(kind) {
  if (BEHAVIOR === "invalid-json") {
    return "not valid json";
  }
  if (kind === "adversarial-review" && BEHAVIOR !== "adversarial-clean") {
    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }
  return JSON.stringify({
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
}

function stopGatePayload() {
  if (BEHAVIOR === "adversarial-clean") {
    return "ALLOW: No blocking issues found in the previous turn.";
  }
  return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
}

function taskPayload(prompt, session) {
  if (session.loaded || prompt.includes("Continue from the current session state") || prompt.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }
  return "Handled the requested task.\\nTask prompt accepted.";
}

function transferPayload() {
  return "Picked up the transferred Claude Code session context.\\nTransfer seed accepted.";
}

function thoughtText(kind) {
  if (kind === "review" || kind === "adversarial-review") {
    return "Reviewed the changed files and checked the likely regression paths.";
  }
  return "Inspected the prompt, gathered evidence, and checked the highest-risk paths first.";
}

function streamThought(sessionId, text) {
  send({
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } } }
  });
}

function streamFinalMessage(sessionId, text) {
  const midpoint = Math.ceil(text.length / 2);
  send({
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: text.slice(0, midpoint) } } }
  });
  send({
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: text.slice(midpoint) } } }
  });
}

function completePrompt(sessionId, requestId, kind, payload) {
  if (BEHAVIOR === "with-reasoning") {
    streamThought(sessionId, thoughtText(kind));
  }
  streamFinalMessage(sessionId, payload);
  send({ id: requestId, result: { stopReason: "end_turn" } });
}

function requestPermission(sessionId, prompt) {
  const toolCallId = "call_" + nextServerRequestId;
  const requestId = "srv_" + nextServerRequestId;
  nextServerRequestId += 1;
  const isBash = /\\b(bash|shell|execute|command|run)\\b/i.test(prompt);
  const kind = isBash ? "execute" : "edit";
  const title = isBash ? "Run Bash command" : "Edit file";
  const toolCall = { toolCallId, title, kind, status: "in_progress" };

  send({
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId, title, kind, status: "in_progress" } }
  });

  return new Promise((resolve) => {
    pendingServerRequests.set(requestId, resolve);
    send({
      id: requestId,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall,
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
          { optionId: "reject_once", name: "Reject once", kind: "reject_once" }
        ]
      }
    });
    // Safety net: a client that never answers session/request_permission must
    // not wedge the whole test suite; continue the turn with no outcome.
    setTimeout(() => {
      const pending = pendingServerRequests.get(requestId);
      if (pending) {
        pendingServerRequests.delete(requestId);
        pending(null);
      }
    }, 10000).unref();
  }).then((outcome) => {
    const state = loadState();
    state.lastPermissionRequest = { sessionId, toolCall, outcome: outcome ?? null };
    saveState(state);
    send({
      method: "session/update",
      params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed" } }
    });
  });
}

function handlePrompt(message, state) {
  const session = ensureSession(state, message.params.sessionId);
  const prompt = (message.params.prompt || [])
    .filter((block) => block && block.type === "text")
    .map((block) => block.text)
    .join("\\n");
  const kind = classifyPrompt(prompt);

  session.updatedAt = nowIso();
  session.prompts.push(prompt);
  state.lastPrompt = {
    sessionId: session.id,
    prompt,
    model: session.config.model,
    thinking: session.config.thinking,
    mode: session.config.mode
  };
  if (kind === "transfer") {
    state.lastTransfer = { sessionId: session.id, prompt };
  }
  saveState(state);

  const payload =
    kind === "stop-gate"
      ? stopGatePayload()
      : kind === "review" || kind === "adversarial-review"
        ? structuredReviewPayload(kind)
        : kind === "transfer"
          ? transferPayload()
          : taskPayload(prompt, session);

  const finish = () => {
    if (BEHAVIOR === "permission-request") {
      requestPermission(session.id, prompt).then(() => {
        completePrompt(session.id, message.id, kind, payload);
      });
      return;
    }
    completePrompt(session.id, message.id, kind, payload);
  };

  if (BEHAVIOR === "interruptible-slow-task") {
    const timer = setTimeout(() => {
      interruptiblePrompts.delete(session.id);
      finish();
    }, 5000);
    interruptiblePrompts.set(session.id, { requestId: message.id, timer });
    return;
  }
  if (BEHAVIOR === "slow-task") {
    setTimeout(finish, 400);
    return;
  }
  finish();
}

function handleMessage(message) {
  if (message.id !== undefined && !message.method) {
    const pending = pendingServerRequests.get(message.id);
    if (pending) {
      pendingServerRequests.delete(message.id);
      pending(message.error ? { outcome: "error", error: message.error } : (message.result && message.result.outcome) || null);
    }
    return;
  }

  const state = loadState();

  try {
    switch (message.method) {
      case "initialize":
        state.initializeParams = message.params || null;
        saveState(state);
        send({
          id: message.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: true, audio: false, embeddedContext: true },
              mcpCapabilities: { http: true, sse: true },
              sessionCapabilities: { list: {}, resume: {} }
            },
            authMethods: buildAuthMethods(),
            agentInfo: { name: "Kimi Code CLI", version: "0.26.0" }
          }
        });
        break;

      case "initialized":
        break;

      case "session/new": {
        if (BEHAVIOR === "auth-run-fails") {
          throw new Error("authentication expired; run kimi login");
        }
        const session = {
          id: "session_" + crypto.randomUUID(),
          index: state.nextSessionIndex++,
          cwd: (message.params && message.params.cwd) || process.cwd(),
          createdAt: nowIso(),
          updatedAt: nowIso(),
          loaded: false,
          config: { model: DEFAULT_MODEL, thinking: DEFAULT_THINKING, mode: DEFAULT_MODE },
          prompts: []
        };
        state.sessions.unshift(session);
        saveState(state);
        send({ id: message.id, result: { sessionId: session.id, configOptions: buildConfigOptions(session) } });
        break;
      }

      case "session/load": {
        if (BEHAVIOR === "auth-run-fails") {
          throw new Error("authentication expired; run kimi login");
        }
        const session = ensureSession(state, message.params.sessionId);
        session.loaded = true;
        session.updatedAt = nowIso();
        saveState(state);
        send({ id: message.id, result: { configOptions: buildConfigOptions(session) } });
        break;
      }

      case "session/set_config_option": {
        if (BEHAVIOR === "config-read-fails") {
          throw new Error("session/set_config_option failed for cwd");
        }
        const session = ensureSession(state, message.params.sessionId);
        const configId = message.params.configId;
        const value = message.params.value;
        if (configId === "model" || configId === "thinking" || configId === "mode") {
          session.config[configId] = value;
        }
        session.updatedAt = nowIso();
        state.lastSetConfigOption = { sessionId: session.id, configId, value };
        saveState(state);
        send({ id: message.id, result: { configOptions: buildConfigOptions(session) } });
        break;
      }

      case "session/prompt": {
        if (BEHAVIOR === "auth-run-fails") {
          throw new Error("authentication expired; run kimi login");
        }
        handlePrompt(message, state);
        break;
      }

      case "session/cancel": {
        const sessionId = message.params && message.params.sessionId;
        state.lastCancel = { sessionId };
        saveState(state);
        const pending = interruptiblePrompts.get(sessionId);
        if (pending) {
          clearTimeout(pending.timer);
          interruptiblePrompts.delete(sessionId);
          send({ id: pending.requestId, result: { stopReason: "cancelled" } });
        }
        break;
      }

      default:
        if (message.id !== undefined) {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
        }
        break;
    }
  } catch (error) {
    if (message.id !== undefined) {
      send({ id: message.id, error: { code: -32000, message: error.message } });
    }
  }
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("kimi-cli test");
  process.exit(0);
}
if (args[0] === "acp" && args[1] === "--help") {
  console.log("fake acp help");
  process.exit(0);
}
if (args[0] === "login") {
  process.exit(0);
}
if (args[0] !== "acp") {
  process.exit(1);
}
const bootState = loadState();
bootState.acpStarts = (bootState.acpStarts || 0) + 1;
saveState(bootState);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  handleMessage(message);
});
`;
  writeExecutable(scriptPath, source);

  // On Windows, npm global binaries are invoked via .cmd wrappers.
  // Create a kimi.cmd so the fake binary is discoverable by spawn with shell: true.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0kimi" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "kimi.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  const env = scrubEnv(process.env);
  return {
    ...env,
    PATH: `${binDir}${sep}${env.PATH}`
  };
}
