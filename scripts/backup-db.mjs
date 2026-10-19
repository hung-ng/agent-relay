#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";

export async function backupDatabase({
  dbPath = process.env.AGENT_RELAY_DB ?? path.resolve("data/agent-relay.db"),
  backupDir = process.env.AGENT_RELAY_BACKUP_DIR ?? path.resolve("data/backups"),
  retention = Number(process.env.AGENT_RELAY_BACKUP_RETENTION ?? 7),
  clock = () => new Date()
} = {}) {
  if (!dbPath || dbPath === ":memory:") throw new Error("a file-backed SQLite database is required");
  const keep = Math.max(1, Number.isFinite(retention) ? Math.floor(retention) : 7);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });

  const lockPath = path.join(backupDir, ".backup.lock");
  await acquireLock(lockPath);

  const stamp = clock().toISOString().replace(/[-:]/g, "").replace(".", "");
  const backupPath = path.join(backupDir, `agent-relay-${stamp}.db`);
  const partialPath = `${backupPath}.partial`;
  let source;
  try {
    await unlink(partialPath).catch(() => {});
    source = new DatabaseSync(dbPath);
    source.exec("PRAGMA busy_timeout = 5000;");
    source.exec(`VACUUM INTO '${escapeSqlString(partialPath)}'`);
    source.close();
    source = null;

    const integrity = verifyIntegrity(partialPath);
    if (integrity !== "ok") throw new Error(`backup integrity check failed: ${integrity}`);
    await rename(partialPath, backupPath);

    const removed = await pruneBackups(backupDir, keep);
    return { path: backupPath, integrity, removed, retained: keep };
  } finally {
    source?.close();
    await unlink(partialPath).catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

async function acquireLock(lockPath) {
  try {
    await writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const owner = await readFile(lockPath, "utf8").catch(() => "");
  const pid = Number(owner.trim());
  if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
    throw new Error("a database backup is already running");
  }
  await unlink(lockPath).catch(() => {});
  try {
    await writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("a database backup is already running");
    throw error;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
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

async function pruneBackups(backupDir, retention) {
  const names = (await readdir(backupDir))
    .filter((name) => /^agent-relay-[0-9TZ]+\.db$/.test(name))
    .sort()
    .reverse();
  const removed = [];
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
