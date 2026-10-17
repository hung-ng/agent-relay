const WORKFLOWS = {
  prompt: {
    description: "Run the supplied prompt as written.",
    executionMode: "default",
    build: ({ prompt }) => prompt
  },
  review: {
    description: "Inspect the repository and return findings without editing files.",
    executionMode: "read_only",
    build: ({ prompt }) => [
      "Review the current repository for this task. Do not edit files.",
      `Task: ${prompt}`,
      "Inspect the relevant implementation, tests, and documentation before reaching a conclusion.",
      "Return findings with file paths and line references, evidence for each finding, and a short recommended next step."
    ].join("\n\n")
  },
  test: {
    description: "Run focused tests, then broader tests when useful, without editing files.",
    executionMode: "read_only",
    build: ({ prompt }) => [
      "Verify this task in the current repository. Do not edit files.",
      `Task: ${prompt}`,
      "Run the narrowest relevant checks first, then the broader test suite when it adds confidence.",
      "Return the exact commands run, the important output, any failures, and your diagnosis."
    ].join("\n\n")
  },
  implement: {
    description: "Implement the requested repository change and run relevant validation.",
    executionMode: "write",
    build: ({ prompt }) => [
      "Implement this task in the current repository.",
      `Requirements: ${prompt}`,
      "Inspect existing code and tests before editing. Keep the change focused and follow the repository's conventions.",
      "Run relevant tests before finishing. Return a concise summary of changed files, validation performed, and any remaining risks."
    ].join("\n\n")
  }
};

export function listWorkflows() {
  return Object.entries(WORKFLOWS).map(([name, value]) => ({ name, description: value.description }));
}

export function buildTaskPayload({ workflow = "prompt", prompt, cwd = null }) {
  const selected = WORKFLOWS[workflow];
  if (!selected) throw new Error(`unknown workflow: ${workflow}; choose one of ${Object.keys(WORKFLOWS).join(", ")}`);
  const normalizedPrompt = String(prompt ?? "").trim();
  if (!normalizedPrompt) throw new Error("a non-empty prompt is required");
  return {
    workflow,
    execution_mode: selected.executionMode,
    prompt: selected.build({ prompt: normalizedPrompt }),
    ...(cwd ? { cwd } : {})
  };
}
