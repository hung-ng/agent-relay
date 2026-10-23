#!/usr/bin/env node
import { requestJson } from "../src/http.js";
const baseUrl = (process.env.AGENT_RELAY_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const headers = process.env.AGENT_RELAY_TOKEN
  ? { authorization: `Bearer ${process.env.AGENT_RELAY_TOKEN}` }
  : {};

for (const path of ["/healthz", "/readyz", "/v1/agents"]) {
  const body = await requestJson(`${baseUrl}${path}`, { headers });
  console.log(`${path}: ${JSON.stringify(body)}`);
}
