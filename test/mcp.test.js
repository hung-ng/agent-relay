import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { createMcpHandler } from "../src/mcp.js";

function requestFor(body, headers = {}) {
  return requestForJson(JSON.stringify(body), headers);
}

function requestForJson(text, headers = {}) {
  return {
    headers,
    async *[Symbol.asyncIterator]() { yield Buffer.from(text); }
  };
}

test("MCP negotiates its supported version and rejects unsupported transport versions", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const handler = createMcpHandler({ store, publish() {} });
  for (const version of ["2025-06-18", "2099-01-01"]) {
    const response = responseFor();
    await handler(requestFor({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version } }), response);
    assert.equal(JSON.parse(response.body).result.protocolVersion, "2025-06-18");
    assert.equal(response.headers["MCP-Protocol-Version"], "2025-06-18");
  }
  for (const version of ["2099-01-01", "", ["2025-06-18"]]) {
    const response = responseFor();
    await handler(requestFor({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "send_message", arguments: { sender: "operator", recipient: "worker", body: "must not be sent" }
    } }, { "mcp-protocol-version": version }), response);
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body).error.data.supported, ["2025-06-18"]);
  }
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM messages").get().count, 0);
  const ping = responseFor();
  await handler(requestFor({ jsonrpc: "2.0", id: 3, method: "ping" }, { "mcp-protocol-version": "2025-06-18" }), ping);
  assert.equal(ping.status, 200);
  assert.deepEqual(JSON.parse(ping.body).result, {});
});

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

test("MCP rejects deep metadata before persistence and counts its request envelope", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const original = store.registerAgent({ id: "existing", hostId: "original", metadata: { keep: true } });
  const register = t.mock.method(store, "registerAgent");
  const published = [];
  const handler = createMcpHandler({ store, publish: (...args) => published.push(args) });
  const registration = (id, depth) => '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"register_agent","arguments":{"agent_id":'
    + JSON.stringify(id) + ',"host_id":"changed","metadata":' + '{"n":'.repeat(depth) + "null" + "}".repeat(depth) + "}}}";

  for (const metadataDepth of [126, 5845]) {
    const response = responseFor();
    await handler(requestForJson(registration("existing", metadataDepth)), response);
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body), {
      jsonrpc: "2.0", id: null,
      error: { code: -32700, message: "request body exceeds 128 levels of nesting" }
    });
    assert.equal(register.mock.callCount(), 0);
    assert.deepEqual(store.getAgent("existing"), original);
    assert.deepEqual(published, []);
  }
  const response = responseFor();
  await handler(requestForJson(registration("boundary", 125)), response);
  assert.equal(response.status, 200);
  const result = JSON.parse(response.body).result;
  assert.equal(result.structuredContent.id, "boundary");
  assert.equal(result.content[0].text, JSON.stringify(result.structuredContent));
  assert.deepEqual(store.getAgent("boundary"), result.structuredContent);
  assert.equal(register.mock.callCount(), 1);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM agents").get().count, 2);
});

test("MCP text stays compact as stored result depth grows and preserves result shapes", async () => {
  const sizes = new Map();
  for (const depth of [128, 256, 1024]) {
    const metadata = JSON.parse('{"n":'.repeat(depth) + '"line 1\\nline 2 😀"' + "}".repeat(depth));
    const record = { id: "stored", metadata };
    const store = { getJob: () => record, listAgents: () => [record] };
    const handler = createMcpHandler({ store, publish() {} });
    for (const [name, args, expected] of [
      ["get_job", { job_id: "stored" }, record], ["list_agents", {}, [record]]
    ]) {
      const response = responseFor();
      await handler(requestFor({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), response);
      assert.equal(response.status, 200);
      const result = JSON.parse(response.body).result;
      const compact = JSON.stringify(expected);
      const text = result.content[0].text;
      assert.equal(result.isError, undefined);
      assert.equal(result.content[0].type, "text");
      assert.equal(text.length, compact.length);
      assert.equal(text, compact);
      assert.equal(JSON.stringify(JSON.parse(text)), compact);
      assert.equal(Object.hasOwn(result, "structuredContent"), name === "get_job");
      if (name === "get_job") assert.equal(JSON.stringify(result.structuredContent), compact);
      sizes.set(`${name}:${depth}`, text.length);
    }
  }
  for (const name of ["get_job", "list_agents"]) {
    assert.ok(sizes.get(`${name}:256`) <= 2 * sizes.get(`${name}:128`));
    assert.ok(sizes.get(`${name}:1024`) <= 4 * sizes.get(`${name}:256`));
  }
});
