#!/usr/bin/env node
import path from "node:path";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { validateHeaderValue } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { writePrivateFile } from "../src/files.js";

export const usage = "usage: node scripts/update-worker-token.mjs --new-token-file PRIVATE_FILE --plist WORKER_PLIST [--plist WORKER_PLIST ...] [--token-copy EXISTING_PRIVATE_TOKEN_FILE ...] [--apply]";

class TokenUpdateError extends Error {}
const fail = (message) => new TokenUpdateError(message);
const quoted = (value) => JSON.stringify(value);

export function parseArgs(args) {
  const options = { plists: [], tokenCopies: [], apply: false };
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--apply" && !options.apply) {
      options.apply = true;
      continue;
    }
    if (!["--new-token-file", "--plist", "--token-copy"].includes(option)) {
      throw fail("Invalid or repeated option.");
    }
    const value = args[++index];
    if (typeof value !== "string" || !value || value.startsWith("-") || value.includes("\0")) {
      throw fail("Each file option requires a path.");
    }
    if (option === "--new-token-file") {
      if (options.newTokenFile) throw fail("--new-token-file may appear only once.");
      options.newTokenFile = value;
    } else {
      options[option === "--plist" ? "plists" : "tokenCopies"].push(value);
    }
  }
  if (!options.newTokenFile || !options.plists.length) throw fail("A candidate token file and at least one worker plist are required.");
  return options;
}

// plutil receives credentials only through stdin. Never expose its diagnostics.
export function convertPlist(bytes, format, run = spawnSync) {
  if (!["json", "xml1"].includes(format)) throw fail("Unsupported plist conversion.");
  try {
    const result = run("/usr/bin/plutil", ["-convert", format, "-o", "-", "--", "-"], {
      input: bytes,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (result.error || result.status !== 0 || !result.stdout?.length) throw fail("Plist conversion failed.");
    return Buffer.from(result.stdout);
  } catch {
    throw fail("Plist conversion failed.");
  }
}

async function readInput(filename, privateFile) {
  let handle;
  try {
    const resolved = path.resolve(filename);
    const info = await lstat(resolved);
    if (!info.isFile() || info.uid !== process.getuid()) throw fail("Inputs must be owned regular files, without symlinks.");
    if (privateFile && (info.mode & 0o077)) throw fail("Token files must have no group or other permissions.");
    const physical = await realpath(resolved);
    handle = await open(physical, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw fail("An input changed while being read.");
    return {
      path: physical,
      realPath: physical,
      identity: `${opened.dev}:${opened.ino}`,
      mode: opened.mode & 0o777,
      privateFile,
      bytes: await handle.readFile()
    };
  } catch (error) {
    if (error instanceof TokenUpdateError) throw error;
    throw fail("Could not read an owned regular input file.");
  } finally {
    await handle?.close();
  }
}

function readToken(bytes, candidate = false) {
  let token;
  try { token = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r?\n$/, ""); }
  catch { throw fail("Token files must contain UTF-8 text."); }
  if (!token || /[\r\n]/.test(token)) throw fail("Token files must contain one nonempty line, with an optional final newline.");
  if (candidate) {
    if (token.trim() !== token) throw fail("The candidate token must not start or end with whitespace.");
    try { validateHeaderValue("authorization", `Bearer ${token}`); }
    catch { throw fail("The candidate token must be safe for an HTTP header."); }
  }
  return token;
}

function parsePlist(bytes, convert) {
  try { return JSON.parse(convert(bytes, "json").toString("utf8")); }
  catch { throw fail("Could not decode a plist as JSON."); }
}

const dictionary = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function workerToken(plist) {
  if (!dictionary(plist) || typeof plist.Label !== "string" || !/^com\.agent-relay\.worker\.[^\s/\\]+$/.test(plist.Label)) {
    throw fail("Only com.agent-relay.worker.* plists are accepted.");
  }
  const args = plist.ProgramArguments;
  if (!Array.isArray(args) || args.length < 3 || args.some((arg) => typeof arg !== "string" || !arg)
    || path.basename(args[1]) !== "cli.js" || args[2] !== "worker") {
    throw fail("ProgramArguments must run cli.js worker.");
  }
  if (args.slice(3).some((arg) => arg === "--token" || arg.startsWith("--token="))) {
    throw fail("Worker credentials must come from EnvironmentVariables.");
  }
  const token = plist.EnvironmentVariables?.AGENT_RELAY_TOKEN;
  if (!dictionary(plist.EnvironmentVariables) || typeof token !== "string" || !token) {
    throw fail("Worker EnvironmentVariables.AGENT_RELAY_TOKEN must be a nonempty string.");
  }
  return token;
}

function prepareWorker(input, candidate, convert) {
  const plist = parsePlist(input.bytes, convert);
  const token = workerToken(plist);
  try {
    // Refuse values or plist types that would change during the JSON roundtrip.
    const canonical = Buffer.from(convert(input.bytes, "xml1"));
    const roundtrip = Buffer.from(convert(Buffer.from(JSON.stringify(plist)), "xml1"));
    if (!canonical.equals(roundtrip)) throw fail("Plist values cannot be preserved through JSON conversion.");
    const updated = { ...plist, EnvironmentVariables: { ...plist.EnvironmentVariables, AGENT_RELAY_TOKEN: candidate } };
    const replacement = Buffer.from(convert(Buffer.from(JSON.stringify(updated)), "xml1"));
    if (!isDeepStrictEqual(parsePlist(replacement, convert), updated)) throw fail("Plist replacement validation failed.");
    return { ...input, type: "plist", label: plist.Label, token, replacement: token === candidate ? input.bytes : replacement, changed: token !== candidate || input.mode !== 0o600 };
  } catch (error) {
    if (error instanceof TokenUpdateError) throw error;
    throw fail("Plist replacement validation failed.");
  }
}

async function verifyInputs(inputs) {
  for (const input of inputs) {
    const current = await readInput(input.path, input.privateFile);
    if (current.identity !== input.identity || current.realPath !== input.realPath
      || current.mode !== input.mode || !current.bytes.equals(input.bytes)) {
      throw fail("An input changed before replacement; retry with stable files.");
    }
  }
}

export async function updateWorkerToken(options, { convert = convertPlist, writeFile = writePrivateFile } = {}) {
  try { return await prepareAndApply(options, convert, writeFile); }
  catch (error) {
    if (error instanceof TokenUpdateError) throw error;
    throw fail("Worker token update failed.");
  }
}

async function prepareAndApply({ newTokenFile, plists, tokenCopies = [], apply = false }, convert, writeFile) {
  if (typeof newTokenFile !== "string" || !newTokenFile || !Array.isArray(plists) || !plists.length
    || !Array.isArray(tokenCopies) || typeof apply !== "boolean"
    || [...plists, ...tokenCopies].some((filename) => typeof filename !== "string" || !filename)) {
    throw fail("A candidate token file and at least one worker plist are required.");
  }
  const filenames = [newTokenFile, ...plists, ...tokenCopies].map((filename) => path.resolve(filename));
  if (new Set(filenames).size !== filenames.length) throw fail("Duplicate input paths or a candidate/target collision.");
  const inputs = [];
  for (let index = 0; index < filenames.length; index++) {
    inputs.push(await readInput(filenames[index], index === 0 || index > plists.length));
  }
  if (new Set(inputs.map((input) => input.realPath)).size !== inputs.length
    || new Set(inputs.map((input) => input.identity)).size !== inputs.length) {
    throw fail("Duplicate input files or a candidate/target collision.");
  }
  const candidate = readToken(inputs[0].bytes, true);
  const workers = inputs.slice(1, plists.length + 1).map((input) => prepareWorker(input, candidate, convert));
  const existing = workers[0].token;
  if (workers.some((worker) => worker.token !== existing)) throw fail("Existing worker credentials do not match.");
  const copies = inputs.slice(plists.length + 1).map((input) => {
    const token = readToken(input.bytes);
    if (token !== existing) throw fail("An existing token copy does not match the worker credential.");
    return { ...input, type: "token-copy", replacement: token === candidate ? input.bytes : Buffer.from(`${candidate}\n`), changed: token !== candidate || input.mode !== 0o600 };
  });
  const targets = [...workers, ...copies];
  const result = {
    apply,
    changed: targets.filter((target) => target.changed).length,
    targets: targets.map(({ path: filename, type, label, changed }) => ({ path: filename, type, ...(label ? { label } : {}), changed })),
    backupPath: null
  };
  if (!apply) return result;

  await verifyInputs(inputs);
  const backupPath = await mkdtemp(path.join(path.dirname(workers[0].path), ".agent-relay-worker-token-backup-"));
  result.backupPath = backupPath;
  try {
    await chmod(backupPath, 0o700);
    const manifest = { version: 1, targets: [] };
    for (const [index, target] of targets.entries()) {
      const backupFile = `${index + 1}.original`;
      const filename = path.join(backupPath, backupFile);
      await writeFile(filename, target.bytes);
      await chmod(filename, 0o600);
      manifest.targets.push({ path: target.path, type: target.type, ...(target.label ? { label: target.label } : {}), backupFile, mode: target.mode });
    }
    const filename = path.join(backupPath, "manifest.json");
    await writeFile(filename, `${JSON.stringify(manifest, null, 2)}\n`);
    await chmod(filename, 0o600);
    await verifyInputs(inputs);
  } catch {
    throw fail(`Private backup preparation failed; no targets were changed. Backups: ${quoted(backupPath)}`);
  }

  const attempted = [];
  try {
    for (const target of targets.filter((target) => target.changed)) {
      await verifyInputs([target]);
      attempted.push(target);
      await writeFile(target.path, target.replacement);
      await chmod(target.path, 0o600);
    }
    for (const target of targets) {
      const current = await readInput(target.path, target.privateFile);
      if (current.realPath !== target.realPath || !current.bytes.equals(target.changed ? target.replacement : target.bytes) || current.mode !== 0o600) {
        throw fail("A target changed after replacement.");
      }
    }
  } catch {
    let restored = true;
    for (const target of attempted.reverse()) {
      try {
        const current = await readInput(target.path, target.privateFile);
        if (current.bytes.equals(target.bytes) && current.mode === target.mode) continue;
        if (current.realPath !== target.realPath || !current.bytes.equals(target.replacement) || current.mode !== 0o600) {
          restored = false;
          continue;
        }
        await writeFile(target.path, target.bytes);
        await chmod(target.path, target.mode);
      } catch { restored = false; }
    }
    throw fail(`Replacement failed; ${restored ? "original files restored" : "some files could not be restored"}. Recovery backups: ${quoted(backupPath)}`);
  }
  return result;
}

export async function main(args = process.argv.slice(2), { log = console.log, ...dependencies } = {}) {
  if (args.length === 1 && args[0] === "--help") {
    log(usage);
    log("Dry-run is the default. Only credential files are replaced. Launchd reload is still required after apply.");
    return;
  }
  const result = await updateWorkerToken(parseArgs(args), dependencies);
  for (const target of result.targets) log(`${target.label ? quoted(target.label) : "Token copy"}: ${quoted(target.path)}`);
  log(`${result.apply ? "Applied" : "Dry-run"}: ${result.changed} of ${result.targets.length} files ${result.apply ? "changed" : "would change"}.`);
  if (result.backupPath) log(`Backups: ${quoted(result.backupPath)}`);
  log("Launchd reload is still required after apply.");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof TokenUpdateError ? error.message : "Worker token update failed.");
    console.error(usage);
    process.exitCode = 1;
  });
}
