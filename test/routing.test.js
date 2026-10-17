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
  const app = createServer({ dbPath: ":memory:" });
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
});

test("readiness reports the relay is available", async (t) => {
  const app = createServer({ dbPath: ":memory:" });
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
