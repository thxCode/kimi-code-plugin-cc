#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, KimiAcpClient } from "./lib/acp-client.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

const PLUGIN_MANIFEST_URL = new URL("../.claude-plugin/plugin.json", import.meta.url);

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

// session/prompt holds the upstream stream for its whole turn: the response
// only arrives once the turn completes, and session/update notifications flow
// in between.
const STREAMING_METHODS = new Set(["session/prompt"]);
const CANCEL_METHOD = "session/cancel";

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

// Answered locally per downstream client; everything else is forwarded
// upstream, so advertise a minimal-but-valid capability set.
function buildInitializeResult() {
  return {
    protocolVersion: 1,
    userAgent: "kimi-companion-broker",
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
      sessionCapabilities: { list: {}, resume: {} }
    },
    authMethods: [],
    agentInfo: { name: "kimi-companion-broker", version: PLUGIN_MANIFEST.version ?? "0.0.0" }
  };
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/acp-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const appClient = await KimiAcpClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let lastActiveSocket = null;
  const sockets = new Set();
  // Upstream server->client request ids forwarded to each downstream socket,
  // so responses coming back can be routed to the upstream agent.
  const forwardedUpstreamIds = new Map();
  // sessionId of the in-flight streaming (session/prompt) request per socket,
  // so a dead stream owner can have its orphaned upstream turn cancelled.
  const streamSessionBySocket = new Map();

  function trackForwardedId(socket, id) {
    let ids = forwardedUpstreamIds.get(socket);
    if (!ids) {
      ids = new Set();
      forwardedUpstreamIds.set(socket, ids);
    }
    ids.add(id);
  }

  function consumeForwardedId(socket, id) {
    const ids = forwardedUpstreamIds.get(socket);
    if (!ids || !ids.has(id)) {
      return false;
    }
    ids.delete(id);
    if (ids.size === 0) {
      forwardedUpstreamIds.delete(socket);
    }
    return true;
  }

  function clearSocketOwnership(socket) {
    const orphanedStreamSession = streamSessionBySocket.get(socket) ?? null;
    streamSessionBySocket.delete(socket);
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
    }
    if (lastActiveSocket === socket) {
      lastActiveSocket = null;
    }
    if (orphanedStreamSession) {
      // The client that owned an in-flight streaming turn is gone; cancel the
      // orphaned upstream turn so it does not keep burning tokens with no
      // consumer, and so a later client is not routed its stale updates.
      appClient.notify(CANCEL_METHOD, { sessionId: orphanedStreamSession });
    }
    const ids = forwardedUpstreamIds.get(socket);
    if (ids) {
      forwardedUpstreamIds.delete(socket);
      for (const id of ids) {
        // The client that was supposed to answer this upstream request is
        // gone; fail it so the agent does not hang waiting for a response.
        appClient.sendMessage({
          jsonrpc: "2.0",
          id,
          error: buildJsonRpcError(-32000, "Broker client disconnected before responding.")
        });
      }
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
  }

  // Upstream server->client requests (e.g. session/request_permission) are
  // forwarded to the socket that owns the current stream, falling back to the
  // last-active socket when idle; the socket's response is routed back upstream.
  function routeServerRequest(message) {
    const target = activeStreamSocket ?? activeRequestSocket ?? lastActiveSocket;
    if (!target || target.destroyed || !sockets.has(target)) {
      appClient.sendMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`)
      });
      return;
    }
    trackForwardedId(target, message.id);
    send(target, message);
  }

  async function shutdown(server) {
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  appClient.setNotificationHandler(routeNotification);
  appClient.setServerRequestHandler(routeServerRequest);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            jsonrpc: "2.0",
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        // Responses to forwarded upstream requests (id + result/error, no method).
        if (message.id !== undefined && !message.method) {
          if (consumeForwardedId(socket, message.id)) {
            if (message.error) {
              appClient.sendMessage({ jsonrpc: "2.0", id: message.id, error: message.error });
            } else {
              appClient.sendMessage({ jsonrpc: "2.0", id: message.id, result: message.result ?? {} });
            }
          }
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            jsonrpc: "2.0",
            id: message.id,
            result: buildInitializeResult()
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { jsonrpc: "2.0", id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        // Downstream notifications: only session/cancel is forwarded upstream.
        // It is allowed through even while another socket owns the stream.
        if (message.id === undefined) {
          if (message.method === CANCEL_METHOD) {
            appClient.notify(message.method, message.params ?? {});
          }
          continue;
        }

        if ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) {
          send(socket, {
            jsonrpc: "2.0",
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Kimi ACP broker is busy.")
          });
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;
        lastActiveSocket = socket;
        if (isStreaming) {
          activeStreamSocket = socket;
          if (typeof message.params?.sessionId === "string") {
            streamSessionBySocket.set(socket, message.params.sessionId);
          }
        }

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { jsonrpc: "2.0", id: message.id, result });
        } catch (error) {
          send(socket, {
            jsonrpc: "2.0",
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
        } finally {
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket) {
            activeStreamSocket = null;
          }
          streamSessionBySocket.delete(socket);
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
