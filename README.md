# agent-relay

`agent-relay` is a small coordinator for local Claude Code, Codex, and host-side jobs. It gives every worker an identity, durable messages, targeted jobs, and live wakeups without requiring a peer-to-peer network.

It currently uses only Node.js built-ins. Node 22.13.0 or newer is required because the coordinator stores state through `node:sqlite`, which became available without `--experimental-sqlite` in that release.

## Run the coordinator

On the machine that should host the bus:

```bash
npm start -- --host 127.0.0.1 --port 8787
```

Set `AGENT_RELAY_TOKEN` before allowing network access. Keep remote workers behind Tailscale or another private HTTPS network. The relay assumes trusted workers under one operator.

JSON request bodies are limited to 1 MiB and 128 nested objects or arrays, including the root object. They require valid UTF-8. The HTTP and MCP endpoints reject malformed encoding or excessive nesting with HTTP 400 before storing messages or jobs. Braces and brackets inside strings do not count toward the nesting limit.

Message and job IDs are trimmed at creation and limited to 4096 characters after `encodeURIComponent`. Reply message IDs allow 4104 characters to fit the generated `reply:` prefix. IDs cannot be `.` or `..`, contain NUL, or contain unpaired Unicode surrogates. Agent identities and sender, recipient, and requester references must also roundtrip the `X-Agent-Id` header without changes, so they require Latin-1 characters, no ASCII control characters, and no leading or trailing spaces. Hosts and conversation IDs cannot contain NUL or unpaired surrogates. Message bodies and job payload text retain their Unicode support.

Capabilities, agent and job kinds, and message types reject NUL and unpaired Unicode surrogates before storage. Valid Unicode capability names remain supported.

For a coordinated credential change, the coordinator can temporarily accept the old credential through `AGENT_RELAY_PREVIOUS_TOKEN` while `AGENT_RELAY_TOKEN` holds the new one. A previous token requires a nonempty primary token. After every worker and client has switched, remove the previous token and restart the coordinator to revoke it. Both credentials grant the same access during the overlap.

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

The coordinator exposes a small MCP endpoint at `/mcp`. Tool result text uses compact JSON so indentation cannot inflate deeply nested results.

It negotiates protocol `2025-06-18` during initialization. Unsupported `MCP-Protocol-Version` headers receive HTTP 400 before tool execution. Requests without that header remain accepted for existing clients. The endpoint accepts POST messages; GET streams and DELETE session requests receive HTTP 405 with `Allow: POST`, following the [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle) and [transport rules](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

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

Each worker executes one item at a time while continuing to read events. Every 15 seconds it sends a heartbeat and starts a recovery pass if the previous pass has finished. Recovery checks active claims and fetches up to 200 pending messages and 200 jobs. Slow recovery reads do not delay heartbeat requests. A failed pending read leaves the live event stream open, and later recovery passes retry it. This recovers missed wakeups and drains backlogs larger than one batch. Workers register again after reconnecting or when a heartbeat reports that their registration is missing.

Workers send their identity in the `X-Agent-Id` header. The server checks that header when a worker reads pending work, delivers or acknowledges a message, claims a job, sends a job result, or heartbeats. When `AGENT_RELAY_TOKEN` is set, workers also send the matching bearer token.

Current workers claim jobs with `claim_token_version: 1` and include the returned `claim_token` when completing or failing the job. An expired attempt cannot change a newer attempt. Legacy claims remain supported for staged upgrades, but workers need the current claim protocol for this protection.

Jobs require a capability. The HTTP API uses `kind` as the capability by default, or accepts an explicit `capability` field. Host-based dispatch selects only online agents that advertise that capability.

Jobs retry up to three times by default. Set `max_attempts` from 1 to 10 when creating a job. A job returns to `queued` after a failed attempt or when its worker goes offline, and becomes `failed` after the final attempt, which gives callers a dead-letter state to inspect.

Workers can report a permanent failure with `retryable: false` on the failure endpoint. The job then becomes `failed` immediately. Current workers use this when the relay rejects a result that cannot be delivered, so completed work does not run repeatedly because its report is too large.

Execution can repeat after a disconnect or retry. Tasks with side effects must tolerate repeated execution. Reusing a creation ID prevents duplicate records, but does not guarantee a task runs only once.

While a worker stays running, it retains undelivered job results and message replies so it can resend them after a network error without repeating the same execution. These cached results do not survive a worker restart.

Heartbeats also revisit cached message replies when an acknowledgement response was lost. If the server already acknowledged the message, the worker releases the cached reply without running the task again.

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

- `prompt` runs the supplied prompt as written in a read-only sandbox with no approval prompt.
- `review` asks Codex to inspect the repository and return findings without editing files. It runs with a read-only sandbox and no approval prompt.
- `test` asks Codex to run focused checks and report the evidence without editing files. It runs with a read-only sandbox and no approval prompt.
- `implement` asks Codex to make the requested change and run relevant validation. It requires a worker advertising `agent.task.write`; that capability enables a workspace-write sandbox with no approval prompt, so only grant it to an isolated worker you intend to authorize for unattended edits.

Use `--source-host` instead of `--target-agent` when the relay should select an online worker for a host. Use `--wait-ms 0` to submit without polling, or `--cwd` to select the repository directory on the worker. The workflow name remains in the job payload so later policy and audit rules can distinguish read-only reviews from implementation work.

Host-based workflow requests select an online Codex worker with the required capability.

Pass `--id YOUR_STABLE_ID` when submitting a task that you may need to retry after a timeout. The same ID returns the original job, including when its worker has since gone offline. Workflow execution modes must match their workflow, and implementation work always requires `agent.task.write`.

The CLI also supports durable follow-up actions:

```bash
node src/cli.js task status --server https://mini.example.ts.net --job-id JOB_ID
node src/cli.js task wait --server https://mini.example.ts.net --job-id JOB_ID --wait-ms 120000
node src/cli.js task cancel --server https://mini.example.ts.net --job-id JOB_ID --requested-by operator@mini
```

Cancellation changes the durable job state and sends an event to the target worker. Current workers abort the running task when they receive that event or observe the cancelled state during a heartbeat. On macOS and Linux, cancellation, task timeout, and worker shutdown terminate the subprocess group, escalating to `SIGKILL` after five seconds if it has not exited. Probe cancellation closes its active connection and skips remaining checks.

A cancellation response confirms the stored state. An unreachable or older worker may still be executing, so confirm that it has stopped before repeating work with side effects.

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

On macOS and Linux, every CLI exit terminates remaining subprocesses in its process group. A successful task cannot leave those subprocesses running or wait indefinitely for output pipes they inherited.

Workers send prompts through stdin, so large prompts and text beginning with a CLI flag stay task input. Codex tasks use a read-only sandbox and `approval_policy="never"` unless they explicitly request authorized write execution. Claude print workers use `dontAsk` permission mode, which denies operations that require an interactive permission prompt.

Captured stdout and stderr each have a limit of 128,000 characters and 256,000 JSON-encoded bytes. Results include `stdout_truncated` and `stderr_truncated` flags. This keeps job results and message replies within the relay's request limit. Large probe reports retain bounded check details and report any omitted details while still executing every requested check.

## Development

```bash
npm run check
npm test
```

The test suite uses in-memory and temporary SQLite databases. Integration tests open ephemeral ports on `127.0.0.1`, run fake agent tasks, and verify worker recovery, retries, cancellation, CLI idempotency, and the smoke script. It does not call Claude or Codex or connect to deployed workers.

GitHub Actions runs these checks on pushes and pull requests across Node 22, 24, and 26 on Ubuntu and macOS.

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

The monitor checks all three endpoints concurrently with a ten-second request timeout and requires successful health and readiness payloads. It replaces its state file atomically. A SQLite lock prevents overlapping backups and releases automatically if the backup process exits or crashes.

Backup recovery removes abandoned snapshot partials under the SQLite lock. Retention always keeps the snapshot just verified, including when the system clock moves backward. Cleanup and retention preserve the source database through symlinks and hard links. A backup destination that points to the source is rejected. Only backup scripts using the SQLite lock participate in writer exclusion; older PID-file-only scripts do not coordinate with current writers.

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

Database and backup files use mode `0600`; new data and backup directories use `0700`. Backups require an existing source database and verify SQLite integrity before keeping a copy under `data/backups`. Keep a copy on another disk or machine. Restoring one requires stopping the server, moving the current database aside, copying the selected backup to `data/agent-relay.db`, and starting the server again.
