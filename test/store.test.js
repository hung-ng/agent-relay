import test from "node:test";
import assert from "node:assert/strict";
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
