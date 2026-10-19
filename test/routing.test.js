import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";

function requestFor(method, url, body, headers = {}) {
  return {
    method,
    url,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    }
  };
}

function responseFor(resolve) {
  return {
    headers: {},
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = { ...this.headers, ...headers };
    },
    end(body = "") {
      this.body = body;
      resolve(this);
    }
  };
}

async function jsonRequest(app, method, url, body, headers) {
  const response = await new Promise((resolve) => {
    app.server.emit("request", requestFor(method, url, body, headers), responseFor(resolve));
  });
  const value = response.body ? JSON.parse(response.body) : null;
  return { response, value };
}

test("dispatch selects an agent with the requested capability", async (t) => {
  const app = createServer({ dbPath: ":memory:", token: "" });
  t.after(() => app.close());

  await jsonRequest(app, "POST", "/v1/agents/register", {
    id: "claude@mini",
    host_id: "mini",
    kind: "claude",
    capabilities: ["agent.task"]
  });
  await jsonRequest(app, "POST", "/v1/agents/register", {
    id: "probe@mini",
    host_id: "mini",
    kind: "probe",
    capabilities: ["network.probe"]
  });

  const { response, value } = await jsonRequest(app, "POST", "/v1/jobs", {
    kind: "agent.task",
    requested_by: "service-monitor",
    source_host: "mini",
    payload: { prompt: "check the service" }
  });

  assert.equal(response.status, 201);
  assert.equal(value.job.target_agent, "claude@mini");
  assert.equal(value.job.required_capability, "agent.task");

  const incompatibleTarget = await jsonRequest(app, "POST", "/v1/jobs", {
    kind: "network.probe",
    requested_by: "service-monitor",
    target_agent: "claude@mini",
    payload: { checks: [{ type: "dns", name: "localhost" }] }
  });
  assert.equal(incompatibleTarget.response.status, 409);

  const workflowOnClaude = await jsonRequest(app, "POST", "/v1/jobs", {
    kind: "agent.task",
    requested_by: "service-monitor",
    target_agent: "claude@mini",
    payload: { workflow: "review", execution_mode: "read_only", prompt: "inspect" }
  });
  assert.equal(workflowOnClaude.response.status, 409);

  await jsonRequest(app, "POST", "/v1/agents/register", {
    id: "codex@mini",
    host_id: "mini",
    kind: "codex",
    capabilities: ["agent.task"]
  });

  const writeWorkflow = await jsonRequest(app, "POST", "/v1/jobs", {
    kind: "agent.task",
    requested_by: "service-monitor",
    target_agent: "codex@mini",
    payload: { workflow: "implement", execution_mode: "write", prompt: "edit" }
  });
  assert.equal(writeWorkflow.response.status, 409);

  const bypassedWriteWorkflow = await jsonRequest(app, "POST", "/v1/jobs", {
    kind: "agent.task",
    capability: "agent.task",
    requested_by: "service-monitor",
    target_agent: "codex@mini",
    payload: { workflow: "implement", execution_mode: "write", prompt: "edit" }
  });
  assert.equal(bypassedWriteWorkflow.response.status, 409);
});

test("readiness reports the relay is available", async (t) => {
  const app = createServer({ dbPath: ":memory:", token: "" });
  t.after(() => app.close());

  const { response, value } = await jsonRequest(app, "GET", "/readyz");
  assert.equal(response.status, 200);
  assert.deepEqual(value, { ok: true, service: "agent-relay" });
});

test("worker actions require the matching authenticated agent", async (t) => {
  const app = createServer({ dbPath: ":memory:", token: "secret" });
  t.after(() => app.close());
  const auth = { authorization: "Bearer secret" };

  await jsonRequest(app, "POST", "/v1/agents/register", {
    id: "probe@mini",
    host_id: "mini",
    kind: "probe",
    capabilities: ["network.probe"]
  }, auth);
  const { value: createdMessage } = await jsonRequest(app, "POST", "/v1/messages", {
    sender: "claude@book",
    recipient: "probe@mini",
    payload: { body: "hello" }
  }, auth);

  const missingIdentity = await jsonRequest(
    app,
    "POST",
    `/v1/messages/${encodeURIComponent(createdMessage.message.id)}/deliver`,
    undefined,
    auth
  );
  assert.equal(missingIdentity.response.status, 401);

  const wrongIdentity = await jsonRequest(
    app,
    "POST",
    `/v1/messages/${encodeURIComponent(createdMessage.message.id)}/deliver`,
    undefined,
    { ...auth, "x-agent-id": "claude@book" }
  );
  assert.equal(wrongIdentity.response.status, 403);

  const delivered = await jsonRequest(
    app,
    "POST",
    `/v1/messages/${encodeURIComponent(createdMessage.message.id)}/deliver`,
    undefined,
    { ...auth, "x-agent-id": "probe@mini" }
  );
  assert.equal(delivered.response.status, 200);

  const { value: createdJob } = await jsonRequest(app, "POST", "/v1/jobs", {
    kind: "network.probe",
    max_attempts: 2,
    requested_by: "claude@book",
    target_agent: "probe@mini",
    payload: { checks: [{ type: "dns", name: "localhost" }] }
  }, auth);
  const wrongClaim = await jsonRequest(
    app,
    "POST",
    `/v1/jobs/${encodeURIComponent(createdJob.job.id)}/claim`,
    { agent_id: "claude@book" },
    { ...auth, "x-agent-id": "claude@book" }
  );
  assert.equal(wrongClaim.response.status, 403);

  const claimed = await jsonRequest(
    app,
    "POST",
    `/v1/jobs/${encodeURIComponent(createdJob.job.id)}/claim`,
    { agent_id: "probe@mini" },
    { ...auth, "x-agent-id": "probe@mini" }
  );
  assert.equal(claimed.response.status, 200);

  const wrongCompletion = await jsonRequest(
    app,
    "POST",
    `/v1/jobs/${encodeURIComponent(createdJob.job.id)}/complete`,
    { result: { ok: false } },
    { ...auth, "x-agent-id": "claude@book" }
  );
  assert.equal(wrongCompletion.response.status, 403);

  const retried = await jsonRequest(
    app,
    "POST",
    `/v1/jobs/${encodeURIComponent(createdJob.job.id)}/fail`,
    { error: "first attempt failed" },
    { ...auth, "x-agent-id": "probe@mini" }
  );
  assert.equal(retried.response.status, 200);
  assert.equal(retried.value.job.status, "queued");
  assert.equal(retried.value.job.attempts, 1);

  await jsonRequest(
    app,
    "POST",
    `/v1/jobs/${encodeURIComponent(createdJob.job.id)}/claim`,
    { agent_id: "probe@mini" },
    { ...auth, "x-agent-id": "probe@mini" }
  );
  const deadLetter = await jsonRequest(
    app,
    "POST",
    `/v1/jobs/${encodeURIComponent(createdJob.job.id)}/fail`,
    { error: "second attempt failed" },
    { ...auth, "x-agent-id": "probe@mini" }
  );
  assert.equal(deadLetter.value.job.status, "failed");
  assert.equal(deadLetter.value.job.attempts, 2);
});

test("rejects capability bypasses and malformed JSON bodies", async (t) => {
  const app = createServer({ dbPath: ":memory:", token: "" });
  t.after(() => app.close());
  await jsonRequest(app, "POST", "/v1/agents/register", {
    id: "probe@mini",
    host_id: "mini",
    kind: "probe",
    capabilities: null
  });

  const bypass = await jsonRequest(app, "POST", "/v1/jobs", {
    kind: "network.probe",
    capability: "",
    requested_by: "service-monitor",
    target_agent: "probe@mini",
    payload: { checks: [] }
  });
  assert.equal(bypass.response.status, 409);

  const invalidRequest = requestFor("POST", "/v1/messages", undefined);
  invalidRequest[Symbol.asyncIterator] = async function* () { yield Buffer.from("not-json"); };
  const invalid = await new Promise((resolve) => app.server.emit("request", invalidRequest, responseFor(resolve)));
  assert.equal(invalid.status, 400);
  assert.match(JSON.parse(invalid.body).error, /valid JSON/);

  const oversizedRequest = requestFor("POST", "/v1/messages", "x", { "content-length": "2000000" });
  const oversized = await new Promise((resolve) => app.server.emit("request", oversizedRequest, responseFor(resolve)));
  assert.equal(oversized.status, 413);
  assert.match(JSON.parse(oversized.body).error, /exceeds/);
});

test("a retry wakes the target worker instead of only the requester", async (t) => {
  const app = createServer({ dbPath: ":memory:", token: "" });
  t.after(() => app.close());
  await jsonRequest(app, "POST", "/v1/agents/register", {
    id: "probe@mini",
    host_id: "mini",
    kind: "probe",
    capabilities: ["network.probe"]
  });

  const events = [];
  let resolveRetry;
  const retryEvent = new Promise((resolve) => { resolveRetry = resolve; });
  const eventRequest = { ...requestFor("GET", "/v1/events?agent_id=probe%40mini", undefined, { "x-agent-id": "probe@mini" }), on() {} };
  let closeResponse;
  const eventResponse = {
    writeHead() {},
    write(chunk) {
      events.push(String(chunk));
      if (events.length === 2) resolveRetry(events[1]);
    },
    end() { closeResponse?.(); },
    on(event, handler) { if (event === "close") closeResponse = handler; }
  };
  app.server.emit("request", eventRequest, eventResponse);
  await new Promise((resolve) => setImmediate(resolve));

  const { value: created } = await jsonRequest(app, "POST", "/v1/jobs", {
    kind: "network.probe",
    requested_by: "service-monitor",
    target_agent: "probe@mini",
    payload: { checks: [] }
  });
  await jsonRequest(app, "POST", `/v1/jobs/${created.job.id}/claim`, { agent_id: "probe@mini" }, { "x-agent-id": "probe@mini" });
  await jsonRequest(app, "POST", `/v1/jobs/${created.job.id}/fail`, { error: "retry me" }, { "x-agent-id": "probe@mini" });

  const event = await Promise.race([
    retryEvent,
    new Promise((_, reject) => setTimeout(() => reject(new Error("retry event timed out")), 1000))
  ]);
  assert.match(event, /event: job\.created/);
  assert.match(event, new RegExp(created.job.id));
});
