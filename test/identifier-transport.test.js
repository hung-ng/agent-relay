import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";
import { dispatchJob } from "../src/jobs.js";
import { Worker } from "../src/worker.js";

async function startRelay(t) {
  const app = createServer({ dbPath: ":memory:", token: "identifier-test-token" });
  const workers = [];
  t.after(async () => {
    await Promise.all(workers.map((worker) => worker.stop()));
    app.close();
    app.server.closeAllConnections();
  });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const serverUrl = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, body, headers = {}) => {
    const response = await fetch(`${serverUrl}${route}`, {
      method: "POST",
      headers: { authorization: "Bearer identifier-test-token", "content-type": "application/json", ...headers },
      body: JSON.stringify(body ?? {})
    });
    return { status: response.status, body: await response.json() };
  };
  const call = async (name, args) => {
    const response = await request("/mcp", {
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args }
    });
    assert.equal(response.status, 200);
    return response.body;
  };
  const makeWorker = (agentId) => {
    const worker = new Worker({ serverUrl, agentId, hostId: "雪host😀", kind: "codex", capabilities: ["agent.task"], token: "identifier-test-token", logger: { log() {}, error() {} } });
    workers.push(worker);
    return worker;
  };
  return { app, request, call, makeWorker };
}

function assertToolError(response, field) {
  assert.equal(response.result?.isError, true, JSON.stringify(response));
  assert.match(response.result.content[0].text, new RegExp(field));
  assert.ok(!response.result.content[0].text.includes("private-value"));
}

test("HTTP and MCP reject invalid record IDs before creating work", { timeout: 10_000 }, async (t) => {
  const { app, request, call } = await startRelay(t);
  app.store.registerAgent({ id: "worker", hostId: "host", kind: "codex", capabilities: ["agent.task"] });
  for (const id of ["private-value\0", "private-value\ud800", "private-value\udfff", ".", " .. ", "x".repeat(20_000), "雪".repeat(2000)]) {
    const message = await request("/v1/messages", { id, sender: "operator", recipient: "worker", payload: { body: "work" } });
    assert.equal(message.status, 400);
    assert.match(message.body.error, /message id/);
    assertToolError(await call("send_message", { id, sender: "operator", recipient: "worker", body: "work" }), "message id");
    const job = { id, kind: "agent.task", requested_by: "operator", target_agent: "worker", payload: { prompt: "work" } };
    const dispatched = await request("/v1/jobs", job);
    assert.equal(dispatched.status, 400);
    assert.match(dispatched.body.error, /job id/);
    assertToolError(await call("dispatch_job", job), "job id");
  }
  assert.equal(app.store.db.prepare("SELECT count(*) AS count FROM messages").get().count, 0);
  assert.equal(app.store.db.prepare("SELECT count(*) AS count FROM jobs").get().count, 0);
});

test("HTTP and MCP validate identity references, hosts, and conversations", { timeout: 10_000 }, async (t) => {
  const { app, request, call } = await startRelay(t);
  app.store.registerAgent({ id: "worker", hostId: "host", capabilities: ["agent.task"] });
  for (const id of ["private-value\0", "private-value\ud800", "雪worker", "bad\nworker", " worker "]) {
    assert.equal((await request("/v1/agents/register", { id, host_id: "host" })).status, 400);
    assertToolError(await call("register_agent", { agent_id: id, host_id: "host" }), "agent id");
    for (const field of ["sender", "recipient"]) {
      const args = { sender: "operator", recipient: "worker", body: "work", [field]: id };
      assert.equal((await request("/v1/messages", args)).status, 400);
      assertToolError(await call("send_message", args), field);
    }
    for (const field of ["requested_by", "target_agent"]) {
      const args = { kind: "agent.task", requested_by: "operator", target_agent: "worker", payload: { prompt: "work" }, [field]: id };
      assert.equal((await request("/v1/jobs", args)).status, 400);
      assertToolError(await call("dispatch_job", args), field);
    }
  }
  for (const id of ["private-value\0", "private-value\ud800", "private-value\udfff"]) {
    assert.equal((await request("/v1/agents/register", { id: "new-worker", host_id: id })).status, 400);
    assertToolError(await call("register_agent", { agent_id: "new-worker", host_id: id }), "host_id");
    const args = { sender: "operator", recipient: "worker", body: "work", conversation_id: id };
    assert.equal((await request("/v1/messages", args)).status, 400);
    assertToolError(await call("send_message", args), "conversation_id");
    for (const field of ["source_host", "target_host"]) {
      const job = { kind: "agent.task", requested_by: "operator", target_agent: "worker", payload: { prompt: "work" }, [field]: id };
      assert.equal((await request("/v1/jobs", job)).status, 400);
      assertToolError(await call("dispatch_job", job), field);
    }
  }
  assert.equal(app.store.listAgents().length, 1);
  assert.equal(app.store.db.prepare("SELECT count(*) AS count FROM messages").get().count, 0);
  assert.equal(app.store.db.prepare("SELECT count(*) AS count FROM jobs").get().count, 0);
});

test("dispatch validates its ID before lookup and ignores unused replay fields", () => {
  const lookups = [];
  const existing = { id: "stable", payload: { prompt: "original" } };
  const context = {
    store: {
      getJob(id) { lookups.push(id); return id === "stable" ? existing : null; },
      findAgentForHost() { assert.fail("invalid new identifiers reached host routing"); },
      agentSupports() { assert.fail("invalid new identifiers reached capability routing"); }
    },
    publish() { assert.fail("invalid or replayed job was published"); }
  };
  const base = { kind: "agent.task", requested_by: "operator", target_agent: "worker", payload: { prompt: "work" } };
  for (const id of ["private-value\0", "private-value\ud800", ".", " .. ", "x".repeat(4097), "雪".repeat(456)]) {
    assert.throws(() => dispatchJob(context, { ...base, id }), { status: 400 });
  }
  assert.deepEqual(lookups, []);
  for (const field of ["requested_by", "target_agent", "source_host", "target_host"]) {
    assert.throws(() => dispatchJob(context, { ...base, [field]: "private-value\0" }), { status: 400 });
  }
  const payload = { workflow: "unknown", execution_mode: "unknown" };
  payload.self = payload;
  assert.equal(dispatchJob(context, { ...base, id: " stable ", requested_by: "雪", target_agent: " worker ", source_host: "private-value\0", target_host: "private-value\ud800", capability: "unavailable", payload }), existing);
  for (const extra of [{ kind: "" }, { requested_by: "" }, { target_agent: "" }, { capability: "" }, { payload: [] }, { max_attempts: 11 }]) {
    assert.throws(() => dispatchJob(context, { ...base, id: "stable", ...extra }), { status: 400 });
  }
});

test("HTTP and MCP replays preserve original records despite unused invalid routing", { timeout: 10_000 }, async (t) => {
  const { app, request, call } = await startRelay(t);
  app.store.registerAgent({ id: "worker", hostId: "host", capabilities: ["agent.task"] });
  const message = (await request("/v1/messages", { id: "message", sender: "operator", recipient: "worker", payload: { body: "original" } })).body.message;
  const messageReplay = { id: " message ", sender: "雪", recipient: " worker ", conversation_id: "private-value\0", body: "changed" };
  const replayedMessage = await request("/v1/messages", messageReplay);
  assert.equal(replayedMessage.status, 201);
  assert.deepEqual(replayedMessage.body.message, message);
  assert.deepEqual((await call("send_message", messageReplay)).result.structuredContent, message);
  const job = (await request("/v1/jobs", { id: "job", kind: "agent.task", requested_by: "operator", target_agent: "worker", payload: { prompt: "original" } })).body.job;
  app.store.db.exec("UPDATE agents SET status = 'offline', capabilities = '[]'");
  const jobReplay = { id: " job ", kind: "changed", requested_by: "雪", target_agent: " worker ", source_host: "private-value\0", target_host: "private-value\ud800", capability: "unavailable", payload: { workflow: "unknown", execution_mode: "unknown" } };
  const replayedJob = await request("/v1/jobs", jobReplay);
  assert.equal(replayedJob.status, 201);
  assert.deepEqual(replayedJob.body.job, job);
  assert.deepEqual((await call("dispatch_job", jobReplay)).result.structuredContent, job);
  assert.equal(app.store.db.prepare("SELECT count(*) AS count FROM messages").get().count, 1);
  assert.equal(app.store.db.prepare("SELECT count(*) AS count FROM jobs").get().count, 1);
});

test("HTTP and MCP selectors cannot alias replacement-character keys", { timeout: 10_000 }, async (t) => {
  const { app, request, call } = await startRelay(t);
  app.store.registerAgent({ id: "worker", hostId: "host", capabilities: ["agent.task"] });
  const id = "private-value�";
  app.store.createMessage({ id, sender: "operator", recipient: "worker" });
  app.store.createJob({ id, kind: "agent.task", requestedBy: "operator", targetAgent: "worker", requiredCapability: "agent.task" });
  for (const selector of ["private-value\ud800", "private-value\udfff", "private-value\0"]) {
    assertToolError(await call("ack_message", { message_id: selector }), "message id");
    assertToolError(await call("get_job", { job_id: selector }), "job id");
  }
  for (const action of ["ack", "deliver"]) {
    assert.equal((await request(`/v1/messages/private-value%00/${action}`, {}, { "x-agent-id": "worker" })).status, 400);
  }
  assert.equal((await request("/v1/jobs/private-value%00/claim", { agent_id: "worker" }, { "x-agent-id": "worker" })).status, 400);
  assert.equal(app.store.getMessage(id).status, "queued");
  assert.equal(app.store.getJob(id).status, "queued");
});

test("unchanged Workers roundtrip maximum request IDs, generated replies, and Latin-1 identities", { timeout: 10_000 }, async (t) => {
  const { app, request, makeWorker } = await startRelay(t);
  const worker = makeWorker("café");
  const operator = makeWorker("operator");
  let executions = 0;
  worker.runAgentTask = async () => ({ stdout: `answer ${++executions}` });
  operator.runAgentTask = async () => assert.fail("reply spawned another reply");
  await worker.register();
  await operator.register();
  for (const id of ["x".repeat(4096), "雪".repeat(455) + "x", "😀".repeat(341) + "abcd", "a:b/c😀"]) {
    const created = await request("/v1/messages", { id: ` ${id} `, sender: "operator", recipient: "café", type: "request", conversation_id: "雪😀", payload: { body: "work" } });
    assert.equal(created.status, 201);
    await worker.handleMessage(created.body.message);
    assert.equal(app.store.getMessage(id).status, "acknowledged");
    const reply = app.store.getMessage(`reply:${id}`);
    assert.equal(reply.id, `reply:${id}`);
    assert.equal(encodeURIComponent(reply.id).length, encodeURIComponent(id).length + 8);
    assert.equal(reply.sender, "café");
    assert.equal(reply.conversation_id, "雪😀");
    await operator.handleMessage(reply);
    assert.equal(app.store.getMessage(reply.id).status, "acknowledged");
    assert.equal(app.store.db.prepare("SELECT count(*) AS count FROM messages WHERE id = ?").get(`reply:${reply.id}`).count, 0);
    const dispatched = await request("/v1/jobs", { id, kind: "agent.task", requested_by: "operator", target_agent: "café", payload: { prompt: "work" } });
    assert.equal(dispatched.status, 201);
    await worker.handleJob(dispatched.body.job);
    assert.equal(app.store.getJob(id).status, "completed");
    assert.equal(app.store.getJob(id).attempts, 1);
  }
  assert.equal(executions, 8);
  await worker.heartbeat();
  assert.equal(app.store.getAgent("café").host_id, "雪host😀");
});
