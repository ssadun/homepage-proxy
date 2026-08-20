# Homepage Hostname Proxy

Transparent reverse proxy for Homepage that rewrites NAS hostnames in navigable links so links stay consistent with the hostname the user used to open the dashboard.

Example:
- User opens Homepage at `http://nas-docker:3085`
- A service link in payload is `http://nas:5055`
- Proxy rewrites it to `http://nas-docker:5055`

## Why This Exists

Homepage service links can point to one NAS alias (for example `nas`) while users may open Homepage through another alias (`nas-docker`, `nas.local`, Tailscale name, and so on). This proxy normalizes link hostnames at response time.

## What It Rewrites

The proxy rewrites hostname aliases in:
- HTML link attributes: `href`, `src`, `action`
- JSON link-like fields: `href`, `link`, `redirect`

`url` and `siteMonitor` fields are deliberately **not** rewritten — Homepage
fetches those server-side (widget data, monitor pings) using the real
internal hostname (e.g. `http://nas:3000`). Rewriting them would point the
backend's own outbound request at the public-facing hostname/port, which is
usually not routable and breaks widgets.

Only responses with these content types are processed:
- `text/html`
- `application/json`

Rewrites are applied only when the request host is in `NAS_HOSTNAMES`.

## Environment Variables

- `TARGET` (default: `http://localhost:3080`)
: Upstream Homepage URL.
- `PORT` (default: `3000`)
: Port the proxy listens on in the container.
- `NAS_HOSTNAMES` (default: `nas,nas-docker`)
: Comma-separated list of host aliases that should be treated as equivalent.

## Run With Docker Compose

This repo includes [compose.yaml](compose.yaml).

1. Adjust `TARGET`, `PORT`, and `NAS_HOSTNAMES` in [compose.yaml](compose.yaml).
2. Start the service:

```bash
docker-compose up --build -d
```

3. Open Homepage through the proxy host/port, for example:

```text
http://nas-docker:3085
```

## Local Run (Node)

1. Install deps:

```bash
npm install
```

2. Set env vars (optional) and start:

```bash
TARGET=http://homepage:3080 PORT=3085 NAS_HOSTNAMES=nas,nas.local,nas-docker npm start
```

## Project Files

- [proxy.js](proxy.js): Rewrite and proxy logic
- [compose.yaml](compose.yaml): Compose service definition
- [dockerfile](dockerfile): Container build image
- [package.json](package.json): Node metadata and dependencies

## Notes

- WebSocket upgrades are forwarded.
- Compressed upstream responses (`gzip`, `br`, `deflate`) are decompressed before rewrite.
- The proxy logs request and rewrite summaries to help with troubleshooting.

## Troubleshooting

### Link still points to old hostname

- Hard refresh the browser (`Ctrl+Shift+R`) to avoid cached payloads.
- Confirm you are opening Homepage through the proxy port (for example `:3085`) and not directly through the upstream app.
- Verify `NAS_HOSTNAMES` includes every alias you use, including local and DNS variants.

### Proxy is running but links are not rewritten

- Check logs with:

```bash
docker-compose logs -f homepage-proxy
```

- Ensure requests show the expected `host` and `rewrite: true` in log lines.
- Confirm response content type is `text/html` or `application/json`.

### Container cannot reach Homepage target

- Verify `TARGET` points to a reachable service from inside the container network.
- If using custom networking, make sure the proxy container and Homepage container are on the same network.
- Confirm the upstream port in `TARGET` is correct.

### Changes in proxy.js not applied

- Rebuild and restart:

```bash
docker-compose down
docker-compose up --build -d
```

- If behavior still looks stale, inspect running container logs again after a hard refresh.