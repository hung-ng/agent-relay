import { normalizeJobPayload, requiredCapabilityForJob } from "./routing.js";
import { executionModeForWorkflow } from "./workflows.js";

export function dispatchJob({ store, publish }, input) {
  for (const field of ["kind", "requested_by"]) requireString(input[field], field);
  for (const field of ["id", "target_agent", "source_host", "target_host", "capability"]) {
    if (input[field] !== undefined && input[field] !== null) requireString(input[field], field);
  }
  if (input.max_attempts !== undefined && (!Number.isInteger(input.max_attempts) || input.max_attempts < 1 || input.max_attempts > 10)) {
    throw requestError("max_attempts must be an integer from 1 to 10");
  }
  if (input.payload !== undefined && (input.payload === null || typeof input.payload !== "object" || Array.isArray(input.payload))) {
    throw requestError("payload must be a JSON object");
  }

  const existing = input.id ? store.getJob(input.id.trim()) : null;
  if (existing) return existing;

  const payload = normalizeJobPayload({
    kind: input.kind,
    payload: input.payload,
    sourceHost: input.source_host,
    targetHost: input.target_host
  });
  if (input.kind === "agent.task") {
    requireString(payload.prompt, "payload.prompt");
    if (payload.cwd !== undefined) requireString(payload.cwd, "payload.cwd");
    if (payload.task_timeout_ms !== undefined && (!Number.isInteger(payload.task_timeout_ms) || payload.task_timeout_ms < 1 || payload.task_timeout_ms > 86_400_000)) {
      throw requestError("payload.task_timeout_ms must be an integer from 1 to 86400000");
    }
    if (payload.workflow !== undefined) {
      let executionMode;
      try { executionMode = executionModeForWorkflow(payload.workflow); }
      catch (error) { throw requestError(error.message); }
      if (payload.execution_mode !== undefined && payload.execution_mode !== executionMode) {
        throw requestError("execution_mode does not match the workflow");
      }
      payload.execution_mode = executionMode;
    }
    if (payload.execution_mode !== undefined && !["default", "read_only", "write"].includes(payload.execution_mode)) {
      throw requestError("unknown execution_mode");
    }
  }

  const requiredCapability = requiredCapabilityForJob({ kind: input.kind, capability: input.capability, payload });
  const targetAgent = input.target_agent ?? (input.source_host ? store.findAgentForHost(input.source_host, requiredCapability)?.id : null);
  if (!targetAgent) throw requestError("no target agent is registered", 409);
  if (!store.agentSupports(targetAgent, requiredCapability)) throw requestError("target agent does not provide the required capability", 409);
  if ((payload.workflow || ["read_only", "write"].includes(payload.execution_mode)) && store.getAgent(targetAgent)?.kind !== "codex") {
    throw requestError("workflow tasks require a codex agent", 409);
  }
  const job = store.createJob({
    id: input.id,
    kind: input.kind,
    requiredCapability,
    maxAttempts: input.max_attempts,
    requestedBy: input.requested_by,
    targetAgent,
    sourceHost: input.source_host,
    targetHost: input.target_host,
    payload
  });
  publish(job.target_agent, "job.created", job);
  return job;
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw requestError(`${field} must be a non-empty string`);
}

function requestError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
