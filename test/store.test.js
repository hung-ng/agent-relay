import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

test("registers agents and selects an online host capability", () => {
  const store = new Store(":memory:");
  store.registerAgent({ id: "probe@macbook", hostId: "macbook", kind: "probe", capabilities: ["network.probe"] });
  store.registerAgent({ id: "claude@macbook", hostId: "macbook", kind: "claude", capabilities: ["agent.task"] });

  assert.equal(store.findAgentForHost("macbook", "network.probe").id, "probe@macbook");
  assert.equal(store.listAgents().length, 2);
  store.close();
});

test("persists messages and job lifecycle", () => {
  const store = new Store(":memory:");
  store.registerAgent({ id: "codex@mini", hostId: "mini", kind: "codex" });
  const message = store.createMessage({ sender: "claude@book", recipient: "codex@mini", payload: { body: "hello" } });
  assert.equal(store.getMessages("codex@mini")[0].id, message.id);
  store.markMessageDelivered(message.id);
  assert.equal(store.getPendingWork("codex@mini").messages[0].id, message.id);
  store.acknowledgeMessage(message.id);
  assert.equal(store.markMessageDelivered(message.id).status, "acknowledged");

  const job = store.createJob({ kind: "network.probe", requestedBy: "claude@book", targetAgent: "codex@mini", payload: { checks: [] } });
  assert.equal(store.claimJob(job.id, "codex@mini").status, "running");
  assert.equal(store.claimJob(job.id, "codex@mini").status, "running");
  assert.equal(store.getPendingWork("codex@mini").jobs[0].id, job.id);
  assert.equal(store.completeJob(job.id, { ok: true }).status, "completed");
  assert.deepEqual(store.getJob(job.id).result, { ok: true });
  store.close();
});

test("reuses caller supplied IDs for safe retries", () => {
  const store = new Store(":memory:");
  const message = store.createMessage({
    id: "message-retry",
    sender: "claude@book",
    recipient: "codex@mini",
    payload: { body: "hello" }
  });
  const repeatedMessage = store.createMessage({
    id: "message-retry",
    sender: "different-sender",
    recipient: "different-recipient",
    payload: { body: "different" }
  });
  assert.deepEqual(repeatedMessage, message);

  const job = store.createJob({
    id: "job-retry",
    kind: "agent.task",
    requestedBy: "service-monitor",
    targetAgent: "codex@mini",
    payload: { prompt: "inspect" }
  });
  const repeatedJob = store.createJob({
    id: "job-retry",
    kind: "network.probe",
    requestedBy: "different-requester",
    targetAgent: "probe@mini",
    payload: { checks: [] }
  });
  assert.deepEqual(repeatedJob, job);
  store.close();
});

test("an expired job attempt cannot finish or fail a newer attempt", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.registerAgent({ id: "worker", hostId: "host" });
  const job = store.createJob({ kind: "agent.task", requestedBy: "operator", targetAgent: "worker" });
  const first = store.claimJob(job.id, "worker");
  store.db.prepare("UPDATE agents SET status = 'offline' WHERE id = ?").run("worker");
  store.requeueStaleJobs();
  const second = store.claimJob(job.id, "worker");

  assert.ok(first.claim_token);
  assert.notEqual(second.claim_token, first.claim_token);
  assert.equal(store.completeJobBy(job.id, { stale: true }, "worker", first.claim_token), null);
  assert.equal(store.failJobBy(job.id, "stale error", "worker", first.claim_token), null);
  assert.equal(store.completeJobBy(job.id, {}, "worker"), null);
  assert.equal(store.getJob(job.id).status, "running");
  assert.equal(store.completeJobBy(job.id, { fresh: true }, "worker", second.claim_token).status, "completed");
});

test("fractional and non-finite inbox limits cannot break SQLite reads", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.createMessage({ sender: "operator", recipient: "worker", payload: {} });
  for (const limit of ["1.5", "Infinity", "NaN", -1, 0, 500]) {
    assert.equal(store.getMessages("worker", limit).length, 1);
    assert.equal(store.getPendingWork("worker", limit).messages.length, 1);
  }
});

test("opening an older database migrates claims without losing a running job", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "relay.db");
  const original = new Store(filename);
  const created = original.createJob({ kind: "agent.task", requestedBy: "operator", targetAgent: "worker", payload: { prompt: "inspect" } });
  original.claimJob(created.id, "worker", { withToken: false });
  original.db.exec("ALTER TABLE jobs DROP COLUMN claim_token");
  original.close();
  const migrated = new Store(filename);
  t.after(() => migrated.close());
  assert.equal(migrated.getJob(created.id).status, "running");
  assert.equal(migrated.getJob(created.id).claim_token, null);
  assert.equal(migrated.completeJobBy(created.id, { ok: true }, "worker").status, "completed");
});

test("claim checks remain atomic when another database connection retries a job", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-claim-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "relay.db");
  const first = new Store(filename);
  const second = new Store(filename);
  t.after(() => { first.close(); second.close(); });
  const created = first.createJob({ kind: "agent.task", requestedBy: "operator", targetAgent: "worker" });
  const oldClaim = first.claimJob(created.id, "worker");
  const getJob = first.getJob.bind(first);
  let raced = false;
  first.getJob = (id) => {
    const snapshot = getJob(id);
    if (!raced) {
      raced = true;
      second.failJobBy(id, "retry", "worker", oldClaim.claim_token);
      second.claimJob(id, "worker");
    }
    return snapshot;
  };
  assert.equal(first.completeJobBy(created.id, { stale: true }, "worker", oldClaim.claim_token), null);
  const current = second.getJob(created.id);
  assert.equal(current.status, "running");
  assert.equal(current.attempts, 2);
  assert.equal(current.result, null);
});
