import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { backupDatabase } from "../scripts/backup-db.mjs";
import { checkRelay, runMonitor } from "../scripts/monitor-relay.mjs";

test("backs up SQLite data, checks integrity, and prunes old backups", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-backup-"));
  const dbPath = path.join(root, "agent-relay.db");
  const backupDir = path.join(root, "backups");
  const store = new Store(dbPath);
  store.registerAgent({ id: "probe@test", hostId: "test", capabilities: ["network.probe"] });
  store.close();

  const first = await backupDatabase({ dbPath, backupDir, retention: 1, clock: () => new Date("2026-10-17T12:00:00.000Z") });
  const second = await backupDatabase({ dbPath, backupDir, retention: 1, clock: () => new Date("2026-10-17T12:00:01.000Z") });
  const files = await readdir(backupDir);

  assert.equal(first.integrity, "ok");
  assert.equal(second.integrity, "ok");
  assert.deepEqual(files.filter((name) => name.endsWith(".db")).length, 1);
  assert.ok((await stat(second.path)).size > 0);
  await rm(root, { recursive: true, force: true });
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

test("monitor can authenticate with the rendered token environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-monitor-"));
  const requests = [];
  const responses = {
    "/healthz": { ok: true, service: "agent-relay" },
    "/readyz": { ok: true, service: "agent-relay" },
    "/v1/agents": { agents: [{ id: "probe@test", status: "online", capabilities: ["network.probe"] }] }
  };
  const result = await runMonitor({
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
  assert.deepEqual(new Set(requests.map(({ authorization }) => authorization)), new Set(["Bearer secret"]));
  await rm(root, { recursive: true, force: true });
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

  assert.equal(store.claimJob(job.id, "codex@test").attempts, 1);
  assert.equal(store.failJobBy(job.id, "first failure", "codex@test").status, "queued");
  assert.equal(store.getPendingWork("codex@test").jobs[0].id, job.id);
  assert.equal(store.claimJob(job.id, "codex@test").attempts, 2);
  const failed = store.failJobBy(job.id, "second failure", "codex@test");

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
