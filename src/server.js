import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Store } from "./store.js";
import { createMcpHandler } from "./mcp.js";
import { normalizeJobPayload, requiredCapabilityForJob } from "./routing.js";
import { readJsonBody } from "./body.js";

export function createServer({ dbPath = "./data/agent-relay.db", token = process.env.AGENT_RELAY_TOKEN ?? "" } = {}) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const store = new Store(dbPath);
  const subscribers = new Map();
  const refreshStaleWork = () => {
    store.markStale();
    for (const job of store.requeueStaleJobs()) publishJobEvent(job);
  };
  const staleTimer = setInterval(refreshStaleWork, 15000);
  let closed = false;

  const publish = (agentId, event, data) => {
    const listeners = subscribers.get(agentId) ?? new Set();
    for (const response of listeners) {
      try {
        const accepted = response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (accepted === false) {
          listeners.delete(response);
          response.destroy?.();
        }
      } catch {
        listeners.delete(response);
        try { response.end(); } catch { /* The peer already closed the stream. */ }
      }
    }
    if (listeners.size === 0) subscribers.delete(agentId);
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
      if (url.pathname === "/readyz" && request.method === "GET") {
        store.checkReady();
        return sendJson(response, 200, { ok: true, service: "agent-relay" });
      }
      if (url.pathname === "/mcp" && request.method === "POST") return mcpHandler(request, response);
      if (url.pathname === "/v1/events" && request.method === "GET") {
        const agentId = url.searchParams.get("agent_id");
        const actor = agentIdentity(request);
        if (!actor) return sendJson(response, 401, { error: "x-agent-id is required" });
        if (actor !== agentId) return sendJson(response, 403, { error: "agent identity does not match agent_id" });
        return openEvents(agentId, request, response);
      }
      if (url.pathname === "/v1/agents" && request.method === "GET") {
        return sendJson(response, 200, { agents: store.listAgents() });
      }
      if (url.pathname === "/v1/agents/register" && request.method === "POST") {
        const body = await readJsonBody(request);
        if (!isNonEmptyString(body.id) || !isNonEmptyString(body.host_id)) {
          return sendJson(response, 400, { error: "id and host_id are required" });
        }
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
        const actor = agentIdentity(request);
        if (!actor) return sendJson(response, 401, { error: "x-agent-id is required" });
        const agentId = decodeURIComponent(heartbeat[1]);
        if (actor !== agentId) return sendJson(response, 403, { error: "agent identity does not match agent_id" });
        const agent = store.heartbeat(agentId);
        return agent ? sendJson(response, 200, { agent }) : sendJson(response, 404, { error: "agent not found" });
      }
      if (url.pathname === "/v1/messages" && request.method === "POST") {
        const body = await readJsonBody(request);
        if (!isNonEmptyString(body.sender) || !isNonEmptyString(body.recipient) || !isOptionalId(body.id)) {
          return sendJson(response, 400, { error: "sender and recipient are required" });
        }
        const message = store.createMessage({
          id: body.id,
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
      if (url.pathname === "/v1/pending" && request.method === "GET") {
        const agentId = url.searchParams.get("agent_id");
        if (!agentId) return sendJson(response, 400, { error: "agent_id is required" });
        const actor = agentIdentity(request);
        if (!actor) return sendJson(response, 401, { error: "x-agent-id is required" });
        if (actor !== agentId) return sendJson(response, 403, { error: "agent identity does not match agent_id" });
        return sendJson(response, 200, store.getPendingWork(agentId, url.searchParams.get("limit")));
      }
      const messageAction = url.pathname.match(/^\/v1\/messages\/([^/]+)\/(ack|deliver)$/);
      if (messageAction && request.method === "POST") {
        const actor = agentIdentity(request);
        if (!actor) return sendJson(response, 401, { error: "x-agent-id is required" });
        const id = decodeURIComponent(messageAction[1]);
        const message = messageAction[2] === "ack"
          ? store.acknowledgeMessageBy(id, actor)
          : store.markMessageDeliveredBy(id, actor);
        return message
          ? sendJson(response, 200, { message })
          : sendJson(response, 403, { error: "agent is not the message recipient" });
      }
      if (url.pathname === "/v1/jobs" && request.method === "POST") {
        const body = await readJsonBody(request);
        if (!isNonEmptyString(body.kind) || !isNonEmptyString(body.requested_by) || !isOptionalId(body.id)) {
          return sendJson(response, 400, { error: "kind and requested_by are required" });
        }
        const payload = normalizeJobPayload({
          kind: body.kind,
          payload: body.payload,
          sourceHost: body.source_host,
          targetHost: body.target_host
        });
        const requiredCapability = requiredCapabilityForJob({ kind: body.kind, capability: body.capability, payload });
        const targetAgent = body.target_agent ?? (body.source_host ? store.findAgentForHost(body.source_host, requiredCapability)?.id : null);
        if (!targetAgent) return sendJson(response, 409, { error: "no target agent is registered" });
        if (!store.agentSupports(targetAgent, requiredCapability)) {
          return sendJson(response, 409, { error: "target agent does not provide the required capability" });
        }
        if (payload.workflow && store.getAgent(targetAgent)?.kind !== "codex") {
          return sendJson(response, 409, { error: "workflow tasks require a codex agent" });
        }
        const job = store.createJob({
          id: body.id,
          kind: body.kind,
          requiredCapability,
          maxAttempts: body.max_attempts,
          requestedBy: body.requested_by,
          targetAgent,
          sourceHost: body.source_host,
          targetHost: body.target_host,
          payload
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
        const actor = agentIdentity(request);
        if (!actor) return sendJson(response, 401, { error: "x-agent-id is required" });
        const body = await readJsonBody(request);
        if (body.agent_id !== actor) return sendJson(response, 403, { error: "agent identity does not match agent_id" });
        const id = decodeURIComponent(jobClaim[1]);
        const existing = store.getJob(id);
        if (!existing) return sendJson(response, 404, { error: "job not found" });
        if (!store.agentSupports(actor, existing.required_capability)) {
          return sendJson(response, 403, { error: "agent is offline or lacks the required capability" });
        }
        if (existing.target_agent && existing.target_agent !== actor) {
          return sendJson(response, 403, { error: "agent is not the job target" });
        }
        const job = store.claimJob(id, actor);
        return job ? sendJson(response, 200, { job }) : sendJson(response, 409, { error: "job is not available" });
      }
      const jobResult = url.pathname.match(/^\/v1\/jobs\/([^/]+)\/(complete|fail|cancel)$/);
      if (jobResult && request.method === "POST") {
        const actor = agentIdentity(request);
        if (!actor) return sendJson(response, 401, { error: "x-agent-id is required" });
        const id = decodeURIComponent(jobResult[1]);
        const action = jobResult[2];
        const body = await readJsonBody(request);
        const existing = store.getJob(id);
        if (!existing) return sendJson(response, 404, { error: "job not found" });
        if (action === "cancel" && actor !== existing.requested_by && actor !== existing.target_agent) {
          return sendJson(response, 403, { error: "agent is not authorized for this job" });
        }
        const job = action === "complete"
          ? store.completeJobBy(id, body.result, actor)
          : action === "fail"
            ? store.failJobBy(id, body.error, actor)
            : store.cancelJob(id);
        if (!job) return sendJson(response, 403, { error: "agent is not authorized for this job" });
        publishJobEvent(job);
        return sendJson(response, 200, { job });
      }
      return sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
      if (status === 500) console.error(error);
      return sendJson(response, status, { error: status === 500 ? "internal server error" : error.message });
    }
  });

  const close = () => {
    if (closed) return;
    closed = true;
    for (const listeners of subscribers.values()) {
      for (const response of listeners) {
        try { response.end(); } catch { /* The peer already closed the stream. */ }
      }
    }
    clearInterval(staleTimer);
    store.close();
    if (server.listening) server.close();
  };

  refreshStaleWork();
  return { server, store, close };

  function publishJobEvent(job) {
    const event = job.status === "queued" ? "job.created" : `job.${job.status}`;
    publish(job.status === "queued" ? job.target_agent : job.requested_by, event, job);
    if (job.status === "queued" && job.requested_by && job.requested_by !== job.target_agent) {
      publish(job.requested_by, event, job);
    }
  }

  function openEvents(agentId, request, response) {
    if (!agentId) return sendJson(response, 400, { error: "agent_id is required" });
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    if (response.write(`event: ready\ndata: ${JSON.stringify({ agent_id: agentId })}\n\n`) === false) {
      response.destroy?.();
      return;
    }
    if (!subscribers.has(agentId)) subscribers.set(agentId, new Set());
    subscribers.get(agentId).add(response);
    let keepAlive;
    const cleanup = () => {
      clearInterval(keepAlive);
      subscribers.get(agentId)?.delete(response);
      if (subscribers.get(agentId)?.size === 0) subscribers.delete(agentId);
    };
    keepAlive = setInterval(() => {
      try {
        if (response.write(": keep-alive\n\n") === false) {
          cleanup();
          response.destroy?.();
        }
      } catch { cleanup(); }
    }, 15000);
    request.on("close", cleanup);
    response.on("close", cleanup);
  }
}

function authenticate(request, token) {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

function agentIdentity(request) {
  const value = request.headers["x-agent-id"];
  return typeof value === "string" && value ? value : null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && Boolean(value.trim());
}

function isOptionalId(value) {
  return value === undefined || value === null || isNonEmptyString(value);
}

function sendJson(response, status, payload) {
  if (response.writableEnded || response.destroyed) return;
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (status === 204) {
    response.writeHead(status);
    response.end();
    return;
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}
