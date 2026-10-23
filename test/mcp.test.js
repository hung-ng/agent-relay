import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { createMcpHandler } from "../src/mcp.js";

function requestFor(body) {
  return {
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); }
  };
}

function responseFor() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers = {}) { this.status = status; this.headers = { ...this.headers, ...headers }; },
    end(body = "") { this.body = body; }
  };
}

test("MCP exposes tools and routes a message", async () => {
  const store = new Store(":memory:");
  store.registerAgent({ id: "codex@mini", hostId: "mini", kind: "codex" });
  store.registerAgent({ id: "claude@book", hostId: "book", kind: "claude", capabilities: ["agent.task"] });
  const published = [];
  const handler = createMcpHandler({ store, publish: (...args) => published.push(args) });

  const listResponse = responseFor();
  await handler(requestFor({ jsonrpc: "2.0", id: 1, method: "tools/list" }), listResponse);
  const tools = JSON.parse(listResponse.body).result.tools.map((tool) => tool.name);
  assert.ok(tools.includes("register_agent"));
  assert.ok(tools.includes("send_message"));
  assert.ok(tools.includes("run_probe"));

  const messageResponse = responseFor();
  await handler(requestFor({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "send_message", arguments: { sender: "claude@book", recipient: "codex@mini", body: "hello" } }
  }), messageResponse);
  assert.equal(JSON.parse(messageResponse.body).result.structuredContent.recipient, "codex@mini");
  assert.equal(published[0][0], "codex@mini");

  const jobResponse = responseFor();
  await handler(requestFor({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "dispatch_job",
      arguments: {
        requested_by: "codex@mini",
        kind: "agent.task",
        source_host: "book",
        payload: { prompt: "check the service" }
      }
    }
  }), jobResponse);
  const job = JSON.parse(jobResponse.body).result.structuredContent;
  assert.equal(job.target_agent, "claude@book");
  assert.equal(job.required_capability, "agent.task");
  store.close();
});

test("MCP rejects malformed methods and tool arguments without throwing", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const handler = createMcpHandler({ store, publish() {} });
  for (const method of [123, {}, null]) {
    const response = responseFor();
    await handler(requestFor({ jsonrpc: "2.0", id: 1, method }), response);
    assert.equal(JSON.parse(response.body).error.code, -32600);
  }
  for (const args of [[], "bad", { sender: "worker" }, { sender: "worker", recipient: {}, body: "hi" }]) {
    const response = responseFor();
    await handler(requestFor({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_message", arguments: args } }), response);
    assert.equal(JSON.parse(response.body).error.code, -32602);
  }
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM messages").get().count, 0);
});

test("MCP message retries publish to the original recipient", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const published = [];
  const handler = createMcpHandler({ store, publish: (...args) => published.push(args) });
  for (const recipient of ["original", "other"]) {
    await handler(requestFor({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "send_message", arguments: { id: "stable", sender: "sender", recipient, body: "hi" }
    } }), responseFor());
  }
  assert.deepEqual(published.map(([recipient]) => recipient), ["original", "original"]);
});

test("MCP array and null tool results remain valid text-only results", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const handler = createMcpHandler({ store, publish() {} });
  for (const [name, args, expected] of [
    ["list_agents", {}, []], ["get_inbox", { agent_id: "worker" }, []],
    ["wait_for_message", { agent_id: "worker", timeout_ms: 100 }, null]
  ]) {
    const response = responseFor();
    await handler(requestFor({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), response);
    const result = JSON.parse(response.body).result;
    assert.equal(Object.hasOwn(result, "structuredContent"), false);
    assert.deepEqual(JSON.parse(result.content[0].text), expected);
  }
});

test("MCP returns an execution error when a valid dispatch has no target", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const response = responseFor();
  await createMcpHandler({ store, publish() {} })(requestFor({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "dispatch_job", arguments: { kind: "agent.task", requested_by: "operator", target_agent: "missing", payload: { prompt: "inspect" } }
  } }), response);
  const value = JSON.parse(response.body);
  assert.equal(value.result.isError, true);
  assert.match(value.result.content[0].text, /capability/);
});
