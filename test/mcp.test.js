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
