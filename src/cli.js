#!/usr/bin/env node
import process from "node:process";
import { createServer } from "./server.js";
import { Worker } from "./worker.js";

const [command = "help", ...args] = process.argv.slice(2);
const options = parseArgs(args);

if (command === "server") await runServer(options);
else if (command === "worker") await runWorker(options);
else printHelp();

async function runServer(options) {
  const port = Number(options.port ?? process.env.PORT ?? 8787);
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const app = createServer({ dbPath: options.db ?? process.env.AGENT_RELAY_DB ?? "./data/agent-relay.db", token: options.token ?? process.env.AGENT_RELAY_TOKEN });
  app.server.listen(port, host, () => console.log(`agent-relay listening on http://${host}:${port}`));
  const shutdown = () => { app.close(); process.exit(0); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runWorker(options) {
  const server = options.server ?? process.env.AGENT_RELAY_URL;
  const agentId = options.agent ?? process.env.AGENT_ID;
  const hostId = options.host ?? process.env.HOST_ID ?? "local";
  if (!server || !agentId) {
    console.error("worker requires --server and --agent");
    process.exit(2);
  }
  const kind = options.kind ?? process.env.AGENT_KIND ?? "probe";
  const capabilities = options.capabilities?.split(",") ?? (kind === "probe" ? ["network.probe"] : ["agent.task"]);
  const worker = new Worker({ serverUrl: server, agentId, hostId, kind, capabilities, token: options.token ?? process.env.AGENT_RELAY_TOKEN, command: options.command });
  await worker.start();
  console.log(`agent-relay worker ${agentId} connected as ${hostId}`);
  const shutdown = async () => { await worker.stop(); process.exit(0); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2);
    result[key.replaceAll("-", "_")] = inline ?? args[++index] ?? true;
  }
  return result;
}

function printHelp() {
  console.log(`agent-relay\n\nCommands:\n  agent-relay server [--host 127.0.0.1] [--port 8787] [--db ./data/agent-relay.db]\n  agent-relay worker --server http://... --agent claude@macbook --host macbook --kind probe\n\nEnvironment:\n  AGENT_RELAY_TOKEN  Require Bearer authentication when set.\n  AGENT_RELAY_URL    Worker server URL.\n  AGENT_ID           Worker agent ID.\n  HOST_ID            Worker host ID.`);
}
