import { validateIdentifier } from "./identifiers.js";

export function normalizeJobPayload({ kind, payload, sourceHost = null, targetHost = null }) {
  const normalizedPayload = isRecord(payload) ? { ...payload } : {};
  if (kind !== "network.probe") return normalizedPayload;
  return {
    ...normalizedPayload,
    source_host: sourceHost ?? normalizedPayload.source_host ?? null,
    target_host: targetHost ?? normalizedPayload.target_host ?? null
  };
}

export function supportsCapability(capabilities, capability) {
  if (capability === null || capability === undefined) return true;
  const normalizedCapability = String(capability).trim();
  if (!normalizedCapability) return false;
  return Array.isArray(capabilities) && capabilities.includes(normalizedCapability);
}

export function requiredCapabilityForJob({ kind, capability, payload }) {
  const normalizedCapability = capability === null || capability === undefined ? "" : normalizeCapability(capability);
  if (kind === "agent.task" && payload?.execution_mode === "write") return "agent.task.write";
  return normalizedCapability || validateIdentifier(kind, "kind");
}

export function normalizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) return [];
  return [...new Set(capabilities.map(normalizeCapability).filter(Boolean))];
}

function normalizeCapability(value) {
  return validateIdentifier(String(value).trim(), "capability");
}

export function normalizeMetadata(metadata) {
  return isRecord(metadata) ? metadata : {};
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
