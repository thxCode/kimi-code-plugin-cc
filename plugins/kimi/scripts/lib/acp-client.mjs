/**
 * @typedef {Error & { data?: unknown, rpcCode?: number, foreignBroker?: boolean, acpClientTransport?: string, acpBrokerEndpoint?: string | null }} ProtocolError
 * @typedef {import("./acp-protocol").AcpMethod} AcpMethod
 * @typedef {import("./acp-protocol").AcpNotification} AcpNotification
 * @typedef {import("./acp-protocol").AcpNotificationHandler} AcpNotificationHandler
 * @typedef {import("./acp-protocol").AcpServerRequest} AcpServerRequest
 * @typedef {import("./acp-protocol").AcpServerRequestHandler} AcpServerRequestHandler
 * @typedef {import("./acp-protocol").ClientCapabilities} ClientCapabilities
 * @typedef {import("./acp-protocol").ClientInfo} ClientInfo
 * @typedef {import("./acp-protocol").KimiAcpClientOptions} KimiAcpClientOptions
 * @typedef {import("./acp-protocol").PermissionPolicy} PermissionPolicy
 * @typedef {import("./acp-protocol").SessionRequestPermissionParams} SessionRequestPermissionParams
 * @typedef {import("./acp-protocol").SessionRequestPermissionResult} SessionRequestPermissionResult
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { clearBrokerSession, ensureBrokerSession, readBrokerSession, readOwnBrokerSession } from "./broker-lifecycle.mjs";
import { terminateProcessTree } from "./process.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);

function loadPluginManifest() {
  try {
    return JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));
  } catch {
    // The manifest can be absent while the plugin is being assembled;
    // fall back to a placeholder version instead of failing to load.
    return { version: "0.0.0" };
  }
}

const PLUGIN_MANIFEST = loadPluginManifest();

export const BROKER_ENDPOINT_ENV = "KIMI_COMPANION_ACP_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;
export const ACP_PROTOCOL_VERSION = 1;

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Kimi Code Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {ClientCapabilities} */
const DEFAULT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false
};

// toolCall.kind values that mutate the workspace; rejected under "read-only".
const READ_ONLY_BLOCKED_TOOL_KINDS = new Set(["edit", "delete", "move"]);

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

/**
 * The ACP peer must identify itself as Kimi — either a directly spawned
 * `kimi acp` ("Kimi Code CLI") or this plugin's broker
 * ("kimi-companion-broker"). A cached broker endpoint can point at a
 * DIFFERENT agent's server (e.g. a sibling companion plugin whose broker
 * session leaked into this state root via a shared CLAUDE_PLUGIN_DATA); its
 * method set rejects session/new with "unknown variant" errors that are
 * opaque to callers, so fail fast at the handshake instead.
 */
function assertKimiAcpPeer(initializeResult, transport, endpoint) {
  const identities = [initializeResult?.agentInfo?.name, initializeResult?.userAgent];
  if (identities.some((value) => typeof value === "string" && /kimi/i.test(value))) {
    return;
  }
  const observed = identities.find((value) => typeof value === "string" && value) ?? "unidentified";
  const subject = transport === "broker" ? `broker at ${endpoint}` : "kimi acp process";
  const hint =
    transport === "broker"
      ? " A sibling agent plugin may be sharing this state directory; the cached broker session was rejected."
      : " Check that the `kimi` binary on PATH is the Kimi Code CLI.";
  const error = createProtocolError(
    `The ${subject} is not a Kimi ACP server (it identifies as ${JSON.stringify(observed)}).${hint}`
  );
  error.foreignBroker = true;
  throw error;
}

/**
 * Build the result for an ACP `session/request_permission` server request by
 * applying a permission policy to the offered options.
 * @param {SessionRequestPermissionParams} params
 * @param {PermissionPolicy} [policy]
 * @returns {SessionRequestPermissionResult}
 */
export function respondPermission(params, policy = "write") {
  const options = Array.isArray(params?.options) ? params.options : [];
  if (options.length === 0) {
    return { outcome: { outcome: "cancelled" } };
  }

  const toolKind = typeof params?.toolCall?.kind === "string" ? params.toolCall.kind : null;
  let decision = "allow";
  if (policy === "read-only") {
    decision = toolKind && READ_ONLY_BLOCKED_TOOL_KINDS.has(toolKind) ? "reject" : "allow";
  } else if (policy && typeof policy === "object") {
    // Object policies map toolCall.kind ("execute", "edit", ... or "*") to a verdict.
    const verdict = (toolKind ? policy[toolKind] : undefined) ?? policy["*"] ?? "allow";
    decision = verdict === "reject" ? "reject" : "allow";
  }
  // "write" (and anything unrecognized) allows everything.

  const preferred = options.find((option) => String(option?.kind ?? "").startsWith(decision));
  const selected = preferred ?? options[0];
  return { outcome: { outcome: "selected", optionId: selected.optionId } };
}

class KimiAcpClientBase {
  /**
   * @param {string} cwd
   * @param {KimiAcpClientOptions} [options]
   */
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {AcpNotificationHandler | null} */
    this.notificationHandler = null;
    /** @type {AcpServerRequestHandler | null} */
    this.serverRequestHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";
    /** @type {string | null} The broker endpoint when transport is "broker". */
    this.endpoint = null;

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  setServerRequestHandler(handler) {
    this.serverRequestHandler = handler;
  }

  /**
   * @template {AcpMethod} M
   * @param {M} method
   * @param {import("./acp-protocol").AcpRequestParams<M>} params
   * @returns {Promise<import("./acp-protocol").AcpResponse<M>>}
   */
  request(method, params) {
    if (this.closed) {
      throw new Error("kimi acp client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ jsonrpc: "2.0", method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse kimi acp JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `kimi acp ${pending.method} failed.`, message.error));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AcpNotification} */ (message));
    }
  }

  handleServerRequest(message) {
    if (this.serverRequestHandler) {
      this.serverRequestHandler(message);
      return;
    }

    if (message.method === "session/request_permission" && this.options.permissionPolicy) {
      this.sendMessage({
        jsonrpc: "2.0",
        id: message.id,
        result: respondPermission(message.params ?? {}, this.options.permissionPolicy)
      });
      return;
    }

    this.sendMessage({
      jsonrpc: "2.0",
      id: message.id,
      error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
    });
  }

  handleExit(error) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("kimi acp connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }

  /** ACP handshake: initialize request followed by the initialized notification. */
  async performHandshake() {
    const initializeResult = await this.request("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      clientCapabilities: this.options.clientCapabilities ?? DEFAULT_CAPABILITIES
    });
    assertKimiAcpPeer(initializeResult, this.transport, this.endpoint);
    this.notify("initialized", {});
  }

  /**
   * @param {string} [cwd]
   * @returns {Promise<import("./acp-protocol").SessionNewResult>}
   */
  sessionNew(cwd = this.cwd) {
    return this.request("session/new", { cwd, mcpServers: [] });
  }

  /**
   * @param {string} sessionId
   * @param {string} [cwd]
   * @returns {Promise<import("./acp-protocol").SessionLoadResult>}
   */
  sessionLoad(sessionId, cwd = this.cwd) {
    return this.request("session/load", { sessionId, cwd, mcpServers: [] });
  }

  /**
   * @param {string} sessionId
   * @param {string} configId
   * @param {string} value
   * @returns {Promise<import("./acp-protocol").SessionSetConfigOptionResult>}
   */
  setConfigOption(sessionId, configId, value) {
    return this.request("session/set_config_option", { sessionId, configId, value });
  }

  /**
   * Streams session/update notifications via notificationHandler and resolves
   * with the raw result (including stopReason) when the turn completes.
   * @param {string} sessionId
   * @param {string} text
   * @returns {Promise<import("./acp-protocol").SessionPromptResult>}
   */
  prompt(sessionId, text) {
    return this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  }

  /**
   * ACP cancel is a notification; the in-flight session/prompt then resolves
   * with stopReason "cancelled".
   * @param {string} sessionId
   */
  cancelSession(sessionId) {
    this.notify("session/cancel", { sessionId });
  }
}

export class SpawnedKimiAcpClient extends KimiAcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    this.proc = spawn("kimi", ["acp"], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `kimi acp exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.performHandshake();
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          // On Windows with shell: true, the direct child is cmd.exe.
          // Use terminateProcessTree to kill the entire tree including
          // the grandchild node process.
          if (process.platform === "win32") {
            try {
              terminateProcessTree(this.proc.pid);
            } catch {
              // Best-effort cleanup inside an unref'd timer — swallow errors
              // to avoid crashing the host process during shutdown.
            }
          } else {
            this.proc.kill("SIGTERM");
          }
        }
      }, 50).unref?.();
    }

    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("kimi acp stdin is not available.");
    }
    stdin.write(line);
  }
}

export class BrokerKimiAcpClient extends KimiAcpClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint ?? null;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        this.handleExit(this.exitError);
      });
    });

    await this.performHandshake();
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
      setTimeout(() => {
        // A peer that never closes its side (e.g. a foreign broker this
        // client is rejecting) would otherwise keep `exitPromise` pending
        // forever; destroy forces the close event so close() can finish.
        if (this.socket && !this.socket.destroyed) {
          this.socket.destroy();
        }
      }, 50).unref?.();
    }
    await this.exitPromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("kimi acp broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class KimiAcpClient {
  /**
   * @param {string} cwd
   * @param {KimiAcpClientOptions} [options]
   * @returns {Promise<SpawnedKimiAcpClient | BrokerKimiAcpClient>}
   */
  static async connect(cwd, options = {}) {
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = readOwnBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerKimiAcpClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedKimiAcpClient(cwd, options);
    try {
      await client.initialize();
    } catch (error) {
      // A failed handshake can leave a connected-but-rejected transport (a
      // foreign broker never closes its socket); always release it so the
      // process does not hang on exit, and tag the error so withAcpClient
      // can still apply its broker fallbacks.
      if (error instanceof Error) {
        const tagged = /** @type {ProtocolError} */ (error);
        tagged.acpClientTransport = client.transport;
        tagged.acpBrokerEndpoint = client.endpoint ?? null;
      }
      await client.close().catch(() => {});
      throw error;
    }
    return client;
  }
}

/**
 * Run `fn` with a connected client, transparently retrying with a direct
 * spawned client when the broker connection is missing (ENOENT/ECONNREFUSED),
 * the broker reports itself busy (rpc code -32001), or the cached broker
 * turns out to be a foreign agent's server (poisoned session cache — the
 * stale record is cleared before falling back).
 * @template T
 * @param {string} cwd
 * @param {(client: SpawnedKimiAcpClient | BrokerKimiAcpClient) => Promise<T>} fn
 * @param {KimiAcpClientOptions} [options]
 * @returns {Promise<T>}
 */
export async function withAcpClient(cwd, fn, options = {}) {
  let client = null;
  try {
    client = await KimiAcpClient.connect(cwd, options);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const explicitBrokerEndpoint = Boolean(
      options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV]
    );
    // When connect() itself fails the client is never assigned here; its
    // transport/endpoint travel on the error instead.
    const failedTransport = client?.transport ?? error?.acpClientTransport ?? null;
    const failedBrokerEndpoint = client?.endpoint ?? error?.acpBrokerEndpoint ?? null;
    const brokerRequested = failedTransport === "broker" || explicitBrokerEndpoint;
    const foreignBroker = error?.foreignBroker === true && failedTransport === "broker" && !explicitBrokerEndpoint;
    const shouldRetryDirect =
      foreignBroker ||
      (failedTransport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));
    const rejectedBrokerEndpoint = foreignBroker ? failedBrokerEndpoint : null;

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    if (rejectedBrokerEndpoint) {
      // Drop the poisoned cache entry — but only if it still points at the
      // endpoint we just rejected, so a concurrently respawned valid broker
      // session is not deleted.
      const cached = readBrokerSession(cwd);
      if (cached?.endpoint === rejectedBrokerEndpoint) {
        clearBrokerSession(cwd);
      }
    }

    const directClient = await KimiAcpClient.connect(cwd, { ...options, disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}
