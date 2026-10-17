#!/usr/bin/env node
import process from "node:process";
import { createServer } from "./server.js";
import { Worker } from "./worker.js";
import { buildTaskPayload, listWorkflows } from "./workflows.js";

const [command = "help", ...args] = process.argv.slice(2);
const options = parseArgs(args);

if (command === "server") await runServer(options);
else if (command === "worker") await runWorker(options);
else if (command === "task") await runTask(options);
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

async function runTask(options) {
  const server = options.server ?? process.env.AGENT_RELAY_URL;
  const requestedBy = options.requested_by ?? process.env.AGENT_ID ?? "cli@local";
  const targetAgent = options.target_agent ?? null;
  const sourceHost = options.source_host ?? null;
  if (!server || (!targetAgent && !sourceHost)) {
    console.error("task requires --server and either --target-agent or --source-host");
    process.exitCode = 2;
    return;
  }

  let payload;
  try {
    payload = buildTaskPayload({
      workflow: options.workflow ?? "prompt",
      prompt: options.prompt,
      cwd: options.cwd ?? null
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }

  const headers = {
    ...(options.token ?? process.env.AGENT_RELAY_TOKEN
      ? { authorization: `Bearer ${options.token ?? process.env.AGENT_RELAY_TOKEN}` }
      : {}),
    "content-type": "application/json"
  };
  const body = {
    kind: "agent.task",
    capability: "agent.task",
    requested_by: requestedBy,
    target_agent: targetAgent,
    source_host: sourceHost,
    target_host: options.target_host ?? null,
    max_attempts: options.max_attempts === undefined ? undefined : Number(options.max_attempts),
    payload
  };
  const created = await requestJson(server, "/v1/jobs", { method: "POST", headers, body });
  const waitMs = Math.min(Math.max(Number(options.wait_ms ?? 30000) || 30000, 0), 300000);
  const job = waitMs === 0
    ? created.job
    : await waitForJob(server, created.job.id, { headers, timeoutMs: waitMs });
  console.log(JSON.stringify(job, null, 2));
  if (["failed", "cancelled"].includes(job.status)) process.exitCode = 1;
}

async function waitForJob(server, id, { headers, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const { job } = await requestJson(server, `/v1/jobs/${encodeURIComponent(id)}`, { headers });
    if (["completed", "failed", "cancelled"].includes(job.status) || Date.now() >= deadline) return job;
    await delay(Math.min(500, Math.max(deadline - Date.now(), 1)));
  }
}

async function requestJson(server, route, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(`${server.replace(/\/$/, "")}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `request failed: ${response.status}`);
  return value;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  console.log(`agent-relay\n\nCommands:\n  agent-relay server [--host 127.0.0.1] [--port 8787] [--db ./data/agent-relay.db]\n  agent-relay worker --server http://... --agent claude@macbook --host macbook --kind probe\n  agent-relay task --server https://... --target-agent codex@macbook --prompt "..." [--workflow prompt]\n\nTask workflows:\n${listWorkflows().map(({ name, description }) => `  ${name.padEnd(10)} ${description}`).join("\n")}\n\nEnvironment:\n  AGENT_RELAY_TOKEN  Require Bearer authentication when set.\n  AGENT_RELAY_URL    Worker server URL.\n  AGENT_ID           Worker agent ID or default requester.\n  HOST_ID            Worker host ID.`);
}
