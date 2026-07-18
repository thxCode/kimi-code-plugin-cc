/**
 * Core runtime library for the Kimi Code plugin: drives the Kimi Code CLI
 * through `kimi acp` (Agent Client Protocol over stdio), optionally via the
 * shared broker. Session-based ACP semantics: a run is one session/prompt
 * round-trip, streamed through session/update notifications.
 *
 * @typedef {import("./acp-protocol").AcpNotification} AcpNotification
 * @typedef {import("./acp-protocol").ConfigOption} ConfigOption
 * @typedef {import("./acp-protocol").SessionRequestPermissionParams} SessionRequestPermissionParams
 * @typedef {((update: string | { message: string, phase: string | null, sessionId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   sessionId: string,
 *   messageText: string,
 *   thoughtText: string,
 *   toolCalls: Map<string, TrackedToolCall>,
 *   commandExecutions: Array<{ id: string, kind: string, title: string, command: string, status: string }>,
 *   commandExecutionById: Map<string, { id: string, kind: string, title: string, command: string, status: string }>,
 *   touchedFiles: Set<string>,
 *   stopReason: string | null,
 *   error: unknown,
 *   onProgress: ProgressReporter | null
 * }} TurnCaptureState
 * @typedef {{
 *   id: string,
 *   title: string | null,
 *   kind: string | null,
 *   status: string | null,
 *   locations: unknown[],
 *   rawInput: unknown,
 *   startReported: boolean,
 *   completionReported: boolean
 * }} TrackedToolCall
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BROKER_ENDPOINT_ENV,
  KimiAcpClient,
  SpawnedKimiAcpClient,
  respondPermission,
  withAcpClient
} from "./acp-client.mjs";
import { readOwnBrokerSession } from "./broker-lifecycle.mjs";
import { compressClaudeTranscript } from "./claude-session-transfer.mjs";
import { readJsonFile } from "./fs.mjs";
import { binaryAvailable } from "./process.mjs";

const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";
const KIMI_UNAVAILABLE_MESSAGE =
  "Kimi Code CLI is not installed or is missing required runtime support. Install it from https://moonshotai.github.io/kimi-code/, then rerun `/kimi:setup`.";

// Stall watchdog: a turn that streams nothing at all is almost always a
// black-holed upstream request (observed: kimi acp logs "llm request" and
// then nothing for 6+ minutes). Heartbeat-log after STALL_WARN_MS of
// silence, auto-cancel after STALL_TIMEOUT_MS; 0 disables either knob.
const STALL_TIMEOUT_ENV = "KIMI_COMPANION_STALL_TIMEOUT_MS";
const STALL_WARN_ENV = "KIMI_COMPANION_STALL_WARN_MS";
const DEFAULT_STALL_TIMEOUT_MS = 600000;
const DEFAULT_STALL_WARN_MS = 120000;
const STALL_TICK_MS = 250;

// toolCall.kind values that mutate the workspace: tracked as touched files and
// rejected under the read-only permission policy.
const FILE_MUTATION_TOOL_KINDS = new Set(["edit", "delete", "move"]);
// kimi acp frequently omits toolCall.kind in permission requests, so read-only
// rejection also keys on the tool call title.
const READ_ONLY_BLOCKED_TITLE_PATTERN = /\b(edit|write|delete|move|apply\s*patch|strreplace|create|notebook)\b/i;
const VERIFICATION_TITLE_PATTERN = /test|spec|npm|node --test|pytest|vitest|jest/i;

function cleanKimiStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

function resolveStallBudget(optionValue, envValue, fallback) {
  const raw = optionValue ?? envValue;
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function formatSilenceDuration(ms) {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Watch a turn for total upstream silence. Every STALL_WARN_MS of quiet logs
 * a heartbeat (and flips the job phase to "waiting" so /kimi:status stops
 * saying "starting"); after STALL_TIMEOUT_MS it resolves {stalled: true} so
 * the caller can cancel the turn and fail the job instead of hanging forever.
 */
function startStallWatchdog({ timeoutMs, warnMs, onHeartbeat }) {
  let lastActivityAt = Date.now();
  let lastHeartbeatAt = 0;
  let resolveStall;
  const promise = new Promise((resolve) => {
    resolveStall = resolve;
  });

  const timer = setInterval(() => {
    const silentMs = Date.now() - lastActivityAt;
    if (timeoutMs > 0 && silentMs >= timeoutMs) {
      clearInterval(timer);
      resolveStall({ stalled: true, silentMs });
      return;
    }
    if (warnMs > 0 && silentMs >= warnMs && Date.now() - lastHeartbeatAt >= warnMs) {
      lastHeartbeatAt = Date.now();
      onHeartbeat(silentMs, timeoutMs);
    }
  }, STALL_TICK_MS);
  // The watchdog must never keep the host process alive on its own.
  timer.unref?.();

  return {
    promise,
    touch() {
      lastActivityAt = Date.now();
    },
    stop() {
      clearInterval(timer);
    }
  };
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationTitle(title) {
  return VERIFICATION_TITLE_PATTERN.test(String(title ?? ""));
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    ...fields
  };
}

function resolveKimiCredentialsPath() {
  return path.join(os.homedir(), ".kimi-code", "credentials", "kimi-code.json");
}

export function getKimiAvailability(cwd) {
  const versionStatus = binaryAvailable("kimi", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const acpStatus = binaryAvailable("kimi", ["acp", "--help"], { cwd });
  if (!acpStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${acpStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV] ?? readOwnBrokerSession(cwd)?.endpoint ?? null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Kimi runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Kimi runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

export async function getKimiAuthStatus(cwd, options = {}) {
  const availability = getKimiAvailability(cwd);
  if (!availability.available) {
    return buildAuthStatus({
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability"
    });
  }

  const credentialsExist = fs.existsSync(resolveKimiCredentialsPath());

  // The broker answers `initialize` locally with authMethods: [], so the
  // handshake must go to a directly spawned `kimi acp`. withAcpClient does not
  // expose the initialize result, so capture it by wrapping client.request
  // before the handshake runs.
  let client = null;
  try {
    client = new SpawnedKimiAcpClient(cwd, { env: options.env });
    const originalRequest = client.request.bind(client);
    /** @type {Promise<import("./acp-protocol").InitializeResult> | null} */
    let initializeResultPromise = null;
    client.request = /** @type {any} */ (
      (/** @type {string} */ method, /** @type {any} */ params) => {
        const pending = originalRequest(/** @type {any} */ (method), params);
        if (method === "initialize") {
          initializeResultPromise = pending;
        }
        return pending;
      }
    );
    await client.initialize();
    const initializeResult = initializeResultPromise ? await initializeResultPromise : null;
    const authMethods = Array.isArray(initializeResult?.authMethods) ? initializeResult.authMethods : [];
    const authMethod =
      authMethods
        .map((method) => (typeof method?.name === "string" && method.name.trim() ? method.name.trim() : method?.id))
        .filter(Boolean)
        .join(", ") || null;

    if (credentialsExist) {
      return buildAuthStatus({
        loggedIn: true,
        detail: "Kimi credentials found (unverified): ~/.kimi-code/credentials/kimi-code.json",
        source: "acp",
        authMethod,
        verified: false
      });
    }

    return buildAuthStatus({
      loggedIn: false,
      detail: "Not logged in. Run `kimi login`, then rerun `/kimi:setup`.",
      source: "acp",
      authMethod,
      verified: false
    });
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "acp"
    });
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

/**
 * @param {string} cwd
 * @param {{ sessionId?: string }} [args]
 */
export async function interruptAcpSession(cwd, { sessionId } = {}) {
  if (!sessionId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing sessionId"
    };
  }

  const availability = getKimiAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }

  let client = null;
  try {
    client = await KimiAcpClient.connect(cwd, { reuseExistingBroker: true });
    // session/cancel is a notification: the in-flight session/prompt held by
    // the owning client resolves with stopReason "cancelled".
    client.cancelSession(sessionId);
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Interrupted ${sessionId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

/**
 * Read-only permission verdict: reject workspace-mutating tool calls and allow
 * everything else (execute/read/search/fetch pass, so self-collected git
 * commands keep working). kind is often absent, so titles are checked too.
 * @param {import("./acp-protocol").RequestPermissionToolCall | undefined} toolCall
 */
function shouldRejectReadOnlyPermission(toolCall) {
  const kind = typeof toolCall?.kind === "string" ? toolCall.kind : null;
  if (kind && FILE_MUTATION_TOOL_KINDS.has(kind)) {
    return true;
  }
  const title = typeof toolCall?.title === "string" ? toolCall.title : "";
  return READ_ONLY_BLOCKED_TITLE_PATTERN.test(title);
}

/**
 * Install a server-request handler that answers session/request_permission
 * with the read-only policy. Non-permission server requests get -32601.
 * @param {import("./acp-client.mjs").SpawnedKimiAcpClient | import("./acp-client.mjs").BrokerKimiAcpClient} client
 */
function installReadOnlyPermissionHandler(client) {
  client.setServerRequestHandler((/** @type {any} */ message) => {
    if (message?.method !== "session/request_permission") {
      client.sendMessage({
        jsonrpc: "2.0",
        id: message?.id ?? null,
        error: { code: -32601, message: `Unsupported server request: ${message?.method}` }
      });
      return;
    }

    const params = /** @type {SessionRequestPermissionParams} */ (message.params ?? {});
    if (shouldRejectReadOnlyPermission(params.toolCall)) {
      const options = Array.isArray(params.options) ? params.options : [];
      const rejectOption = options.find((option) => String(option?.kind ?? "").startsWith("reject"));
      client.sendMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: rejectOption
          ? { outcome: { outcome: "selected", optionId: rejectOption.optionId } }
          : { outcome: { outcome: "cancelled" } }
      });
      return;
    }

    client.sendMessage({
      jsonrpc: "2.0",
      id: message.id,
      result: respondPermission(params, "write")
    });
  });
}

/**
 * Apply caller-requested session config (model/thinking, plus mode=yolo for
 * unattended write runs) from the configOptions reported by session/new or
 * session/load. Unavailable options or values warn and are ignored.
 * @param {import("./acp-client.mjs").SpawnedKimiAcpClient | import("./acp-client.mjs").BrokerKimiAcpClient} client
 * @param {string} sessionId
 * @param {ConfigOption[] | undefined} configOptions
 */
async function applySessionConfig(client, sessionId, configOptions, options = {}) {
  /** @type {Array<[string, string]>} */
  const requested = [];
  if (typeof options.model === "string" && options.model) {
    requested.push(["model", options.model]);
  }
  if (typeof options.thinking === "string" && options.thinking) {
    requested.push(["thinking", options.thinking]);
  }
  if (options.write) {
    requested.push(["mode", "yolo"]);
  }

  for (const [configId, value] of requested) {
    const option = Array.isArray(configOptions) ? configOptions.find((candidate) => candidate?.id === configId) : null;
    if (!option) {
      console.error(`[kimi] warning: session ${sessionId} does not expose a "${configId}" config option; ignoring requested value "${value}".`);
      continue;
    }
    const availableValues = Array.isArray(option.options) ? option.options.map((candidate) => candidate?.value) : [];
    if (!availableValues.includes(value)) {
      console.error(
        `[kimi] warning: "${value}" is not an available value for the "${configId}" config option on session ${sessionId}; ignoring it.`
      );
      continue;
    }
    try {
      await client.setConfigOption(sessionId, configId, value);
    } catch (error) {
      console.error(
        `[kimi] warning: failed to set "${configId}" to "${value}" on session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/**
 * @param {string} sessionId
 * @returns {TurnCaptureState}
 */
function createTurnCaptureState(sessionId, options = {}) {
  return {
    sessionId,
    messageText: "",
    thoughtText: "",
    toolCalls: new Map(),
    commandExecutions: [],
    commandExecutionById: new Map(),
    touchedFiles: new Set(),
    stopReason: null,
    error: null,
    onProgress: options.onProgress ?? null
  };
}

function extractTextFromContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function extractToolCallCommand(toolCall) {
  const rawInput = toolCall?.rawInput;
  if (rawInput && typeof rawInput === "object" && typeof rawInput.command === "string") {
    return rawInput.command;
  }
  if (typeof rawInput === "string") {
    return rawInput;
  }
  return typeof toolCall?.title === "string" ? toolCall.title : "";
}

function extractPathsFromLocations(locations) {
  if (!Array.isArray(locations)) {
    return [];
  }
  return locations
    .map((location) => (location && typeof location === "object" && typeof location.path === "string" ? location.path : null))
    .filter(Boolean);
}

function extractPathsFromTitle(title) {
  const text = String(title ?? "");
  if (!text) {
    return [];
  }
  return text
    .split(/\s+/)
    .map((token) => token.replace(/^["'`(]+|["'`),.;:]+$/g, ""))
    .filter((token) => token.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(token));
}

function describeToolCallStarted(toolCall) {
  const title = toolCall.title ?? toolCall.kind ?? "tool";
  switch (toolCall.kind) {
    case "execute": {
      const command = extractToolCallCommand(toolCall) || title;
      return {
        message: `Running command: ${shorten(command, 96)}`,
        phase: looksLikeVerificationTitle(command) ? "verifying" : "running"
      };
    }
    case "edit":
    case "delete":
    case "move":
      return { message: `Applying file change: ${shorten(title, 96)}`, phase: "editing" };
    case "read":
    case "search":
    case "fetch":
      return { message: `Calling tool: ${shorten(title, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeToolCallCompleted(toolCall) {
  const statusLabel = toolCall.status === "completed" ? "completed" : toolCall.status ?? "updated";
  const title = toolCall.title ?? toolCall.kind ?? "tool";
  switch (toolCall.kind) {
    case "execute": {
      const command = extractToolCallCommand(toolCall) || title;
      return {
        message: `Command ${statusLabel}: ${shorten(command, 96)}`,
        phase: looksLikeVerificationTitle(command) ? "verifying" : "running"
      };
    }
    case "edit":
    case "delete":
    case "move":
      return { message: `File changes ${statusLabel}: ${shorten(title, 96)}`, phase: "editing" };
    case "read":
    case "search":
    case "fetch":
      return { message: `Tool ${shorten(title, 48)} ${statusLabel}.`, phase: "investigating" };
    default:
      return null;
  }
}

function recordToolCallEffects(state, toolCall) {
  if (toolCall.kind === "execute") {
    let execution = state.commandExecutionById.get(toolCall.id);
    if (!execution) {
      execution = {
        id: toolCall.id,
        kind: "execute",
        title: toolCall.title ?? "",
        command: extractToolCallCommand(toolCall),
        status: toolCall.status ?? "in_progress"
      };
      state.commandExecutionById.set(toolCall.id, execution);
      state.commandExecutions.push(execution);
    }
    execution.title = toolCall.title ?? execution.title;
    execution.command = extractToolCallCommand(toolCall) || execution.command;
    execution.status = toolCall.status ?? execution.status;
    return;
  }

  if (toolCall.kind && FILE_MUTATION_TOOL_KINDS.has(toolCall.kind)) {
    const paths = extractPathsFromLocations(toolCall.locations);
    const titlePaths = paths.length === 0 ? extractPathsFromTitle(toolCall.title) : [];
    for (const filePath of [...paths, ...titlePaths]) {
      state.touchedFiles.add(filePath);
    }
  }
}

/**
 * @param {TurnCaptureState} state
 * @param {any} update session/update payload
 */
function trackToolCall(state, update) {
  const toolCallId = typeof update?.toolCallId === "string" ? update.toolCallId : null;
  if (!toolCallId) {
    return;
  }

  const isStart = update.sessionUpdate === "tool_call";
  let toolCall = state.toolCalls.get(toolCallId);
  const isNew = !toolCall;
  if (!toolCall) {
    toolCall = {
      id: toolCallId,
      title: null,
      kind: null,
      status: null,
      locations: [],
      rawInput: null,
      startReported: false,
      completionReported: false
    };
    state.toolCalls.set(toolCallId, toolCall);
  }

  if (typeof update.title === "string" && update.title.trim()) {
    toolCall.title = update.title;
  }
  if (typeof update.kind === "string" && update.kind) {
    toolCall.kind = update.kind;
  }
  if (typeof update.status === "string" && update.status) {
    toolCall.status = update.status;
  }
  if (Array.isArray(update.locations) && update.locations.length > 0) {
    toolCall.locations = update.locations;
  }
  if (update.rawInput !== undefined && update.rawInput !== null) {
    toolCall.rawInput = update.rawInput;
  }

  if ((isStart || isNew) && !toolCall.startReported) {
    toolCall.startReported = true;
    const started = describeToolCallStarted(toolCall);
    if (started) {
      emitProgress(state.onProgress, started.message, started.phase);
    }
  }

  recordToolCallEffects(state, toolCall);

  if ((toolCall.status === "completed" || toolCall.status === "failed") && !toolCall.completionReported) {
    toolCall.completionReported = true;
    const completed = describeToolCallCompleted(toolCall);
    if (completed) {
      emitProgress(state.onProgress, completed.message, completed.phase);
    }
  }
}

/**
 * @param {TurnCaptureState} state
 * @param {any} update
 */
function applySessionUpdate(state, update) {
  switch (update?.sessionUpdate) {
    case "agent_message_chunk":
      // incremental delta; accumulate
      state.messageText += extractTextFromContent(update.content);
      break;
    case "agent_thought_chunk":
      // incremental delta; accumulate
      state.thoughtText += extractTextFromContent(update.content);
      break;
    case "tool_call":
    case "tool_call_update":
      trackToolCall(state, update);
      break;
    default:
      break;
  }
}

function summarizeThoughts(thoughtText) {
  const merged = [];
  for (const section of String(thoughtText ?? "").split(/\r?\n/)) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

/**
 * Build the per-turn result once session/prompt has settled. Completion is the
 * prompt promise resolving: end_turn and no error -> exit-style status 0,
 * anything else (cancelled, thrown/rpc error) -> 1, mirroring the source
 * plugin's buildResultStatus. The ACP stopReason is preserved separately.
 * @param {TurnCaptureState} state
 */
function finalizeTurnCapture(state, options = {}) {
  const finalMessage = state.messageText.trim();
  const reasoningSummary = summarizeThoughts(state.thoughtText);
  const reviewMode = Boolean(options.reviewMode);

  if (state.error) {
    const message = state.error instanceof Error ? state.error.message : String(state.error);
    emitProgress(state.onProgress, `Kimi error: ${message}`, "failed");
  } else if (state.stopReason === "cancelled") {
    emitProgress(state.onProgress, "Turn cancelled.", "finalizing");
  } else {
    emitProgress(state.onProgress, "Turn completed.", "finalizing");
  }

  if (reasoningSummary.length > 0) {
    emitLogEvent(state.onProgress, {
      message: `Reasoning summary captured: ${shorten(reasoningSummary[0], 96)}`,
      logTitle: "Reasoning summary",
      logBody: reasoningSummary.map((section) => `- ${section}`).join("\n")
    });
  }

  if (finalMessage) {
    emitLogEvent(state.onProgress, {
      message: reviewMode ? "Review output captured." : `Assistant message captured: ${shorten(finalMessage, 96)}`,
      phase: "finalizing",
      logTitle: reviewMode ? "Review output" : "Assistant message",
      logBody: finalMessage
    });
  }

  const status = state.error || state.stopReason !== "end_turn" ? 1 : 0;
  return {
    status,
    stopReason: state.stopReason,
    finalMessage,
    reasoningSummary,
    error: state.error ? (state.error instanceof Error ? state.error.message : String(state.error)) : null,
    touchedFiles: [...state.touchedFiles],
    commandExecutions: state.commandExecutions
  };
}

/**
 * Send one prompt and aggregate its session/update stream until the
 * session/prompt response resolves the turn — or until the stall watchdog
 * fires (no session traffic at all for STALL_TIMEOUT_MS), in which case the
 * turn is cancelled upstream and reported as an error instead of hanging.
 * @param {import("./acp-client.mjs").SpawnedKimiAcpClient | import("./acp-client.mjs").BrokerKimiAcpClient} client
 * @param {string} sessionId
 * @param {string} promptText
 */
async function captureAcpTurn(client, sessionId, promptText, options = {}) {
  const state = createTurnCaptureState(sessionId, options);
  const previousHandler = client.notificationHandler;

  const timeoutMs = resolveStallBudget(options.stallTimeoutMs, process.env[STALL_TIMEOUT_ENV], DEFAULT_STALL_TIMEOUT_MS);
  const warnMs = resolveStallBudget(options.stallWarnMs, process.env[STALL_WARN_ENV], DEFAULT_STALL_WARN_MS);
  const watchdog = startStallWatchdog({
    timeoutMs,
    warnMs,
    onHeartbeat: (silentMs) => {
      const waited = formatSilenceDuration(silentMs);
      const budget = timeoutMs > 0 ? `; auto-cancel after ${formatSilenceDuration(timeoutMs)} of silence` : "";
      emitProgress(state.onProgress, `No output from Kimi for ${waited}${budget}.`, "waiting");
    }
  });

  client.setNotificationHandler((/** @type {AcpNotification} */ message) => {
    const params = /** @type {any} */ (message?.params);
    if (message?.method === "session/update" && (!params?.sessionId || params.sessionId === sessionId)) {
      watchdog.touch();
      applySessionUpdate(state, params.update);
      return;
    }
    if (previousHandler) {
      previousHandler(message);
    }
  });

  try {
    const promptPromise = client.prompt(sessionId, promptText);
    // The stall watchdog abandons the prompt promise; swallow its late
    // settlement so an upstream reply arriving after the timeout cannot
    // surface as an unhandled rejection.
    const settled = await Promise.race([
      promptPromise.then(
        (result) => ({ result }),
        (error) => ({ error })
      ),
      watchdog.promise
    ]);
    promptPromise.catch(() => {});

    if (settled?.stalled) {
      try {
        client.cancelSession(sessionId);
      } catch {
        // Best effort: the upstream may already be unreachable.
      }
      state.error = new Error(
        `Kimi produced no output for ${formatSilenceDuration(settled.silentMs)}; the stalled turn was cancelled. ` +
          `The upstream kimi acp request appears wedged (network/API). Retry the job; if it persists, ` +
          `restart the shared Kimi broker or check the connection to the Kimi API. ` +
          `Tune or disable via ${STALL_TIMEOUT_ENV}.`
      );
    } else if (settled?.error) {
      state.error = settled.error;
    } else {
      state.stopReason = typeof settled?.result?.stopReason === "string" ? settled.result.stopReason : null;
    }
  } catch (error) {
    state.error = error;
  } finally {
    watchdog.stop();
    client.setNotificationHandler(previousHandler ?? null);
  }

  return finalizeTurnCapture(state, options);
}

function buildSessionSeedPrompt(transcript) {
  return [
    "You are continuing a coding session transferred from Claude Code. The compressed transcript below is the prior conversation.",
    "Adopt it as your working context: treat its user messages as instructions already given to you and its assistant messages as your own prior replies and actions.",
    "Do not repeat work the transcript shows as completed; from now on, continue as the coding agent on this task.",
    "Reply with one short sentence confirming you have adopted this context.",
    "",
    "<transferred-transcript>",
    transcript,
    "</transferred-transcript>"
  ].join("\n");
}

export async function runAcpReview(cwd, options = {}) {
  const availability = getKimiAvailability(cwd);
  if (!availability.available) {
    throw new Error(KIMI_UNAVAILABLE_MESSAGE);
  }

  return withAcpClient(cwd, async (client) => {
    installReadOnlyPermissionHandler(client);
    emitProgress(options.onProgress, "Starting Kimi review session.", "starting");
    const session = await client.sessionNew(cwd);
    const sessionId = session.sessionId;
    emitProgress(options.onProgress, `Session ready (${sessionId}).`, "starting", { sessionId });
    await applySessionConfig(client, sessionId, session.configOptions, {
      model: options.model,
      thinking: options.thinking
    });

    const prompt = options.prompt?.trim() || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Kimi run.");
    }

    const turn = await captureAcpTurn(client, sessionId, prompt, {
      onProgress: options.onProgress,
      reviewMode: true
    });

    return {
      status: turn.status,
      sessionId,
      stopReason: turn.stopReason,
      reviewText: turn.finalMessage,
      reasoningSummary: turn.reasoningSummary,
      error: turn.error,
      stderr: cleanKimiStderr(client.stderr)
    };
  });
}

export async function runAcpTurn(cwd, options = {}) {
  const availability = getKimiAvailability(cwd);
  if (!availability.available) {
    throw new Error(KIMI_UNAVAILABLE_MESSAGE);
  }

  const write = Boolean(options.write);
  return withAcpClient(
    cwd,
    async (client) => {
      if (!write) {
        installReadOnlyPermissionHandler(client);
      }

      let sessionId;
      /** @type {ConfigOption[] | undefined} */
      let configOptions;
      if (options.resumeSessionId) {
        emitProgress(options.onProgress, `Resuming session ${options.resumeSessionId}.`, "starting");
        const loaded = await client.sessionLoad(options.resumeSessionId, cwd);
        sessionId = options.resumeSessionId;
        configOptions = loaded.configOptions;
      } else {
        emitProgress(options.onProgress, "Starting Kimi task session.", "starting");
        const session = await client.sessionNew(cwd);
        sessionId = session.sessionId;
        configOptions = session.configOptions;
      }

      emitProgress(options.onProgress, `Session ready (${sessionId}).`, "starting", { sessionId });
      await applySessionConfig(client, sessionId, configOptions, {
        model: options.model,
        thinking: options.thinking,
        write
      });

      const prompt = options.prompt?.trim() || options.defaultPrompt || "";
      if (!prompt) {
        throw new Error("A prompt is required for this Kimi run.");
      }

      const turn = await captureAcpTurn(client, sessionId, prompt, { onProgress: options.onProgress });

      return {
        status: turn.status,
        sessionId,
        stopReason: turn.stopReason,
        finalMessage: turn.finalMessage,
        reasoningSummary: turn.reasoningSummary,
        error: turn.error,
        stderr: cleanKimiStderr(client.stderr),
        touchedFiles: turn.touchedFiles,
        commandExecutions: turn.commandExecutions
      };
    },
    write ? { permissionPolicy: "write" } : {}
  );
}

export async function importClaudeSession(cwd, options = {}) {
  const availability = getKimiAvailability(cwd);
  if (!availability.available) {
    throw new Error(KIMI_UNAVAILABLE_MESSAGE);
  }
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }

  return withAcpClient(cwd, async (client) => {
    installReadOnlyPermissionHandler(client);
    emitProgress(options.onProgress, "Importing Claude session into Kimi.", "transferring");
    const transcript = compressClaudeTranscript(options.sourcePath);
    const session = await client.sessionNew(cwd);
    const sessionId = session.sessionId;
    await client.prompt(sessionId, buildSessionSeedPrompt(transcript));
    emitProgress(options.onProgress, `Claude session imported (${sessionId}).`, "completed", { sessionId });
    return {
      sessionId,
      stderr: cleanKimiStderr(client.stderr)
    };
  });
}

function extractJsonCandidate(rawOutput) {
  const fenceMatch = String(rawOutput).match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  const firstBrace = String(rawOutput).indexOf("{");
  const lastBrace = String(rawOutput).lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return String(rawOutput).slice(firstBrace, lastBrace + 1);
  }
  return null;
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Kimi did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  let lastError = null;
  const candidates = [rawOutput, extractJsonCandidate(rawOutput)].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return {
        parsed: JSON.parse(candidate),
        parseError: null,
        rawOutput,
        ...fallback
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    parsed: null,
    parseError: lastError?.message ?? "Kimi did not return a final structured message.",
    rawOutput,
    ...fallback
  };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT };
