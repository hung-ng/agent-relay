import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
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

function mockTransport(t, app, responseDelay = () => 0) {
  const requests = [];
  t.mock.method(globalThis, "fetch", (url, options = {}) => {
    const { origin, pathname, search } = new URL(url);
    assert.equal(origin, "http://bus");
    requests.push({ path: pathname, time: Date.now() });
    return new Promise((resolve, reject) => {
      const request = Object.assign(new EventEmitter(), requestFor(
        options.method ?? "GET", pathname + search,
        options.body === undefined ? undefined : JSON.parse(options.body), options.headers
      ));
      let timer;
      let closeStream;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        closeStream?.(options.signal.reason);
        reject(options.signal.reason);
      };
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      let response;
      if (pathname === "/v1/events") {
        let controller;
        const body = new ReadableStream({
          start(value) { controller = value; },
          cancel() { cleanup(); request.emit("close"); }
        });
        closeStream = (error) => { controller.error(error); request.emit("close"); };
        response = Object.assign(new EventEmitter(), {
          writeHead(status) { resolve({ ok: status === 200, status, body }); },
          write(chunk) { controller.enqueue(Buffer.from(chunk)); return true; },
          end() { cleanup(); controller.close(); request.emit("close"); }
        });
      } else {
        response = responseFor((value) => {
          const finish = () => {
            cleanup();
            resolve({ ok: value.status >= 200 && value.status < 300, status: value.status,
              async json() { return value.body ? JSON.parse(value.body) : null; } });
          };
          const wait = responseDelay(pathname);
          if (wait === Infinity) return;
          if (wait > 0) timer = setTimeout(finish, wait);
          else finish();
        });
      }
      app.server.emit("request", request, response);
    });
  });
  return requests;
}

async function advanceTime(t, milliseconds) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 1000) {
    t.mock.timers.tick(Math.min(1000, milliseconds - elapsed));
    await nextTurn();
  }
}

test("scheduled heartbeats keep a running claim alive during slow reconciliation", async (t) => {
  const start = Date.UTC(2026, 9, 23);
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: start });
  const app = createServer({ dbPath: ":memory:", token: "" });
  const worker = new Worker({
    serverUrl: "http://bus", agentId: "worker", hostId: "host", kind: "codex", capabilities: ["agent.task"],
    logger: { log() {}, error() {} }
  });
  t.after(async () => { await worker.stop(); app.close(); });
  let pendingReads = 0;
  const requests = mockTransport(t, app, (route) => {
    if (route === "/v1/pending") return pendingReads++ === 0 ? 0 : 29_000;
    if (route === "/v1/jobs/slow") return 29_000;
    return 0;
  });
  let executions = 0;
  worker.runAgentTask = async (payload, { signal }) => {
    executions += 1;
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    throw new Error("task aborted");
  };
  await advanceTime(t, 5000);
  await worker.start();
  await nextTurn();
  const { job } = await jsonRequest(app, "POST", "/v1/jobs", {
    id: "slow", kind: "agent.task", requested_by: "operator", target_agent: "worker", payload: { prompt: "wait" }
  });
  await nextTurn();
  const claim = app.store.getJob(job.id).claim_token;
  assert.ok(claim);

  await advanceTime(t, 190_000);

  assert.equal(app.store.getAgent("worker").status, "online");
  assert.equal(app.store.getJob(job.id).status, "running");
  assert.equal(app.store.getJob(job.id).claim_token, claim);
  assert.equal(app.store.getJob(job.id).attempts, 1);
  assert.equal(executions, 1);
  assert.deepEqual(requests.filter(({ path }) => path.endsWith("/heartbeat")).map(({ time }) => time - start),
    [20_000, 35_000, 50_000, 65_000, 80_000, 95_000, 110_000, 125_000, 140_000, 155_000, 170_000, 185_000]);
  assert.deepEqual(requests.filter(({ path }) => path === "/v1/jobs/slow").map(({ time }) => time - start),
    [20_000, 80_000, 140_000]);
});

test("pending timeouts preserve a healthy event stream and retry missed work", async (t) => {
  const start = Date.UTC(2026, 9, 23);
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: start });
  const app = createServer({ dbPath: ":memory:", token: "" });
  const errors = [];
  const worker = new Worker({
    serverUrl: "http://bus", agentId: "worker", hostId: "host", kind: "codex", capabilities: ["agent.task"],
    logger: { log() {}, error(error) { errors.push(String(error)); } }
  });
  t.after(async () => { await worker.stop(); app.close(); });
  let blocked = true;
  const requests = mockTransport(t, app, (route) => route === "/v1/pending" && blocked ? Infinity : 0);
  const dispatch = (id) => jsonRequest(app, "POST", "/v1/jobs", {
    id, kind: "agent.task", requested_by: "operator", target_agent: "worker", payload: { prompt: id }
  });
  const executions = [];
  let active = 0;
  let maxActive = 0;
  worker.runAgentTask = async ({ prompt }) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    executions.push(prompt);
    try { await nextTurn(); return { stdout: prompt }; }
    finally { active -= 1; }
  };
  await worker.register();
  await dispatch("missed");
  await worker.start();
  await nextTurn();
  await dispatch("live-1");
  await dispatch("live-2");
  await nextTurn();
  assert.ok(executions.includes("live-1"), "SSE work must start before pending replay times out");

  await advanceTime(t, 130_000);

  assert.deepEqual(executions, ["live-1", "live-2"]);
  assert.equal(maxActive, 1);
  assert.equal(app.store.getJob("live-1").status, "completed");
  assert.equal(app.store.getJob("live-2").status, "completed");
  assert.equal(app.store.getJob("missed").status, "queued");
  assert.equal(app.store.getAgent("worker").status, "online");
  assert.equal(requests.filter(({ path }) => path === "/v1/events").length, 1);
  assert.deepEqual(requests.filter(({ path }) => path === "/v1/pending").map(({ time }) => time - start),
    [0, 45_000, 90_000]);
  assert.ok(errors.some((error) => error.includes("timed out after 30000ms")));
  assert.ok(errors.every((error) => !error.includes("connection lost")));

  blocked = false;
  await advanceTime(t, 45_000);

  assert.deepEqual(executions, ["live-1", "live-2", "missed"]);
  assert.equal(app.store.getJob("missed").status, "completed");
  assert.equal(app.store.getJob("missed").attempts, 1);
  assert.equal(requests.filter(({ path }) => path === "/v1/events").length, 1);
});

test("scheduled heartbeat POSTs do not overlap when their responses are slow", async (t) => {
  const start = Date.UTC(2026, 9, 23);
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: start });
  const app = createServer({ dbPath: ":memory:", token: "" });
  const worker = new Worker({
    serverUrl: "http://bus", agentId: "worker", hostId: "host", logger: { log() {}, error() {} }
  });
  t.after(async () => { await worker.stop(); app.close(); });
  const requests = mockTransport(t, app, (route) => route.endsWith("/heartbeat") ? 29_000 : 0);
  await worker.start();
  await nextTurn();

  await advanceTime(t, 80_000);

  assert.deepEqual(requests.filter(({ path }) => path.endsWith("/heartbeat")).map(({ time }) => time - start),
    [15_000, 45_000, 75_000]);
  assert.equal(app.store.getAgent("worker").status, "online");
  assert.equal(requests.filter(({ path }) => path === "/v1/events").length, 1);
});

test("stop aborts heartbeat, reconciliation, replay, and execution without waiting for their timeouts", { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: Date.UTC(2026, 9, 23) });
  const app = createServer({ dbPath: ":memory:", token: "" });
  const worker = new Worker({
    serverUrl: "http://bus", agentId: "worker", hostId: "host", kind: "codex", capabilities: ["agent.task"],
    logger: { log() {}, error() {} }
  });
  t.after(async () => { await worker.stop(); app.close(); });
  const requests = mockTransport(t, app, (route) =>
    route.endsWith("/heartbeat") || route === "/v1/jobs/slow" || route === "/v1/pending" ? Infinity : 0);
  const executions = [];
  let aborted = false;
  worker.runAgentTask = async ({ prompt }, { signal }) => {
    executions.push(prompt);
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    aborted = signal.aborted;
    throw new Error("task aborted");
  };
  await worker.start();
  await nextTurn();
  for (const id of ["slow", "queued"]) {
    await jsonRequest(app, "POST", "/v1/jobs", {
      id, kind: "agent.task", requested_by: "operator", target_agent: "worker", payload: { prompt: id }
    });
  }
  await advanceTime(t, 20_000);
  assert.equal(requests.filter(({ path }) => path.endsWith("/heartbeat")).length, 1);
  assert.equal(requests.filter(({ path }) => path === "/v1/jobs/slow").length, 1);
  assert.equal(requests.filter(({ path }) => path === "/v1/pending").length, 1);

  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await nextTurn();
  assert.equal(stopped, true, "shutdown must finish before fake time advances");
  await stopping;

  assert.equal(aborted, true);
  assert.deepEqual(executions, ["slow"]);
  const count = requests.length;
  await advanceTime(t, 60_000);
  assert.equal(requests.length, count);
});

test("worker replays unfinished work after reconnecting", async (t) => {
  const app = createServer({ dbPath: ":memory:", token: "" });
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
  await worker.drainPromise;

  assert.deepEqual(replayedMessages, [message.message.id]);
  assert.deepEqual(replayedJobs, [job.job.id]);

  const workerHeaders = { "x-agent-id": "probe@mini" };
  await jsonRequest(app, "POST", `/v1/messages/${encodeURIComponent(message.message.id)}/ack`, undefined, workerHeaders);
  const claimed = await jsonRequest(app, "POST", `/v1/jobs/${encodeURIComponent(job.job.id)}/claim`, { agent_id: "probe@mini" }, workerHeaders);
  await jsonRequest(app, "POST", `/v1/jobs/${encodeURIComponent(job.job.id)}/complete`, { result: { ok: true }, claim_token: claimed.job.claim_token }, workerHeaders);
  assert.deepEqual(
    await jsonRequest(app, "GET", "/v1/pending?agent_id=probe%40mini", undefined, { "x-agent-id": "probe@mini" }),
    { messages: [], jobs: [] }
  );
});
