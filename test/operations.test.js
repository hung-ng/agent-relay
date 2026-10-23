import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { backupDatabase } from "../scripts/backup-db.mjs";
import { checkRelay, runMonitor } from "../scripts/monitor-relay.mjs";

async function pauseBackupAfterVacuum(t, { dbPath, backupDir, stamp }) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
import { DatabaseSync } from 'node:sqlite';
import { writeSync } from 'node:fs';
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  const result = exec.call(this, sql);
  if (sql.startsWith('VACUUM INTO ')) {
    writeSync(1, 'vacuum complete');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return result;
};
const { backupDatabase } = await import(process.argv[1]);
await backupDatabase({ dbPath: process.argv[2], backupDir: process.argv[3], clock: () => new Date(process.argv[4]) });
`, new URL("../scripts/backup-db.mjs", import.meta.url).href, dbPath, backupDir, stamp], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  const [ready] = await Promise.race([
    once(child.stdout, "data", { signal: AbortSignal.timeout(2000) }),
    exited.then(([code, signal]) => { throw new Error(`backup exited before VACUUM completed: ${code ?? signal}\n${stderr}`); })
  ]);
  assert.equal(ready.toString(), "vacuum complete");
  return { child, exited };
}

test("backs up SQLite data, checks integrity, and prunes old backups", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-backup-"));
  const dbPath = path.join(root, "agent-relay.db");
  const backupDir = path.join(root, "backups");
  const store = new Store(dbPath);
  store.registerAgent({ id: "probe@test", hostId: "test", capabilities: ["network.probe"] });
  store.close();

  const first = await backupDatabase({ dbPath, backupDir, retention: 2, clock: () => new Date("2026-10-17T12:00:00.000Z") });
  await chmod(first.path, 0o644);
  const second = await backupDatabase({ dbPath, backupDir, retention: 2, clock: () => new Date("2026-10-17T12:00:01.000Z") });
  assert.equal((await stat(first.path)).mode & 0o777, 0o600);
  const final = await backupDatabase({ dbPath, backupDir, retention: 1, clock: () => new Date("2026-10-17T12:00:02.000Z") });
  const files = await readdir(backupDir);

  assert.equal(first.integrity, "ok");
  assert.equal(second.integrity, "ok");
  assert.deepEqual(files.filter((name) => name.endsWith(".db")).length, 1);
  assert.equal(final.integrity, "ok");
  assert.ok((await stat(final.path)).size > 0);
  assert.equal((await stat(final.path)).mode & 0o777, 0o600);
  await rm(root, { recursive: true, force: true });
});

test("a backup rejects a missing source without creating an empty database", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-missing-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "missing.db");
  const backupDir = path.join(root, "backups");
  await assert.rejects(backupDatabase({ dbPath, backupDir }), /unable to open database/);
  await assert.rejects(access(dbPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(backupDir), []);
});

test("recovers a backup lock left by a dead process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-backup-lock-"));
  const dbPath = path.join(root, "agent-relay.db");
  const backupDir = path.join(root, "backups");
  const store = new Store(dbPath);
  store.close();
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, ".backup.lock"), "99999999\n");

  const result = await backupDatabase({ dbPath, backupDir, retention: 1, clock: () => new Date("2026-10-17T12:00:00.000Z") });
  assert.equal(result.integrity, "ok");
  await rm(root, { recursive: true, force: true });
});

test("a stale PID marker cannot block backups when its PID belongs to a live unrelated process", { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-backup-reused-pid-"));
  const dbPath = path.join(root, "relay.db");
  const backupDir = path.join(root, "backups");
  const store = new Store(dbPath);
  store.close();
  await mkdir(backupDir);
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000);"], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(root, { recursive: true, force: true });
  });
  await once(child.stdout, "data", { signal: AbortSignal.timeout(2000) });
  for (const stamp of ["2026-10-21T12:00:00.000Z", "2026-10-22T12:00:00.000Z"]) {
    await writeFile(path.join(backupDir, ".backup.lock"), `${child.pid}\n`, { mode: 0o600 });
    const result = await backupDatabase({ dbPath, backupDir, retention: 1, clock: () => new Date(stamp) });
    assert.equal(result.integrity, "ok");
    assert.ok((await stat(result.path)).size > 0);
  }
});

test("a backup cleans partial snapshots from repeated crashes and preserves unrelated files", { timeout: 10000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-backup-partials-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "relay.db");
  const backupDir = path.join(root, "backups");
  const source = new DatabaseSync(dbPath);
  source.exec("CREATE TABLE samples (payload BLOB); INSERT INTO samples VALUES (zeroblob(262144));");
  source.close();
  await chmod(dbPath, 0o600);
  const original = await readFile(dbPath);
  await mkdir(backupDir, { mode: 0o700 });
  const unrelated = ["notes.partial", "agent-relay-manual.db.partial", "agent-relay-123.db.partial", "agent-relay-20261019T120000000Z.db.partial.keep", "unrelated.db"];
  for (const name of unrelated) await writeFile(path.join(backupDir, name), name, { mode: 0o600 });
  const directory = "agent-relay-20261018T120000000Z.db.partial";
  await mkdir(path.join(backupDir, directory));

  for (const day of [20, 21]) {
    const { child, exited } = await pauseBackupAfterVacuum(t, { dbPath, backupDir, stamp: `2026-10-${day}T12:00:00.000Z` });
    const partialPath = path.join(backupDir, `agent-relay-202610${day}T120000000Z.db.partial`);
    assert.ok((await stat(partialPath)).size >= 262144);
    assert.equal((await stat(partialPath)).mode & 0o777, 0o600);
    child.kill("SIGKILL");
    await exited;
  }

  const result = await backupDatabase({ dbPath, backupDir, retention: 1, clock: () => new Date("2026-10-22T12:00:00.000Z") });
  const files = await readdir(backupDir);
  assert.deepEqual(files.filter((name) => name.endsWith(".db.partial")), ["agent-relay-123.db.partial", directory, "agent-relay-manual.db.partial"]);
  assert.deepEqual(files.filter((name) => /^agent-relay-[0-9TZ]+\.db$/.test(name)), [path.basename(result.path)]);
  for (const name of unrelated) assert.equal(await readFile(path.join(backupDir, name), "utf8"), name);
  assert.ok((await stat(path.join(backupDir, directory))).isDirectory());
  assert.deepEqual(await readFile(dbPath), original);
  assert.equal(result.integrity, "ok");
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(backupDir, ".backup-lock.sqlite"))).mode & 0o777, 0o600);
  assert.equal((await stat(backupDir)).mode & 0o777, 0o700);
});

test("retention preserves the fresh backup when the clock moves backward", async (t) => {
  for (const retention of [1, 2]) await t.test(`retention ${retention}`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-backup-rollback-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = path.join(root, "relay.db");
    const backupDir = path.join(root, "backups");
    const store = new Store(dbPath);
    t.after(() => store.close());
    store.registerAgent({ id: "before@test", hostId: "test", capabilities: [] });
    const oldest = await backupDatabase({ dbPath, backupDir, retention: 3, clock: () => new Date("2026-10-20T12:00:00.000Z") });
    const future = await backupDatabase({ dbPath, backupDir, retention: 3, clock: () => new Date("2026-10-23T12:00:00.000Z") });
    store.registerAgent({ id: "fresh@test", hostId: "test", capabilities: [] });
    const result = await backupDatabase({ dbPath, backupDir, retention, clock: () => new Date("2026-10-22T12:00:00.000Z") });

    assert.equal(result.integrity, "ok");
    assert.ok((await stat(result.path)).size > 0);
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    const snapshot = new DatabaseSync(result.path, { readOnly: true });
    try {
      assert.deepEqual(snapshot.prepare("SELECT id FROM agents ORDER BY id").all().map(({ id }) => id), ["before@test", "fresh@test"]);
    } finally { snapshot.close(); }
    const expected = retention === 1 ? [path.basename(result.path)] : [path.basename(result.path), path.basename(future.path)];
    assert.deepEqual((await readdir(backupDir)).filter((name) => name.endsWith(".db")).sort(), expected.sort());
    assert.ok(result.removed.includes(path.basename(oldest.path)));
    assert.ok(!result.removed.includes(path.basename(result.path)));
    assert.equal(result.retained, retention);
  });
});

test("partial cleanup preserves the source database through file aliases", async (t) => {
  for (const kind of ["direct", "symlink", "hard link"]) await t.test(kind, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-backup-source-alias-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const backupDir = path.join(root, "backups");
    await mkdir(backupDir);
    const actual = path.join(backupDir, "agent-relay-20261020T120000000Z.db.partial");
    const database = new DatabaseSync(actual);
    database.exec("CREATE TABLE samples(value); INSERT INTO samples VALUES (42)");
    database.close();
    const original = await readFile(actual);
    const dbPath = kind === "direct" ? actual : path.join(root, "source.db");
    if (kind === "symlink") await symlink(actual, dbPath);
    if (kind === "hard link") await link(actual, dbPath);
    const result = await backupDatabase({ dbPath, backupDir, clock: () => new Date("2026-10-23T12:00:00.000Z") });
    assert.deepEqual(await readFile(actual), original);
    assert.deepEqual(await readFile(dbPath), original);
    const snapshot = new DatabaseSync(result.path, { readOnly: true });
    try { assert.equal(snapshot.prepare("SELECT value FROM samples").get().value, 42); }
    finally { snapshot.close(); }
  });
});

test("retention preserves backup-shaped source databases through aliases", async (t) => {
  for (const kind of ["direct", "symlink", "hard link"]) await t.test(kind, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-backup-source-retention-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const backupDir = path.join(root, "backups");
    await mkdir(backupDir);
    const actual = path.join(backupDir, "agent-relay-20261020T120000000Z.db");
    const database = new DatabaseSync(actual);
    database.exec("CREATE TABLE samples(value); INSERT INTO samples VALUES (42)");
    database.close();
    const original = await readFile(actual);
    const dbPath = kind === "direct" ? actual : path.join(root, "source.db");
    if (kind === "symlink") await symlink(actual, dbPath);
    if (kind === "hard link") await link(actual, dbPath);
    const result = await backupDatabase({ dbPath, backupDir, retention: 1, clock: () => new Date("2026-10-23T12:00:00.000Z") });
    assert.deepEqual(await readFile(actual), original);
    assert.deepEqual(await readFile(dbPath), original);
    assert.ok(!result.removed.includes(path.basename(actual)));
    assert.deepEqual((await readdir(backupDir)).filter((name) => name.endsWith(".db")).sort(), [path.basename(actual), path.basename(result.path)].sort());
  });
});

test("a backup destination cannot replace the source database", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-backup-source-collision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "agent-relay-20261023T120000000Z.db");
  const database = new DatabaseSync(dbPath);
  database.exec("CREATE TABLE samples(value); INSERT INTO samples VALUES (42)");
  database.close();
  const original = await readFile(dbPath);
  const identity = await stat(dbPath);
  await assert.rejects(backupDatabase({ dbPath, backupDir: root, clock: () => new Date("2026-10-23T12:00:00.000Z") }), /destination.*source/);
  assert.deepEqual(await readFile(dbPath), original);
  assert.equal((await stat(dbPath)).ino, identity.ino);
});

test("monitor checks relay health and the expected online capability", async () => {
  const responses = {
    "/healthz": { ok: true, service: "agent-relay" },
    "/readyz": { ok: true, service: "agent-relay" },
    "/v1/agents": { agents: [{ id: "probe@test", status: "online", capabilities: ["network.probe"] }] }
  };
  const result = await checkRelay({
    baseUrl: "http://relay",
    expectedAgentId: "probe@test",
    fetchImpl: async (url) => ({ ok: true, status: 200, async json() { return responses[new URL(url).pathname]; } })
  });
  assert.equal(result.ok, true);
  assert.equal(result.agent.id, "probe@test");
});

test("monitor rejects a false health result even when the worker is online", async () => {
  for (const route of ["/healthz", "/readyz"]) {
    await assert.rejects(checkRelay({
      baseUrl: "http://relay", expectedAgentId: "probe@test",
      fetchImpl: async (url) => ({ ok: true, status: 200, json: async () => {
        if (new URL(url).pathname === "/v1/agents") return { agents: [{ id: "probe@test", status: "online", capabilities: ["network.probe"] }] };
        return { ok: new URL(url).pathname !== route, service: "agent-relay" };
      } })
    }), /health|readiness/);
  }
});

test("backup locks exclude concurrent processes and release after a crash", { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-backup-mutex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "relay.db");
  const backupDir = path.join(root, "backups");
  const store = new Store(dbPath);
  store.close();
  const { child, exited } = await pauseBackupAfterVacuum(t, { dbPath, backupDir, stamp: "2026-10-21T12:00:00.000Z" });
  const partialPath = path.join(backupDir, "agent-relay-20261021T120000000Z.db.partial");
  const partial = await readFile(partialPath);
  await rm(path.join(backupDir, ".backup.lock"), { force: true });
  await assert.rejects(backupDatabase({ dbPath, backupDir, clock: () => new Date("2026-10-22T12:00:00.000Z") }), /backup is already running/);
  assert.deepEqual(await readFile(partialPath), partial);
  assert.deepEqual((await readdir(backupDir)).filter((name) => name.endsWith(".partial")), [path.basename(partialPath)]);
  child.kill("SIGKILL");
  await exited;
  assert.equal((await backupDatabase({ dbPath, backupDir })).integrity, "ok");
});

test("monitor can authenticate with the rendered token environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-monitor-"));
  const requests = [];
  const responses = {
    "/healthz": { ok: true, service: "agent-relay" },
    "/readyz": { ok: true, service: "agent-relay" },
    "/v1/agents": { agents: [{ id: "probe@test", status: "online", capabilities: ["network.probe"] }] }
  };
  const result = await runMonitor({
    baseUrl: "http://selected-relay:8788",
    token: "secret",
    tokenFile: path.join(root, "missing.token"),
    logFile: path.join(root, "logs", "monitor.log"),
    stateFile: path.join(root, "monitor-state.json"),
    expectedAgentId: "probe@test",
    expectedCapability: "network.probe",
    fetchImpl: async (url, options) => {
      requests.push({ url, authorization: options.headers.authorization });
      return { ok: true, status: 200, async json() { return responses[new URL(url).pathname]; } };
    }
  });
  assert.equal(result.ok, true);
  assert.ok(requests.every(({ url }) => url.startsWith("http://selected-relay:8788/")));
  assert.deepEqual(new Set(requests.map(({ authorization }) => authorization)), new Set(["Bearer secret"]));
  await rm(root, { recursive: true, force: true });
});

test("monitor aborts remaining requests after a failed check", async () => {
  let aborted = 0;
  await assert.rejects(checkRelay({
    fetchImpl: async (url, { signal }) => {
      if (new URL(url).pathname === "/healthz") return { ok: false, status: 503, json: async () => ({ error: "unavailable" }) };
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => {
        aborted += 1;
        reject(signal.reason);
      }, { once: true }));
    }
  }), /unavailable/);
  assert.equal(aborted, 2);
});

test("failed jobs retry up to max attempts, then become failed", () => {
  const store = new Store(":memory:");
  const job = store.createJob({
    kind: "agent.task",
    requiredCapability: "agent.task",
    maxAttempts: 2,
    requestedBy: "service-monitor",
    targetAgent: "codex@test",
    payload: { prompt: "fail twice" }
  });

  const first = store.claimJob(job.id, "codex@test");
  assert.equal(first.attempts, 1);
  assert.equal(store.failJobBy(job.id, "first failure", "codex@test", first.claim_token).status, "queued");
  assert.equal(store.getPendingWork("codex@test").jobs[0].id, job.id);
  const second = store.claimJob(job.id, "codex@test");
  assert.equal(second.attempts, 2);
  const failed = store.failJobBy(job.id, "second failure", "codex@test", second.claim_token);

  assert.equal(failed.status, "failed");
  assert.equal(failed.attempts, 2);
  assert.equal(failed.max_attempts, 2);
  assert.equal(failed.error, "second failure");
  store.close();
});

test("requeues a running job when its worker goes offline", () => {
  const store = new Store(":memory:");
  store.registerAgent({ id: "probe@test", hostId: "test", capabilities: ["network.probe"] });
  const job = store.createJob({
    kind: "network.probe",
    requiredCapability: "network.probe",
    requestedBy: "service-monitor",
    targetAgent: "probe@test",
    payload: { checks: [] }
  });
  store.claimJob(job.id, "probe@test");
  store.db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", "probe@test");
  store.markStale();

  const [requeued] = store.requeueStaleJobs();
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.claimed_by, null);
  assert.match(requeued.error, /went offline/);

  const terminalJob = store.createJob({
    kind: "network.probe",
    requiredCapability: "network.probe",
    maxAttempts: 1,
    requestedBy: "service-monitor",
    targetAgent: "probe@test",
    payload: { checks: [] }
  });
  store.claimJob(terminalJob.id, "probe@test");
  const [failed] = store.requeueStaleJobs();
  assert.equal(failed.status, "failed");
  assert.ok(failed.completed_at);
  assert.equal(failed.claimed_by, null);
  store.close();
});
