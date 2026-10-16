import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";
import { Worker } from "../src/worker.js";

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

async function jsonRequest(app, method, url, body, headers = {}) {
  const response = await new Promise((resolve) => {
    app.server.emit("request", requestFor(method, url, body, headers), responseFor(resolve));
  });
  const value = response.body ? JSON.parse(response.body) : null;
  assert.ok(response.status >= 200 && response.status < 300, JSON.stringify(value));
  return value;
}

test("worker replays unfinished work after reconnecting", async (t) => {
  const app = createServer({ dbPath: ":memory:" });
  t.after(() => app.close());

  await jsonRequest(app, "POST", "/v1/agents/register", { id: "probe@mini", host_id: "mini", kind: "probe", capabilities: ["network.probe"] });
  const message = await jsonRequest(app, "POST", "/v1/messages", { sender: "claude@book", recipient: "probe@mini", payload: { body: "hello" } });
  const job = await jsonRequest(app, "POST", "/v1/jobs", {
    kind: "network.probe",
    requested_by: "claude@book",
    target_agent: "probe@mini",
    payload: { source_host: "mini", checks: [{ type: "dns", name: "localhost" }] }
  });
  const pending = await jsonRequest(app, "GET", "/v1/pending?agent_id=probe%40mini", undefined, { "x-agent-id": "probe@mini" });

  const worker = new Worker({
    serverUrl: "http://bus",
    agentId: "probe@mini",
    hostId: "mini",
    kind: "probe",
    logger: { log() {}, error() {} }
  });
  const replayedMessages = [];
  const replayedJobs = [];
  worker.request = async (path) => {
    if (path.startsWith("/v1/agents/")) return { agent: { id: "probe@mini" } };
    if (path.startsWith("/v1/pending")) return pending;
    throw new Error(`unexpected request: ${path}`);
  };
  worker.handleMessage = async (value) => replayedMessages.push(value.id);
  worker.handleJob = async (value) => replayedJobs.push(value.id);

  await worker.register();
  await worker.replayPending();

  assert.deepEqual(replayedMessages, [message.message.id]);
  assert.deepEqual(replayedJobs, [job.job.id]);

  const workerHeaders = { "x-agent-id": "probe@mini" };
  await jsonRequest(app, "POST", `/v1/messages/${encodeURIComponent(message.message.id)}/ack`, undefined, workerHeaders);
  await jsonRequest(app, "POST", `/v1/jobs/${encodeURIComponent(job.job.id)}/claim`, { agent_id: "probe@mini" }, workerHeaders);
  await jsonRequest(app, "POST", `/v1/jobs/${encodeURIComponent(job.job.id)}/complete`, { result: { ok: true }, }, workerHeaders);
  assert.deepEqual(
    await jsonRequest(app, "GET", "/v1/pending?agent_id=probe%40mini", undefined, { "x-agent-id": "probe@mini" }),
    { messages: [], jobs: [] }
  );
});
