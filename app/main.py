"""
Standalone Gemini Web API (gemini_webapi) for VPS/Docker.

- Per-profile cookie dirs under GEMINI_PROFILES_ROOT; each sets GEMINI_COOKIE_PATH so the library
  persists rotated cookies (gemini_webapi background task: rotate_1psidts / save_cookies).
- Optional env: GEMINI_AUTO_ROTATE (or GEMINI_AUTO_REFRESH), GEMINI_REFRESH_INTERVAL_SECONDS.
- Optional upstream proxy: GEMINI_UPSTREAM_PROXY (alias GEMINI_PROXY) — full URL, or host:port:user:password with GEMINI_PROXY_SCHEME (default http). Passed to gemini_webapi.GeminiClient.
- Nexus-compatible routes: POST /v1/list-models, /v1/generate, /v1/status (cookies optional if on-disk; X-Gemini-Profile: random or GEMINI_V1_DEFAULT_PROFILE=random). Upstream gemini_webapi errors map to HTTP 429/401/503 where applicable.
- Admin: paste cookies per profile (Bearer ADMIN_API_KEY); GET /admin/api/profiles/auth-status scans all profiles’ session health.

Set ADMIN_API_KEY and put the service behind Cloudflare Access or a private network.
"""

from __future__ import annotations

import asyncio
import base64
import enum
import json
import logging
import mimetypes
import os
import re
import secrets
import sys
import shutil
import tempfile
import threading
import traceback
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Header
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

if sys.version_info < (3, 11) and not hasattr(enum, "StrEnum"):

    class StrEnum(str, enum.Enum):
        pass

    enum.StrEnum = StrEnum  # type: ignore[attr-defined, assignment]

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("gemini-api-standalone")

_LOG_BUFFER_MAX = max(100, int(os.environ.get("GEMINI_LOG_BUFFER_LINES", "3000")))
_log_lock = threading.Lock()
_log_buffer: deque[dict[str, Any]] = deque(maxlen=_LOG_BUFFER_MAX)


def _log_record_to_item(record: logging.LogRecord) -> dict[str, Any]:
    try:
        msg = record.getMessage()
    except Exception:
        msg = "<unprintable log message>"
    ts = datetime.fromtimestamp(record.created, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    return {
        "t": ts,
        "level": record.levelname,
        "logger": record.name,
        "msg": msg,
    }


def _skip_ring_buffer_record(record: logging.LogRecord) -> bool:
    """Avoid flooding the UI log buffer with the logs endpoint's own access lines."""
    if record.name != "uvicorn.access":
        return False
    try:
        msg = record.getMessage()
    except Exception:
        return False
    return "/admin/api/logs" in msg


class _RingBufferHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        if _skip_ring_buffer_record(record):
            return
        try:
            item = _log_record_to_item(record)
        except Exception:
            return
        with _log_lock:
            _log_buffer.append(item)


_root_ring = _RingBufferHandler()
_root_ring.setLevel(logging.DEBUG)


def _attach_ring_buffer_handlers() -> None:
    """
    Uvicorn's default LOGGING_CONFIG sets propagate=false on uvicorn / uvicorn.access,
    so those records never reach the root logger. Attach our handler there too, and
    re-run after startup in case dictConfig replaced root handlers.
    """
    targets: list[logging.Logger] = [
        logging.getLogger(),
        logging.getLogger("uvicorn"),
        logging.getLogger("uvicorn.access"),
    ]
    for lg in targets:
        if any(isinstance(h, _RingBufferHandler) for h in lg.handlers):
            continue
        lg.addHandler(_root_ring)


_attach_ring_buffer_handlers()

PROFILES_ROOT = Path(os.environ.get("GEMINI_PROFILES_ROOT", "/data/profiles")).resolve()
ADMIN_API_KEY = (os.environ.get("ADMIN_API_KEY") or "").strip()
OPTIONAL_CLIENT_KEY = (os.environ.get("GEMINI_API_CLIENT_KEY") or "").strip()


def _resolve_upstream_proxy_url() -> str | None:
    """
    GEMINI_UPSTREAM_PROXY / GEMINI_PROXY:
    - Full URL if it contains '://' (e.g. http://..., socks5://...).
    - Else treated as host:port:username:password (first three ':' only; rest is password, so ':' in password is OK).
    - host:port or host:port:user also work.
    GEMINI_PROXY_SCHEME defaults to http (use socks5, socks5h, https, etc. when needed).
    """
    raw = (os.environ.get("GEMINI_UPSTREAM_PROXY") or os.environ.get("GEMINI_PROXY") or "").strip()
    if not raw:
        return None
    if "://" in raw:
        return raw
    parts = raw.split(":", 3)
    if len(parts) < 2:
        log.warning("GEMINI_UPSTREAM_PROXY %r is not a URL and not host:port:… — proxy disabled", raw)
        return None
    host, port_s = parts[0].strip(), parts[1].strip()
    user = parts[2].strip() if len(parts) > 2 else ""
    password = parts[3] if len(parts) > 3 else ""
    if not host or not port_s:
        log.warning("GEMINI_UPSTREAM_PROXY host:port form is empty — proxy disabled")
        return None
    try:
        int(port_s)
    except ValueError:
        log.warning("GEMINI_UPSTREAM_PROXY has invalid port %r — proxy disabled", port_s)
        return None
    scheme = (os.environ.get("GEMINI_PROXY_SCHEME") or "http").strip().lower()
    scheme = scheme.split("://", 1)[-1] if "://" in scheme else scheme
    scheme = scheme.rstrip("/") or "http"
    if user and password:
        return f"{scheme}://{quote(user, safe='')}:{quote(password, safe='')}@{host}:{port_s}"
    if user:
        return f"{scheme}://{quote(user, safe='')}@{host}:{port_s}"
    return f"{scheme}://{host}:{port_s}"


GEMINI_UPSTREAM_PROXY = _resolve_upstream_proxy_url()


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        return float(str(raw).strip())
    except ValueError:
        return default


# Background rotation of __Secure-1PSIDTS (gemini_webapi start_auto_refresh → rotate_1psidts).
GEMINI_AUTO_ROTATE = _env_bool(
    "GEMINI_AUTO_ROTATE",
    _env_bool("GEMINI_AUTO_REFRESH", True),
)
GEMINI_REFRESH_INTERVAL_SECONDS = max(60.0, _env_float("GEMINI_REFRESH_INTERVAL_SECONDS", 600.0))

_PROFILE_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$")
_PROFILE_RANDOM_ALIASES = frozenset(s.lower() for s in ("random", "any", "*"))

FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"


def _mask_cookie_value(v: str, prefix: int = 6, suffix: int = 4) -> str:
    t = (v or "").strip()
    if len(t) <= prefix + suffix:
        return "***"
    return f"{t[:prefix]}…{t[-suffix:]}"


def _mask_cookie_map_for_display(ck: dict[str, str]) -> dict[str, str]:
    return {k: _mask_cookie_value(v) for k, v in sorted(ck.items())}


def _sanitize_profile_id(raw: str) -> str:
    t = (raw or "").strip()
    if not t:
        return "default"
    if not _PROFILE_ID_RE.match(t):
        raise HTTPException(status_code=400, detail="Invalid X-Gemini-Profile (use letters, digits, ._-)")
    return t


def profile_root_dir(profile_id: str) -> Path:
    """Resolved profile directory path; does not create the directory."""
    return PROFILES_ROOT / _sanitize_profile_id(profile_id)


def profile_data_dir(profile_id: str) -> Path:
    d = profile_root_dir(profile_id)
    d.mkdir(parents=True, mode=0o700, exist_ok=True)
    return d


def _set_gemini_cookie_path_for_profile(profile_id: str) -> Path:
    d = profile_data_dir(profile_id)
    os.environ["GEMINI_COOKIE_PATH"] = str(d)
    return d


def normalize_gemini_web_cookies_from_parsed(parsed: Any) -> Optional[dict[str, str]]:
    if parsed is None:
        return None
    out: dict[str, str] = {}

    def put(name: str, value: Any) -> None:
        if not isinstance(name, str):
            return
        v = value if isinstance(value, str) else str(value or "")
        v = v.strip()
        if not v:
            return
        n = name.strip()
        if n == "__Secure-1PSID":
            out["__Secure-1PSID"] = v
            return
        if n == "__Secure-3PSID":
            if "__Secure-1PSID" not in out:
                out["__Secure-1PSID"] = v
            return
        if n == "__Secure-1PSIDTS":
            out["__Secure-1PSIDTS"] = v
            return
        if n == "__Secure-3PSIDTS":
            if "__Secure-1PSIDTS" not in out:
                out["__Secure-1PSIDTS"] = v
            return
        if n not in out:
            out[n] = v

    if isinstance(parsed, dict):
        for k, val in parsed.items():
            if k in ("__Secure-1PSID", "__Secure-3PSID", "__Secure-1PSIDTS", "__Secure-3PSIDTS"):
                put(k, val)
                continue
            if isinstance(val, dict) and isinstance(val.get("name"), str):
                put(str(val["name"]), val.get("value"))
                continue
            if isinstance(val, str):
                put(str(k), val)
    elif isinstance(parsed, list):
        for item in parsed:
            if isinstance(item, dict) and isinstance(item.get("name"), str):
                put(str(item["name"]), item.get("value"))

    if "__Secure-1PSID" not in out:
        return None
    return out


def load_cookies_json_file(path: Path) -> Optional[dict[str, str]]:
    if not path.is_file():
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None
    if isinstance(data, dict) and "cookies" in data and isinstance(data["cookies"], (dict, list)):
        return normalize_gemini_web_cookies_from_parsed(data["cookies"])
    return normalize_gemini_web_cookies_from_parsed(data)


def list_profile_ids_with_valid_cookies() -> list[str]:
    if not PROFILES_ROOT.is_dir():
        return []
    found: list[str] = []
    for p in PROFILES_ROOT.iterdir():
        if not p.is_dir():
            continue
        name = p.name
        if not _PROFILE_ID_RE.match(name):
            continue
        ck = load_cookies_json_file(p / "cookies.json")
        if ck and ck.get("__Secure-1PSID"):
            found.append(name)
    return found


def _pick_random_profile_id() -> str:
    candidates = list_profile_ids_with_valid_cookies()
    if not candidates:
        raise HTTPException(
            status_code=400,
            detail="No profiles with saved cookies under profiles root. "
            "Add cookies via POST /admin/api/profiles/{id}/cookies first.",
        )
    return secrets.choice(candidates)


def resolve_v1_profile(x_gemini_profile: Optional[str]) -> str:
    """
    If header is omitted, uses GEMINI_V1_DEFAULT_PROFILE (default name 'default').
    Values 'random', 'any', '*' pick a random profile that has valid on-disk cookies.
    """
    h = (x_gemini_profile or "").strip()
    if not h:
        h = (os.environ.get("GEMINI_V1_DEFAULT_PROFILE") or "default").strip() or "default"
    if h.lower() in _PROFILE_RANDOM_ALIASES:
        return _pick_random_profile_id()
    return _sanitize_profile_id(h)


_ACCOUNT_STATUS_CACHE_NAME = "account_status.json"


def _account_status_cache_path(profile_id: str) -> Path:
    return profile_root_dir(profile_id) / _ACCOUNT_STATUS_CACHE_NAME


def load_account_status_cache(profile_id: str) -> Optional[dict[str, Any]]:
    path = _account_status_cache_path(profile_id)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def save_account_status_cache(profile_id: str, snapshot: dict[str, Any]) -> None:
    """Persist last successful POST /v1/status result; cleared when cookies are replaced."""
    pid = _sanitize_profile_id(profile_id)
    d = profile_data_dir(pid)
    path = d / _ACCOUNT_STATUS_CACHE_NAME
    payload = {
        "status": snapshot.get("status"),
        "description": snapshot.get("description") or "",
        "authenticated": snapshot.get("authenticated"),
        "checkedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    try:
        path.chmod(0o600)
    except OSError:
        pass


def clear_account_status_cache(profile_id: str) -> None:
    path = _account_status_cache_path(profile_id)
    if path.is_file():
        try:
            path.unlink()
        except OSError:
            pass


def save_cookies_json_file(path: Path, cookie_map: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    payload = {
        "cookies": cookie_map,
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    try:
        path.chmod(0o600)
    except OSError:
        pass


def merge_maps(base: Optional[dict[str, str]], overlay: Optional[dict[str, str]]) -> Optional[dict[str, str]]:
    if not base:
        return dict(overlay) if overlay else None
    if not overlay:
        return dict(base)
    m = dict(base)
    m.update(overlay)
    return m


def resolve_cookies_for_request(
    profile_id: str,
    body_cookies: Optional[dict[str, Any]],
) -> dict[str, str]:
    disk_path = profile_root_dir(profile_id) / "cookies.json"
    from_disk = load_cookies_json_file(disk_path)
    from_body = None
    if body_cookies:
        from_body = normalize_gemini_web_cookies_from_parsed(body_cookies)
    merged = merge_maps(from_disk, from_body)
    if not merged or not merged.get("__Secure-1PSID"):
        disk_exists = disk_path.is_file()
        disk_ok = bool(from_disk and from_disk.get("__Secure-1PSID"))
        log.warning(
            "resolve_cookies: no __Secure-1PSID after merge profile=%s path=%s file_exists=%s disk_ok=%s",
            profile_id,
            disk_path,
            disk_exists,
            disk_ok,
        )
        raise HTTPException(
            status_code=400,
            detail=(
                f"Missing cookies for profile {profile_id!r}. "
                f"On-disk path: {disk_path.resolve()} (file exists={disk_exists}, "
                f"loaded valid __Secure-1PSID from disk={disk_ok}). "
                "If /ui shows cookies saved, use the same server URL, pick that account in the tester, "
                "or send header X-Gemini-Profile matching that profile (default profile id is 'default'). "
                "Otherwise set cookies via POST /admin/api/profiles/{id}/cookies or include cookies in the JSON body."
            ),
        )
    return merged


def apply_cookie_string_map_to_gemini_client(client: Any, cookie_map: dict[str, str]) -> None:
    jar = getattr(client, "_cookies", None)
    if jar is None:
        return
    setfn = getattr(jar, "set", None)
    if not callable(setfn):
        return
    for name, value in cookie_map.items():
        if not name or not str(value).strip():
            continue
        v = str(value).strip()
        try:
            setfn(name, v, domain=".google.com")
        except Exception:
            try:
                setfn(name, v, domain=".gemini.google.com")
            except Exception:
                pass


def extract_flat_cookie_map_from_client(client: Any) -> dict[str, str]:
    jar = getattr(client, "_cookies", None)
    if jar is None:
        return {}
    out: dict[str, str] = {}
    try:
        inner = getattr(jar, "jar", None)
        if inner is not None:
            for cookie in inner:
                name = getattr(cookie, "name", None)
                val = getattr(cookie, "value", None)
                if name and val is not None:
                    out[str(name)] = str(val)
    except Exception:
        pass
    return out


def _psid_pair(ck: dict[str, str]) -> tuple[str, str]:
    psid = (ck.get("__Secure-1PSID") or "").strip()
    psidts = (ck.get("__Secure-1PSIDTS") or "").strip()
    if not psid:
        raise HTTPException(status_code=400, detail="Missing __Secure-1PSID in cookie map.")
    return psid, psidts


async def _maybe_await_close(client: Any) -> None:
    closer = getattr(client, "close", None)
    if not callable(closer):
        return
    try:
        r = closer()
        if asyncio.iscoroutine(r):
            await r
    except Exception:
        pass


def _parse_http_status_from_gemini_message(msg: str) -> int | None:
    m = re.search(r"Status:\s*(\d+)", msg, re.I)
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def _http_exception_from_upstream(profile: str, exc: BaseException) -> HTTPException:
    """
    Map gemini_webapi exceptions to HTTP responses (e.g. 429 for rate limits, not generic 502).
    """
    msg = str(exc).strip() or repr(exc)
    prefix = f"[profile={profile!r}] "
    try:
        from gemini_webapi.exceptions import (
            APIError,
            AuthError,
            GeminiError,
            ModelInvalid,
            TemporarilyBlocked,
            TimeoutError,
            UsageLimitExceeded,
        )
    except ImportError:
        code = _parse_http_status_from_gemini_message(msg)
        if code == 429:
            return HTTPException(status_code=429, detail=prefix + msg)
        if code == 0:
            return HTTPException(
                status_code=503,
                detail=prefix + "Upstream status 0 (network or empty response). " + msg,
            )
        return HTTPException(status_code=502, detail=prefix + msg)

    if isinstance(exc, AuthError):
        return HTTPException(
            status_code=401,
            detail=prefix + "Gemini Web session invalid (AuthError). " + msg + " Re-paste cookies in /ui for this profile.",
        )
    if isinstance(exc, UsageLimitExceeded):
        return HTTPException(status_code=429, detail=prefix + msg)
    if isinstance(exc, TemporarilyBlocked):
        return HTTPException(status_code=429, detail=prefix + msg)
    if isinstance(exc, ModelInvalid):
        return HTTPException(status_code=400, detail=prefix + msg)
    if isinstance(exc, TimeoutError):
        return HTTPException(status_code=504, detail=prefix + msg)
    if isinstance(exc, APIError):
        code = _parse_http_status_from_gemini_message(msg)
        if code == 429:
            return HTTPException(status_code=429, detail=prefix + msg)
        if code == 0:
            return HTTPException(
                status_code=503,
                detail=prefix + "Upstream returned status 0 (network or empty response). " + msg,
            )
        if code is not None and 400 <= code < 500 and code not in (429,):
            return HTTPException(
                status_code=401,
                detail=prefix + f"Upstream HTTP {code}. " + msg + " Cookies may be expired — refresh in /ui.",
            )
        if code is not None and code >= 500:
            return HTTPException(status_code=502, detail=prefix + f"Upstream HTTP {code}. " + msg)
        return HTTPException(status_code=502, detail=prefix + msg)
    if isinstance(exc, GeminiError):
        return HTTPException(status_code=502, detail=prefix + msg)

    return HTTPException(status_code=502, detail=prefix + msg)


def _raise_mapped_upstream(profile: str, exc: BaseException) -> None:
    """Raise HTTPException from gemini_webapi; log full traceback only for mapped 5xx responses."""
    he = _http_exception_from_upstream(profile, exc)
    if he.status_code >= 500:
        traceback.print_exc()
    else:
        log.warning("upstream profile=%s -> HTTP %s: %s", profile, he.status_code, exc)
    raise he from exc


def _account_status_fields_from_client(client: Any) -> dict[str, Any]:
    status_obj = getattr(client, "account_status", None)
    if status_obj is not None:
        name = getattr(status_obj, "name", None) or str(status_obj)
        desc = (getattr(status_obj, "description", "") or "").strip()
        return {
            "authenticated": str(name).upper() != "UNAUTHENTICATED",
            "status": name,
            "description": desc,
        }
    return {
        "authenticated": True,
        "status": "UNKNOWN",
        "description": "client initialized (no account_status on client)",
    }


def list_all_profile_ids_on_disk() -> list[str]:
    if not PROFILES_ROOT.is_dir():
        return []
    names: list[str] = []
    for p in PROFILES_ROOT.iterdir():
        if not p.is_dir():
            continue
        if _PROFILE_ID_RE.match(p.name):
            names.append(p.name)
    return sorted(names)


# --- FastAPI models (Nexus bridge compatible) ---


class ImagePart(BaseModel):
    mimeType: str = Field(..., description="e.g. image/jpeg")
    base64: str


class CookiesBody(BaseModel):
    cookies: Optional[dict[str, Any]] = Field(
        default=None,
        description="Optional. Omit or null to use only cookies saved for the profile on disk.",
    )


class GenerateRequest(CookiesBody):
    prompt: str = ""
    model: Optional[str] = None
    responseMimeType: Optional[str] = None
    images: Optional[list[ImagePart]] = None


# --- Auth ---


def _check_admin(authorization: Optional[str]) -> None:
    if not ADMIN_API_KEY:
        raise HTTPException(status_code=503, detail="ADMIN_API_KEY is not configured on the server.")
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if token != ADMIN_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing admin token.")


def _check_optional_client_key(x_client_key: Optional[str]) -> None:
    if not OPTIONAL_CLIENT_KEY:
        return
    if (x_client_key or "").strip() != OPTIONAL_CLIENT_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Gemini-Api-Key.")


# --- Gemini ops ---


def _gemini_web_model_is_known(name: str) -> bool:
    try:
        from gemini_webapi.constants import Model

        Model.from_name(name)
        return True
    except Exception:
        return False


def _normalize_model_for_gemini_web(requested: str) -> str | None:
    m0 = requested.strip()
    if not m0 or m0.lower() == "unspecified":
        return None
    legacy: dict[str, str] = {
        "gemini-2.5-pro": "gemini-3-pro",
        "gemini-2.5-flash": "gemini-3-flash",
        "gemini-2.5-flash-lite": "gemini-3-flash",
    }
    catalog_hint: dict[str, str] = {
        "gemini-3.1-pro-low": "gemini-3-pro",
        "gemini-3.1-pro-high": "gemini-3-pro-plus",
    }
    variants: list[str] = [m0]
    if m0 in legacy:
        variants.append(legacy[m0])
    if m0 in catalog_hint:
        variants.append(catalog_hint[m0])
    if m0.endswith("-preview"):
        base = m0[: -len("-preview")]
        variants.extend([base, legacy.get(base, base), catalog_hint.get(base, base)])
    seen: set[str] = set()
    for t in variants:
        if not t or t in seen:
            continue
        seen.add(t)
        if _gemini_web_model_is_known(t):
            return t
    for fb in ("gemini-3-pro", "gemini-3-flash"):
        if _gemini_web_model_is_known(fb):
            return fb
    return m0


_singleton_clients: dict[str, Any] = {}
_singleton_locks: dict[str, asyncio.Lock] = {}
_singleton_ids: dict[str, str] = {}


def _cookie_identity_hash(ck: dict[str, str]) -> str:
    import hashlib

    items = sorted(ck.items())
    return hashlib.sha256(json.dumps(items, sort_keys=True).encode("utf-8")).hexdigest()


def _client_singleton_signature(ck: dict[str, str]) -> str:
    """Cookies + upstream proxy; changing either must rebuild GeminiClient."""
    return _cookie_identity_hash(ck) + "\n" + (GEMINI_UPSTREAM_PROXY or "")


async def _get_or_create_client(profile_id: str, ck: dict[str, str]) -> Any:
    from gemini_webapi import GeminiClient

    _set_gemini_cookie_path_for_profile(profile_id)
    pid = _sanitize_profile_id(profile_id)
    sig = _client_singleton_signature(ck)
    if pid not in _singleton_locks:
        _singleton_locks[pid] = asyncio.Lock()
    lock = _singleton_locks[pid]
    async with lock:
        cur = _singleton_clients.get(pid)
        cur_sig = _singleton_ids.get(pid)
        if cur is not None and cur_sig == sig:
            apply_cookie_string_map_to_gemini_client(cur, ck)
            return cur
        if cur is not None:
            await _maybe_await_close(cur)
            _singleton_clients.pop(pid, None)
        psid, psidts = _psid_pair(ck)
        client = GeminiClient(psid, psidts, proxy=GEMINI_UPSTREAM_PROXY)
        apply_cookie_string_map_to_gemini_client(client, ck)
        await client.init(
            timeout=120,
            auto_close=False,
            close_delay=300,
            auto_refresh=GEMINI_AUTO_ROTATE,
            refresh_interval=GEMINI_REFRESH_INTERVAL_SECONDS,
        )
        _singleton_clients[pid] = client
        _singleton_ids[pid] = sig
        p = profile_data_dir(pid) / "cookies.json"
        flat = extract_flat_cookie_map_from_client(client)
        norm = normalize_gemini_web_cookies_from_parsed(flat)
        if norm:
            save_cookies_json_file(p, norm)
        return client


async def _run_with_client(
    profile_id: str,
    ck: dict[str, str],
    op: Callable[[Any], Awaitable[Any]],
) -> Any:
    client = await _get_or_create_client(profile_id, ck)
    try:
        return await op(client)
    finally:
        flat = extract_flat_cookie_map_from_client(client)
        norm = normalize_gemini_web_cookies_from_parsed(flat)
        if norm:
            save_cookies_json_file(profile_data_dir(profile_id) / "cookies.json", norm)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _attach_ring_buffer_handlers()
    log.info("gemini-api log buffer ready (root + uvicorn + uvicorn.access)")
    PROFILES_ROOT.mkdir(parents=True, mode=0o700, exist_ok=True)
    if not ADMIN_API_KEY:
        log.warning("ADMIN_API_KEY is empty — admin routes disabled until set.")
    if GEMINI_UPSTREAM_PROXY:
        log.info("GEMINI_UPSTREAM_PROXY is set — GeminiClient will use that proxy for upstream requests.")
    yield
    for pid, c in list(_singleton_clients.items()):
        try:
            await _maybe_await_close(c)
        except Exception:
            pass
    _singleton_clients.clear()
    _singleton_ids.clear()


app = FastAPI(title="Gemini Web API (standalone)", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "profilesRoot": str(PROFILES_ROOT),
        "clientKeyRequired": bool(OPTIONAL_CLIENT_KEY),
        "adminConfigured": bool(ADMIN_API_KEY),
        "autoRotate": GEMINI_AUTO_ROTATE,
        "refreshIntervalSeconds": GEMINI_REFRESH_INTERVAL_SECONDS,
        "upstreamProxyConfigured": bool(GEMINI_UPSTREAM_PROXY),
    }


@app.get("/", include_in_schema=False)
async def root_redirect() -> RedirectResponse:
    return RedirectResponse(url="/ui", status_code=302)


if (FRONTEND_DIST / "assets").is_dir():
    app.mount("/ui/assets", StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="ui_assets")


@app.get("/ui", response_class=HTMLResponse)
@app.get("/ui/{catchall:path}", response_class=HTMLResponse)
async def serve_spa(catchall: str = ""):
    index = FRONTEND_DIST / "index.html"
    if not index.is_file():
        raise HTTPException(status_code=503, detail="Frontend index.html not found. Please build the frontend.")
    return HTMLResponse(index.read_text(encoding="utf-8"))


@app.get("/admin", include_in_schema=False)
async def admin_redirect_to_ui() -> RedirectResponse:
    return RedirectResponse(url="/ui", status_code=302)


@app.get("/admin/api/server")
async def admin_server_info(authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    _check_admin(authorization)
    try:
        import gemini_webapi

        ver = getattr(gemini_webapi, "__version__", None) or "unknown"
    except Exception:
        ver = "unknown"
    return {
        "service": "gemini-api-standalone",
        "profilesRoot": str(PROFILES_ROOT),
        "geminiWebapiVersion": ver,
        "clientKeyRequired": bool(OPTIONAL_CLIENT_KEY),
        "adminConfigured": bool(ADMIN_API_KEY),
        "autoRotate": GEMINI_AUTO_ROTATE,
        "refreshIntervalSeconds": GEMINI_REFRESH_INTERVAL_SECONDS,
        "upstreamProxyConfigured": bool(GEMINI_UPSTREAM_PROXY),
    }


@app.get("/admin/api/logs")
async def admin_logs(authorization: Optional[str] = Header(None), limit: int = 500) -> dict[str, Any]:
    """Recent application + uvicorn log lines (ring buffer, admin only)."""
    _check_admin(authorization)
    lim = max(1, min(int(limit), 2000))
    with _log_lock:
        snap = list(_log_buffer)
    lines = snap[-lim:] if len(snap) > lim else snap
    return {
        "lines": lines,
        "bufferMax": _LOG_BUFFER_MAX,
        "returned": len(lines),
        "totalInBuffer": len(snap),
    }


@app.post("/v1/list-models")
async def list_models(
    body: CookiesBody,
    x_gemini_profile: Optional[str] = Header(None, alias="X-Gemini-Profile"),
    x_gemini_api_key: Optional[str] = Header(None, alias="X-Gemini-Api-Key"),
) -> dict[str, Any]:
    _check_optional_client_key(x_gemini_api_key)
    pid = resolve_v1_profile(x_gemini_profile)
    ck = resolve_cookies_for_request(pid, body.cookies)

    async def do_list(client: Any) -> dict[str, Any]:
        lm = getattr(client, "list_models", None)
        if not callable(lm):
            raise HTTPException(status_code=501, detail="gemini_webapi client has no list_models")
        raw = lm()
        if asyncio.iscoroutine(raw):
            raw = await raw
        out: list[dict[str, str]] = []
        if raw:
            for m in raw:
                mid = getattr(m, "model_name", None) or getattr(m, "name", None) or str(m)
                label = getattr(m, "display_name", None) or getattr(m, "label", None) or mid
                out.append({"id": str(mid), "label": str(label)})
        return {"models": out, "profile": pid}

    try:
        log.info("POST /v1/list-models profile=%s", pid)
        out = await _run_with_client(pid, ck, do_list)
        n = len(out.get("models") or []) if isinstance(out, dict) else 0
        log.info("POST /v1/list-models profile=%s ok models=%s", pid, n)
        return out
    except HTTPException:
        raise
    except Exception as e:
        _raise_mapped_upstream(pid, e)


@app.post("/v1/generate")
async def generate(
    body: GenerateRequest,
    x_gemini_profile: Optional[str] = Header(None, alias="X-Gemini-Profile"),
    x_gemini_api_key: Optional[str] = Header(None, alias="X-Gemini-Api-Key"),
) -> dict[str, Any]:
    _check_optional_client_key(x_gemini_api_key)
    pid = resolve_v1_profile(x_gemini_profile)
    ck = resolve_cookies_for_request(pid, body.cookies)

    prompt = body.prompt or ""
    if body.responseMimeType == "application/json":
        prompt = (
            prompt
            + "\n\nReturn ONLY valid JSON. No markdown fences or text outside the JSON object or array."
        )

    temp_paths: list[str] = []
    for im in body.images or []:
        ext = mimetypes.guess_extension(im.mimeType.split(";")[0].strip()) or ".bin"
        fd, path = tempfile.mkstemp(suffix=ext)
        os.close(fd)
        try:
            data = base64.b64decode(im.base64, validate=False)
        except Exception as e:
            try:
                os.unlink(path)
            except OSError:
                pass
            raise HTTPException(status_code=400, detail=f"Invalid base64 image: {e}") from e
        with open(path, "wb") as f:
            f.write(data)
        temp_paths.append(path)

    async def do_gen(client: Any) -> dict[str, Any]:
        kwargs: dict[str, Any] = {}
        m = body.model
        if m and str(m).strip() and str(m).strip().lower() != "unspecified":
            resolved = _normalize_model_for_gemini_web(str(m).strip())
            if resolved:
                kwargs["model"] = resolved
        if temp_paths:
            out = await client.generate_content(prompt, files=temp_paths, **kwargs)
        else:
            out = await client.generate_content(prompt, **kwargs)
        text = getattr(out, "text", None)
        if text is None:
            text = str(out)
        return {"text": text or "", "profile": pid}

    try:
        n_img = len(body.images or [])
        want_json = body.responseMimeType == "application/json"
        log.info(
            "POST /v1/generate profile=%s model=%s images=%s prompt_chars=%s json=%s",
            pid,
            (body.model or "").strip() or "default",
            n_img,
            len(body.prompt or ""),
            want_json,
        )
        result = await _run_with_client(pid, ck, do_gen)
        rchars = len((result.get("text") or "")) if isinstance(result, dict) else 0
        log.info("POST /v1/generate profile=%s completed response_chars=%s", pid, rchars)
        return result
    except HTTPException:
        raise
    except Exception as e:
        _raise_mapped_upstream(pid, e)
    finally:
        for p in temp_paths:
            try:
                os.unlink(p)
            except OSError:
                pass


@app.post("/v1/status")
async def status(
    body: CookiesBody,
    x_gemini_profile: Optional[str] = Header(None, alias="X-Gemini-Profile"),
    x_gemini_api_key: Optional[str] = Header(None, alias="X-Gemini-Api-Key"),
) -> dict[str, Any]:
    _check_optional_client_key(x_gemini_api_key)
    pid = resolve_v1_profile(x_gemini_profile)
    ck = resolve_cookies_for_request(pid, body.cookies)

    async def do_status(client: Any) -> dict[str, Any]:
        d = _account_status_fields_from_client(client)
        return {**d, "profile": pid}

    try:
        log.info("POST /v1/status profile=%s", pid)
        out = await _run_with_client(pid, ck, do_status)
        if isinstance(out, dict):
            log.info(
                "POST /v1/status profile=%s ok authenticated=%s account_status=%s",
                pid,
                out.get("authenticated"),
                out.get("status"),
            )
            try:
                save_account_status_cache(pid, out)
            except Exception as e:
                log.warning("save_account_status_cache profile=%s: %s", pid, e)
        return out
    except HTTPException:
        raise
    except Exception as e:
        _raise_mapped_upstream(pid, e)


# --- Admin ---


class CookiesPayload(BaseModel):
    """
    Accepts:
    - {"cookies": {"__Secure-1PSID": "..."}}  (flat map)
    - {"cookies": [{"name","value"}, ...]}   (browser extension array)
    - {"__Secure-1PSID": "..."}              (flat map at root — common paste mistake)
    - [{"name","value"}, ...]               (raw array body)
    """

    cookies: dict[str, Any] | list[Any]

    @model_validator(mode="before")
    @classmethod
    def coerce_cookie_body(cls, data: Any) -> Any:
        if isinstance(data, list):
            return {"cookies": data}
        if not isinstance(data, dict):
            return data
        if "cookies" in data:
            return data
        if any(
            k in data
            for k in (
                "__Secure-1PSID",
                "__Secure-3PSID",
                "__Secure-1PSIDTS",
                "__Secure-3PSIDTS",
            )
        ):
            return {"cookies": data}
        return data


class CreateProfilePayload(BaseModel):
    profileId: str = Field(..., min_length=1, max_length=63)


@app.get("/admin/api/profiles/{profile_id}/cookies")
async def admin_get_cookies(profile_id: str, authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    _check_admin(authorization)
    pid = _sanitize_profile_id(profile_id)
    path = (PROFILES_ROOT / pid / "cookies.json").resolve()
    if not path.is_file():
        return {"missing": True, "profile": pid}
    ck = load_cookies_json_file(path)
    if not ck:
        return {"missing": True, "profile": pid}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        updated = raw.get("updatedAt") if isinstance(raw, dict) else None
    except (json.JSONDecodeError, OSError):
        updated = None
    cache = load_account_status_cache(pid)
    return {
        "profile": pid,
        "updatedAt": updated,
        "cookiesMasked": _mask_cookie_map_for_display(ck),
        "lastAccountStatus": cache.get("status") if cache else None,
        "lastAccountStatusCheckedAt": cache.get("checkedAt") if cache else None,
        "lastAccountStatusDescription": cache.get("description") if cache else None,
    }


@app.post("/admin/api/profiles")
async def admin_create_profile(body: CreateProfilePayload, authorization: Optional[str] = Header(None)) -> JSONResponse:
    _check_admin(authorization)
    pid = _sanitize_profile_id(body.profileId.strip())
    profile_data_dir(pid)
    return JSONResponse({"ok": True, "profile": pid})


@app.delete("/admin/api/profiles/{profile_id}")
async def admin_delete_profile(profile_id: str, authorization: Optional[str] = Header(None)) -> JSONResponse:
    _check_admin(authorization)
    pid = _sanitize_profile_id(profile_id)
    if pid in _singleton_clients:
        c = _singleton_clients.pop(pid)
        await _maybe_await_close(c)
    _singleton_ids.pop(pid, None)
    d = PROFILES_ROOT / pid
    if d.is_dir():
        shutil.rmtree(d, ignore_errors=True)
    return JSONResponse({"ok": True, "deleted": pid})


@app.post("/admin/api/profiles/{profile_id}/cookies")
async def admin_save_cookies(profile_id: str, body: CookiesPayload, authorization: Optional[str] = Header(None)) -> JSONResponse:
    _check_admin(authorization)
    pid = _sanitize_profile_id(profile_id)
    ck = normalize_gemini_web_cookies_from_parsed(body.cookies)
    if not ck:
        raise HTTPException(status_code=400, detail="Could not normalize cookies (need __Secure-1PSID).")
    save_cookies_json_file(profile_data_dir(pid) / "cookies.json", ck)
    clear_account_status_cache(pid)
    # Drop cached client for this profile so next request re-inits with new cookies
    if pid in _singleton_clients:
        c = _singleton_clients.pop(pid)
        await _maybe_await_close(c)
    _singleton_ids.pop(pid, None)
    return JSONResponse({"ok": True, "profile": pid})


@app.get("/admin/api/profiles")
async def admin_list_profiles(authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    _check_admin(authorization)
    if not PROFILES_ROOT.is_dir():
        return {"profiles": []}
    names = sorted([p.name for p in PROFILES_ROOT.iterdir() if p.is_dir()])
    return {"profiles": names}


@app.get("/admin/api/profiles/auth-status")
async def admin_profiles_auth_status(authorization: Optional[str] = Header(None)) -> dict[str, Any]:
    """
    Probe every profile directory: load on-disk cookies, init GeminiClient, read account_status.
    Use this to see which accounts are UNAUTHENTICATED / rate-limited before calling /v1/generate.
    """
    _check_admin(authorization)
    checked_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows: list[dict[str, Any]] = []

    async def do_probe(client: Any) -> dict[str, Any]:
        return _account_status_fields_from_client(client)

    for pid in list_all_profile_ids_on_disk():
        disk_path = profile_root_dir(pid) / "cookies.json"
        ck = load_cookies_json_file(disk_path)
        if not ck or not ck.get("__Secure-1PSID"):
            rows.append(
                {
                    "profile": pid,
                    "cookiesOnDisk": disk_path.is_file(),
                    "diskHasValidPsid": False,
                    "authenticated": None,
                    "status": "NO_COOKIES",
                    "description": "No valid __Secure-1PSID in cookies.json for this profile.",
                    "error": None,
                    "httpStatus": None,
                }
            )
            continue
        try:
            snap = await asyncio.wait_for(_run_with_client(pid, ck, do_probe), timeout=120.0)
            rows.append(
                {
                    "profile": pid,
                    "cookiesOnDisk": True,
                    "diskHasValidPsid": True,
                    **snap,
                    "error": None,
                    "httpStatus": 200,
                }
            )
        except asyncio.TimeoutError:
            rows.append(
                {
                    "profile": pid,
                    "cookiesOnDisk": True,
                    "diskHasValidPsid": True,
                    "authenticated": None,
                    "status": "TIMEOUT",
                    "description": "Client init or status probe exceeded 120s.",
                    "error": "timeout after 120s",
                    "httpStatus": 504,
                }
            )
        except Exception as e:
            he = _http_exception_from_upstream(pid, e)
            err_detail = he.detail
            if not isinstance(err_detail, str):
                err_detail = json.dumps(err_detail, ensure_ascii=False)
            rows.append(
                {
                    "profile": pid,
                    "cookiesOnDisk": True,
                    "diskHasValidPsid": True,
                    "authenticated": None,
                    "status": "PROBE_ERROR",
                    "description": None,
                    "error": err_detail,
                    "httpStatus": he.status_code,
                }
            )

    return {
        "profilesRoot": str(PROFILES_ROOT),
        "checkedAt": checked_at,
        "profiles": rows,
    }
