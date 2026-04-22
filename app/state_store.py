"""
Profile account-status snapshots and optional Redis-backed auxiliary state.

- ``REDIS_URL`` unset: last ``POST /v1/status`` result is stored as
  ``<profile>/account_status.json`` on disk (under ``GEMINI_PROFILES_ROOT``).
- ``REDIS_URL`` set and reachable at startup: the same payload is stored in Redis
  (key prefix ``GEMINI_REDIS_KEY_PREFIX``, default ``gemini``); the on-disk file is
  removed on write to avoid two sources of truth.

Optional: ``GEMINI_REDIS_ACCOUNT_STATUS_TTL_SECONDS`` (>0) sets Redis EX for account
status keys (default: no expiry).

Also: background job tick metadata (health probe loop, cookie persistence hints) and
``/v1/generate`` history (request id + profile + outcome), stored in Redis when
available, else small JSONL under ``GEMINI_PROFILES_ROOT`` (``_generation_history.jsonl``).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger("gemini-api-standalone")

REDIS_URL = (os.environ.get("REDIS_URL") or "").strip()
KEY_PREFIX = (os.environ.get("GEMINI_REDIS_KEY_PREFIX") or "gemini").strip().rstrip(":") or "gemini"
PROFILES_ROOT = Path(os.environ.get("GEMINI_PROFILES_ROOT", "/data/profiles")).resolve()
_ACCOUNT_STATUS_DISK_NAME = "account_status.json"

_r: Any = None
redis_configured: bool = False
redis_connected: bool = False

# In-memory job ticks when Redis is unavailable (single-process).
_mem_health_tick: dict[str, Any] = {}
_mem_cookie_tick: dict[str, Any] = {}


def _account_status_redis_key(profile_id: str) -> str:
    return f"{KEY_PREFIX}:profile:{profile_id}:account_status"


def _generations_redis_key() -> str:
    return f"{KEY_PREFIX}:generations"


def _job_health_redis_key() -> str:
    return f"{KEY_PREFIX}:job:health"


def _job_cookie_redis_key() -> str:
    return f"{KEY_PREFIX}:job:cookie_rotation"


def _generations_max() -> int:
    raw = (os.environ.get("GEMINI_REDIS_GENERATIONS_MAX") or "500").strip()
    try:
        n = int(raw)
    except ValueError:
        n = 500
    return max(10, min(n, 50_000))


def _generations_disk_path() -> Path:
    return PROFILES_ROOT / "_generation_history.jsonl"


def _disk_path(profile_id: str) -> Path:
    return PROFILES_ROOT / profile_id / _ACCOUNT_STATUS_DISK_NAME


def _load_disk(profile_id: str) -> Optional[dict[str, Any]]:
    path = _disk_path(profile_id)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def _save_disk(profile_id: str, payload: dict[str, Any]) -> None:
    parent = PROFILES_ROOT / profile_id
    parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    path = parent / _ACCOUNT_STATUS_DISK_NAME
    text = json.dumps(payload, indent=2, ensure_ascii=False)
    fd, tmp_name = tempfile.mkstemp(prefix=".account_status.", suffix=".tmp", dir=str(parent.resolve()))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    try:
        path.chmod(0o600)
    except OSError:
        pass


def _unlink_disk(profile_id: str) -> None:
    p = _disk_path(profile_id)
    if p.is_file():
        try:
            p.unlink()
        except OSError:
            pass


def _redis_active() -> bool:
    return _r is not None and redis_connected


async def startup() -> None:
    global _r, redis_configured, redis_connected
    redis_configured = bool(REDIS_URL)
    redis_connected = False
    _r = None
    if not REDIS_URL:
        log.info("REDIS_URL not set — account status cache uses on-disk JSON per profile.")
        return
    try:
        import redis.asyncio as redis_async
    except ImportError as e:
        log.error("redis package missing but REDIS_URL is set: %s", e)
        return
    client = redis_async.from_url(REDIS_URL, decode_responses=True)
    try:
        await asyncio.wait_for(client.ping(), timeout=5.0)
        _r = client
        redis_connected = True
        log.info("Redis connected for state (key prefix=%s).", KEY_PREFIX)
    except Exception as e:
        log.error("Redis ping failed — using disk for account status only: %s", e)
        redis_connected = False
        await client.aclose()


async def shutdown() -> None:
    global _r, redis_connected
    if _r is not None:
        try:
            await _r.aclose()
        except Exception:
            pass
        _r = None
    redis_connected = False


async def get_account_status(profile_id: str) -> Optional[dict[str, Any]]:
    if _redis_active():
        try:
            raw = await _r.get(_account_status_redis_key(profile_id))
            if raw:
                data = json.loads(raw)
                if isinstance(data, dict):
                    return data
        except Exception as e:
            log.warning("Redis GET account_status profile=%s: %s", profile_id, e)
    return await asyncio.to_thread(_load_disk, profile_id)


async def set_account_status(profile_id: str, snapshot: dict[str, Any]) -> None:
    payload = {
        "status": snapshot.get("status"),
        "description": snapshot.get("description") or "",
        "authenticated": snapshot.get("authenticated"),
        "checkedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if _redis_active():
        try:
            ttl_raw = (os.environ.get("GEMINI_REDIS_ACCOUNT_STATUS_TTL_SECONDS") or "0").strip()
            ttl = int(ttl_raw) if ttl_raw else 0
            kwargs: dict[str, Any] = {}
            if ttl > 0:
                kwargs["ex"] = ttl
            await _r.set(_account_status_redis_key(profile_id), json.dumps(payload), **kwargs)
            _unlink_disk(profile_id)
            return
        except Exception as e:
            log.warning("Redis SET account_status profile=%s: %s — falling back to disk", profile_id, e)
    await asyncio.to_thread(_save_disk, profile_id, payload)


async def clear_account_status(profile_id: str) -> None:
    if _redis_active():
        try:
            await _r.delete(_account_status_redis_key(profile_id))
        except Exception as e:
            log.warning("Redis DEL account_status profile=%s: %s", profile_id, e)
    await asyncio.to_thread(_unlink_disk, profile_id)


# --- Generic namespaced JSON (optional; for future rate limits, flags, etc.) ---


async def kv_json_get(scope: str, name: str) -> Optional[dict[str, Any]]:
    if not _redis_active():
        return None
    key = f"{KEY_PREFIX}:kv:{scope}:{name}"
    try:
        raw = await _r.get(key)
        if not raw:
            return None
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except Exception as e:
        log.warning("Redis GET kv scope=%s name=%s: %s", scope, name, e)
        return None


async def kv_json_set(scope: str, name: str, obj: dict[str, Any], ttl_seconds: int = 0) -> bool:
    if not _redis_active():
        return False
    key = f"{KEY_PREFIX}:kv:{scope}:{name}"
    try:
        kwargs: dict[str, Any] = {}
        if ttl_seconds > 0:
            kwargs["ex"] = ttl_seconds
        await _r.set(key, json.dumps(obj), **kwargs)
        return True
    except Exception as e:
        log.warning("Redis SET kv scope=%s name=%s: %s", scope, name, e)
        return False


async def kv_delete(scope: str, name: str) -> None:
    if not _redis_active():
        return
    key = f"{KEY_PREFIX}:kv:{scope}:{name}"
    try:
        await _r.delete(key)
    except Exception as e:
        log.warning("Redis DEL kv scope=%s name=%s: %s", scope, name, e)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iso_plus_seconds(iso_base: str, seconds: float) -> str:
    try:
        base = datetime.strptime(iso_base, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except Exception:
        base = datetime.now(timezone.utc)
    return (base + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


async def record_health_job_tick(*, ok: bool, detail: str, interval_seconds: float) -> None:
    """Persist last/next health probe times for the admin Jobs UI."""
    global _mem_health_tick
    now = _utc_now_iso()
    nxt = _iso_plus_seconds(now, interval_seconds)
    payload = {
        "lastRunAt": now,
        "nextRunAt": nxt,
        "ok": bool(ok),
        "detail": (detail or "")[:2000],
    }
    if _redis_active():
        try:
            await _r.set(_job_health_redis_key(), json.dumps(payload))
            return
        except Exception as e:
            log.warning("Redis SET health job tick: %s", e)
    _mem_health_tick = dict(payload)


async def record_cookie_persist_hint(*, profile_id: str) -> None:
    """
    Best-effort timestamp when session cookies were persisted (generate/status/etc.).
    Used by the Jobs UI as activity signal alongside GEMINI_REFRESH_INTERVAL_SECONDS.
    """
    global _mem_cookie_tick
    now = _utc_now_iso()
    payload = {
        "lastPersistAt": now,
        "lastProfile": (profile_id or "")[:128],
    }
    if _redis_active():
        try:
            await _r.set(_job_cookie_redis_key(), json.dumps(payload))
            return
        except Exception as e:
            log.warning("Redis SET cookie job hint: %s", e)
    _mem_cookie_tick = dict(payload)


async def redis_ping_ok() -> tuple[bool, str]:
    """Returns (ok, detail) for an optional connectivity probe (admin health job)."""
    if not redis_configured:
        return True, "redis not configured"
    if not _redis_active():
        return False, "redis configured but not connected"
    try:
        await asyncio.wait_for(_r.ping(), timeout=3.0)
        return True, "redis ping ok"
    except Exception as e:
        return False, f"redis ping failed: {e}"


async def get_job_ticks() -> tuple[dict[str, Any], dict[str, Any]]:
    """Returns (health_tick, cookie_tick) dicts possibly empty."""
    health: dict[str, Any] = {}
    cookie: dict[str, Any] = {}
    if _redis_active():
        try:
            raw_h = await _r.get(_job_health_redis_key())
            if raw_h:
                h = json.loads(raw_h)
                if isinstance(h, dict):
                    health = h
        except Exception as e:
            log.warning("Redis GET health job tick: %s", e)
        try:
            raw_c = await _r.get(_job_cookie_redis_key())
            if raw_c:
                c = json.loads(raw_c)
                if isinstance(c, dict):
                    cookie = c
        except Exception as e:
            log.warning("Redis GET cookie job tick: %s", e)
    if not health and _mem_health_tick:
        health = dict(_mem_health_tick)
    if not cookie and _mem_cookie_tick:
        cookie = dict(_mem_cookie_tick)
    return health, cookie


def _append_generation_disk_line(line: str) -> None:
    path = _generations_disk_path()
    try:
        path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError as e:
        log.warning("generation history disk append failed: %s", e)


def _list_generation_events_from_disk_sync(lim: int, off: int) -> list[dict[str, Any]]:
    path = _generations_disk_path()
    if not path.is_file():
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    chunk: list[dict[str, Any]] = []
    for ln in reversed(lines):
        ln = ln.strip()
        if not ln:
            continue
        try:
            data = json.loads(ln)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            chunk.append(data)
    return chunk[off : off + lim]


async def record_generation_event(event: dict[str, Any]) -> None:
    """
    Record a /v1/generate outcome (success or mapped HTTP error). Payload should be JSON-serializable.
    """
    row = dict(event)
    row.setdefault("recordedAt", _utc_now_iso())
    line = json.dumps(row, ensure_ascii=False)
    if _redis_active():
        try:
            key = _generations_redis_key()
            max_n = _generations_max()
            await _r.lpush(key, line)
            await _r.ltrim(key, 0, max_n - 1)
            return
        except Exception as e:
            log.warning("Redis LPUSH generations: %s — falling back to disk", e)
    await asyncio.to_thread(_append_generation_disk_line, line)


async def list_generation_events(limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
    lim = max(1, min(int(limit), 500))
    off = max(0, int(offset))
    out: list[dict[str, Any]] = []
    if _redis_active():
        try:
            raw_rows = await _r.lrange(_generations_redis_key(), off, off + lim - 1)
            for raw in raw_rows or []:
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if isinstance(data, dict):
                    out.append(data)
            return out
        except Exception as e:
            log.warning("Redis LRANGE generations: %s — falling back to disk", e)
    return await asyncio.to_thread(_list_generation_events_from_disk_sync, lim, off)
