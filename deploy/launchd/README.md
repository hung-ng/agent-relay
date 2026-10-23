# launchd deployment

The plist files in this directory are templates. They contain placeholders and do not contain a host name, user path, or secret.

Copy the matching environment example, fill in values on the target machine, then render the plist:

```bash
cp deploy/launchd/server.env.example /tmp/agent-relay-server.env
${EDITOR:-vi} /tmp/agent-relay-server.env
set -a
. /tmp/agent-relay-server.env
set +a
node scripts/render-launchd.mjs \
  deploy/launchd/server.plist.template \
  "$HOME/Library/LaunchAgents/com.agent-relay.server.plist"
```

For a worker, use `worker.env.example`. Give every worker a unique `AGENT_ID`, keep `HOST_ID` stable, list the capabilities that its `Worker` implementation supports, and render it from a shell where the worker CLI is on `PATH`. The renderer carries that `PATH` into launchd, whose default environment does not include user-level package managers.

Keep `AGENT_CAPABILITIES=agent.task` for read-only Codex work. Add `agent.task.write` only on a worker and repository where unattended implementation edits are explicitly authorized. `AGENT_RELAY_TASK_TIMEOUT_MS` defaults to ten minutes and bounds each agent subprocess.

The renderer validates the values used by the selected template before creating directories or replacing a plist. Set absolute paths for `AGENT_RELAY_ROOT`, `NODE_BIN`, `AGENT_RELAY_DATA`, `AGENT_RELAY_LOG_DIR`, and `AGENT_RELAY_TOKEN_FILE` when the template uses them. The project directory must exist and `NODE_BIN` must be executable. `NODE_BIN` defaults to the Node executable running the renderer. Worker IDs cannot contain path separators because the worker template uses them in log filenames. Relay URLs must use HTTP or HTTPS. Ports must be between 1 and 65535, and task timeouts and backup retention must be positive integers.

The renderer creates missing data, log, backup, and output directories with mode `0700` as needed by the template. `AGENT_RELAY_DATA` defaults to `AGENT_RELAY_ROOT/data`; `AGENT_RELAY_LOG_DIR` defaults to `AGENT_RELAY_DATA/logs`. The monitor also writes to `AGENT_RELAY_DATA/logs`, so the renderer prepares that directory when launchd logs go elsewhere. Existing directory permissions stay unchanged.

Values are escaped for XML and inserted once. Text such as `@@AGENT_ID@@` inside a token or path stays literal. The renderer replaces the plist atomically with mode `0600` and preserves the existing plist if validation or replacement fails. Run `plutil -lint -- "$HOME/Library/LaunchAgents/com.agent-relay.server.plist"` before loading it with `launchctl bootstrap`.

Keep the environment files and rendered plists outside version control. The rendered files contain the bearer token.

The backup template runs daily at 03:15 and keeps seven copies by default. Set `AGENT_RELAY_BACKUP_RETENTION` before rendering to change that. The monitor template runs every 60 seconds and checks the relay plus the expected worker. Set `AGENT_RELAY_MONITOR_URL`, `AGENT_RELAY_TOKEN`, `AGENT_RELAY_TOKEN_FILE`, `AGENT_RELAY_MONITOR_AGENT_ID`, and `AGENT_RELAY_MONITOR_CAPABILITY` for the target machine. The monitor uses `AGENT_RELAY_TOKEN` directly and falls back to `AGENT_RELAY_TOKEN_FILE` when the direct value is absent.

Jobs retry three times by default. A failed job or a job abandoned by an offline worker is re-queued until `max_attempts` is reached, then remains in `failed` as a dead-letter record with its last error.

Upgrade the coordinator before its workers. The coordinator adds the claim-token column to existing databases automatically and accepts legacy worker claims during rollout. Current workers use claim tokens to reject results from expired attempts. They also receive cancellation events, check for missed cancellations during heartbeats, and terminate task subprocess groups on macOS and Linux. Older workers retain their previous cancellation behavior until upgraded.
