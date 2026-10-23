#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";

export async function backupDatabase({
  dbPath = process.env.AGENT_RELAY_DB ?? path.resolve("data/agent-relay.db"),
  backupDir = process.env.AGENT_RELAY_BACKUP_DIR ?? path.resolve("data/backups"),
  retention = Number(process.env.AGENT_RELAY_BACKUP_RETENTION ?? 7),
  clock = () => new Date()
} = {}) {
  if (!dbPath || dbPath === ":memory:") throw new Error("a file-backed SQLite database is required");
  const keep = Math.max(1, Number.isFinite(retention) ? Math.floor(retention) : 7);
  const stamp = clock().toISOString().replace(/[-:]/g, "").replace(".", "");
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = path.join(backupDir, `agent-relay-${stamp}.db`);
  const partialPath = `${backupPath}.partial`;
  let source = new DatabaseSync(dbPath, { readOnly: true });
  let release;
  let ownsPartial = false;
  try {
    release = await acquireMutex(path.join(backupDir, ".backup-lock.sqlite"));
    const sourceIdentity = await stat(dbPath, { bigint: true });
    const destination = await stat(backupPath, { bigint: true }).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (destination && sameFile(destination, sourceIdentity)) throw new Error("backup destination must differ from the source database");
    await cleanPartialBackups(backupDir, sourceIdentity);
    await writeFile(partialPath, "", { flag: "wx", mode: 0o600 });
    ownsPartial = true;
    source.exec("PRAGMA busy_timeout = 5000;");
    source.exec(`VACUUM INTO '${escapeSqlString(partialPath)}'`);
    source.close();
    source = null;

    const integrity = verifyIntegrity(partialPath);
    if (integrity !== "ok") throw new Error(`backup integrity check failed: ${integrity}`);
    await chmod(partialPath, 0o600);
    await rename(partialPath, backupPath);

    const removed = await pruneBackups(backupDir, keep, path.basename(backupPath), sourceIdentity);
    return { path: backupPath, integrity, removed, retained: keep };
  } finally {
    try {
      source?.close();
    } finally {
      try {
        if (ownsPartial) await unlink(partialPath).catch(() => {});
      } finally { release?.(); }
    }
  }
}

async function acquireMutex(filename) {
  const database = new DatabaseSync(filename);
  try {
    await chmod(filename, 0o600);
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  } catch (error) {
    database.close();
    if (error.errcode === 5 || error.errcode === 6) throw new Error("a database backup is already running");
    throw error;
  }
  return () => {
    try { database.exec("ROLLBACK"); }
    finally { database.close(); }
  };
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function cleanPartialBackups(backupDir, sourceIdentity) {
  for (const entry of await readdir(backupDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^agent-relay-\d{8}T\d{9}Z\.db\.partial$/.test(entry.name)) continue;
    const filename = path.join(backupDir, entry.name);
    const candidate = await stat(filename, { bigint: true });
    if (!sameFile(candidate, sourceIdentity)) await unlink(filename);
  }
}

function verifyIntegrity(filename) {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const row = database.prepare("PRAGMA integrity_check").get();
    return row?.integrity_check ?? "unknown";
  } finally {
    database.close();
  }
}

async function pruneBackups(backupDir, retention, currentBackup, sourceIdentity) {
  const names = [];
  for (const entry of await readdir(backupDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^agent-relay-[0-9TZ]+\.db$/.test(entry.name) || entry.name === currentBackup) continue;
    const candidate = await stat(path.join(backupDir, entry.name), { bigint: true });
    if (!sameFile(candidate, sourceIdentity)) names.push(entry.name);
  }
  names.sort().reverse();
  names.unshift(currentBackup);
  const removed = [];
  for (const name of names.slice(0, retention)) await chmod(path.join(backupDir, name), 0o600);
  for (const name of names.slice(retention)) {
    await unlink(path.join(backupDir, name));
    removed.push(name);
  }
  return removed;
}

function escapeSqlString(value) {
  return value.replaceAll("'", "''");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  backupDatabase()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(`database backup failed: ${error.message}`);
      process.exitCode = 1;
    });
}
