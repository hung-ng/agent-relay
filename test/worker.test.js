import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "../src/worker.js";

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
