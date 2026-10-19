import test from "node:test";
import assert from "node:assert/strict";
import { Worker, agentTaskArgs, runProcess } from "../src/worker.js";

test("read-only Codex tasks use the installed noninteractive policy", () => {
  assert.deepEqual(agentTaskArgs("codex", { execution_mode: "read_only", prompt: "inspect" }), [
    "exec",
    "--sandbox",
    "read-only",
    "--config",
    'approval_policy="never"',
    "inspect"
  ]);
  assert.deepEqual(agentTaskArgs("codex", { execution_mode: "write", prompt: "implement" }), ["exec", "implement"]);
  assert.deepEqual(agentTaskArgs("codex", { execution_mode: "write", allow_write: true, prompt: "implement" }), [
    "exec",
    "--sandbox",
    "workspace-write",
    "--config",
    'approval_policy="never"',
    "implement"
  ]);
});

test("worker subprocesses are terminated when they exceed their timeout", async () => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { timeoutMs: 20 }),
    /timed out after 20ms/
  );
});

test("worker subprocesses stop when the worker is aborted", async () => {
  const controller = new AbortController();
  const running = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(running, /was aborted/);
});

test("agent workers turn requests into replies", async () => {
  const calls = [];
  const worker = new Worker({
    serverUrl: "http://bus",
    agentId: "claude@book",
    hostId: "book",
    kind: "claude",
    logger: { log() {}, error() {} }
  });
  worker.request = async (path, options = {}) => {
    calls.push({ path, options });
    return {};
  };
  worker.runAgentTask = async ({ prompt }) => ({ command: "claude", stdout: `answer: ${prompt}`, stderr: "", code: 0 });

  await worker.handleMessage({
    id: "message-1",
    sender: "codex@mini",
    recipient: "claude@book",
    type: "request",
    conversation_id: "conversation-1",
    payload: { body: "check the service" }
  });

  assert.deepEqual(calls.map((call) => call.path), [
    "/v1/messages/message-1/deliver",
    "/v1/messages",
    "/v1/messages/message-1/ack"
  ]);
  assert.equal(calls[1].options.body.recipient, "codex@mini");
  assert.equal(calls[1].options.body.type, "reply");
  assert.equal(calls[1].options.body.id, "reply:message-1");
  assert.equal(calls[1].options.body.payload.body, "answer: check the service");
});

test("agent workers skip a duplicate message after it is acknowledged", async () => {
  const calls = [];
  const worker = new Worker({
    serverUrl: "http://bus",
    agentId: "claude@book",
    hostId: "book",
    kind: "claude",
    logger: { log() {}, error() {} }
  });
  worker.request = async (path) => {
    calls.push(path);
    return { message: { status: "acknowledged" } };
  };
  worker.runAgentTask = async () => {
    throw new Error("duplicate task execution");
  };

  await worker.handleMessage({
    id: "message-2",
    sender: "codex@mini",
    recipient: "claude@book",
    type: "request",
    payload: { body: "run once" }
  });

  assert.deepEqual(calls, ["/v1/messages/message-2/deliver"]);
});
