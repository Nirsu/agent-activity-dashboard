# Fleet deploy — central server, TLS, auth

Goal: one dashboard the whole team's Claude Code points at. TLS is terminated by a
**Caddy** reverse proxy (automatic HTTPS); the Node server stays plain HTTP behind
it and enforces **token auth** in-app.

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
INGEST_TOKEN=<long-random-token>     # devs' machines present this
VIEWER_TOKEN=<different-random-token> # dashboard viewers present this
SESSION_TTL_MS=1800000
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

Each dev runs once (see `bootstrap.sh`):
```bash
TEAM_ID=stream-mobile \
DASHBOARD_URL=https://agents.example.com \
INGEST_TOKEN=<the-ingest-token> \
bash fleet/bootstrap.sh
```
New terminal → `claude`. Their sessions show up as an anonymized agent in their
stream. Prompt/tool **content is never sent** — only structural telemetry.

## 5. Viewers

Open `https://agents.example.com/?token=<VIEWER_TOKEN>` once; the token is stored in
the browser thereafter. Without a valid token, `/api/*` and `/live` return 401.

That `?token=` is a one-time bootstrap on the *page* URL only: the dashboard
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
- **Retention:** normalized detailed history is stored in SQLite and pruned
  after 60 rolling days by default (`RETENTION_DAYS=60`).
- **RGPD:** anonymization is on (`ANONYMIZE=1`) — no identities stored or shown. If
  you ever turn it off to show names, the CSE information-consultation + registry
  entry from the brief apply first.
