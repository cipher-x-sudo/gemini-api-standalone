# Gemini Web API (standalone, Docker)

HTTP service wrapping [`gemini_webapi`](https://pypi.org/project/gemini-webapi/) (same family as [cipher-x-sudo/Gemini-API](https://github.com/cipher-x-sudo/Gemini-API)) for **always-on** Gemini Web sessions with **persisted cookies** on disk.

This is **not** the official Google Generative AI SDK; it uses browser session cookies and may violate Google’s terms if misused. Use at your own risk.

## Features

- **Single `docker-compose.yml`**: `gemini-api` + **`cloudflared`** on one shared external Docker network with your other stacks (`frontend`, etc.).
- **Docker + volume**: Cookie data under `/data` (named volume `gemini_data`).
- **Multi-profile**: header `X-Gemini-Profile` isolates cookies per Google account.
- **Control UI** at `/ui` for cookies, models from Gemini Web, and test calls.

## Prerequisites

1. A **Docker network** that your other services already use (e.g. `portico_default`). It must **exist** before `docker compose up` (`docker network ls`). If your main compose creates it, start that stack once first, or run `docker network create portico_default`.
2. **Stop** any other `cloudflared` container using the **same** `TUNNEL_TOKEN` (only one connector per tunnel).

## Quick start

```bash
cd gemini-api-standalone
cp .env.example .env
# Edit .env: ADMIN_API_KEY, TUNNEL_TOKEN, DOCKER_NETWORK
docker compose --env-file .env up -d --build
```

Open **`http://localhost:4000/ui`** (or your host port) for the control panel, or **`https://gemini.prismacreative.online/ui`** via Cloudflare once routes are saved.

**Ports**

| Where | What |
| ----- | ---- |
| Inside Docker | **`gemini-api:9380`** — use this in Cloudflare **Published application route → Service** |
| Host | **`localhost:4000`** (default `GEMINI_API_PORT`) — debugging only |

**Cloudflare Zero Trust** (same tunnel as `frontend`): add a route e.g. `gemini.prismacreative.online` → **`http://gemini-api:9380`**.

## Cloudflare checklist

1. **Tunnel token**: Zero Trust → **Networks** → **Tunnels** → your tunnel → **Configure** → copy token into `.env` as `TUNNEL_TOKEN`.
2. **Published routes** (example): `proxy…` → `http://frontend:80`, `gemini…` → `http://gemini-api:9380`.
3. **Access** (optional): protect the hostname with Cloudflare Access.
4. **SSL/TLS** (zone): **Full** is typical with tunnel → origin HTTP.

## Environment

| Variable | Description |
| -------- | ----------- |
| `ADMIN_API_KEY` | Bearer token for admin API + UI auth. |
| `TUNNEL_TOKEN` | Cloudflare tunnel connector token (required). |
| `DOCKER_NETWORK` | **Existing** external network name (e.g. `portico_default`). |
| `GEMINI_INTERNAL_PORT` | Inside `gemini-api` (default **9380**). Must match tunnel URL. |
| `GEMINI_API_PORT` | Published host port (default **4000**). |
| `GEMINI_API_CLIENT_KEY` | Optional; if set, required as `X-Gemini-Api-Key` on `/v1/*`. |

## Layout on disk

```
/data/   (Docker volume gemini_data)
  profiles/
    <profile>/
      cookies.json
      .cached_cookies_*.json   # gemini_webapi cache when GEMINI_COOKIE_PATH is set
```

## License

Upstream `gemini_webapi` is AGPL-3.0 — comply when redistributing.
