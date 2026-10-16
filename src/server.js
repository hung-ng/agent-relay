import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Store } from "./store.js";
import { createMcpHandler } from "./mcp.js";

export function createServer({ dbPath = "./data/agent-relay.db", token = process.env.AGENT_RELAY_TOKEN ?? "" } = {}) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const store = new Store(dbPath);
  const subscribers = new Map();
  const staleTimer = setInterval(() => store.markStale(), 15000);

  const publish = (agentId, event, data) => {
    const listeners = subscribers.get(agentId) ?? new Set();
    for (const response of listeners) {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  const mcpHandler = createMcpHandler({ store, publish });
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "OPTIONS") return sendJson(response, 204, null);
      if (!authenticate(request, token)) return sendJson(response, 401, { error: "unauthorized" });
      const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);

      if (url.pathname === "/healthz" && request.method === "GET") {
        return sendJson(response, 200, { ok: true, service: "agent-relay" });
      }
      if (url.pathname === "/mcp" && request.method === "POST") return mcpHandler(request, response);
      if (url.pathname === "/v1/events" && request.method === "GET") {
        return openEvents(url.searchParams.get("agent_id"), request, response);
      }
      if (url.pathname === "/v1/agents" && request.method === "GET") {
        return sendJson(response, 200, { agents: store.listAgents() });
      }
      if (url.pathname === "/v1/agents/register" && request.method === "POST") {
        const body = await readJson(request);
        if (!body.id || !body.host_id) return sendJson(response, 400, { error: "id and host_id are required" });
        return sendJson(response, 200, { agent: store.registerAgent({
          id: body.id,
          hostId: body.host_id,
          kind: body.kind,
          capabilities: body.capabilities,
          metadata: body.metadata
        }) });
      }
      const heartbeat = url.pathname.match(/^\/v1\/agents\/([^/]+)\/heartbeat$/);
      if (heartbeat && request.method === "POST") {
        const agent = store.heartbeat(decodeURIComponent(heartbeat[1]));
        return agent ? sendJson(response, 200, { agent }) : sendJson(response, 404, { error: "agent not found" });
      }
      if (url.pathname === "/v1/messages" && request.method === "POST") {
        const body = await readJson(request);
        if (!body.sender || !body.recipient) return sendJson(response, 400, { error: "sender and recipient are required" });
        const message = store.createMessage({
          sender: body.sender,
          recipient: body.recipient,
          type: body.type,
          conversationId: body.conversation_id,
          payload: body.payload ?? { body: body.body }
        });
        publish(message.recipient, "message.created", message);
        return sendJson(response, 201, { message });
      }
      if (url.pathname === "/v1/messages" && request.method === "GET") {
        const recipient = url.searchParams.get("agent_id");
        if (!recipient) return sendJson(response, 400, { error: "agent_id is required" });
        return sendJson(response, 200, { messages: store.getMessages(recipient, url.searchParams.get("limit")) });
      }
      const messageAction = url.pathname.match(/^\/v1\/messages\/([^/]+)\/(ack|deliver)$/);
      if (messageAction && request.method === "POST") {
        const id = decodeURIComponent(messageAction[1]);
        const message = messageAction[2] === "ack" ? store.acknowledgeMessage(id) : store.markMessageDelivered(id);
        return message ? sendJson(response, 200, { message }) : sendJson(response, 404, { error: "message not found" });
      }
      if (url.pathname === "/v1/jobs" && request.method === "POST") {
        const body = await readJson(request);
        if (!body.kind || !body.requested_by) return sendJson(response, 400, { error: "kind and requested_by are required" });
        const targetAgent = body.target_agent ?? (body.source_host ? store.findAgentForHost(body.source_host)?.id : null);
        if (!targetAgent) return sendJson(response, 409, { error: "no target agent is registered" });
        const job = store.createJob({
          kind: body.kind,
          requestedBy: body.requested_by,
          targetAgent,
          sourceHost: body.source_host,
          targetHost: body.target_host,
          payload: body.payload ?? {}
        });
        publish(targetAgent, "job.created", job);
        return sendJson(response, 201, { job });
      }
      const jobRoute = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
      if (jobRoute && request.method === "GET") {
        const job = store.getJob(decodeURIComponent(jobRoute[1]));
        return job ? sendJson(response, 200, { job }) : sendJson(response, 404, { error: "job not found" });
      }
      const jobClaim = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/claim$/);
      if (jobClaim && request.method === "POST") {
        const body = await readJson(request);
        const job = store.claimJob(decodeURIComponent(jobClaim[1]), body.agent_id);
        return job ? sendJson(response, 200, { job }) : sendJson(response, 409, { error: "job is not available" });
      }
      const jobResult = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/(complete|fail|cancel)$/);
      if (jobResult && request.method === "POST") {
        const id = decodeURIComponent(jobResult[1]);
        const action = jobResult[2];
        const body = await readJson(request);
        const job = action === "complete"
          ? store.completeJob(id, body.result)
          : action === "fail"
            ? store.failJob(id, body.error)
            : store.cancelJob(id);
        if (!job) return sendJson(response, 404, { error: "job not found" });
        publish(job.requested_by, `job.${job.status}`, job);
        return sendJson(response, 200, { job });
      }
      return sendJson(response, 404, { error: "not found" });
    } catch (error) {
      console.error(error);
      return sendJson(response, 500, { error: error.message });
    }
  });

  const close = () => {
    for (const listeners of subscribers.values()) {
      for (const response of listeners) response.end();
    }
    clearInterval(staleTimer);
    store.close();
    if (server.listening) server.close();
  };

  return { server, store, close };

  function openEvents(agentId, request, response) {
    if (!agentId) return sendJson(response, 400, { error: "agent_id is required" });
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ agent_id: agentId })}\n\n`);
    if (!subscribers.has(agentId)) subscribers.set(agentId, new Set());
    subscribers.get(agentId).add(response);
    const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15000);
    const cleanup = () => {
      clearInterval(keepAlive);
      subscribers.get(agentId)?.delete(response);
      if (subscribers.get(agentId)?.size === 0) subscribers.delete(agentId);
    };
    request.on("close", cleanup);
    response.on("close", cleanup);
  }
}

function authenticate(request, token) {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(response, status, payload) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (status === 204) {
    response.writeHead(status);
    response.end();
    return;
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}
