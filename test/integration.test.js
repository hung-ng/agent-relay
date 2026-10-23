import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "../src/server.js";
import { Worker, runProcess } from "../src/worker.js";
import { requestJson } from "../src/http.js";

async function startRelay(t, { worker: startWorker = true } = {}) {
  const app = createServer({ dbPath: ":memory:", token: "integration-token" });
  const errors = [];
  let worker;
  t.after(async () => {
    await worker?.stop();
    app.close();
    app.server.closeAllConnections();
  });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const serverUrl = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, options = {}) => requestJson(`${serverUrl}${route}`, {
    ...options,
    headers: { authorization: "Bearer integration-token", ...options.headers }
  });
  if (startWorker) {
    worker = new Worker({
      serverUrl, agentId: "worker", hostId: "host", kind: "codex", capabilities: ["agent.task"],
      token: "integration-token", logger: { log() {}, error: (error) => errors.push(error) }
    });
  }
  const dispatch = (prompt, extra = {}) => request("/v1/jobs", {
    method: "POST",
    body: { kind: "agent.task", requested_by: "operator", target_agent: "worker", payload: { prompt }, ...extra }
  });
  return { app, worker, errors, serverUrl, request, dispatch };
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await delay(10);
  }
}

test("HTTP workers retry, cancel a running task, and continue queued work serially", { timeout: 10_000 }, async (t) => {
  const { app, worker, dispatch, request, errors } = await startRelay(t);
  let failures = 0;
  let active = 0;
  let maxActive = 0;
  let cancelled = false;
  worker.runAgentTask = async ({ prompt }, { signal }) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (prompt === "retry" && failures++ < 2) throw new Error("transient failure");
      if (prompt === "slow") {
        try { await delay(20_000, null, { signal }); }
        finally { cancelled = signal.aborted; }
      }
      return { stdout: prompt };
    } finally { active -= 1; }
  };
  await worker.start();
  const { job: retry } = await dispatch("retry");
  await waitUntil(() => app.store.getJob(retry.id).status === "completed");
  assert.equal(app.store.getJob(retry.id).attempts, 3);

  const { job: slow } = await dispatch("slow");
  await waitUntil(() => active === 1);
  const { job: next } = await dispatch("next");
  const cancellation = await request(`/v1/jobs/${slow.id}/cancel`, {
    method: "POST", headers: { "x-agent-id": "operator" }, body: {}
  });
  assert.equal(cancellation.job.status, "cancelled");
  await waitUntil(() => app.store.getJob(next.id).status === "completed");
  assert.equal(cancelled, true);
  assert.equal(maxActive, 1);
  assert.equal(app.store.getJob(slow.id).status, "cancelled");
  assert.deepEqual(errors, []);
});

test("heartbeat restores registration and drains work beyond a pending batch", { timeout: 10_000 }, async (t) => {
  const { app, worker, errors } = await startRelay(t);
  const jobs = Array.from({ length: 205 }, () => app.store.createJob({
    kind: "agent.task", requestedBy: "operator", targetAgent: "worker", requiredCapability: "agent.task", payload: { prompt: "backlog" }
  }));
  worker.runAgentTask = async () => ({ stdout: "done" });
  await worker.start();
  await waitUntil(() => jobs.slice(0, 200).every((job) => app.store.getJob(job.id).status === "completed"));
  app.store.db.exec("DELETE FROM agents");
  await worker.heartbeat();
  assert.equal(app.store.getAgent("worker").status, "online");
  await waitUntil(() => jobs.every((job) => app.store.getJob(job.id).status === "completed"));
  assert.ok(jobs.every((job) => app.store.getJob(job.id).attempts === 1));
  assert.deepEqual(errors, []);
});

test("heartbeat recovers cached replies after ambiguous acknowledgements", { timeout: 10_000 }, async (t) => {
  for (const committed of [false, true]) {
    await t.test(committed ? "response lost after commit" : "request lost before commit", async (t) => {
      const { app, worker, request } = await startRelay(t);
      let executions = 0;
      worker.runAgentTask = async () => ({ stdout: `answer ${++executions}` });
      await worker.register();
      const { message } = await request("/v1/messages", {
        method: "POST",
        body: { sender: "operator", recipient: "worker", type: "request", payload: { body: "work" } }
      });
      const realRequest = worker.request.bind(worker);
      let loseAcknowledgement = true;
      worker.request = async (route, options) => {
        if (route.endsWith("/ack") && loseAcknowledgement) {
          loseAcknowledgement = false;
          if (committed) await realRequest(route, options);
          throw new Error("acknowledgement response lost");
        }
        return realRequest(route, options);
      };
      await assert.rejects(worker.handleMessage(message), /acknowledgement response lost/);
      assert.equal(worker.messageReplies.size, 1);
      assert.equal(app.store.getMessage(message.id).status, committed ? "acknowledged" : "delivered");
      if (committed) assert.deepEqual(app.store.getPendingWork("worker").messages, []);

      await worker.heartbeat();
      await worker.drainPromise;

      assert.equal(worker.messageReplies.size, 0);
      assert.equal(executions, 1);
      assert.equal(app.store.getMessage(message.id).status, "acknowledged");
      assert.deepEqual(app.store.getMessages("operator").map((reply) => reply.payload), [{
        body: "answer 1", result: { stdout: "answer 1" }
      }]);
    });
  }
});

test("the CLI reuses --id after its worker goes offline and preserves the prompt", { timeout: 10_000 }, async (t) => {
  const { app, serverUrl } = await startRelay(t, { worker: false });
  app.store.registerAgent({ id: "worker", hostId: "host", kind: "codex", capabilities: ["agent.task"] });
  const args = ["src/cli.js", "task", "--server", serverUrl, "--target-agent", "worker", "--id", "stable-id", "--prompt=check x=y=z", "--wait-ms", "0"];
  const options = { timeoutMs: 5000, env: { ...process.env, AGENT_RELAY_TOKEN: "integration-token" } };
  const first = JSON.parse((await runProcess(process.execPath, args, options)).stdout);
  app.store.db.exec("UPDATE agents SET status = 'offline', capabilities = '[]'");
  const repeated = JSON.parse((await runProcess(process.execPath, args, options)).stdout);
  assert.equal(first.id, "stable-id");
  assert.equal(first.payload.prompt, "check x=y=z");
  assert.deepEqual(repeated, first);
  assert.equal(app.store.db.prepare("SELECT count(*) AS count FROM jobs").get().count, 1);
  const smoke = await runProcess(process.execPath, ["scripts/smoke.mjs"], {
    ...options, env: { ...options.env, AGENT_RELAY_URL: serverUrl }
  });
  assert.match(smoke.stdout, /\/healthz:.*"ok":true/);
  assert.match(smoke.stdout, /\/readyz:.*"ok":true/);
  assert.match(smoke.stdout, /\/v1\/agents:/);
});

test("large escaped task output fits both job results and message replies", { timeout: 10_000 }, async (t) => {
  const { app, worker, dispatch, request, errors } = await startRelay(t);
  worker.runAgentTask = async () => runProcess(process.execPath, ["-e", `
process.stdout.write("\\u0001".repeat(128_000));
process.stderr.write("\\u0001".repeat(128_000));`], { timeoutMs: 3000 });
  await worker.start();
  const { job } = await dispatch("large output");
  await waitUntil(() => app.store.getJob(job.id).status === "completed");
  assert.equal(app.store.getJob(job.id).result.stdout_truncated, true);
  const { message } = await request("/v1/messages", {
    method: "POST", body: { sender: "operator", recipient: "worker", type: "request", payload: { body: "large output" } }
  });
  await waitUntil(() => app.store.getMessage(message.id).status === "acknowledged");
  const reply = app.store.getMessage(`reply:${message.id}`);
  assert.equal(reply.payload.result.stderr_truncated, true);
  assert.deepEqual(errors, []);
});

test("an undeliverable result fails once instead of keeping a job running forever", { timeout: 10_000 }, async (t) => {
  const { app, worker, dispatch, errors } = await startRelay(t);
  let executions = 0;
  worker.runAgentTask = async () => { executions += 1; return { stdout: "x".repeat(1_048_576) }; };
  await worker.start();
  const { job } = await dispatch("undeliverable");
  await waitUntil(() => app.store.getJob(job.id).status === "failed");
  const failed = app.store.getJob(job.id);
  assert.match(failed.error, /HTTP 413/);
  assert.equal(failed.attempts, 1);
  assert.equal(executions, 1);
  assert.deepEqual(errors, []);
});

test("an undeliverable reply reports the error and acknowledges the original message", { timeout: 10_000 }, async (t) => {
  const { app, worker, request, errors } = await startRelay(t);
  let executions = 0;
  worker.runAgentTask = async () => { executions += 1; return { stdout: "x".repeat(1_048_576) }; };
  await worker.start();
  const { message } = await request("/v1/messages", {
    method: "POST", body: { sender: "operator", recipient: "worker", type: "request", payload: { body: "undeliverable" } }
  });
  await waitUntil(() => app.store.getMessage(message.id).status === "acknowledged");
  assert.match(app.store.getMessage(`reply:${message.id}`).payload.error, /HTTP 413/);
  assert.equal(executions, 1);
  assert.deepEqual(errors, []);
});

test("a large probe completes all checks with a bounded deliverable report", { timeout: 10_000 }, async (t) => {
  const { app, worker, request, errors } = await startRelay(t);
  worker.kind = "probe";
  worker.capabilities = ["network.probe"];
  await worker.start();
  const { job } = await request("/v1/jobs", { method: "POST", body: {
    kind: "network.probe", requested_by: "operator", target_agent: "worker",
    payload: { checks: Array.from({ length: 15_000 }, () => ({})) }
  } });
  await waitUntil(() => app.store.getJob(job.id).status === "completed");
  const completed = app.store.getJob(job.id);
  assert.equal(completed.attempts, 1);
  assert.equal(completed.result.ok, false);
  assert.equal(completed.result.truncated, true);
  assert.equal(completed.result.completed_checks, 15_000);
  assert.equal(completed.result.omitted_checks, 15_000 - completed.result.checks.length);
  assert.ok(Buffer.byteLength(JSON.stringify(completed.result)) <= 524_288);
  assert.deepEqual(errors, []);
});
