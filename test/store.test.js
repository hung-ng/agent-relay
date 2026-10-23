import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { Worker } from "../src/worker.js";

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

function invalidIdentifier(operation, field) {
  assert.throws(operation, (error) => {
    assert.equal(error.status, 400);
    assert.match(error.message, new RegExp(field));
    assert.ok(!error.message.includes("private-value"));
    return true;
  });
}

test("record IDs reject SQLite corruption, dot segments, and oversized worker URLs", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  for (const id of ["private-value\0id", "private-value\ud800", "private-value\udfff", ".", " .. ", "x".repeat(20_000), "雪".repeat(2000)]) {
    invalidIdentifier(() => store.createMessage({ id, sender: "operator", recipient: "worker" }), "message id");
    invalidIdentifier(() => store.createJob({ id, kind: "agent.task", requestedBy: "operator" }), "job id");
  }
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM messages").get().count, 0);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM jobs").get().count, 0);
});

test("agent identities and references must survive X-Agent-ID without changes", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  for (const id of ["private-value\0", "private-value\ud800", "雪worker", "bad\nworker", " worker ", "worker\t", "bad\x7fworker", ".", "..", "x".repeat(4097)]) {
    invalidIdentifier(() => store.registerAgent({ id, hostId: "host" }), "agent id");
    invalidIdentifier(() => store.createMessage({ sender: id, recipient: "worker" }), "sender");
    invalidIdentifier(() => store.createMessage({ sender: "operator", recipient: id }), "recipient");
    invalidIdentifier(() => store.createJob({ kind: "agent.task", requestedBy: id }), "requested_by");
    invalidIdentifier(() => store.createJob({ kind: "agent.task", requestedBy: "operator", targetAgent: id }), "target_agent");
  }
  assert.equal(store.registerAgent({ id: "café", hostId: "雪host😀" }).id, "café");
  const message = store.createMessage({ sender: "café", recipient: "café" });
  assert.equal(store.acknowledgeMessageBy(message.id, "café").status, "acknowledged");
});

test("host and conversation identifiers reject corruption without restricting payload text", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  for (const id of ["private-value\0", "private-value\ud800", "private-value\udfff"]) {
    invalidIdentifier(() => store.registerAgent({ id: "worker", hostId: id }), "host_id");
    invalidIdentifier(() => store.findAgentForHost(id, "agent.task"), "host_id");
    invalidIdentifier(() => store.createMessage({ sender: "operator", recipient: "worker", conversationId: id }), "conversation_id");
    invalidIdentifier(() => store.createJob({ kind: "agent.task", requestedBy: "operator", sourceHost: id }), "source_host");
    invalidIdentifier(() => store.createJob({ kind: "agent.task", requestedBy: "operator", targetHost: id }), "target_host");
  }
  const text = "free text\0\ud800 text \udfff雪😀";
  const message = store.createMessage({ sender: "operator", recipient: "worker", conversationId: "雪😀", payload: { body: text } });
  assert.equal(message.conversation_id, "雪😀");
  assert.equal(message.payload.body, text);
  assert.equal(store.createMessage({ sender: "operator", recipient: "worker", conversationId: "" }).conversation_id, "");
  const job = store.createJob({ kind: "agent.task", requestedBy: "operator", targetAgent: "worker", payload: { prompt: text } });
  assert.equal(job.payload.prompt, text);
  store.claimJob(job.id, "worker");
  assert.equal(store.completeJob(job.id, { stdout: text }).result.stdout, text);
});

test("invalid selectors cannot acknowledge or claim a different identifier", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const message = store.createMessage({ id: "private-value�", sender: "operator", recipient: "worker" });
  const job = store.createJob({ id: message.id, kind: "agent.task", requestedBy: "operator", targetAgent: "worker" });
  for (const id of ["private-value\ud800", "private-value\udfff", "private-value\0"]) {
    for (const operation of [
      () => store.getMessage(id), () => store.markMessageDelivered(id), () => store.acknowledgeMessage(id),
      () => store.markMessageDeliveredBy(id, "worker"), () => store.acknowledgeMessageBy(id, "worker")
    ]) invalidIdentifier(operation, "message id");
    for (const operation of [
      () => store.getJob(id), () => store.claimJob(id, "worker"), () => store.cancelJob(id),
      () => store.completeJob(id, {}), () => store.failJob(id, "failed"),
      () => store.completeJobBy(id, {}, "worker"), () => store.failJobBy(id, "failed", "worker")
    ]) invalidIdentifier(operation, "job id");
  }
  for (const actor of ["private-value\ud800", "private-value\0", " worker "]) {
    invalidIdentifier(() => store.acknowledgeMessageBy(message.id, actor), "agent id");
    invalidIdentifier(() => store.markMessageDeliveredBy(message.id, actor), "agent id");
    invalidIdentifier(() => store.claimJob(job.id, actor), "agent id");
    invalidIdentifier(() => store.completeJobBy(job.id, {}, actor), "agent id");
    invalidIdentifier(() => store.failJobBy(job.id, "failed", actor), "agent id");
    invalidIdentifier(() => store.getPendingWork(actor), "agent id");
    invalidIdentifier(() => store.getMessages(actor), "recipient");
    invalidIdentifier(() => store.getPendingMessages(actor), "recipient");
    invalidIdentifier(() => store.heartbeat(actor), "agent id");
    invalidIdentifier(() => store.getAgent(actor), "agent id");
  }
  assert.equal(store.getMessage(message.id).status, "queued");
  assert.equal(store.getJob(job.id).status, "queued");
  assert.equal(store.getMessage(` ${message.id} `), null);
  assert.equal(store.claimJob(` ${job.id} `, "worker"), null);
});

test("record IDs retain trim, slash, colon, emoji, and reply budgets", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  for (const id of ["  a:b/c😀  ", "x".repeat(4096), "雪".repeat(455) + "x", "😀".repeat(341) + "abcd"]) {
    assert.ok(encodeURIComponent(id.trim()).length <= 4096);
    const message = store.createMessage({ id, sender: "operator", recipient: "worker" });
    assert.equal(message.id, id.trim());
    const reply = store.createMessage({ id: `reply:${message.id}`, type: "reply", sender: "worker", recipient: "operator" });
    assert.equal(reply.id, `reply:${message.id}`);
    const job = store.createJob({ id, kind: "agent.task", requestedBy: "operator", targetAgent: "worker" });
    assert.equal(store.claimJob(job.id, "worker").id, id.trim());
  }
  invalidIdentifier(() => store.createMessage({ id: "x".repeat(4097), sender: "operator", recipient: "worker" }), "message id");
  invalidIdentifier(() => store.createMessage({ id: "x".repeat(4105), type: "reply", sender: "worker", recipient: "operator" }), "message id");
  assert.equal(store.createMessage({ id: "x".repeat(4104), type: "reply", sender: "worker", recipient: "operator" }).id.length, 4104);
  assert.equal(store.createMessage({ id: 123, sender: "operator", recipient: "worker" }).id, "123");
});

test("same-ID replays return the original before validating unused fields", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const message = store.createMessage({ id: "reply:" + "x".repeat(4096), sender: "worker", recipient: "operator", type: "reply" });
  const circular = {};
  circular.self = circular;
  assert.deepEqual(store.createMessage({ id: ` ${message.id} `, sender: "雪", recipient: " worker ", conversationId: "private-value\0", type: "request", payload: circular }), message);
  const job = store.createJob({ id: "job", kind: "agent.task", requestedBy: "operator" });
  assert.deepEqual(store.createJob({ id: " job ", kind: "other", requestedBy: "雪", targetAgent: " worker ", sourceHost: "private-value\0", payload: circular }), job);
});

test("legacy invalid rows do not prevent reopening or stale job recovery", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-relay-legacy-identifiers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "relay.db");
  const original = new Store(filename);
  original.registerAgent({ id: "worker", hostId: "host" });
  const legacy = original.createJob({ id: "legacy", kind: "agent.task", requestedBy: "operator", targetAgent: "worker" });
  original.claimJob(legacy.id, "worker");
  original.db.prepare("UPDATE jobs SET id = ? WHERE id = ?").run("legacy\0row", legacy.id);
  original.createJob({ id: "legacy", kind: "agent.task", requestedBy: "operator", targetAgent: "worker" });
  original.createJob({ id: "ordinary", kind: "agent.task", requestedBy: "operator", targetAgent: "worker" });
  original.claimJob("ordinary", "worker");
  original.db.exec("UPDATE agents SET status = 'offline'");
  original.close();
  const reopened = new Store(filename);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.requeueStaleJobs().map(job => job.id), ["ordinary"]);
  assert.equal(reopened.getJob("legacy").status, "queued");
  assert.equal(reopened.db.prepare("SELECT status FROM jobs WHERE id = ?").get("legacy\0row").status, "queued");
});

test("stale legacy IDs cannot notify a different running job", async (t) => {
  for (const [name, storedId, validId] of [
    ["NUL truncation", Buffer.from("shared\0legacy"), "shared"],
    ["invalid UTF-8 replacement", Buffer.from([0x73, 0x68, 0x61, 0x72, 0x65, 0x64, 0x80]), "shared�"]
  ]) await t.test(name, (t) => {
    const store = new Store(":memory:");
    t.after(() => store.close());
    for (const id of ["old-worker", "worker"]) store.registerAgent({ id, hostId: "host" });
    const legacy = store.createJob({ id: "legacy", kind: "agent.task", requestedBy: "worker", targetAgent: "old-worker", maxAttempts: 1 });
    store.claimJob(legacy.id, "old-worker");
    store.db.prepare("UPDATE jobs SET id = CAST(? AS TEXT) WHERE id = ?").run(storedId, legacy.id);
    store.createJob({ id: validId, kind: "agent.task", requestedBy: "operator", targetAgent: "worker" });
    const claimed = store.claimJob(validId, "worker");
    const worker = new Worker({ serverUrl: "http://unused", agentId: "worker", hostId: "host" });
    const controller = new AbortController();
    const outcome = { claimToken: claimed.claim_token, attempts: claimed.attempts, result: { ok: true } };
    worker.jobControllers.set(validId, { controller, claimToken: claimed.claim_token, attempts: claimed.attempts });
    worker.jobOutcomes.set(validId, outcome);
    store.db.prepare("UPDATE agents SET status = 'offline' WHERE id = ?").run("old-worker");

    const notifications = store.requeueStaleJobs();
    for (const job of notifications) worker.handleEvent({ event: `job.${job.status}`, data: job });

    assert.equal(controller.signal.aborted, false);
    assert.equal(worker.jobOutcomes.get(validId), outcome);
    assert.deepEqual(notifications, []);
    assert.equal(store.getJob(validId).status, "running");
    assert.equal(store.db.prepare("SELECT status FROM jobs WHERE CAST(id AS BLOB) = ?").get(storedId).status, "failed");
  });
});
