export function normalizeJobPayload({ kind, payload, sourceHost = null, targetHost = null }) {
  if (kind !== "network.probe") return payload ?? {};
  return {
    ...(payload ?? {}),
    source_host: sourceHost ?? payload?.source_host ?? null,
    target_host: targetHost ?? payload?.target_host ?? null
  };
}

export function supportsCapability(capabilities, capability) {
  return !capability || capabilities.includes(capability);
}

export function requiredCapabilityForJob({ kind, capability, payload }) {
  if (kind === "agent.task" && payload?.execution_mode === "write") return "agent.task.write";
  return capability ?? kind;
}
