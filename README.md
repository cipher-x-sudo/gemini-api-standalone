# Gemini Web API (standalone, Docker)

HTTP service wrapping [`gemini_webapi`](https://pypi.org/project/gemini-webapi/) (same family as [cipher-x-sudo/Gemini-API](https://github.com/cipher-x-sudo/Gemini-API)) for **always-on** Gemini Web sessions with **persisted cookies** on disk.

This is **not** the official Google Generative AI SDK; it uses browser session cookies and may violate Google’s terms if misused. Use at your own risk.

## Features

- **Single `docker-compose.yml`**: `gemini-api` + **`cloudflared`**, no manual `docker network create`.
- Compose **creates** a bridge network named **`gemini-prismacreative-net`** automatically on first `up`.
- **Docker + volume**: cookie data under `/data` (`gemini_data`).
- **Control UI** at `/ui`.
- **Persistent cookies**: background session refresh and disk writes — see [Persistent cookies and always-on sessions](#persistent-cookies-and-always-on-sessions) below.

## Persistent cookies and always-on sessions

**Persistent Cookies** — The service is designed for **always-on** operation: it passes **`auto_refresh`** into `gemini_webapi`’s `GeminiClient.init` so the upstream library can **rotate session cookies in the background** (notably `__Secure-1PSIDTS` while the account is still valid), and it **saves the cookie jar to disk** after `init` and after each upstream call under each profile’s `cookies.json` (see [`app/main.py`](app/main.py) and the **Layout on disk** section below).

**This is not a full re-login or OAuth flow.** If Google invalidates the main session cookie (`__Secure-1PSID`) or the account is signed out, you must **re-paste cookies** from a logged-in browser (via `/ui` or `POST /admin/api/profiles/{id}/cookies`).

### Upstream behavior (reference: `Gemini-API/` in this repo)

The runtime dependency is **`gemini_webapi`** from PyPI ([`requirements.txt`](requirements.txt)). If you keep a copy of the library under **[`Gemini-API/`](Gemini-API/)**, it is the same family of code; use it to read exactly how “persistent cookies / background refresh” works:

| Piece | Where in `Gemini-API/` |
| ----- | ---------------------- |
| **`init(auto_refresh=..., refresh_interval=...)`** — schedules the background loop when `auto_refresh` is true | [`src/gemini_webapi/client.py`](Gemini-API/src/gemini_webapi/client.py) (`GeminiClient.init`, `asyncio.create_task(self.start_auto_refresh())`) |
| **Background loop** — sleeps `refresh_interval` (clamped to ≥ 60s), then calls rotation under a lock | [`start_auto_refresh`](Gemini-API/src/gemini_webapi/client.py) on `GeminiClient` |
| **Rotation request** — `POST` to Google’s rotate endpoint, updates `__Secure-1PSIDTS`, writes cache file | [`rotate_1psidts`](Gemini-API/src/gemini_webapi/utils/rotate_1psidts.py) and `save_cookies` in the same module |
| **Where files go** — directory from env `GEMINI_COOKIE_PATH` (this service sets it per profile to your `profiles/<id>/` dir before creating the client) | `_get_cookie_cache_dir` / `_get_cookies_cache_path` in [`rotate_1psidts.py`](Gemini-API/src/gemini_webapi/utils/rotate_1psidts.py) |
| **Save on shutdown** | `GeminiClient.close` → `save_cookies` in the same [`client.py`](Gemini-API/src/gemini_webapi/client.py) |

This standalone app wires **`GEMINI_AUTO_ROTATE`** / **`GEMINI_REFRESH_INTERVAL_SECONDS`** into that `init` path and additionally **exports the client jar to `cookies.json`** after operations ([`app/main.py`](app/main.py)) so your Docker volume stays the source of truth for `/v1/*`.

### How to enable and tune

| Action | What to do |
| ------ | ---------- |
| Keep background refresh **on** (default) | Set `GEMINI_AUTO_ROTATE=true` or `GEMINI_AUTO_REFRESH=true` in `.env` (Compose default is **true**). |
| Set how often the library attempts refresh (seconds; min **60**) | `GEMINI_REFRESH_INTERVAL_SECONDS` (default **600**). |
| Apply changes | **Restart** `gemini-api` so in-process `GeminiClient` instances are rebuilt (see the Environment table below). |

`GET /health` and `GET /admin/api/server` expose **`autoRotate`** and **`refreshIntervalSeconds`** so you can confirm what the process is using.

### Storage (sessions survive restarts)

The `gemini-api` service mounts the **`gemini_data`** Docker volume at **`/data`**. Per-profile files live under `GEMINI_PROFILES_ROOT` (default **`/data/profiles`**, e.g. `profiles/<id>/cookies.json`). **Do not delete this volume** if you want sessions to survive container recreation.

### First-time and ongoing use of `/v1/*`

1. **Seed cookies per profile** once: use **`/ui`** or **`POST /admin/api/profiles/{id}/cookies`** (with `Authorization: Bearer <ADMIN_API_KEY>`). Without a valid `cookies.json` for a profile, `/v1/*` returns **400** (missing cookies), regardless of `GEMINI_AUTO_ROTATE`.
2. **Match the profile** in API clients: send header **`X-Gemini-Profile: <id>`** (or set `GEMINI_V1_DEFAULT_PROFILE` / use `random` as documented in the **Nexus-compatible (`/v1`)** section).

### Monitor session health (optional)

- **Per profile, quick check:** `POST /v1/status` with the same `X-Gemini-Api-Key` (if required) and `X-Gemini-Profile` as your generate calls; JSON includes **`authenticated`** and upstream **`status`**.
- **All profiles, admin scan:** `GET /admin/api/profiles/auth-status` with `Authorization: Bearer <ADMIN_API_KEY>`.

Example (`GEMINI_API_CLIENT_KEY` and profile id must match your server):

```bash
curl -sS -X POST "$BASE/v1/status" \
  -H "Content-Type: application/json" \
  -H "X-Gemini-Profile: my-profile" \
  -H "X-Gemini-Api-Key: $GEMINI_API_CLIENT_KEY" \
  -d '{}'
```

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

The API container bakes in **`frontend/dist`** at **image build time**. After you change the React UI, rebuild and redeploy so the browser gets the new bundle, for example:

```bash
docker compose build --no-cache gemini-api && docker compose up -d gemini-api
```

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
| `GEMINI_UVICORN_WORKERS` | Number of **uvicorn worker processes** inside the container (default **1**). Values greater than **1** improve parallel CPU throughput; each worker keeps its **own** in-memory `GeminiClient` cache (on-disk cookies remain shared). |
| `GEMINI_SYNC_IO_THREADS` | If **greater than 0**, blocking disk work (cookie saves, large image staging, some admin reads) uses a **dedicated thread pool** of this size instead of only the default `asyncio` executor. Default **0**. |
| `GEMINI_MAX_CONCURRENT_UPSTREAM_GLOBAL` | Maximum **concurrent** upstream Gemini operations **across all profiles** on this process. **0** = no limit (default). Helps reduce burst **429** responses. |
| `GEMINI_MAX_CONCURRENT_UPSTREAM_PER_PROFILE` | Same, but **per profile id**. **0** = no limit (default). If `gemini_webapi` misbehaves with parallel calls on one session, set this to **1**. |
| `GEMINI_UPSTREAM_RETRY_MAX` | After a **retryable** upstream rate limit (`UsageLimitExceeded`, `TemporarilyBlocked`, HTTP **429** in mapped errors), retry up to this many **extra** attempts (default **0**). Retries **re-invoke** the same operation and may consume additional quota. |
| `GEMINI_UPSTREAM_RETRY_BASE_MS` | Base delay in milliseconds for exponential backoff between retries (default **500**). |

Restart the service after changing rotation settings so existing Gemini clients are recreated. For a full description of auto-rotate, disk layout, and monitoring, see [Persistent cookies and always-on sessions](#persistent-cookies-and-always-on-sessions).

### Concurrency and blocking I/O

Heavy **disk** work and large **image** decoding run off the asyncio event loop (`asyncio.to_thread`, or a bounded pool when `GEMINI_SYNC_IO_THREADS` is set) so **`GET /health`** and unrelated routes stay responsive under load.

**Upstream limits:** optional semaphores (`GEMINI_MAX_CONCURRENT_UPSTREAM_*`) serialize Gemini traffic to reduce burst **429** responses. **Retries** (`GEMINI_UPSTREAM_RETRY_*`) apply only to mapped rate-limit errors; each retry is a **new** upstream call and may count against quota.

**Scaling:** `GEMINI_UVICORN_WORKERS` runs multiple uvicorn processes in one container. Use **Redis** (`REDIS_URL`) if you rely on shared auxiliary state (account-status cache, generation history); each worker still reads and writes **`cookies.json`** on the shared volume.

## HTTP API

Unless noted, JSON bodies use `Content-Type: application/json`.

### Public / health

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| `GET` | `/health` | None | Liveness: `ok`, paths, admin/client key flags, **`autoRotate`**, **`refreshIntervalSeconds`**, **`syncIoThreadsConfigured`**, **`maxConcurrentUpstreamGlobal`**, **`maxConcurrentUpstreamPerProfile`**, **`upstreamRetryMax`**, Redis connectivity. |
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
