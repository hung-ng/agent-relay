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

The renderer fails when a required value is missing, escapes values for XML, and writes the plist with mode `0600`. Run `plutil -lint` before loading it with `launchctl bootstrap`.

Keep the environment files and rendered plists outside version control. The rendered files contain the bearer token.

The backup template runs daily at 03:15 and keeps seven copies by default. Set `AGENT_RELAY_BACKUP_RETENTION` before rendering to change that. The monitor template runs every 60 seconds and checks the relay plus the expected worker. Set `AGENT_RELAY_MONITOR_URL`, `AGENT_RELAY_TOKEN`, `AGENT_RELAY_TOKEN_FILE`, `AGENT_RELAY_MONITOR_AGENT_ID`, and `AGENT_RELAY_MONITOR_CAPABILITY` for the target machine. The monitor uses `AGENT_RELAY_TOKEN` directly and falls back to `AGENT_RELAY_TOKEN_FILE` when the direct value is absent.

Jobs retry three times by default. A failed job or a job abandoned by an offline worker is re-queued until `max_attempts` is reached, then remains in `failed` as a dead-letter record with its last error.
