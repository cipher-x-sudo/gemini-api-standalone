# Gemini Web API (standalone, Docker)

HTTP service wrapping [`gemini_webapi`](https://pypi.org/project/gemini-webapi/) (same family as [cipher-x-sudo/Gemini-API](https://github.com/cipher-x-sudo/Gemini-API)) for **always-on** Gemini Web sessions with **persisted cookies** on disk.

This is **not** the official Google Generative AI SDK; it uses browser session cookies and may violate Google’s terms if misused. Use at your own risk.

## Features

- **Docker + volume**: Cookie cache and per-profile data live under `/data` (mapped volume in Compose).
- **`GEMINI_COOKIE_PATH`**: Each profile directory is set as `GEMINI_COOKIE_PATH` before `GeminiClient` init so the library’s built-in rotation / `save_cookies` targets that path (see upstream `gemini_webapi` docs).
- **Multi-profile**: Header `X-Gemini-Profile: myaccount` isolates cookies under `/data/profiles/<profile>/`.
- **Nexus-shaped API**: `POST /v1/list-models`, `/v1/generate`, `/v1/status` with the same JSON bodies as the Nexus gemini-web-bridge (cookies optional if already saved for that profile).
- **Admin UI**: `GET /admin` — paste cookies JSON; stored at `profiles/<id>/cookies.json`.
- **Optional API key**: Set `GEMINI_API_CLIENT_KEY` to require header `X-Gemini-Api-Key` on `/v1/*` (in addition to Cloudflare).

## Quick start

```bash
cd gemini-api-standalone
cp .env.example .env
# Edit .env — set ADMIN_API_KEY to a long random string
docker compose --env-file .env up -d --build
```

Open **`http://localhost:4000/`** (or whatever **`GEMINI_API_PORT`** you set) and **`/ui`** — the **control panel** lets you set admin/client keys in the browser session, manage profiles and cookies, and try **status**, **list models**, and **generate** without curl. Legacy URL **`/admin`** redirects to `/ui`.

**Ports:** The app listens inside the container on **`GEMINI_INTERNAL_PORT`** (default **9380**, not 8080). Compose maps **`GEMINI_API_PORT`** (default **4000**) on the host to that internal port. Point Cloudflare Tunnel at `http://127.0.0.1:<GEMINI_API_PORT>`.

Paste cookies from `gemini.google.com` (see upstream README for `__Secure-1PSID` / `__Secure-1PSIDTS`) under **Profiles & cookies**.

Then call the API with header `X-Gemini-Profile: default` and either:

- **No `cookies` in body** — uses saved file for that profile, or  
- **`cookies` in body** — merged over saved file (same as Nexus).

Example:

```bash
curl -sS -X POST "http://127.0.0.1:4000/v1/generate" \
  -H "Content-Type: application/json" \
  -H "X-Gemini-Profile: default" \
  -d '{"prompt":"Say hello in one sentence.","cookies":{}}'
```

(Empty `cookies` works only after cookies were saved for that profile via `/admin`.)

## Cloudflare (recommended on a VPS)

1. **DNS**: Point your subdomain to the origin (or use **Cloudflare Tunnel** and no public inbound ports).
2. **Access (Zero Trust)**: Add an **Application** for `https://gemini-api.example.com` and restrict to your email/IdP so the Internet cannot hit `/admin` or `/v1/*` without identity.
3. **SSL/TLS**: **Full (strict)** to origin if origin presents a valid cert; with Tunnel, TLS is often terminated at the edge.
4. **Origin**: Keep `ADMIN_API_KEY` strong; optionally set `GEMINI_API_CLIENT_KEY` and send `X-Gemini-Api-Key` from trusted clients.

Cloudflare mitigates DDoS and unauthenticated access; it does **not** replace locking down SSH, firewall rules, and volume backups for `/data`.

## Environment

| Variable | Description |
| -------- | ----------- |
| `GEMINI_PROFILES_ROOT` | Root for profiles (default `/data/profiles`). |
| `GEMINI_INTERNAL_PORT` | Port **inside** the container for uvicorn (default **9380**). |
| `GEMINI_API_PORT` | Host port in Compose mapping (default **4000** → internal port). |
| `ADMIN_API_KEY` | Bearer token for `POST /admin/api/profiles/.../cookies` and `GET /admin/api/profiles`. |
| `GEMINI_API_CLIENT_KEY` | If set, required as `X-Gemini-Api-Key` on `/v1/*`. |

## Layout on disk

```
/data/
  profiles/
    default/
      cookies.json          # user/admin written + updated after requests
      .cached_cookies_*.json # gemini_webapi library cache (when using GEMINI_COOKIE_PATH)
```

## License

The Nexus repository license applies to this folder. Upstream `gemini_webapi` is AGPL-3.0 — comply when redistributing.
