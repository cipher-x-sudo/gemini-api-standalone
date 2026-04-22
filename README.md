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
| `GEMINI_V1_DEFAULT_PROFILE` | Used when **`X-Gemini-Profile` is omitted**. Default **`default`**. Set to **`random`** (or `any` / `*`) to pick a **random** profile that already has saved `cookies.json` (same effect as sending header `X-Gemini-Profile: random`). |

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

**Cookies in the JSON body are optional.** If you omit `cookies` (or send `null`), the server uses **`profiles/<profile>/cookies.json`** for the chosen profile. Body cookies, when present, **override** on-disk values for that request only.

**Profile selection:** header **`X-Gemini-Profile`** (optional). If you omit it, the server uses **`GEMINI_V1_DEFAULT_PROFILE`** (default profile name **`default`**). To use a **random** account among those that already have saved cookies, send **`X-Gemini-Profile: random`** (also accepted: `any`, `*`) or set **`GEMINI_V1_DEFAULT_PROFILE=random`**. Responses include **`profile`** so you can see which profile was used (including after a random pick).

**Random profile for a single job (per request):** send the header on every `/v1` call — the server picks one profile at random from those that already have valid `cookies.json`. Synonyms: `random`, `any`, `*` (case-insensitive).

```bash
# Example: generate using a random saved account (read profile id from JSON response)
curl -sS -X POST "$BASE/v1/generate" \
  -H "Content-Type: application/json" \
  -H "X-Gemini-Profile: random" \
  -H "X-Gemini-Api-Key: $GEMINI_API_CLIENT_KEY" \
  -d '{"prompt":"Hello"}'
```

**Random by default (no header):** set **`GEMINI_V1_DEFAULT_PROFILE=random`** in `.env` so omitting `X-Gemini-Profile` also selects a random profile each time.

If **`GEMINI_API_CLIENT_KEY`** is set, every request must include **`X-Gemini-Api-Key`** with that value.

| Method | Path | Body | Description |
| ------ | ---- | ---- | ----------- |
| `POST` | `/v1/list-models` | `{ "cookies": ... }` optional | Lists models. Response: `models`, **`profile`**. |
| `POST` | `/v1/generate` | `{ "prompt", "model"?, "responseMimeType"?, "images"?, "cookies"? }` | Text generation; optional `images`: `[{ "mimeType", "base64" }]`. Response: `text`, **`profile`**. |
| `POST` | `/v1/status` | `{ "cookies": ... }` optional | Account/session status. Includes **`profile`**. |

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
| `GET` | `/admin/api/profiles/auth-status` | — | **Session health scan:** for each profile directory, loads on-disk cookies and probes Gemini Web `account_status`. Returns `authenticated`, upstream `status` (e.g. `UNAUTHENTICATED`), `NO_COOKIES`, or `PROBE_ERROR` with `httpStatus` when init fails. Can take a while if you have many accounts (per-profile timeout 120s). |

**Upstream errors (`/v1/*`):** `gemini_webapi` failures are mapped when possible — e.g. Google rate limits (`Status: 429`, `UsageLimitExceeded`, `TemporarilyBlocked`) return **HTTP 429** with a clear message instead of a generic **502**. Expired/invalid sessions often surface as **401** or **503** (e.g. upstream status `0`). Use **`GET /admin/api/profiles/auth-status`** or **`POST /v1/status`** to confirm which profiles need fresh cookies.

OpenAPI (Swagger) is available at **`/docs`** when the app is running.

## Layout on disk

```
/data/   (volume gemini_data)
  profiles/<profile>/cookies.json
```

## License

Upstream `gemini_webapi` is AGPL-3.0 — comply when redistributing.
