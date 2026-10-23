#!/usr/bin/env node
import path from "node:path";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, stat } from "node:fs/promises";
import { writePrivateFile } from "../src/files.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args.some((arg) => !arg)) {
    console.error("usage: node scripts/render-launchd.mjs TEMPLATE OUTPUT");
    process.exitCode = 2;
    return;
  }
  const [templatePath, outputPath] = args;

  const root = process.env.AGENT_RELAY_ROOT;
  const data = process.env.AGENT_RELAY_DATA ?? (root ? path.join(root, "data") : undefined);
  const logDir = process.env.AGENT_RELAY_LOG_DIR ?? (data ? path.join(data, "logs") : undefined);
  const values = {
    NODE_BIN: process.env.NODE_BIN ?? process.execPath,
    AGENT_RELAY_PATH: process.env.AGENT_RELAY_PATH ?? process.env.PATH ?? "/usr/bin:/bin",
    AGENT_RELAY_ROOT: root,
    AGENT_RELAY_DATA: data,
    AGENT_RELAY_LOG_DIR: logDir,
    AGENT_RELAY_TOKEN: process.env.AGENT_RELAY_TOKEN ?? "",
    AGENT_RELAY_PREVIOUS_TOKEN: process.env.AGENT_RELAY_PREVIOUS_TOKEN ?? "",
    AGENT_RELAY_TASK_TIMEOUT_MS: process.env.AGENT_RELAY_TASK_TIMEOUT_MS ?? "600000",
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

  const template = await readFile(templatePath, "utf8");
  const placeholders = /@@([A-Z0-9_]+)@@/g;
  const names = new Set([...template.matchAll(placeholders)].map((match) => match[1]));
  for (const name of names) {
    if (!Object.hasOwn(values, name) || values[name] === undefined || (values[name] === "" && !["AGENT_RELAY_TOKEN", "AGENT_RELAY_PREVIOUS_TOKEN"].includes(name))) {
      throw new Error(`missing value for ${name}`);
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(values[name])) {
      throw new Error(`invalid XML character in ${name}`);
    }
  }
  if (names.has("AGENT_RELAY_PREVIOUS_TOKEN") && values.AGENT_RELAY_PREVIOUS_TOKEN && !values.AGENT_RELAY_TOKEN) {
    throw new Error("AGENT_RELAY_PREVIOUS_TOKEN requires AGENT_RELAY_TOKEN");
  }
  for (const name of ["NODE_BIN", "AGENT_RELAY_ROOT", "AGENT_RELAY_DATA", "AGENT_RELAY_LOG_DIR", "AGENT_RELAY_TOKEN_FILE"]) {
    if (names.has(name) && !path.isAbsolute(values[name])) throw new Error(`${name} must be an absolute path`);
  }
  if (names.has("AGENT_ID") && /[/\\]/.test(values.AGENT_ID)) {
    throw new Error("AGENT_ID must not contain path separators");
  }
  for (const name of ["AGENT_RELAY_URL", "AGENT_RELAY_MONITOR_URL"]) {
    if (!names.has(name)) continue;
    let url;
    try { url = new URL(values[name]); } catch {}
    if (!url || !["http:", "https:"].includes(url.protocol)) throw new Error(`${name} must be an HTTP or HTTPS URL`);
  }
  for (const [name, maximum] of [["AGENT_RELAY_PORT", 65535], ["AGENT_RELAY_TASK_TIMEOUT_MS", Number.MAX_SAFE_INTEGER], ["AGENT_RELAY_BACKUP_RETENTION", Number.MAX_SAFE_INTEGER]]) {
    if (!names.has(name)) continue;
    const value = Number(values[name]);
    if (!/^\d+$/.test(values[name]) || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${name} must be an integer between 1 and ${maximum}`);
    }
  }
  if (names.has("AGENT_RELAY_ROOT") && !(await stat(root)).isDirectory()) throw new Error("AGENT_RELAY_ROOT must be a directory");
  if (names.has("NODE_BIN")) {
    if (!(await stat(values.NODE_BIN)).isFile()) throw new Error("NODE_BIN must be a file");
    await access(values.NODE_BIN, constants.X_OK);
  }

  const directories = new Set();
  if (names.has("AGENT_RELAY_DATA")) directories.add(data);
  if (names.has("AGENT_RELAY_LOG_DIR")) directories.add(logDir);
  for (const suffix of ["logs", "backups"]) {
    if (template.includes(`@@AGENT_RELAY_DATA@@/${suffix}`)) directories.add(path.join(data, suffix));
  }
  for (const directory of [...directories, path.dirname(path.resolve(outputPath))]) await validateDirectory(directory);
  const output = await lstat(outputPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  if (output?.isDirectory()) throw new Error("output must be a file");

  const rendered = template.replace(placeholders, (_, name) => escapeXml(values[name]));
  for (const directory of directories) await mkdir(directory, { recursive: true, mode: 0o700 });
  await writePrivateFile(outputPath, rendered);
  console.log(`wrote ${outputPath}`);
}

async function validateDirectory(directory) {
  try {
    if (!(await stat(directory)).isDirectory()) throw new Error(`not a directory: ${directory}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await validateDirectory(path.dirname(directory));
  }
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;").replaceAll("\r", "&#13;");
}

await main().catch((error) => {
  console.error(`launchd rendering failed: ${error.message}`);
  process.exitCode = 1;
});
