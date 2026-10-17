import { randomUUID } from "node:crypto";

const SERVER_INFO = {
  name: "agent-relay",
  version: "0.1.0"
};

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
          conversation_id: { type: "string" }
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
    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return sendJson(response, 400, jsonRpcError(null, -32700, error.message));
    }
    if (body.method?.startsWith("notifications/")) {
      response.writeHead(202);
      response.end();
      return;
    }
    try {
      const result = await handleRequest(body, { store, publish });
      const sessionId = request.headers?.["mcp-session-id"] ?? (body.method === "initialize" ? randomUUID() : null);
      if (sessionId) response.setHeader("Mcp-Session-Id", sessionId);
      response.setHeader("MCP-Protocol-Version", body.params?.protocolVersion ?? "2025-06-18");
      return sendJson(response, 200, { jsonrpc: "2.0", id: body.id ?? null, result });
    } catch (error) {
      return sendJson(response, 200, jsonRpcError(body.id ?? null, -32603, error.message));
    }
  };
}

async function handleRequest(body, context) {
  switch (body.method) {
    case "initialize":
      return {
        protocolVersion: body.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: mcpTools() };
    case "tools/call":
      return callTool(body.params?.name, body.params?.arguments ?? {}, context);
    default:
      throw new Error(`unknown MCP method: ${body.method}`);
  }
}

async function callTool(name, args, { store, publish }) {
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
        sender: args.sender,
        recipient: args.recipient,
        type: args.type ?? "message",
        conversationId: args.conversation_id ?? null,
        payload: { body: args.body }
      });
      publish(args.recipient, "message.created", message);
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
      const requiredCapability = args.capability ?? args.kind;
      const targetAgent = args.target_agent ?? (args.source_host ? store.findAgentForHost(args.source_host, requiredCapability)?.id : null);
      if (!targetAgent) throw new Error("no target agent is registered for this job");
      if (!store.agentSupports(targetAgent, requiredCapability)) throw new Error("target agent does not provide the required capability");
      const payload = args.kind === "network.probe"
        ? {
            ...(args.payload ?? {}),
            source_host: args.source_host ?? args.payload?.source_host ?? null,
            target_host: args.target_host ?? args.payload?.target_host ?? null
          }
        : args.payload ?? {};
      const job = store.createJob({
        kind: args.kind,
        requiredCapability,
        maxAttempts: args.max_attempts,
        requestedBy: args.requested_by,
        targetAgent,
        sourceHost: args.source_host ?? null,
        targetHost: args.target_host ?? null,
        payload
      });
      publish(targetAgent, "job.created", job);
      value = job;
      break;
    }
    case "run_probe": {
      const targetAgent = store.findAgentForHost(args.source_host, "network.probe")?.id;
      if (!targetAgent) throw new Error(`no network probe worker is registered for ${args.source_host}`);
      const job = store.createJob({
        kind: "network.probe",
        requiredCapability: "network.probe",
        maxAttempts: 3,
        requestedBy: args.requested_by,
        targetAgent,
        sourceHost: args.source_host,
        targetHost: args.target_host ?? null,
        payload: {
          source_host: args.source_host,
          target_host: args.target_host ?? null,
          checks: args.checks,
          timeout_ms: args.timeout_ms
        }
      });
      publish(targetAgent, "job.created", job);
      value = job;
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
    structuredContent: value
  };
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

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
