// Fake FOREIGN ACP broker: stands in for a sibling agent plugin's broker
// (e.g. Codex's app-server broker) that a kimi broker session can point at
// when two companion plugins share one state root. It answers `initialize`
// with a non-Kimi identity and rejects every other method with the
// serde-style "unknown variant" error such servers produce.
import fs from "node:fs";
import net from "node:net";
import process from "node:process";

const socketPath = process.argv[2];
if (!socketPath) {
  throw new Error("Usage: node fake-foreign-broker-fixture.mjs <socket-path>");
}

try {
  fs.unlinkSync(socketPath);
} catch {
  // Ignore missing socket file.
}

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (!line.trim()) {
        continue;
      }
      const message = JSON.parse(line);
      if (message.id !== undefined && message.method === "initialize") {
        socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: 1, agentInfo: { name: "Codex", version: "1.0.6" } }
          })}\n`
        );
        continue;
      }
      if (message.id !== undefined && message.method) {
        socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `unknown variant \`${message.method}\`` }
          })}\n`
        );
      }
    }
  });
});

server.listen(socketPath);
