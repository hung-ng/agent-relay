import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { backupDatabase } from "../scripts/backup-db.mjs";
import { checkRelay, runMonitor } from "../scripts/monitor-relay.mjs";

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
  const dbPath = path.join(root, "relay.db");
  const backupDir = path.join(root, "backups");
  const store = new Store(dbPath);
  store.close();
  await mkdir(backupDir);
  const lockPath = path.join(backupDir, ".backup-lock.sqlite");
  const lock = new DatabaseSync(lockPath);
  lock.close();
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
import { DatabaseSync } from 'node:sqlite';
const lock = new DatabaseSync(process.argv[1]);
lock.exec('BEGIN EXCLUSIVE');
process.stdout.write('locked');
setInterval(() => {}, 1000);`, lockPath], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await rm(root, { recursive: true, force: true });
  });
  await once(child.stdout, "data", { signal: AbortSignal.timeout(2000) });
  await assert.rejects(backupDatabase({ dbPath, backupDir }), /backup is already running/);
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
