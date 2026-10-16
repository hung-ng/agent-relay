#!/usr/bin/env node
const baseUrl = (process.env.AGENT_RELAY_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const headers = process.env.AGENT_RELAY_TOKEN
  ? { authorization: `Bearer ${process.env.AGENT_RELAY_TOKEN}` }
  : {};

for (const path of ["/healthz", "/readyz", "/v1/agents"]) {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${body}`);
  console.log(`${path}: ${body}`);
}
