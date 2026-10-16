# agent-relay

`agent-relay` is a small coordinator for local Claude Code, Codex, and host-side jobs. It gives every worker an identity, durable messages, targeted jobs, and live wakeups without requiring a peer-to-peer network.

It currently uses only Node.js built-ins. Node 22.5 or newer is required because the coordinator stores state in SQLite through `node:sqlite`.

## Run the coordinator

On the machine that should host the bus:

```bash
npm start -- --host 127.0.0.1 --port 8787
```

Set `AGENT_RELAY_TOKEN` before allowing network access. Keep remote workers behind Tailscale or another private HTTPS network. The relay assumes trusted workers under one operator.

## Run workers

Workers register an agent, keep a heartbeat, listen for jobs, and execute supported work locally.

```bash
# Probe worker on the MacBook
node src/cli.js worker \
  --server https://mini.example.ts.net \
  --agent probe@macbook \
  --host macbook \
  --kind probe

# Probe worker on the Mac mini
node src/cli.js worker \
  --server https://mini.example.ts.net \
  --agent probe@mac-mini \
  --host mac-mini \
  --kind probe

# Headless Claude worker
node src/cli.js worker \
  --server https://mini.example.ts.net \
  --agent claude@macbook \
  --host macbook \
  --kind claude \
  --capabilities agent.task

# Headless Codex worker
node src/cli.js worker \
  --server https://mini.example.ts.net \
  --agent codex@mac-mini \
  --host mac-mini \
  --kind codex \
  --capabilities agent.task
```

Run each worker under `launchd` so it reconnects after a reboot. The worker makes outbound requests to the coordinator, so the coordinator does not need to open an inbound port on every host.

## Connect Claude Code and Codex

The coordinator exposes a small MCP endpoint at `/mcp`.

```bash
claude mcp add --transport http agent-relay \
  https://mini.example.ts.net/mcp

codex mcp add agent-relay \
  --url https://mini.example.ts.net/mcp
```

If authentication is enabled, add the bearer token using the auth-header option supported by your local client, or put the MCP endpoint behind a private authenticated proxy.

The MCP tools are:

- `register_agent`
- `list_agents`
- `send_message`
- `get_inbox`
- `wait_for_message`
- `ack_message`
- `dispatch_job`
- `run_probe`
- `get_job`
- `wait_for_job`

Agents identify themselves with stable names such as `claude@macbook` or `codex@mac-mini`. A host can run several agents.

An interactive agent should call `register_agent` when it starts. Workers register themselves automatically.

When a `message`, `request`, or `task` is sent to a Claude or Codex worker, the worker starts a headless agent turn and sends the output back as a `reply`. Probe-only workers keep messages as durable inbox entries instead.

Workers replay unfinished messages and jobs whenever they connect or reconnect. A message stays replayable until it is acknowledged. A job stays replayable while it is queued or running for that worker, so a disconnect does not lose work that is already in the SQLite store.

Workers send their identity in the `X-Agent-Id` header. The server checks that header when a worker reads pending work, delivers or acknowledges a message, claims a job, sends a job result, or heartbeats. When `AGENT_RELAY_TOKEN` is set, workers also send the matching bearer token.

Jobs require a capability. The HTTP API uses `kind` as the capability by default, or accepts an explicit `capability` field. Host-based dispatch selects only online agents that advertise that capability.

Jobs retry up to three times by default. Set `max_attempts` from 1 to 10 when creating a job. A job returns to `queued` after a failed attempt or when its worker goes offline, and becomes `failed` after the final attempt, which gives callers a dead-letter state to inspect.

Execution can repeat after a disconnect or retry. Tasks with side effects must tolerate repeated execution. Reusing a creation ID prevents duplicate records, but does not guarantee a task runs only once.

## Run a Codex workflow

The CLI provides a repeatable task envelope for an `agent.task` worker. It submits the task, waits for a terminal job state, and prints the resulting job as JSON:

```bash
AGENT_RELAY_URL="https://mini.example.ts.net" \
AGENT_RELAY_TOKEN="..." \
node src/cli.js task \
  --target-agent codex@macbook \
  --requested-by operator@mini \
  --workflow review \
  --prompt "Review the relay health checks and identify the next focused improvement"
```

The initial workflows are:

- `prompt` runs the supplied prompt as written.
- `review` asks Codex to inspect the repository and return findings without editing files. It runs with a read-only sandbox and no approval prompt.
- `test` asks Codex to run focused checks and report the evidence without editing files. It runs with a read-only sandbox and no approval prompt.
- `implement` asks Codex to make the requested change and run relevant validation. It requires a worker advertising `agent.task.write`; that capability enables a workspace-write sandbox with no approval prompt, so only grant it to an isolated worker you intend to authorize for unattended edits.

Use `--source-host` instead of `--target-agent` when the relay should select an online worker for a host. Use `--wait-ms 0` to submit without polling, or `--cwd` to select the repository directory on the worker. The workflow name remains in the job payload so later policy and audit rules can distinguish read-only reviews from implementation work.

The CLI also supports durable follow-up actions:

```bash
node src/cli.js task status --server https://mini.example.ts.net --job-id JOB_ID
node src/cli.js task wait --server https://mini.example.ts.net --job-id JOB_ID --wait-ms 120000
node src/cli.js task cancel --server https://mini.example.ts.net --job-id JOB_ID --requested-by operator@mini
```

Cancellation changes the durable job state. It does not terminate a subprocess already running on the worker. Inspect that process on the worker before retrying a cancelled operational task.

## Example network test

From Claude Code or Codex, call `run_probe` with:

```json
{
  "requested_by": "codex@macbook",
  "source_host": "macbook",
  "target_host": "mac-mini",
  "checks": [
    { "type": "dns", "name": "mini.example.ts.net" },
    { "type": "tcp", "host": "mini.example.ts.net", "port": 8787 },
    { "type": "http", "url": "http://mini.example.ts.net:8080/health" }
  ]
}
```

The bus chooses the registered probe worker on `macbook`, sends it the job immediately, and routes the result back to `codex@macbook`. A reverse test uses `source_host: "mac-mini"`.

The same request can be sent over HTTP when a script or another service needs to start work:

```bash
curl -X POST http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "sender": "service-monitor",
    "recipient": "claude@macbook",
    "type": "request",
    "payload": { "body": "Check the latest probe failure and explain the likely cause." }
  }'
```

Message and job creation accepts an optional caller-supplied `id`. Reuse that ID when retrying a request after a network timeout; the relay returns the original record instead of creating a duplicate.

## Extend the worker

The first worker supports `network.probe` and `agent.task`. Add another job type in `Worker.handleJob`, keep its input typed, and return structured output. Avoid exposing arbitrary remote shell commands. Give sensitive actions their own capability and approval check.

Agent tasks stop after ten minutes by default so a stalled subprocess cannot hold a durable job forever. Set `AGENT_RELAY_TASK_TIMEOUT_MS` or pass `--task-timeout-ms` to the worker to change the limit, up to 24 hours.

## Development

```bash
npm test
```

The test suite uses an in-memory SQLite database and does not open a network port.

## Run with launchd

The repository includes parameterized templates and environment examples in `deploy/launchd`. Render each template with the values for that machine. The renderer writes a private plist and refuses to render when a required value is missing.

```bash
export AGENT_RELAY_ROOT="$PWD"
export AGENT_RELAY_DATA="$PWD/data"
export AGENT_RELAY_TOKEN="choose-a-long-random-token"

AGENT_RELAY_HOST=0.0.0.0 \
  node scripts/render-launchd.mjs \
  deploy/launchd/server.plist.template \
  "$HOME/Library/LaunchAgents/com.agent-relay.server.plist"

AGENT_RELAY_URL="https://mini.example.ts.net" \
AGENT_ID="probe@macbook" \
HOST_ID="macbook" \
AGENT_KIND="probe" \
AGENT_CAPABILITIES="network.probe" \
  node scripts/render-launchd.mjs \
  deploy/launchd/worker.plist.template \
  "$HOME/Library/LaunchAgents/com.agent-relay.worker.probe@macbook.plist"
```

Check the rendered files and load them with launchd:

```bash
plutil -lint "$HOME/Library/LaunchAgents/com.agent-relay.server.plist"
plutil -lint "$HOME/Library/LaunchAgents/com.agent-relay.worker.probe@macbook.plist"
launchctl bootstrap "gui/$UID" "$HOME/Library/LaunchAgents/com.agent-relay.server.plist"
launchctl bootstrap "gui/$UID" "$HOME/Library/LaunchAgents/com.agent-relay.worker.probe@macbook.plist"
npm run smoke
```

Before using a remote worker, choose the server bind address, private URL, port, data directory, bearer token, and stable agent and host IDs. Keep the plist files private because they contain the bearer token. Put a server bound beyond localhost behind Tailscale or another private HTTPS proxy.

The server can also run a daily SQLite backup and a minute-by-minute monitor. Render `backup.plist.template` and `monitor.plist.template` with the same `AGENT_RELAY_ROOT`, `AGENT_RELAY_DATA`, and `AGENT_RELAY_LOG_DIR` values. Set `AGENT_RELAY_BACKUP_RETENTION` to the number of daily copies to keep. The monitor checks `/healthz`, `/readyz`, and the expected online worker capability, then records its last result in `data/monitor-state.json`.

Load these jobs after rendering them:

```bash
backup_label="com.agent-relay.backup"
monitor_label="com.agent-relay.monitor"
launch_domain="gui/$(id -u)"

launchctl bootout "$launch_domain/$backup_label" 2>/dev/null || true
launchctl bootout "$launch_domain/$monitor_label" 2>/dev/null || true
launchctl bootstrap "$launch_domain" "$HOME/Library/LaunchAgents/$backup_label.plist"
launchctl bootstrap "$launch_domain" "$HOME/Library/LaunchAgents/$monitor_label.plist"
```

Backups are verified SQLite files under `data/backups`. Keep a copy on another disk or machine. Restoring one requires stopping the server, moving the current database aside, copying the selected backup to `data/agent-relay.db`, and starting the server again.
