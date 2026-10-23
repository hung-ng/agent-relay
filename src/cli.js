#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./server.js";
import { Worker } from "./worker.js";
import { buildTaskPayload, listWorkflows } from "./workflows.js";
import { requestJson } from "./http.js";

export async function main(argv = process.argv.slice(2)) {
  const [command = "help", ...rawArgs] = argv;
  const taskAction = command === "task" && rawArgs[0] && !rawArgs[0].startsWith("--") ? rawArgs.shift() : "run";
  const options = parseArgs(rawArgs);
  try {
    if (command === "server") await runServer(options);
    else if (command === "worker") await runWorker(options);
    else if (command === "task") await runTask(taskAction, options);
    else printHelp();
  } catch (error) {
    console.error(`agent-relay ${command} failed: ${error.message}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();

async function runServer(options) {
  const port = Number(options.port ?? process.env.PORT ?? 8787);
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const app = createServer({ dbPath: options.db ?? process.env.AGENT_RELAY_DB ?? "./data/agent-relay.db", token: options.token ?? process.env.AGENT_RELAY_TOKEN });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      app.close();
      reject(error);
    };
    app.server.once("error", onError);
    app.server.listen(port, host, () => {
      app.server.off("error", onError);
      const address = app.server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      console.log(`agent-relay listening on http://${host}:${boundPort}`);
      resolve();
    });
  });
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
  const configuredCapabilities = options.capabilities ?? process.env.AGENT_CAPABILITIES;
  const capabilities = configuredCapabilities
    ? configuredCapabilities.split(",").map((value) => value.trim()).filter(Boolean)
    : (kind === "probe" ? ["network.probe"] : ["agent.task"]);
  const worker = new Worker({
    serverUrl: server,
    agentId,
    hostId,
    kind,
    capabilities,
    token: options.token ?? process.env.AGENT_RELAY_TOKEN,
    command: options.command,
    taskTimeoutMs: options.task_timeout_ms ?? process.env.AGENT_RELAY_TASK_TIMEOUT_MS
  });
  await worker.start();
  console.log(`agent-relay worker ${agentId} connected as ${hostId}`);
  const shutdown = async () => { await worker.stop(); process.exit(0); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runTask(action, options) {
  if (!["run", "status", "wait", "cancel"].includes(action)) {
    console.error(`unknown task action: ${action}`);
    process.exitCode = 2;
    return;
  }
  const server = options.server ?? process.env.AGENT_RELAY_URL;
  const requestedBy = options.requested_by ?? process.env.AGENT_ID ?? "cli@local";
  const headers = {
    ...(options.token ?? process.env.AGENT_RELAY_TOKEN
      ? { authorization: `Bearer ${options.token ?? process.env.AGENT_RELAY_TOKEN}` }
      : {}),
    ...(action === "cancel" ? { "x-agent-id": requestedBy } : {}),
    "content-type": "application/json"
  };
  const jobId = options.job_id ?? options.id;
  if (["status", "wait", "cancel"].includes(action)) {
    if (!server || !jobId) {
      console.error(`task ${action} requires --server and --job-id`);
      process.exitCode = 2;
      return;
    }
    if (action === "cancel") {
      const result = await requestJson(`${server.replace(/\/$/, "")}/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
        headers,
        body: {}
      });
      console.log(JSON.stringify(result.job, null, 2));
      return;
    }
    const job = action === "status"
      ? await getJob(server, jobId, headers)
      : (await waitForJob(server, jobId, { headers, timeoutMs: parseWaitMs(options.wait_ms) })).job;
    console.log(JSON.stringify(job, null, 2));
    if (action === "wait" && !isTerminal(job.status)) process.exitCode = 3;
    if (["failed", "cancelled"].includes(job.status)) process.exitCode = 1;
    return;
  }
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

  const body = {
    ...(options.id === undefined ? {} : { id: options.id }),
    kind: "agent.task",
    capability: payload.execution_mode === "write" ? "agent.task.write" : "agent.task",
    requested_by: requestedBy,
    target_agent: targetAgent,
    source_host: sourceHost,
    target_host: options.target_host ?? null,
    max_attempts: options.max_attempts === undefined ? undefined : Number(options.max_attempts),
    payload
  };
  const created = await requestJson(`${server.replace(/\/$/, "")}/v1/jobs`, { method: "POST", headers, body });
  const waitMs = parseWaitMs(options.wait_ms);
  const waited = waitMs === 0
    ? { job: created.job, timedOut: false }
    : await waitForJob(server, created.job.id, { headers, timeoutMs: waitMs });
  const job = waited.job;
  console.log(JSON.stringify(job, null, 2));
  if (waited.timedOut) process.exitCode = 3;
  if (["failed", "cancelled"].includes(job.status)) process.exitCode = 1;
}

async function getJob(server, id, headers) {
  const result = await requestJson(`${server.replace(/\/$/, "")}/v1/jobs/${encodeURIComponent(id)}`, { headers });
  return result.job;
}

async function waitForJob(server, id, { headers, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const job = await getJob(server, id, headers);
    if (isTerminal(job.status)) return { job, timedOut: false };
    if (Date.now() >= deadline) return { job, timedOut: true };
    await delay(Math.min(500, Math.max(deadline - Date.now(), 1)));
  }
}

export function parseWaitMs(value) {
  if (value === undefined) return 30000;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 300000) : 30000;
}

function isTerminal(status) {
  return ["completed", "failed", "cancelled"].includes(status);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const separator = arg.indexOf("=");
    const key = arg.slice(2, separator === -1 ? undefined : separator);
    const inline = separator === -1 ? undefined : arg.slice(separator + 1);
    if (inline !== undefined) {
      result[key.replaceAll("-", "_")] = inline;
    } else if (args[index + 1] && !args[index + 1].startsWith("--")) {
      result[key.replaceAll("-", "_")] = args[++index];
    } else {
      result[key.replaceAll("-", "_")] = true;
    }
  }
  return result;
}

function printHelp() {
  console.log(`agent-relay\n\nCommands:\n  agent-relay server [--host 127.0.0.1] [--port 8787] [--db ./data/agent-relay.db]\n  agent-relay worker --server http://... --agent claude@macbook --host macbook --kind probe [--task-timeout-ms 600000]\n  agent-relay task --server https://... --target-agent codex@macbook --prompt "..." [--workflow prompt]\n  agent-relay task status --server https://... --job-id ID\n  agent-relay task wait --server https://... --job-id ID [--wait-ms 30000]\n  agent-relay task cancel --server https://... --job-id ID\n\nTask workflows:\n${listWorkflows().map(({ name, description }) => `  ${name.padEnd(10)} ${description}`).join("\n")}\n\nEnvironment:\n  AGENT_RELAY_TOKEN  Require Bearer authentication when set.\n  AGENT_RELAY_URL    Worker server URL.\n  AGENT_ID           Worker agent ID or default requester.\n  HOST_ID            Worker host ID.\n  AGENT_RELAY_TASK_TIMEOUT_MS  Maximum worker task runtime.`);
}
