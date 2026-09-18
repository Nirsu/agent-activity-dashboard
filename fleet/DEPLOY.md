# Fleet deploy — central server, TLS, auth

Goal: one dashboard the team's Codex and Claude Code clients point at. TLS is terminated by a
**Caddy** reverse proxy (automatic HTTPS); the Node server stays plain HTTP behind
it and enforces **token auth** in-app.

For developer enrollment, local project selection and the transition from live
telemetry to Brain reviews, follow [the deployed workflow](SETUP.md#after-deploying-the-shared-dashboard).
Each developer needs the local relay; deploying the server alone does not connect
their clients or authorize their repositories.

```
 developers' Macs ──https──►  Caddy (:443, auto-TLS)  ──http──►  aad server (:4318)
   OTLP + hooks                agents.example.com                 (Node, systemd)
      ▲ INGEST_TOKEN                                              ANONYMIZE=1
 viewers' browsers ──https──►  Caddy  ──►  dashboard UI (static) + /api,/live
      ▲ VIEWER_TOKEN
```

## 1. Server on the VM

```bash
git clone <repo> /opt/aad && cd /opt/aad && npm ci && npm run build
```

`/etc/aad.env`:

```
PORT=4318
HOST=127.0.0.1
ANONYMIZE=1
ANONYMIZE_SALT=<random-stable-string>
# Developers' hooks and telemetry present this token.
INGEST_TOKEN=<long-random-token>
# Dashboard viewers and Brain MCP clients present this separate token.
VIEWER_TOKEN=<different-random-token>
BRAIN_ADMIN_TOKEN=<separate-administrator-token>
SESSION_TTL_MS=1800000
DATABASE_URL=postgresql://<user>:<password>@<private-db-host>:5432/<database>
```

systemd unit `/etc/systemd/system/aad.service`:

```
[Unit]
Description=Agent Activity Dashboard
After=network.target
[Service]
EnvironmentFile=/etc/aad.env
WorkingDirectory=/opt/aad
ExecStart=/usr/bin/node server/dist/index.js
Restart=always
User=aad
[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now aad
```

## 2. Build + host the UI

```bash
cd /opt/aad/ui && VITE_SERVER_URL=https://agents.example.com npm run build
# serves ui/dist as static files (Caddy below)
```

## 3. Caddy (auto-TLS + reverse proxy)

`/etc/caddy/Caddyfile`:

```
agents.example.com {
    encode zstd gzip
    # API + telemetry ingest + WebSocket -> Node
    @api path /v1/* /activity /api/* /live /healthz
    handle @api {
        reverse_proxy 127.0.0.1:4318
    }
    # Everything else -> the built dashboard UI
    handle {
        root * /opt/aad/ui/dist
        try_files {path} /index.html
        file_server
    }
}
```

Caddy fetches a certificate automatically and proxies WebSocket upgrades for `/live`
with no extra config.

## 4. Onboard developers

Use the cross-platform [developer setup](SETUP.md) once per developer account and
machine:

```bash
npm run agents:setup -- --url https://agents.example.com --team stream-mobile --apply
npm run agents:projects -- --allow /absolute/path/to/project
npm run agents:relay
```

Configure the administrator-provided ingest and MCP authentication separately,
in the local relay environment (`AAD_TOKEN`) and client MCP settings respectively,
then restart the clients and complete the trust and account setup described in
that guide. The installer does not provision shared-server credentials.
The local relay filters every developer's selection before sending activity to
this shared server. An empty selection sends nothing. The older `bootstrap.sh`
delegates to this installer for Claude; do not keep older direct hooks or shell
exports alongside it. Hook payloads contain structural metadata, not prompt or tool content.

## 5. Viewers

Open `https://agents.example.com/?token=<VIEWER_TOKEN>` once; the token is stored in
the browser thereafter. Without a valid token, `/api/*` and `/live` return 401.

That `?token=` is a one-time bootstrap on the _page_ URL only: the dashboard
moves it into `localStorage` and strips it from the address bar immediately.
Subsequent API calls use the `x-aad-token` header and `/live` uses the WebSocket
subprotocol. The initial page request still contains the token in its query
string: URL cleanup in the browser cannot remove it from proxy or server logs
already written. Configure those systems to omit or redact that query parameter,
and do not distribute or record token-bearing URLs as ordinary links.

## Notes

- **Auth is app-enforced**, so even if the port were exposed, ingest/viewer routes
  reject tokenless requests. Keep the two tokens distinct and rotate by editing
  `/etc/aad.env` + `systemctl restart aad`.
- **Storage:** `DATABASE_URL` selects PostgreSQL; without it the server uses SQLite.
  Run one application worker. Follow [POSTGRES.md](../POSTGRES.md) for explicit
  migration, backups and the separate local Docker database.
- **Retention:** normalized detailed history is pruned after 60 rolling days by
  default (`RETENTION_DAYS=60`). Brain captures and analysis evidence have their own
  lifecycle; this history retention setting does not delete them.
- **Identity:** `ANONYMIZE=1` replaces reported email identities with pseudonyms.
  Repository, branch and workspace metadata remain visible. If
  you ever turn it off to show names, the CSE information-consultation + registry
  entry from the brief apply first.
