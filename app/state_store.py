"""
Profile account-status snapshots and optional Redis-backed auxiliary state.

- ``REDIS_URL`` unset: last ``POST /v1/status`` result is stored as
  ``<profile>/account_status.json`` on disk (under ``GEMINI_PROFILES_ROOT``).
- ``REDIS_URL`` set and reachable at startup: the same payload is stored in Redis
  (key prefix ``GEMINI_REDIS_KEY_PREFIX``, default ``gemini``); the on-disk file is
  removed on write to avoid two sources of truth.

Optional: ``GEMINI_REDIS_ACCOUNT_STATUS_TTL_SECONDS`` (>0) sets Redis EX for account
status keys (default: no expiry).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
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


def _account_status_redis_key(profile_id: str) -> str:
    return f"{KEY_PREFIX}:profile:{profile_id}:account_status"


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
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
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
    return _load_disk(profile_id)


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
    _save_disk(profile_id, payload)


async def clear_account_status(profile_id: str) -> None:
    if _redis_active():
        try:
            await _r.delete(_account_status_redis_key(profile_id))
        except Exception as e:
            log.warning("Redis DEL account_status profile=%s: %s", profile_id, e)
    _unlink_disk(profile_id)


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
