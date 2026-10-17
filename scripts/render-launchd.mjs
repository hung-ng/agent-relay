#!/usr/bin/env node
import path from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";

const [templatePath, outputPath] = process.argv.slice(2);
if (!templatePath || !outputPath) {
  console.error("usage: node scripts/render-launchd.mjs TEMPLATE OUTPUT");
  process.exit(2);
}

const root = process.env.AGENT_RELAY_ROOT;
const data = process.env.AGENT_RELAY_DATA ?? (root ? path.join(root, "data") : undefined);
const logDir = process.env.AGENT_RELAY_LOG_DIR ?? (data ? path.join(data, "logs") : undefined);
const values = {
  NODE_BIN: process.env.NODE_BIN ?? process.execPath,
  AGENT_RELAY_ROOT: root,
  AGENT_RELAY_DATA: data,
  AGENT_RELAY_LOG_DIR: logDir,
  AGENT_RELAY_TOKEN: process.env.AGENT_RELAY_TOKEN ?? "",
  AGENT_RELAY_HOST: process.env.AGENT_RELAY_HOST ?? "127.0.0.1",
  AGENT_RELAY_PORT: process.env.AGENT_RELAY_PORT ?? "8787",
  AGENT_RELAY_URL: process.env.AGENT_RELAY_URL,
  AGENT_RELAY_TOKEN_FILE: process.env.AGENT_RELAY_TOKEN_FILE ?? (data ? path.join(data, "agent-relay.token") : undefined),
  AGENT_RELAY_MONITOR_URL: process.env.AGENT_RELAY_MONITOR_URL ?? "http://127.0.0.1:8787",
  AGENT_RELAY_MONITOR_AGENT_ID: process.env.AGENT_RELAY_MONITOR_AGENT_ID ?? process.env.AGENT_ID ?? "probe@hung-mini",
  AGENT_RELAY_MONITOR_CAPABILITY: process.env.AGENT_RELAY_MONITOR_CAPABILITY ?? "network.probe",
  AGENT_RELAY_BACKUP_RETENTION: process.env.AGENT_RELAY_BACKUP_RETENTION ?? "7",
  AGENT_ID: process.env.AGENT_ID,
  HOST_ID: process.env.HOST_ID,
  AGENT_KIND: process.env.AGENT_KIND ?? "probe",
  AGENT_CAPABILITIES: process.env.AGENT_CAPABILITIES ?? "network.probe"
};

let template = await readFile(templatePath, "utf8");
const placeholders = [...template.matchAll(/@@([A-Z0-9_]+)@@/g)].map((match) => match[1]);
for (const name of new Set(placeholders)) {
  if (values[name] === undefined || (values[name] === "" && name !== "AGENT_RELAY_TOKEN")) {
    throw new Error(`missing value for ${name}`);
  }
  template = template.replaceAll(`@@${name}@@`, escapeXml(String(values[name] ?? "")));
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, template, { mode: 0o600 });
await chmod(outputPath, 0o600);
console.log(`wrote ${outputPath}`);

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
