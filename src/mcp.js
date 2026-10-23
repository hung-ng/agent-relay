import { randomUUID } from "node:crypto";
import { dispatchJob } from "./jobs.js";
import { readJsonBody } from "./body.js";

const SERVER_INFO = {
  name: "agent-relay",
  version: "0.1.0"
};
const PROTOCOL_VERSION = "2025-06-18";

export function mcpTools() {
  return [
    {
      name: "register_agent",
      description: "Register the current agent so other agents can address it.",
      inputSchema: {
        type: "object",
        required: ["agent_id", "host_id"],
        properties: {
          agent_id: { type: "string" },
          host_id: { type: "string" },
          kind: { type: "string" },
          capabilities: { type: "array", items: { type: "string" } },
          metadata: { type: "object" }
        }
      }
    },
    {
      name: "list_agents",
      description: "List registered agents and their host capabilities.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "send_message",
      description: "Send a durable message to another agent.",
      inputSchema: {
        type: "object",
        required: ["sender", "recipient", "body"],
        properties: {
          sender: { type: "string" },
          recipient: { type: "string" },
          body: { type: "string" },
          type: { type: "string" },
          conversation_id: { type: "string" },
          id: { type: "string" }
        }
      }
    },
    {
      name: "get_inbox",
      description: "Read messages addressed to an agent.",
      inputSchema: {
        type: "object",
        required: ["agent_id"],
        properties: {
          agent_id: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 }
        }
      }
    },
    {
      name: "wait_for_message",
      description: "Wait briefly for a new message addressed to an agent.",
      inputSchema: {
        type: "object",
        required: ["agent_id"],
        properties: {
          agent_id: { type: "string" },
          timeout_ms: { type: "integer", minimum: 100, maximum: 30000 }
        }
      }
    },
    {
      name: "ack_message",
      description: "Acknowledge a message after reading or handling it.",
      inputSchema: {
        type: "object",
        required: ["message_id"],
        properties: { message_id: { type: "string" } }
      }
    },
    {
      name: "dispatch_job",
      description: "Create work for a specific agent or host and wait for its result separately.",
      inputSchema: {
        type: "object",
        required: ["requested_by", "kind", "payload"],
        properties: {
          requested_by: { type: "string" },
          kind: { type: "string" },
          capability: { type: "string" },
          id: { type: "string" },
          max_attempts: { type: "integer", minimum: 1, maximum: 10 },
          target_agent: { type: "string" },
          source_host: { type: "string" },
          target_host: { type: "string" },
          payload: { type: "object" }
        }
      }
    },
    {
      name: "run_probe",
      description: "Run a network probe from a named host through its registered worker.",
      inputSchema: {
        type: "object",
        required: ["requested_by", "source_host", "checks"],
        properties: {
          requested_by: { type: "string" },
          id: { type: "string" },
          source_host: { type: "string" },
          target_host: { type: "string" },
          checks: { type: "array", items: { type: "object" } },
          timeout_ms: { type: "integer" }
        }
      }
    },
    {
      name: "get_job",
      description: "Get the current status and result of a job.",
      inputSchema: {
        type: "object",
        required: ["job_id"],
        properties: { job_id: { type: "string" } }
      }
    },
    {
      name: "wait_for_job",
      description: "Wait briefly for a job to finish, then return its current state.",
      inputSchema: {
        type: "object",
        required: ["job_id"],
        properties: {
          job_id: { type: "string" },
          timeout_ms: { type: "integer", minimum: 100, maximum: 30000 }
        }
      }
    }
  ];
}

export function createMcpHandler({ store, publish }) {
  return async function handleMcp(request, response) {
    const transportVersion = request.headers?.["mcp-protocol-version"];
    if (transportVersion !== undefined && transportVersion !== PROTOCOL_VERSION) {
      return sendJson(response, 400, jsonRpcError(null, -32600, "unsupported MCP protocol version", { supported: [PROTOCOL_VERSION] }));
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      return sendJson(response, error.status ?? 400, jsonRpcError(null, -32700, error.message));
    }
    if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return sendJson(response, 400, jsonRpcError(body.id ?? null, -32600, "invalid JSON-RPC request"));
    }
    if (body.method.startsWith("notifications/")) {
      response.writeHead(202);
      response.end();
      return;
    }
    try {
      const result = await handleRequest(body, { store, publish });
      const sessionId = request.headers?.["mcp-session-id"] ?? (body.method === "initialize" ? randomUUID() : null);
      if (sessionId) response.setHeader("Mcp-Session-Id", sessionId);
      response.setHeader("MCP-Protocol-Version", PROTOCOL_VERSION);
      return sendJson(response, 200, { jsonrpc: "2.0", id: body.id ?? null, result });
    } catch (error) {
      return sendJson(response, 200, jsonRpcError(body.id ?? null, error.rpcCode ?? -32603, error.message));
    }
  };
}

async function handleRequest(body, context) {
  switch (body.method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: mcpTools() };
    case "tools/call":
      try { return await callTool(body.params?.name, body.params?.arguments ?? {}, context); }
      catch (error) {
        if (error.rpcCode) throw error;
        return { isError: true, content: [{ type: "text", text: error.message }] };
      }
    default:
      throw Object.assign(new Error(`unknown MCP method: ${body.method}`), { rpcCode: -32601 });
  }
}

async function callTool(name, args, { store, publish }) {
  validateToolArguments(name, args);
  let value;
  switch (name) {
    case "register_agent":
      value = store.registerAgent({
        id: args.agent_id,
        hostId: args.host_id,
        kind: args.kind,
        capabilities: args.capabilities,
        metadata: args.metadata
      });
      break;
    case "list_agents":
      value = store.listAgents();
      break;
    case "send_message": {
      const message = store.createMessage({
        id: args.id,
        sender: args.sender,
        recipient: args.recipient,
        type: args.type ?? "message",
        conversationId: args.conversation_id ?? null,
        payload: { body: args.body }
      });
      publish(message.recipient, "message.created", message);
      value = message;
      break;
    }
    case "get_inbox":
      value = store.getMessages(args.agent_id, args.limit);
      break;
    case "wait_for_message":
      value = await waitForMessage(store, args.agent_id, args.timeout_ms);
      break;
    case "ack_message":
      value = store.acknowledgeMessage(args.message_id);
      if (!value) throw new Error(`message not found: ${args.message_id}`);
      break;
    case "dispatch_job": {
      value = dispatchJob({ store, publish }, args);
      break;
    }
    case "run_probe": {
      value = dispatchJob({ store, publish }, {
        id: args.id,
        kind: "network.probe",
        requested_by: args.requested_by,
        source_host: args.source_host,
        target_host: args.target_host,
        payload: {
          source_host: args.source_host,
          target_host: args.target_host ?? null,
          checks: args.checks,
          timeout_ms: args.timeout_ms
        }
      });
      break;
    }
    case "get_job":
      value = store.getJob(args.job_id);
      if (!value) throw new Error(`job not found: ${args.job_id}`);
      break;
    case "wait_for_job":
      value = await waitForJob(store, args.job_id, args.timeout_ms);
      break;
    default:
      throw new Error(`unknown tool: ${name}`);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(value !== null && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value } : {})
  };
}

function validateToolArguments(name, args) {
  const tool = mcpTools().find((candidate) => candidate.name === name);
  const invalid = (message) => { throw Object.assign(new Error(message), { rpcCode: -32602 }); };
  if (!tool) invalid(`unknown tool: ${name}`);
  if (args === null || typeof args !== "object" || Array.isArray(args)) invalid("tool arguments must be an object");
  for (const field of tool.inputSchema.required ?? []) {
    if (args[field] === undefined) invalid(`${field} is required`);
  }
  for (const [field, schema] of Object.entries(tool.inputSchema.properties)) {
    const value = args[field];
    if (value === undefined) continue;
    const matches = (value, type) => type === "integer" ? Number.isInteger(value)
      : type === "array" ? Array.isArray(value)
      : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
      : typeof value === type;
    if (!matches(value, schema.type)) invalid(`${field} must be ${schema.type}`);
    if (schema.type === "string" && !value.trim()) invalid(`${field} must be a non-empty string`);
    if (schema.minimum !== undefined && value < schema.minimum) invalid(`${field} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) invalid(`${field} must be at most ${schema.maximum}`);
    if (schema.items && value.some((item) => !matches(item, schema.items.type))) invalid(`${field} has an invalid item`);
  }
}

async function waitForJob(store, id, timeoutMs = 10000) {
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 10000, 100), 30000);
  while (Date.now() < deadline) {
    const job = store.getJob(id);
    if (!job) throw new Error(`job not found: ${id}`);
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return store.getJob(id);
}

async function waitForMessage(store, agentId, timeoutMs = 10000) {
  const deadline = Date.now() + Math.min(Math.max(Number(timeoutMs) || 10000, 100), 30000);
  while (Date.now() < deadline) {
    const message = store.getPendingMessages(agentId, 1)[0];
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

function sendJson(response, status, payload) {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function jsonRpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}
