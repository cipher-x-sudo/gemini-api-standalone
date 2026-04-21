# Gemini Web API (standalone, Docker)

HTTP service wrapping [`gemini_webapi`](https://pypi.org/project/gemini-webapi/) (same family as [cipher-x-sudo/Gemini-API](https://github.com/cipher-x-sudo/Gemini-API)) for **always-on** Gemini Web sessions with **persisted cookies** on disk.

This is **not** the official Google Generative AI SDK; it uses browser session cookies and may violate Google’s terms if misused. Use at your own risk.

## Features

- **Single `docker-compose.yml`**: `gemini-api` + **`cloudflared`**, no manual `docker network create`.
- Compose **creates** a bridge network named **`gemini-prismacreative-net`** automatically on first `up`.
- **Docker + volume**: cookie data under `/data` (`gemini_data`).
- **Control UI** at `/ui`.

## Prerequisites

**Stop** any other `cloudflared` using the **same** `TUNNEL_TOKEN` (only one connector per tunnel).

## Quick start

```bash
cd gemini-api-standalone
cp .env.example .env
# Edit .env: ADMIN_API_KEY, TUNNEL_TOKEN
docker compose --env-file .env up -d --build
```

Open **`http://localhost:4000/ui`** or your public URL via Cloudflare.

### Same tunnel must reach `frontend` and `gemini-api`

This stack creates **`gemini-prismacreative-net`**. Your **Portico** (or other) services must **join that network** so Cloudflare routes like `http://frontend:80` still resolve.

In your **other** `docker-compose.yml` (where `frontend` runs), add:

```yaml
services:
  frontend:
    networks:
      - default          # keep your existing network(s)
      - prismacreative_shared

networks:
  prismacreative_shared:
    external: true
    name: gemini-prismacreative-net
```

Start **this** `gemini-api-standalone` stack **once** so the network exists, then add the snippet above to Portico and `docker compose up` Portico again.

**Ports**

| Where | What |
| ----- | ---- |
| Inside Docker | **`gemini-api:9380`** — Cloudflare route for Gemini |
| Inside Docker | **`frontend:80`** — only if `frontend` is attached to `gemini-prismacreative-net` |
| Host | **`localhost:4000`** — optional debug (`GEMINI_API_PORT`) |

## Cloudflare checklist

1. **Tunnel token** in `.env` as `TUNNEL_TOKEN`.
2. **Routes**: e.g. `gemini.prismacreative.online` → `http://gemini-api:9380`, `proxy.prismacreative.online` → `http://frontend:80` (requires `frontend` on `gemini-prismacreative-net` as above).

## Environment

| Variable | Description |
| -------- | ----------- |
| `ADMIN_API_KEY` | Bearer token for admin API + UI. |
| `TUNNEL_TOKEN` | Cloudflare tunnel connector token. |
| `GEMINI_INTERNAL_PORT` | Inside `gemini-api` (default **9380**). |
| `GEMINI_API_PORT` | Host port (default **4000**). |
| `GEMINI_API_CLIENT_KEY` | Optional `X-Gemini-Api-Key` for `/v1/*`. |
| `GEMINI_PROFILES_ROOT` | Directory for per-profile data (default **`/data/profiles`** in Docker). |
| `GEMINI_AUTO_ROTATE` | If `true`/`1`/`yes`/`on`, runs background **auto-rotation** of `__Secure-1PSIDTS` (same as upstream `auto_refresh`). Alias: `GEMINI_AUTO_REFRESH`. Default **true**. |
| `GEMINI_REFRESH_INTERVAL_SECONDS` | Seconds between rotation attempts when auto-rotate is on (minimum **60**; library clamps lower values). Default **600**. |

Restart the service after changing rotation settings so existing Gemini clients are recreated.

### Auto-rotate (session cookies)

The upstream client can run a background loop that refreshes Google session cookies (notably `__Secure-1PSIDTS`) so long-lived deployments stay authenticated. This service passes that through `GeminiClient.init(auto_refresh=…, refresh_interval=…)` and persists updated cookies under each profile’s `cookies.json`. Disable with `GEMINI_AUTO_ROTATE=false` if you prefer manual cookie updates only.

## HTTP API

Unless noted, JSON bodies use `Content-Type: application/json`.

### Public / health

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `GET` | `/health` | None | Liveness: `ok`, paths, whether admin/client key are configured, **`autoRotate`**, **`refreshIntervalSeconds`**. |
| `GET` | `/` | None | Redirects to `/ui`. |
| `GET` | `/ui` | None | Control panel HTML (cookie admin UI). |
| `GET` | `/admin` | None | Redirects to `/ui`. |

### Nexus-compatible (`/v1`)

All routes accept optional header **`X-Gemini-Profile`** (default `default`) to select a cookie profile. If **`GEMINI_API_CLIENT_KEY`** is set, every request must include **`X-Gemini-Api-Key`** with that value.

| Method | Path | Body | Description |
| ------ | ---- | ---- | ----------- |
| `POST` | `/v1/list-models` | `{ "cookies": { ... } }` | Lists models; `cookies` optional if profile already has `cookies.json` on disk. |
| `POST` | `/v1/generate` | `{ "prompt", "model"?, "responseMimeType"?, "images"?, "cookies"? }` | Text generation; optional `images`: `[{ "mimeType", "base64" }]`. |
| `POST` | `/v1/status` | `{ "cookies": { ... } }` | Account/session status for the current cookies. |

### Admin (Bearer token)

Send **`Authorization: Bearer <ADMIN_API_KEY>`**. If `ADMIN_API_KEY` is unset, these routes return **503**.

| Method | Path | Body | Description |
| ------ | ---- | ---- | ----------- |
| `GET` | `/admin/api/server` | — | Server metadata: `geminiWebapiVersion`, `profilesRoot`, flags, **`autoRotate`**, **`refreshIntervalSeconds`**. |
| `GET` | `/admin/api/profiles` | — | `{ "profiles": [ "id1", ... ] }`. |
| `POST` | `/admin/api/profiles` | `{ "profileId": "my-profile" }` | Creates profile directory. |
| `DELETE` | `/admin/api/profiles/{profile_id}` | — | Deletes profile data and closes cached client. |
| `GET` | `/admin/api/profiles/{profile_id}/cookies` | — | Masked cookies + `updatedAt` (never full secrets). |
| `POST` | `/admin/api/profiles/{profile_id}/cookies` | See `CookiesPayload` in `app/main.py` | Saves cookies for that profile; invalidates cached client. |

OpenAPI (Swagger) is available at **`/docs`** when the app is running.

## Layout on disk

```
/data/   (volume gemini_data)
  profiles/<profile>/cookies.json
```

## License

Upstream `gemini_webapi` is AGPL-3.0 — comply when redistributing.
