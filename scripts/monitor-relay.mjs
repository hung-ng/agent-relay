#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { requestJson } from "../src/http.js";

export async function checkRelay({
  baseUrl = process.env.AGENT_RELAY_MONITOR_URL ?? "http://127.0.0.1:8787",
  token = "",
  expectedAgentId = process.env.AGENT_RELAY_MONITOR_AGENT_ID ?? "probe@hung-mini",
  expectedCapability = process.env.AGENT_RELAY_MONITOR_CAPABILITY ?? "network.probe",
  fetchImpl = fetch
} = {}) {
  const url = baseUrl.replace(/\/$/, "");
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const health = await requestJson(`${url}/healthz`, { headers, fetchImpl });
  const readiness = await requestJson(`${url}/readyz`, { headers, fetchImpl });
  const agents = await requestJson(`${url}/v1/agents`, { headers, fetchImpl });
  const agent = agents.agents?.find((candidate) => candidate.id === expectedAgentId);
  if (!agent) throw new Error(`expected agent is missing: ${expectedAgentId}`);
  if (agent.status !== "online") throw new Error(`expected agent is ${agent.status}: ${expectedAgentId}`);
  if (expectedCapability && !agent.capabilities?.includes(expectedCapability)) {
    throw new Error(`agent is missing capability ${expectedCapability}: ${expectedAgentId}`);
  }
  return { ok: true, health, readiness, agent };
}

export async function runMonitor({
  tokenFile = process.env.AGENT_RELAY_TOKEN_FILE ?? path.resolve("data/agent-relay.token"),
  logFile = process.env.AGENT_RELAY_MONITOR_LOG ?? path.resolve("data/logs/monitor.log"),
  stateFile = process.env.AGENT_RELAY_MONITOR_STATE ?? path.resolve("data/monitor-state.json"),
  token = process.env.AGENT_RELAY_TOKEN,
  expectedAgentId = process.env.AGENT_RELAY_MONITOR_AGENT_ID ?? "probe@hung-mini",
  expectedCapability = process.env.AGENT_RELAY_MONITOR_CAPABILITY ?? "network.probe",
  fetchImpl = fetch
} = {}) {
  const resolvedToken = token || await readFile(tokenFile, "utf8").then((value) => value.trim()).catch(() => "");
  const checkedAt = new Date().toISOString();
  try {
    const result = await checkRelay({ token: resolvedToken, expectedAgentId, expectedCapability, fetchImpl });
    await record({ logFile, stateFile, event: { checked_at: checkedAt, status: "ok", agent: result.agent } });
    return result;
  } catch (error) {
    await record({ logFile, stateFile, event: { checked_at: checkedAt, status: "error", error: error.message } });
    throw error;
  }
}

async function record({ logFile, stateFile, event }) {
  await mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  await appendFile(logFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  await writeFile(stateFile, `${JSON.stringify(event, null, 2)}\n`, { mode: 0o600 });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runMonitor()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(`relay monitor failed: ${error.message}`);
      process.exitCode = 1;
    });
}
