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

For a worker, use `worker.env.example`. Give every worker a unique `AGENT_ID`, keep `HOST_ID` stable, and list the capabilities that its `Worker` implementation supports.

The renderer fails when a required value is missing, escapes values for XML, and writes the plist with mode `0600`. Run `plutil -lint` before loading it with `launchctl bootstrap`.

Keep the environment files and rendered plists outside version control. The rendered files contain the bearer token.
