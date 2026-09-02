"""Native desktop launcher for the OmegaDash telemetry dashboard."""

from __future__ import annotations

import base64
import ctypes
import hashlib
import hmac
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from html import unescape
from datetime import timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from tkinter import filedialog, Tk
from typing import Any

if sys.platform == "win32":
    from ctypes import wintypes
    _webview2_quiet = "--disable-logging --log-level=3 --disable-breakpad"
    _webview2_args = os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "")
    if "--log-level=3" not in _webview2_args:
        os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"{_webview2_args} {_webview2_quiet}".strip()

import sqlite3

import webview

import telemetry

_CHROMIUM_CONSOLE_NOISE = (
    "Chrome_WidgetWin_0",
    "window_impl.cc",
    "Failed to unregister class",
)


def _patch_webview2_quiet_args() -> None:
    """pywebview overwrites AdditionalBrowserArguments; append Chromium quiet flags."""
    if sys.platform != "win32":
        return
    try:
        from webview.platforms.edgechromium import EdgeChrome
    except Exception:
        return
    orig = EdgeChrome.__init__
    extra = " --disable-logging --log-level=3 --disable-breakpad --disable-gpu-logging"
    if getattr(orig, "_omega_quiet", False):
        return

    def wrapped(self, form, window, cache_dir):
        orig(self, form, window, cache_dir)
        try:
            props = self.webview.CreationProperties
            args = str(getattr(props, "AdditionalBrowserArguments", None) or "")
            if "--disable-logging" not in args:
                props.AdditionalBrowserArguments = (args + extra).strip()
                self.webview.CreationProperties = props
        except Exception:
            pass

    wrapped._omega_quiet = True
    EdgeChrome.__init__ = wrapped


def _filter_chromium_stderr() -> None:
    """WebView2 child processes write Chromium logs to the inherited Win32 stderr."""
    if sys.platform != "win32":
        return
    try:
        import msvcrt
    except ImportError:
        return
    kernel32 = ctypes.windll.kernel32
    kernel32.SetStdHandle.argtypes = [wintypes.DWORD, wintypes.HANDLE]
    kernel32.SetStdHandle.restype = wintypes.BOOL
    kernel32.SetHandleInformation.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD]
    kernel32.SetHandleInformation.restype = wintypes.BOOL
    std_error = ctypes.c_uint32(-12 & 0xFFFFFFFF)
    try:
        read_fd, write_fd = os.pipe()
        write_handle = wintypes.HANDLE(msvcrt.get_osfhandle(write_fd))
        kernel32.SetHandleInformation(write_handle, 1, 1)
        if not kernel32.SetStdHandle(std_error, write_handle):
            os.close(read_fd)
            os.close(write_fd)
            return
    except OSError:
        return

    def _pump() -> None:
        leftover = ""
        out = getattr(sys, "__stderr__", None) or sys.stderr
        while True:
            try:
                chunk = os.read(read_fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            leftover += chunk.decode("utf-8", "replace")
            while "\n" in leftover:
                line, leftover = leftover.split("\n", 1)
                if any(token in line for token in _CHROMIUM_CONSOLE_NOISE):
                    continue
                try:
                    out.write(line + "\n")
                    out.flush()
                except Exception:
                    pass

    threading.Thread(target=_pump, name="omega-stderr", daemon=True).start()


_patch_webview2_quiet_args()

BUNDLE_DIR = telemetry.BUNDLE_DIR
APP_DIR = telemetry.APP_DIR
APP_TITLE = "OmegaDash — CS2 Telemetry"
CONSTELIA_API = "https://constelia.ai/api.php"
LEETIFY_API_BASE = "https://api-public.cs-prod.leetify.com"
LEETIFY_PROFILE_URL = f"{LEETIFY_API_BASE}/v3/profile"
LEETIFY_VALIDATE_URL = f"{LEETIFY_API_BASE}/api-key/validate"
STEAM64_BASE = 76561197960265728
SETTINGS_PATH = APP_DIR / "omega-settings.json"
SECRETS_PATH = APP_DIR / "omega-secrets.json"
SENS_RESULT_PATH = APP_DIR / "omega-sens-last.json"
INVENTORY_RESULT_PATH = APP_DIR / "omega-inventory-last.json"
WINDOW_STATE_PATH = APP_DIR / "omega-window.json"
CS2_APPID = 730
CS2_CONTEXTID = 2
STEAM_ICON_CDN = "https://community.akamai.steamstatic.com/economy/image"
INVENTORY_COOLDOWN_PATH = APP_DIR / "omega-inventory-cooldown.json"
CSFLOAT_LISTINGS_URL = "https://csfloat.com/api/v1/listings"
CSFLOAT_PRICE_LIST_URL = "https://csfloat.com/api/v1/listings/price-list"
CSFLOAT_PRICE_PATH = APP_DIR / "omega-csfloat-prices.json"
CSFLOAT_PRICE_LIST_PATH = APP_DIR / "omega-csfloat-pricelist.json"
CSFLOAT_PRICE_TTL = 2 * 60 * 60
CSFLOAT_ERROR_TTL = 15 * 60
CSFLOAT_GAP_SEC = 1.05
CSFLOAT_CACHE_REV = 2
CSFLOAT_SKIN_CATEGORIES = {"weapons", "knives", "gloves"}
CSFLOAT_VALUE_PATH = APP_DIR / "omega-csfloat-value.json"
CSFLOAT_VALUE_MAX = 180
STEAM_RATE_LIMIT_SEC = 2 * 60 * 60
STEAM_COMMUNITY_HOME = "https://steamcommunity.com/"
# One home IP, no proxy pool. steam-inventory-api uses maxUse=25/min across
# rotating proxies; from a single address that burst is enough to 429.
STEAM_PAGE_GAP_SEC = 2.5
STEAM_MAX_REQUESTS_PER_MIN = 6
_INVENTORY_FETCH_LOCK = threading.Lock()
_inventory_fetching = False
_STEAM_REQ_LOCK = threading.Lock()
_steam_req_times: list[float] = []
_STEAM_WIN_LOCK = threading.Lock()
_STEAM_WIN: Any = None
_STEAM_BRIDGE: SteamInvBridge | None = None
_QUIT_LOCK = threading.Lock()
_QUIT_STARTED = False
GEMINI_MODELS = ("gemini-3.5-flash-lite",)
GEMINI_LIMIT_CODES = {429, 503}
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
SECRET_NAMES = ("constelia", "leetify", "gemini", "csfloat")
MAX_SECRET_LEN = 8192
OMEGA_EXE_NAME = "fantasy.earthbound.exe"
_OMEGA_DIR: Path | None = None
_MEMBER_DIR: Path | None = None
SECRETS_FORMAT = 2
# Mixed into DPAPI entropy and the Linux/macOS KDF. Changing this would make
# existing encrypted keys unreadable.
_SECRETS_ENTROPY = b"OmegaAim.secrets.v2.dpapi.2026"
_CRYPTPROTECT_UI_FORBIDDEN = 0x01
_SECRETS_NONCE_LEN = 16
_SECRETS_TAG_LEN = 32
_SECRETS_LOCK = threading.Lock()
_SECRETS_MEM: dict[str, str] | None = None
DEFAULT_WINDOW = {"width": 1440, "height": 920}
MIN_WINDOW = {"width": 980, "height": 680}
FORUM_LINKS = {
    "conversations": "https://constelia.ai/forums/index.php?direct-messages/",
    "alerts": "https://constelia.ai/forums/index.php?account/alerts",
}


if sys.platform == "win32":
    class _DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]
else:
    _DATA_BLOB = None  # type: ignore[misc, assignment]


_crypt32 = None
_kernel32 = None


def _secrets_dlls():
    global _crypt32, _kernel32
    if sys.platform != "win32":
        raise OSError("API key encryption requires Windows")
    if _crypt32 is None:
        crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        crypt32.CryptProtectData.argtypes = [
            ctypes.POINTER(_DATA_BLOB),
            wintypes.LPCWSTR,
            ctypes.POINTER(_DATA_BLOB),
            ctypes.c_void_p,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(_DATA_BLOB),
        ]
        crypt32.CryptProtectData.restype = wintypes.BOOL
        crypt32.CryptUnprotectData.argtypes = [
            ctypes.POINTER(_DATA_BLOB),
            ctypes.POINTER(wintypes.LPWSTR),
            ctypes.POINTER(_DATA_BLOB),
            ctypes.c_void_p,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(_DATA_BLOB),
        ]
        crypt32.CryptUnprotectData.restype = wintypes.BOOL
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        _crypt32, _kernel32 = crypt32, kernel32
    return _crypt32, _kernel32


def _dpapi_blob(data: bytes) -> tuple[_DATA_BLOB, Any]:
    buf = ctypes.create_string_buffer(data, len(data))
    blob = _DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte)))
    return blob, buf


def _dpapi_protect(data: bytes) -> bytes:
    if not data:
        return b""
    crypt32, kernel32 = _secrets_dlls()
    blob_in, keep_in = _dpapi_blob(data)
    blob_ent, keep_ent = _dpapi_blob(_SECRETS_ENTROPY)
    blob_out = _DATA_BLOB()
    if not crypt32.CryptProtectData(
        ctypes.byref(blob_in),
        "OmegaDash",
        ctypes.byref(blob_ent),
        None,
        None,
        _CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(blob_out),
    ):
        raise OSError(ctypes.get_last_error() or "CryptProtectData failed")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        if blob_out.pbData:
            kernel32.LocalFree(blob_out.pbData)
        _ = keep_in, keep_ent


def _dpapi_unprotect(data: bytes) -> bytes:
    if not data:
        return b""
    crypt32, kernel32 = _secrets_dlls()
    blob_in, keep_in = _dpapi_blob(data)
    blob_ent, keep_ent = _dpapi_blob(_SECRETS_ENTROPY)
    blob_out = _DATA_BLOB()
    if not crypt32.CryptUnprotectData(
        ctypes.byref(blob_in),
        None,
        ctypes.byref(blob_ent),
        None,
        None,
        _CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(blob_out),
    ):
        raise OSError(ctypes.get_last_error() or "CryptUnprotectData failed")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        if blob_out.pbData:
            kernel32.LocalFree(blob_out.pbData)
        _ = keep_in, keep_ent


def _host_fingerprint() -> bytes:
    parts: list[bytes] = []
    uid = getattr(os, "getuid", None)
    if callable(uid):
        parts.append(str(int(uid())).encode("ascii"))
    else:
        parts.append((os.getenv("USERNAME") or os.getenv("USER") or "user").encode("utf-8"))
    for path in (Path("/etc/machine-id"), Path("/var/lib/dbus/machine-id")):
        try:
            text = path.read_text(encoding="ascii").strip()
        except OSError:
            continue
        if text:
            parts.append(text.encode("ascii"))
            break
    else:
        try:
            parts.append((socket.gethostname() or "host").encode("utf-8"))
        except OSError:
            parts.append(b"host")
    return b"|".join(parts)


def _local_secret_key(salt: bytes) -> bytes:
    material = _SECRETS_ENTROPY + b"|" + _host_fingerprint()
    try:
        return hashlib.scrypt(material, salt=salt, n=16384, r=8, p=1, dklen=32)
    except (ValueError, TypeError, OSError):
        return hashlib.pbkdf2_hmac("sha256", material, salt, 200_000, dklen=32)


def _local_protect(data: bytes, key: bytes) -> bytes:
    nonce = os.urandom(_SECRETS_NONCE_LEN)
    stream = hashlib.shake_256(key + b"\x00" + nonce).digest(len(data))
    cipher = bytes(a ^ b for a, b in zip(data, stream))
    tag = hmac.new(key, b"omegadash.v2.local|" + nonce + cipher, hashlib.sha256).digest()
    return nonce + tag + cipher


def _local_unprotect(blob: bytes, key: bytes) -> bytes:
    need = _SECRETS_NONCE_LEN + _SECRETS_TAG_LEN
    if len(blob) < need:
        raise ValueError("truncated secret")
    nonce = blob[:_SECRETS_NONCE_LEN]
    tag = blob[_SECRETS_NONCE_LEN:need]
    cipher = blob[need:]
    expect = hmac.new(key, b"omegadash.v2.local|" + nonce + cipher, hashlib.sha256).digest()
    if not hmac.compare_digest(tag, expect):
        raise ValueError("bad secret mac")
    stream = hashlib.shake_256(key + b"\x00" + nonce).digest(len(cipher))
    return bytes(a ^ b for a, b in zip(cipher, stream))


def _encode_secret(value: str, key: bytes | None = None) -> str:
    raw = value.encode("utf-8")
    blob = _local_protect(raw, key) if key is not None else _dpapi_protect(raw)
    return base64.b64encode(blob).decode("ascii")


def _decode_secret(value: str, enc: str, key: bytes | None = None) -> str:
    raw = base64.b64decode(value.encode("ascii"))
    if enc == "local":
        if not key:
            raise ValueError("missing local key")
        text = _local_unprotect(raw, key)
    elif enc == "dpapi":
        text = _dpapi_unprotect(raw)
    else:
        raise ValueError("unknown secret encoding")
    return text.decode("utf-8")


def _plain_secrets_from(parsed: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    for name in SECRET_NAMES:
        value = str(parsed.get(name) or "").strip()
        if value:
            out[name] = value[:MAX_SECRET_LEN]
    return out


def _decrypt_secret_map(parsed: dict) -> dict[str, str]:
    blob = parsed.get("secrets")
    if not isinstance(blob, dict):
        return {}
    enc = str(parsed.get("enc") or "")
    key = None
    if enc == "local":
        try:
            salt = base64.b64decode(str(parsed.get("salt") or "").encode("ascii"))
        except (ValueError, TypeError):
            return {}
        if len(salt) < 16:
            return {}
        key = _local_secret_key(salt)
    out: dict[str, str] = {}
    for name in SECRET_NAMES:
        value = str(blob.get(name) or "").strip()
        if not value:
            continue
        try:
            text = _decode_secret(value, enc, key).strip()[:MAX_SECRET_LEN]
        except (OSError, ValueError, UnicodeDecodeError, TypeError):
            continue
        if text:
            out[name] = text
    return out


def _secrets_payload(secrets: dict[str, str]) -> dict[str, Any]:
    encoded: dict[str, str] = {}
    if sys.platform == "win32":
        for name in SECRET_NAMES:
            value = str(secrets.get(name) or "").strip()[:MAX_SECRET_LEN]
            if value:
                encoded[name] = _encode_secret(value)
        return {"v": SECRETS_FORMAT, "enc": "dpapi", "secrets": encoded}
    salt = os.urandom(16)
    key = _local_secret_key(salt)
    for name in SECRET_NAMES:
        value = str(secrets.get(name) or "").strip()[:MAX_SECRET_LEN]
        if value:
            encoded[name] = _encode_secret(value, key)
    return {
        "v": SECRETS_FORMAT,
        "enc": "local",
        "salt": base64.b64encode(salt).decode("ascii"),
        "secrets": encoded,
    }


def _write_secrets_file(payload: dict[str, Any]) -> None:
    tmp = SECRETS_PATH.with_name(SECRETS_PATH.name + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    if sys.platform != "win32":
        os.chmod(tmp, 0o600)
    tmp.replace(SECRETS_PATH)
    if sys.platform != "win32":
        try:
            os.chmod(SECRETS_PATH, 0o600)
        except OSError:
            pass


def _load_secrets() -> dict[str, str]:
    with _SECRETS_LOCK:
        global _SECRETS_MEM
        if _SECRETS_MEM is not None:
            return dict(_SECRETS_MEM)
        out: dict[str, str] = {}
        migrate = False
        try:
            if SECRETS_PATH.is_file():
                parsed = json.loads(SECRETS_PATH.read_text(encoding="utf-8"))
                if isinstance(parsed, dict):
                    enc = parsed.get("enc")
                    if parsed.get("v") == SECRETS_FORMAT and enc in ("dpapi", "local"):
                        out = _decrypt_secret_map(parsed)
                    else:
                        out = _plain_secrets_from(parsed)
                        migrate = bool(out)
        except (OSError, json.JSONDecodeError):
            out = {}
        if migrate:
            try:
                _write_secrets_file(_secrets_payload(out))
            except OSError:
                pass
        _SECRETS_MEM = out
        return dict(out)


def _save_secrets(secrets: dict[str, str]) -> None:
    clean = {name: str(secrets[name]).strip()[:MAX_SECRET_LEN] for name in SECRET_NAMES if secrets.get(name)}
    payload = _secrets_payload(clean)
    with _SECRETS_LOCK:
        global _SECRETS_MEM
        _write_secrets_file(payload)
        _SECRETS_MEM = clean


def _secret(name: str) -> str:
    return _load_secrets().get(name, "")


def _mask_secret(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if len(text) <= 4:
        return "••••"
    return f"••••{text[-4:]}"


def _constelia_key() -> str:
    key = _secret("constelia")
    if not key:
        raise FileNotFoundError("Constelia API key is not set")
    return key


def _as_steam64(value: object) -> str:
    text = str(value or "").strip()
    if text.isdigit() and text.startswith("7656119") and len(text) >= 17:
        return text
    if text.isdigit() and 1 <= len(text) <= 16:
        try:
            account = int(text)
        except ValueError:
            return ""
        if 0 < account < STEAM64_BASE:
            return str(account + STEAM64_BASE)
        return ""
    steam2 = re.match(r"^STEAM_[0-5]:([01]):(\d+)$", text, re.I)
    if steam2:
        y, z = int(steam2.group(1)), int(steam2.group(2))
        return str(z * 2 + y + STEAM64_BASE)
    steam3 = re.search(r"\[U:1:(\d+)\]", text, re.I)
    if steam3:
        return _as_steam64(steam3.group(1))
    return ""


def _steam_account_rows(raw: object) -> list[dict[str, Any]]:
    if isinstance(raw, dict):
        if any(key in raw for key in ("steamid", "steam_id", "id", "login", "name")):
            return [raw]
        return [row for row in raw.values() if isinstance(row, dict)]
    if isinstance(raw, list):
        return [row for row in raw if isinstance(row, dict)]
    return []


def _member_steam64(raw: dict[str, Any] | None) -> str:
    if not isinstance(raw, dict):
        return ""
    steam = raw.get("steam")
    if isinstance(steam, dict):
        sid = _as_steam64(steam.get("id") or steam.get("steamid") or steam.get("steam_id"))
        if sid:
            return sid
        rows = _steam_account_rows(steam)
    elif isinstance(steam, list):
        rows = _steam_account_rows(steam)
    else:
        rows = []
    for key in ("steam_accounts", "steamAccounts", "accounts"):
        if rows:
            break
        rows = _steam_account_rows(raw.get(key))
    best = ""
    best_login = -1
    for row in rows:
        sid = _as_steam64(row.get("steamid") or row.get("steam_id") or row.get("id"))
        if not sid:
            continue
        try:
            last = int(row.get("last_login") or 0)
        except (TypeError, ValueError):
            last = 0
        if last >= best_login:
            best = sid
            best_login = last
    if best:
        return best
    return _as_steam64(raw.get("steamid") or raw.get("steam_id") or raw.get("steam"))


def _leetify_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/json",
        "User-Agent": "OmegaDash/1.0",
    }
    key = _secret("leetify")
    if key:
        headers["_leetify_key"] = key
        headers["Authorization"] = f"Bearer {key}"
    return headers


def _validate_leetify_key(key: str) -> int:
    token = str(key or "").strip()
    if not token:
        return 401
    request = urllib.request.Request(
        LEETIFY_VALIDATE_URL,
        method="GET",
        headers={
            "Accept": "application/json",
            "User-Agent": "OmegaDash/1.0",
            "_leetify_key": token,
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return int(getattr(response, "status", 200) or 200)
    except urllib.error.HTTPError as exc:
        return int(exc.code or 401)
    except (urllib.error.URLError, TimeoutError, OSError):
        return 500


def _leetify_ban_labels(raw: object) -> list[str]:
    if not isinstance(raw, list):
        return []
    labels = []
    seen = set()
    for item in raw:
        if isinstance(item, dict):
            label = str(item.get("platform") or item.get("type") or item.get("source") or "ban").strip()
        else:
            label = str(item or "").strip()
        if not label:
            continue
        key = label.lower()
        if key in seen:
            continue
        seen.add(key)
        labels.append(label.upper() if len(label) <= 8 else label)
    return labels


def _leetify_int(value: object) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _leetify_map_key(name: object) -> str:
    key = "".join(str(name or "").strip().lower().split())
    key = key.replace("dustii", "dust2")
    if key.startswith("de_") or key.startswith("cs_"):
        return key
    aliases = {
        "mirage": "de_mirage",
        "inferno": "de_inferno",
        "dust2": "de_dust2",
        "ancient": "de_ancient",
        "nuke": "de_nuke",
        "anubis": "de_anubis",
        "overpass": "de_overpass",
        "vertigo": "de_vertigo",
        "train": "de_train",
        "cache": "de_cache",
        "office": "cs_office",
        "italy": "cs_italy",
    }
    return aliases.get(key, key)


def _leetify_competitive(raw: object) -> list[dict[str, Any]]:
    rows: list = []
    if isinstance(raw, list):
        rows = raw
    elif isinstance(raw, dict):
        rows = [{"map_name": key, "rank": val} for key, val in raw.items()]
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in rows:
        if not isinstance(item, dict):
            continue
        map_name = _leetify_map_key(
            item.get("map_name") or item.get("map") or item.get("name") or item.get("mapName")
        )
        rank = _leetify_int(
            item.get("rank") if "rank" in item else item.get("skill_group") or item.get("skillgroup")
        )
        if not map_name or rank is None or map_name in seen:
            continue
        seen.add(map_name)
        out.append({"mapName": map_name, "rank": max(0, min(18, rank))})
        if len(out) >= 24:
            break
    return out


def _public_leetify_profile(steam64: str, raw: dict) -> dict:
    nested = raw.get("profile") if isinstance(raw.get("profile"), dict) else {}
    ranks = raw.get("ranks") if isinstance(raw.get("ranks"), dict) else {}
    if not ranks and isinstance(nested.get("ranks"), dict):
        ranks = nested.get("ranks") or {}
    rating = raw.get("rating") if isinstance(raw.get("rating"), dict) else {}
    if not rating and isinstance(nested.get("rating"), dict):
        rating = nested.get("rating") or {}
    stats = raw.get("stats") if isinstance(raw.get("stats"), dict) else {}
    if not stats and isinstance(nested.get("stats"), dict):
        stats = nested.get("stats") or {}
    bans = _leetify_ban_labels(raw.get("bans"))
    privacy = str(raw.get("privacy_mode") or raw.get("privacy") or "").lower()
    competitive = _leetify_competitive(
        ranks.get("competitive") if "competitive" in ranks else ranks.get("competitive_ranks") or ranks.get("maps")
    )
    status = "private" if privacy and privacy not in {"public", ""} and not ranks and not stats else "ok"
    return {
        "steam64": steam64,
        "status": status,
        "privacy": privacy or None,
        "bans": bans,
        "banCount": len(bans),
        "premier": _leetify_int(ranks.get("premier")),
        "faceit": _leetify_int(ranks.get("faceit")),
        "faceitElo": _leetify_int(ranks.get("faceit_elo") if "faceit_elo" in ranks else ranks.get("faceitElo")),
        "wingman": _leetify_int(ranks.get("wingman")),
        "competitive": competitive,
        "aim": rating.get("aim"),
        "preaim": stats.get("preaim"),
        "reaction": stats.get("reaction_time_ms"),
        "spray": stats.get("spray_accuracy"),
    }


def _fetch_leetify_profile(steam64: str) -> dict:
    query = urllib.parse.urlencode({"steam64_id": steam64})
    request = urllib.request.Request(
        f"{LEETIFY_PROFILE_URL}?{query}",
        method="GET",
        headers=_leetify_headers(),
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code in {404, 422}:
            return {"steam64": steam64, "status": "missing"}
        return {"steam64": steam64, "status": "error", "error": f"HTTP {exc.code}"}
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return {"steam64": steam64, "status": "error"}
    if not isinstance(raw, dict):
        return {"steam64": steam64, "status": "error"}
    if raw.get("error") and not raw.get("ranks") and not raw.get("stats"):
        return {"steam64": steam64, "status": "missing", "error": str(raw.get("error"))}
    return _public_leetify_profile(steam64, raw)


_LEETIFY_LOCK = threading.Lock()
_LEETIFY_QUEUE: list[str] = []
_LEETIFY_QUEUED: set[str] = set()
_LEETIFY_THREAD: threading.Thread | None = None


def _leetify_worker() -> None:
    global _LEETIFY_THREAD
    while True:
        with _LEETIFY_LOCK:
            if not _LEETIFY_QUEUE:
                _LEETIFY_THREAD = None
                return
            sid = _LEETIFY_QUEUE.pop(0)
        try:
            profile = _fetch_leetify_profile(sid)
            telemetry.save_leetify_profile(sid, profile)
        except Exception:
            try:
                telemetry.save_leetify_profile(sid, {"steam64": sid, "status": "error"})
            except (OSError, sqlite3.Error):
                pass
        finally:
            with _LEETIFY_LOCK:
                _LEETIFY_QUEUED.discard(sid)


def _queue_leetify_fetch(steam64: str) -> None:
    global _LEETIFY_THREAD
    sid = str(steam64 or "").strip()
    if not sid:
        return
    with _LEETIFY_LOCK:
        if sid in _LEETIFY_QUEUED:
            return
        _LEETIFY_QUEUED.add(sid)
        _LEETIFY_QUEUE.append(sid)
        if _LEETIFY_THREAD is None or not _LEETIFY_THREAD.is_alive():
            _LEETIFY_THREAD = threading.Thread(target=_leetify_worker, name="leetify-fetch", daemon=True)
            _LEETIFY_THREAD.start()


def _api_key_status() -> dict[str, dict[str, str | bool | int]]:
    secrets = _load_secrets()
    return {
        name: {
            "set": bool(secrets.get(name)),
            "hint": _mask_secret(secrets.get(name, "")),
            "length": len(secrets.get(name, "")),
        }
        for name in SECRET_NAMES
    }


def _http_error_message(exc: urllib.error.HTTPError, fallback: str) -> str:
    raw = exc.read().decode("utf-8", errors="replace")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        data = None
    if isinstance(data, dict):
        detail = str(data.get("message") or data.get("error") or "").strip()
        if isinstance(data.get("error"), dict):
            detail = str(data["error"].get("message") or detail).strip()
        if detail:
            return f"{fallback} ({exc.code}): {detail}"
    return f"{fallback} ({exc.code})"


def _load_inventory_result() -> dict[str, Any] | None:
    try:
        if not INVENTORY_RESULT_PATH.is_file():
            return None
        parsed = json.loads(INVENTORY_RESULT_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _save_inventory_result(payload: dict[str, Any]) -> None:
    INVENTORY_RESULT_PATH.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _inventory_cooldown_until() -> float:
    try:
        if not INVENTORY_COOLDOWN_PATH.is_file():
            return 0.0
        parsed = json.loads(INVENTORY_COOLDOWN_PATH.read_text(encoding="utf-8"))
        return float((parsed or {}).get("until") or 0)
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return 0.0


def _mark_inventory_cooldown(seconds: int | None = None) -> int:
    wait = int(seconds or STEAM_RATE_LIMIT_SEC)
    until = time.time() + wait
    try:
        INVENTORY_COOLDOWN_PATH.write_text(json.dumps({"until": until}), encoding="utf-8")
    except OSError:
        pass
    return wait


def _clear_inventory_cooldown() -> None:
    try:
        INVENTORY_COOLDOWN_PATH.unlink(missing_ok=True)
    except OSError:
        pass


def _inventory_cooldown_left() -> int:
    return max(0, int(_inventory_cooldown_until() - time.time()))


def _with_inventory_cooldown(payload: dict[str, Any]) -> dict[str, Any]:
    payload["cooldown"] = _inventory_cooldown_left()
    return payload


def _csfloat_headers(key: str) -> dict[str, str]:
    return {
        "Accept": "application/json",
        "User-Agent": "OmegaDash/1.0",
        "Authorization": str(key or "").strip(),
    }


def _validate_csfloat_key(key: str) -> int:
    token = str(key or "").strip()
    if not token:
        return 401
    url = f"{CSFLOAT_LISTINGS_URL}?{urllib.parse.urlencode({'limit': '1', 'type': 'buy_now'})}"
    request = urllib.request.Request(url, method="GET", headers=_csfloat_headers(token))
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return int(getattr(response, "status", 200) or 200)
    except urllib.error.HTTPError as exc:
        return int(exc.code or 401)
    except (urllib.error.URLError, TimeoutError, OSError):
        return 500


def _csfloat_category(item: dict[str, Any]) -> str:
    if str(item.get("category") or "") not in CSFLOAT_SKIN_CATEGORIES:
        return ""
    name = str(item.get("name") or "").lower()
    if item.get("souvenir") or "souvenir" in name:
        return "3"
    if item.get("statTrak") or "stattrak" in name.replace("-", ""):
        return "2"
    return "1"


def _csfloat_parse_listings(raw: object) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        rows = raw
    elif isinstance(raw, dict):
        data = raw.get("data")
        listings = raw.get("listings")
        if isinstance(data, list):
            rows = data
        elif isinstance(listings, list):
            rows = listings
        elif isinstance(data, dict) and isinstance(data.get("listings"), list):
            rows = data["listings"]
        else:
            rows = []
    else:
        rows = []
    return [row for row in rows if isinstance(row, dict)]


def _csfloat_parse_price_list(raw: object) -> dict[str, int]:
    if isinstance(raw, list):
        rows = raw
    elif isinstance(raw, dict):
        data = raw.get("data")
        if isinstance(data, list):
            rows = data
        elif isinstance(raw.get("items"), list):
            rows = raw["items"]
        else:
            rows = []
    else:
        rows = []
    out: dict[str, int] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = str(row.get("market_hash_name") or row.get("name") or "").strip()
        if not name:
            continue
        price = row.get("min_price")
        if price is None:
            price = row.get("price")
        try:
            cents = int(price)
        except (TypeError, ValueError):
            continue
        if cents >= 0:
            out[name] = cents
    return out


def _load_csfloat_price_list() -> dict[str, int]:
    global _CSFLOAT_PRICELIST, _CSFLOAT_PRICELIST_AT
    now = time.time()
    with _CSFLOAT_PRICELIST_LOCK:
        if _CSFLOAT_PRICELIST is not None and now - _CSFLOAT_PRICELIST_AT < CSFLOAT_PRICE_TTL:
            return _CSFLOAT_PRICELIST
        try:
            if CSFLOAT_PRICE_LIST_PATH.is_file():
                parsed = json.loads(CSFLOAT_PRICE_LIST_PATH.read_text(encoding="utf-8"))
                if isinstance(parsed, dict):
                    fetched = float(parsed.get("fetchedAt") or 0)
                    items = parsed.get("items")
                    if isinstance(items, dict) and now - fetched < CSFLOAT_PRICE_TTL:
                        clean: dict[str, int] = {}
                        for name, cents in items.items():
                            try:
                                clean[str(name)] = int(cents)
                            except (TypeError, ValueError):
                                continue
                        _CSFLOAT_PRICELIST = clean
                        _CSFLOAT_PRICELIST_AT = fetched
                        return _CSFLOAT_PRICELIST
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            pass
    key = _secret("csfloat")
    if not key:
        return _CSFLOAT_PRICELIST or {}
    request = urllib.request.Request(CSFLOAT_PRICE_LIST_URL, method="GET", headers=_csfloat_headers(key))
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            raw = json.loads(response.read().decode("utf-8"))
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        with _CSFLOAT_PRICELIST_LOCK:
            if _CSFLOAT_PRICELIST is None:
                _CSFLOAT_PRICELIST = {}
            _CSFLOAT_PRICELIST_AT = now - CSFLOAT_PRICE_TTL + 120
            return _CSFLOAT_PRICELIST
    items = _csfloat_parse_price_list(raw)
    with _CSFLOAT_PRICELIST_LOCK:
        _CSFLOAT_PRICELIST = items
        _CSFLOAT_PRICELIST_AT = time.time()
        payload = {"fetchedAt": _CSFLOAT_PRICELIST_AT, "items": items}
        blob = json.dumps(payload, ensure_ascii=False)
    try:
        CSFLOAT_PRICE_LIST_PATH.write_text(blob, encoding="utf-8")
    except OSError:
        pass
    return items


def _prime_csfloat_commodities() -> None:
    prices = _load_csfloat_price_list()
    if not prices:
        return
    now = time.time()
    filled: list[tuple[str, int]] = []
    with _CSFLOAT_LOCK:
        keep: list[tuple[str, str]] = []
        for name, category in _CSFLOAT_QUEUE:
            if category in {"1", "2", "3"}:
                keep.append((name, category))
                continue
            cents = prices.get(name)
            if cents is None:
                keep.append((name, category))
                continue
            filled.append((name, cents))
            _CSFLOAT_QUEUED.discard(name)
        _CSFLOAT_QUEUE[:] = keep
    for name, cents in filled:
        _put_csfloat_row(name, {"state": "ready", "cents": cents, "listingId": "", "fetchedAt": now})


def _csfloat_retry_wait(exc: urllib.error.HTTPError) -> float:
    raw = ""
    try:
        raw = str(exc.headers.get("Retry-After") or "").strip()
    except Exception:
        raw = ""
    if raw.isdigit():
        return float(min(max(int(raw), 5), 120))
    return 20.0


def _load_csfloat_cache() -> dict[str, dict[str, Any]]:
    global _CSFLOAT_CACHE
    with _CSFLOAT_LOCK:
        if _CSFLOAT_CACHE is not None:
            return _CSFLOAT_CACHE
        parsed: dict[str, Any] = {}
        try:
            if CSFLOAT_PRICE_PATH.is_file():
                loaded = json.loads(CSFLOAT_PRICE_PATH.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    parsed = loaded
        except (OSError, json.JSONDecodeError):
            parsed = {}
        items = parsed.get("items") if isinstance(parsed.get("items"), dict) else parsed
        out: dict[str, dict[str, Any]] = {}
        if isinstance(items, dict):
            for name, row in items.items():
                key = str(name or "").strip()
                if key and isinstance(row, dict):
                    out[key] = row
        _CSFLOAT_CACHE = out
        return out


def _put_csfloat_row(name: str, row: dict[str, Any]) -> None:
    global _CSFLOAT_CACHE
    key = str(name or "").strip()
    if not key:
        return
    stored = dict(row)
    stored["rev"] = CSFLOAT_CACHE_REV
    with _CSFLOAT_LOCK:
        if _CSFLOAT_CACHE is None:
            _CSFLOAT_CACHE = {}
        _CSFLOAT_CACHE[key] = stored
        payload = {"updatedAt": int(time.time()), "items": _CSFLOAT_CACHE}
        blob = json.dumps(payload, ensure_ascii=False)
    try:
        CSFLOAT_PRICE_PATH.write_text(blob, encoding="utf-8")
    except OSError:
        pass


def _csfloat_needs_fetch(name: str, cache: dict[str, dict[str, Any]]) -> bool:
    row = cache.get(name)
    if not isinstance(row, dict):
        return True
    try:
        fetched = float(row.get("fetchedAt") or 0)
    except (TypeError, ValueError):
        fetched = 0.0
    age = time.time() - fetched
    state = str(row.get("state") or "")
    try:
        rev = int(row.get("rev") or 0)
    except (TypeError, ValueError):
        rev = 0
    if rev != CSFLOAT_CACHE_REV:
        return True
    if state == "error":
        return age >= CSFLOAT_ERROR_TTL
    if state in {"ready", "none"}:
        return age >= CSFLOAT_PRICE_TTL
    return True


def _item_with_price(item: dict[str, Any], cache: dict[str, dict[str, Any]], has_key: bool) -> dict[str, Any]:
    out = dict(item)
    name = str(item.get("name") or "").strip()
    row = cache.get(name) if name else None
    if isinstance(row, dict):
        try:
            rev = int(row.get("rev") or 0)
        except (TypeError, ValueError):
            rev = 0
        if rev != CSFLOAT_CACHE_REV and str(row.get("state") or "") in {"none", "error"}:
            row = None
    if isinstance(row, dict) and str(row.get("state") or "") in {"ready", "none", "error"}:
        cents = row.get("cents")
        try:
            out["priceCents"] = int(cents) if cents is not None else None
        except (TypeError, ValueError):
            out["priceCents"] = None
        if out["priceCents"] is not None:
            out["priceState"] = "ready"
        else:
            out["priceState"] = str(row.get("state") or "none")
        out["priceListingId"] = str(row.get("listingId") or "")
        return out
    if has_key and name and item.get("marketable"):
        out["priceState"] = "pending"
        out["priceCents"] = None
        out["priceListingId"] = ""
    return out


def _fetch_csfloat_lowest(name: str, category: str) -> dict[str, Any]:
    key = _secret("csfloat")
    if not key:
        raise FileNotFoundError("CSFloat API key is not set")
    params = {
        "type": "buy_now",
        "limit": "1",
        "sort_by": "lowest_price",
        "market_hash_name": name,
    }
    if category in {"1", "2", "3"}:
        params["category"] = category
    url = f"{CSFLOAT_LISTINGS_URL}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(url, method="GET", headers=_csfloat_headers(key))
    with urllib.request.urlopen(request, timeout=20) as response:
        raw = json.loads(response.read().decode("utf-8"))
    listings = _csfloat_parse_listings(raw)
    now = time.time()
    if not listings:
        listed = _load_csfloat_price_list().get(name)
        if listed is not None:
            return {"state": "ready", "cents": listed, "listingId": "", "fetchedAt": now}
        return {"state": "none", "cents": None, "listingId": "", "fetchedAt": now}
    row = listings[0]
    try:
        cents = int(row.get("price"))
    except (TypeError, ValueError):
        cents = None
    listing_id = str(row.get("id") or "")
    if cents is None:
        return {"state": "error", "cents": None, "listingId": listing_id, "fetchedAt": now}
    return {"state": "ready", "cents": cents, "listingId": listing_id, "fetchedAt": now}


def _csfloat_worker() -> None:
    global _CSFLOAT_THREAD, _CSFLOAT_AUTH_BAD
    try:
        while not _QUIT_STARTED:
            _prime_csfloat_commodities()
            with _CSFLOAT_LOCK:
                if not _CSFLOAT_QUEUE:
                    _CSFLOAT_THREAD = None
                    empty = True
                else:
                    empty = False
                    name, category = _CSFLOAT_QUEUE.pop(0)
            if empty:
                _maybe_record_inventory_value()
                return
            try:
                cache = _load_csfloat_cache()
                if not _csfloat_needs_fetch(name, cache):
                    with _CSFLOAT_LOCK:
                        _CSFLOAT_QUEUED.discard(name)
                    continue
                row = _fetch_csfloat_lowest(name, category)
            except urllib.error.HTTPError as exc:
                if exc.code in {401, 403}:
                    _CSFLOAT_AUTH_BAD = True
                    with _CSFLOAT_LOCK:
                        _CSFLOAT_QUEUE.clear()
                        _CSFLOAT_QUEUED.clear()
                    return
                if exc.code == 429:
                    with _CSFLOAT_LOCK:
                        _CSFLOAT_QUEUE.insert(0, (name, category))
                    time.sleep(_csfloat_retry_wait(exc))
                    continue
                _put_csfloat_row(name, {"state": "error", "cents": None, "listingId": "", "fetchedAt": time.time()})
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, FileNotFoundError):
                _put_csfloat_row(name, {"state": "error", "cents": None, "listingId": "", "fetchedAt": time.time()})
            except Exception:
                _put_csfloat_row(name, {"state": "error", "cents": None, "listingId": "", "fetchedAt": time.time()})
            else:
                _put_csfloat_row(name, row)
            with _CSFLOAT_LOCK:
                _CSFLOAT_QUEUED.discard(name)
            if _QUIT_STARTED:
                return
            time.sleep(CSFLOAT_GAP_SEC)
    finally:
        with _CSFLOAT_LOCK:
            if _CSFLOAT_THREAD is threading.current_thread():
                _CSFLOAT_THREAD = None


def _queue_csfloat_from_items(items: list[Any]) -> None:
    global _CSFLOAT_THREAD
    if _QUIT_STARTED or _CSFLOAT_AUTH_BAD or not _secret("csfloat"):
        return
    cache = _load_csfloat_cache()
    jobs: list[tuple[str, str]] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict) or not item.get("marketable"):
            continue
        name = str(item.get("name") or "").strip()
        if not name or name in seen or name == "Unknown":
            continue
        seen.add(name)
        if not _csfloat_needs_fetch(name, cache):
            continue
        jobs.append((name, _csfloat_category(item)))
    if not jobs:
        return
    with _CSFLOAT_LOCK:
        for name, category in jobs:
            if name in _CSFLOAT_QUEUED:
                continue
            _CSFLOAT_QUEUED.add(name)
            _CSFLOAT_QUEUE.append((name, category))
        if _CSFLOAT_THREAD is None or not _CSFLOAT_THREAD.is_alive():
            _CSFLOAT_THREAD = threading.Thread(target=_csfloat_worker, name="csfloat-prices", daemon=True)
            _CSFLOAT_THREAD.start()


def _public_csfloat_row(row: dict[str, Any]) -> dict[str, Any]:
    cents = row.get("cents")
    try:
        cents_i = int(cents) if cents is not None else None
    except (TypeError, ValueError):
        cents_i = None
    state = str(row.get("state") or "")
    if cents_i is not None:
        state = "ready"
    return {
        "cents": cents_i,
        "state": state or "none",
        "listingId": str(row.get("listingId") or ""),
    }


def _finish_inventory_api(payload: dict[str, Any]) -> dict[str, Any]:
    out = _with_inventory_cooldown(payload)
    data = out.get("data")
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        items = [item for item in data["items"] if isinstance(item, dict)]
        _queue_csfloat_from_items(items)
        cache = _load_csfloat_cache()
        with _CSFLOAT_LOCK:
            cache = dict(cache)
        has_key = bool(_secret("csfloat")) and not _CSFLOAT_AUTH_BAD
        priced = dict(data)
        priced["items"] = [_item_with_price(item, cache, has_key) for item in items]
        out = dict(out)
        out["data"] = priced
    return out


def _inventory_item_amount(item: dict[str, Any]) -> int:
    try:
        amount = int(item.get("amount") or 1)
    except (TypeError, ValueError):
        amount = 1
    return max(1, amount)


def _safe_int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _inventory_value_stats(items: list[Any], cache: dict[str, dict[str, Any]]) -> dict[str, int]:
    cents = 0
    priced = 0
    pending = 0
    count = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        amount = _inventory_item_amount(item)
        count += amount
        name = str(item.get("name") or "").strip()
        row = cache.get(name) if name else None
        value = item.get("priceCents")
        if value is None and isinstance(row, dict):
            value = row.get("cents")
        try:
            value_i = int(value) if value is not None else None
        except (TypeError, ValueError):
            value_i = None
        if value_i is not None:
            cents += value_i * amount
            priced += amount
            continue
        state = str(item.get("priceState") or (row.get("state") if isinstance(row, dict) else "") or "")
        if state == "pending" or (name and item.get("marketable") and not isinstance(row, dict)):
            pending += amount
    return {"cents": cents, "priced": priced, "pending": pending, "count": count}


def _load_value_history() -> list[dict[str, Any]]:
    try:
        if not CSFLOAT_VALUE_PATH.is_file():
            return []
        parsed = json.loads(CSFLOAT_VALUE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    rows = parsed.get("points") if isinstance(parsed, dict) else parsed
    if not isinstance(rows, list):
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            at = float(row.get("at") or 0)
            cents = int(row.get("cents"))
        except (TypeError, ValueError):
            continue
        if at <= 0:
            continue
        out.append({
            "at": at,
            "cents": cents,
            "priced": _safe_int(row.get("priced"), 0),
            "count": _safe_int(row.get("count"), 0),
            "steam64": str(row.get("steam64") or ""),
        })
    return out


def _public_value_history(steam64: str = "") -> list[dict[str, Any]]:
    sid = str(steam64 or "").strip()
    points = []
    for row in _load_value_history():
        if sid and row.get("steam64") and row["steam64"] != sid:
            continue
        points.append({"at": row["at"], "cents": row["cents"], "priced": row["priced"], "count": row["count"]})
    return points[-CSFLOAT_VALUE_MAX:]


def _local_day(ts: float) -> tuple[int, int, int]:
    stamp = time.localtime(ts)
    return stamp.tm_year, stamp.tm_mon, stamp.tm_mday


def _maybe_record_inventory_value() -> None:
    if _QUIT_STARTED:
        return
    with _CSFLOAT_LOCK:
        if _CSFLOAT_QUEUE:
            return
    cached = _load_inventory_result()
    if not isinstance(cached, dict):
        return
    items = cached.get("items") if isinstance(cached.get("items"), list) else []
    stats = _inventory_value_stats(items, _load_csfloat_cache())
    if stats["priced"] < 1:
        return
    steam64 = str(cached.get("steam64") or "")
    now = time.time()
    with _CSFLOAT_VALUE_LOCK:
        history = _load_value_history()
        last = next((row for row in reversed(history) if not steam64 or not row.get("steam64") or row["steam64"] == steam64), None)
        if last and _local_day(float(last.get("at") or 0)) == _local_day(now):
            if last.get("cents") == stats["cents"] and last.get("priced") == stats["priced"]:
                return
            last["cents"] = stats["cents"]
            last["priced"] = stats["priced"]
            last["count"] = stats["count"]
            last["steam64"] = steam64
        else:
            history.append({
                "at": now,
                "cents": stats["cents"],
                "priced": stats["priced"],
                "count": stats["count"],
                "steam64": steam64,
            })
        history = history[-CSFLOAT_VALUE_MAX:]
        blob = json.dumps({"updatedAt": int(now), "points": history}, ensure_ascii=False)
        try:
            CSFLOAT_VALUE_PATH.write_text(blob, encoding="utf-8")
        except OSError:
            pass


_CSFLOAT_LOCK = threading.Lock()
_CSFLOAT_QUEUE: list[tuple[str, str]] = []
_CSFLOAT_QUEUED: set[str] = set()
_CSFLOAT_THREAD: threading.Thread | None = None
_CSFLOAT_AUTH_BAD = False
_CSFLOAT_CACHE: dict[str, dict[str, Any]] | None = None
_CSFLOAT_PRICELIST_LOCK = threading.Lock()
_CSFLOAT_PRICELIST: dict[str, int] | None = None
_CSFLOAT_PRICELIST_AT = 0.0
_CSFLOAT_VALUE_LOCK = threading.Lock()


def _inventory_wait_error(remaining: int) -> str:
    mins = max(1, int((remaining + 59) // 60))
    if mins >= 120:
        hours = max(2, int((mins + 59) // 60))
        return f"Steam is still blocking inventory requests from this network. Wait about {hours} hours, then hit Refresh once."
    return f"Steam is rate-limiting inventory requests. Wait about {mins} min, then hit Refresh once."


def _retry_after_seconds(raw: object) -> int:
    text = str(raw or "").strip()
    if text.isdigit():
        return max(int(text), STEAM_RATE_LIMIT_SEC)
    if not text:
        return STEAM_RATE_LIMIT_SEC
    try:
        when = parsedate_to_datetime(text)
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        wait = int(when.timestamp() - time.time())
        return max(wait, STEAM_RATE_LIMIT_SEC)
    except (TypeError, ValueError, OverflowError, OSError):
        return STEAM_RATE_LIMIT_SEC


def _pace_steam_inventory_request() -> None:
    """Space Steam inventory HTTP calls and cap them per minute on this IP."""
    global _steam_req_times
    while True:
        sleep_for = 0.0
        with _STEAM_REQ_LOCK:
            now = time.time()
            _steam_req_times = [stamp for stamp in _steam_req_times if now - stamp < 60]
            if len(_steam_req_times) >= STEAM_MAX_REQUESTS_PER_MIN:
                sleep_for = max(0.05, 60.0 - (now - _steam_req_times[0]) + 0.05)
            elif _steam_req_times:
                gap = STEAM_PAGE_GAP_SEC - (now - _steam_req_times[-1])
                if gap > 0:
                    sleep_for = gap
                else:
                    _steam_req_times.append(now)
                    return
            else:
                _steam_req_times.append(now)
                return
        time.sleep(sleep_for)


class SteamInvBridge:
    """Receives inventory JSON in small pieces from the hidden Steam WebView."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.parts: list[str] = []
        self.status = 0
        self.retry_after = ""
        self.length = 0
        self.error = ""
        self.event = threading.Event()

    def reset(self) -> None:
        with self._lock:
            self.parts = []
            self.status = 0
            self.retry_after = ""
            self.length = 0
            self.error = ""
            self.event.clear()

    def begin(self, status: object = 0, retry_after: object = "", length: object = 0) -> bool:
        with self._lock:
            self.parts = []
            try:
                self.status = int(status or 0)
            except (TypeError, ValueError):
                self.status = 0
            self.retry_after = str(retry_after or "")
            try:
                self.length = int(length or 0)
            except (TypeError, ValueError):
                self.length = 0
            self.error = ""
            self.event.clear()
        return True

    def push(self, part: object = "") -> bool:
        text = ""
        if isinstance(part, dict):
            raw = part.get("t")
            text = raw if isinstance(raw, str) else "" if raw is None else str(raw)
        elif isinstance(part, str):
            text = part
        elif part is not None:
            text = str(part)
        with self._lock:
            self.parts.append(text)
        return True

    def fail(self, error: object = "") -> bool:
        with self._lock:
            self.error = str(error or "Steam inventory request failed")
            self.event.set()
        return True

    def finish(self) -> bool:
        self.event.set()
        return True

    def body(self) -> str:
        with self._lock:
            return "".join(self.parts)


def _steam_bridge() -> SteamInvBridge:
    global _STEAM_BRIDGE
    if _STEAM_BRIDGE is None:
        _STEAM_BRIDGE = SteamInvBridge()
    return _STEAM_BRIDGE


def _create_hidden_steam_window(url: str):
    def make():
        return webview.create_window(
            "OmegaDash Steam",
            url,
            width=420,
            height=320,
            hidden=True,
            focus=False,
            text_select=True,
            js_api=_steam_bridge(),
        )

    if threading.current_thread().name == "MainThread":
        box: list[Any] = []
        errors: list[BaseException] = []

        def worker() -> None:
            try:
                box.append(make())
            except BaseException as exc:
                errors.append(exc)

        thread = threading.Thread(target=worker, name="omega-steam-win", daemon=True)
        thread.start()
        thread.join(30)
        if errors:
            raise errors[0]
        if not box or box[0] is None:
            raise ValueError("Could not open a browser view to load Steam inventory.")
        return box[0]
    window = make()
    if window is None:
        raise ValueError("Could not open a browser view to load Steam inventory.")
    return window


def _steam_community_window():
    global _STEAM_WIN
    with _STEAM_WIN_LOCK:
        window = _STEAM_WIN
    if window is not None:
        return window
    window = _create_hidden_steam_window(STEAM_COMMUNITY_HOME)
    with _STEAM_WIN_LOCK:
        _STEAM_WIN = window
    return window


def _steam_eval_promise(window, script: str, timeout: float = 45) -> Any:
    done = threading.Event()
    holder: dict[str, Any] = {}

    def got(result: object) -> None:
        holder["result"] = result
        done.set()

    try:
        window.evaluate_js(script, got)
    except Exception as exc:
        raise ValueError("Could not read Steam inventory through the browser view.") from exc
    if not done.wait(timeout):
        raise ValueError("Steam inventory request timed out.")
    return holder.get("result")


def _steam_eval_object(raw: object) -> dict[str, Any]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return {}
    return raw if isinstance(raw, dict) else {}


def _steam_chunk_text(raw: object) -> str:
    if isinstance(raw, dict):
        val = raw.get("t")
        return val if isinstance(val, str) else "" if val is None else str(val)
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return raw
        if isinstance(parsed, dict) and "t" in parsed:
            val = parsed.get("t")
            return val if isinstance(val, str) else "" if val is None else str(val)
        return raw
    return "" if raw is None else str(raw)


def _steam_read_inv_body(window, length: int) -> str:
    try:
        total = max(0, int(length or 0))
    except (TypeError, ValueError):
        total = 0
    if total <= 0:
        return ""
    size = 6000
    parts: list[str] = []
    offset = 0
    while offset < total:
        end = min(offset + size, total)
        piece = _steam_chunk_text(
            window.evaluate_js(
                f"(function(){{return {{t:String(window.__omegaInvBody||'').slice({offset},{end})}};}})()"
            )
        )
        parts.append(piece)
        offset = end
    try:
        window.evaluate_js("window.__omegaInvBody=''")
    except Exception:
        pass
    return "".join(parts)


def _parse_inventory_payload(text: str) -> dict[str, Any]:
    body = str(text or "").strip()
    lowered = body.lower()
    if not body:
        raise ValueError("Steam returned an empty inventory page. Try Refresh once in a few minutes.")
    if (
        body.startswith("<")
        or "too many requests" in lowered
        or "access denied" in lowered
        or "error 429" in lowered
    ):
        wait = _mark_inventory_cooldown(_retry_after_seconds(None))
        raise ValueError(_inventory_wait_error(wait))
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ValueError("Steam returned a page we could not read. Try Refresh once in a few minutes.") from exc
    if not isinstance(parsed, dict):
        raise ValueError("Steam returned a page we could not read. Try Refresh once in a few minutes.")
    return parsed


def _resolve_self_steam64() -> str:
    try:
        member = _constelia_post("getMember", {"include_hidden": ""})
    except FileNotFoundError:
        raise
    except (OSError, ValueError, urllib.error.URLError, json.JSONDecodeError):
        member = None
    sid = _member_steam64(member if isinstance(member, dict) else None)
    if sid:
        return sid
    try:
        widget = _constelia_post("getForumWidget")
    except FileNotFoundError:
        raise
    except (OSError, ValueError, urllib.error.URLError, json.JSONDecodeError):
        return ""
    steam = widget.get("steam") if isinstance(widget, dict) and isinstance(widget.get("steam"), dict) else {}
    return _as_steam64(steam.get("id") or steam.get("steamid"))


def _inv_tag_map(tags: object) -> dict[str, str]:
    out: dict[str, str] = {}
    if not isinstance(tags, list):
        return out
    for tag in tags:
        if not isinstance(tag, dict):
            continue
        category = str(tag.get("category") or "").strip().lower()
        label = str(tag.get("localized_tag_name") or tag.get("name") or "").strip()
        if category and label:
            out[category] = label
    return out


def _inv_plain_text(value: object) -> str:
    text = re.sub(r"<br\s*/?>", "\n", str(value or ""), flags=re.I)
    text = re.sub(r"<img[^>]*>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = unescape(text).replace("\xa0", " ").replace("&nbsp;", " ")
    lines = [" ".join(line.split()) for line in text.splitlines()]
    return "\n".join(line for line in lines if line).strip()


def _index_asset_properties(raw: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    rows = raw.get("asset_properties")
    if not isinstance(rows, list):
        return out
    for row in rows:
        if not isinstance(row, dict):
            continue
        aid = str(row.get("assetid") or row.get("id") or "")
        nested = row.get("asset_properties")
        if not isinstance(nested, list):
            nested = row.get("properties")
        if isinstance(nested, list):
            props = [item for item in nested if isinstance(item, dict)]
            if aid and props:
                out.setdefault(aid, []).extend(props)
            continue
        if aid and (row.get("propertyid") is not None or row.get("name")):
            out.setdefault(aid, []).append(row)
    return out


def _parse_asset_props(rows: object) -> tuple[float | None, int | None, str]:
    wear: float | None = None
    pattern: int | None = None
    nametag = ""
    if not isinstance(rows, list):
        return wear, pattern, nametag
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or row.get("property_name") or row.get("localized_label") or "").lower()
        try:
            pid = int(row.get("propertyid") if row.get("propertyid") is not None else row.get("id"))
        except (TypeError, ValueError):
            pid = None
        raw_float = row.get("float_value")
        raw_int = row.get("int_value")
        raw_string = row.get("string_value") if row.get("string_value") is not None else row.get("value")
        number: float | None = None
        for candidate in (raw_float, raw_int, raw_string):
            if candidate is None or candidate == "":
                continue
            try:
                number = float(candidate)
                break
            except (TypeError, ValueError):
                continue
        is_wear = "wear" in name or "paintwear" in name or pid == 2
        is_pattern = "pattern" in name or "paint seed" in name or "paintseed" in name or pid == 1
        is_nametag = "name tag" in name or "nametag" in name or pid == 5
        if is_nametag:
            text = str(raw_string or "").strip()
            if text:
                nametag = text
            continue
        if is_wear and number is not None and 0 <= number <= 1:
            wear = number
            continue
        if is_pattern and number is not None:
            try:
                pattern = int(number)
            except (TypeError, ValueError):
                pass
    return wear, pattern, nametag


def _prop_value(row: dict[str, Any]) -> str:
    for key in ("string_value", "int_value", "float_value", "value"):
        value = row.get(key)
        if value is None or value == "":
            continue
        return str(value)
    return ""


def _sticker_rarity_from_name(name: str) -> str:
    label = str(name or "").lower()
    if "(gold)" in label:
        return "covert"
    if "(holo)" in label or "(foil)" in label or "(lenticular)" in label:
        return "classified"
    if "(glitter)" in label:
        return "restricted"
    return ""


def _inv_stickers(desc: dict[str, Any]) -> list[dict[str, str]]:
    names: list[str] = []
    icons: list[str] = []
    colors: list[str] = []
    rows = desc.get("descriptions")
    if not isinstance(rows, list):
        return []
    for row in rows:
        value = str(row.get("value") or "") if isinstance(row, dict) else str(row or "")
        row_color = str(row.get("color") or "") if isinstance(row, dict) else ""
        if "sticker" not in value.lower() and "<img" not in value.lower():
            continue
        icons.extend(re.findall(r'<img[^>]+src=["\']([^"\']+)["\']', value, flags=re.I))
        found = re.search(r"sticker:\s*(.+)", _inv_plain_text(value), re.I)
        if found:
            parts = [part.strip() for part in found.group(1).split(",") if part.strip()]
            names.extend(parts)
            tint = row_color
            if not tint:
                colored = _inv_colored_fragments(value, "")
                if colored:
                    tint = colored[0][1]
            colors.extend([tint] * len(parts))
    count = max(len(names), len(icons))
    out: list[dict[str, str]] = []
    for index in range(count):
        name = names[index] if index < len(names) else ""
        icon = icons[index] if index < len(icons) else ""
        if not name and not icon:
            continue
        color = colors[index] if index < len(colors) else ""
        rarity = _inv_hex_rarity(color) or _sticker_rarity_from_name(name)
        out.append({"name": name, "icon": icon, "rarity": rarity})
    return out


_INV_RARITY_HEX = {
    "b0c3d9": "consumer",
    "5e98d9": "industrial",
    "4b69ff": "milspec",
    "8847ff": "restricted",
    "d32ce6": "classified",
    "eb4b4b": "covert",
    "e4ae39": "gold",
    "ffd700": "gold",
    "e4ae33": "gold",
}
_INV_CONTAINS_RE = re.compile(r"contains one of the following", re.I)
_INV_RARE_SPECIAL_RE = re.compile(r"exceedingly rare|rare special item", re.I)
_INV_HTML_COLOR_RE = re.compile(
    r"<(font|span)([^>]*)>(.*?)</\1>",
    re.I | re.S,
)
_INV_ATTR_COLOR_RE = re.compile(
    r"(?:color\s*=\s*['\"]?#?|color\s*:\s*#?)([0-9a-fA-F]{3,8})",
    re.I,
)


def _inv_hex_rarity(color: str) -> str:
    key = re.sub(r"[^0-9a-f]", "", str(color or "").lower())
    if len(key) == 3:
        key = "".join(ch * 2 for ch in key)
    key = key[:6]
    return _INV_RARITY_HEX.get(key, "")


def _inv_colored_fragments(html: str, default_color: str = "") -> list[tuple[str, str]]:
    text = str(html or "")
    if not text.strip():
        return []
    parts: list[tuple[str, str]] = []
    for match in _INV_HTML_COLOR_RE.finditer(text):
        attrs, inner = match.group(2) or "", match.group(3) or ""
        found = _INV_ATTR_COLOR_RE.search(attrs)
        color = found.group(1) if found else default_color
        name = _inv_plain_text(inner)
        if name:
            parts.append((name, color))
    if parts:
        return parts
    plain = _inv_plain_text(text)
    if not plain:
        return []
    return [(line, default_color) for line in plain.split("\n") if line]


def _inv_contents(desc: dict[str, Any]) -> list[dict[str, str]]:
    rows = desc.get("descriptions")
    if not isinstance(rows, list):
        return []
    started = False
    seen: set[str] = set()
    out: list[dict[str, str]] = []

    def add(name: str, color: str, *, listed: bool = False) -> None:
        label = " ".join(str(name or "").split())
        if not label or _INV_CONTAINS_RE.search(label):
            return
        rarity = _inv_hex_rarity(color)
        if _INV_RARE_SPECIAL_RE.search(label):
            rarity = rarity or "gold"
        if not listed and not rarity and "|" not in label:
            return
        key = label.lower()
        if key in seen:
            return
        seen.add(key)
        out.append({"name": label, "rarity": rarity or "other", "color": str(color or "")})

    for row in rows:
        if isinstance(row, dict):
            raw = str(row.get("value") or "")
            color = str(row.get("color") or "")
        else:
            raw = str(row or "")
            color = ""
        if _INV_CONTAINS_RE.search(_inv_plain_text(raw) or raw):
            started = True
            for name, tint in _inv_colored_fragments(raw, color):
                if _INV_CONTAINS_RE.search(name):
                    continue
                add(name, tint, listed=True)
            continue
        fragments = _inv_colored_fragments(raw, color)
        if not fragments:
            continue
        for name, tint in fragments:
            rarity = _inv_hex_rarity(tint)
            if started or rarity or _INV_RARE_SPECIAL_RE.search(name):
                add(name, tint, listed=started)
    return out


def _inv_notes(desc: dict[str, Any], contents: list[dict[str, str]] | None = None) -> list[str]:
    skip = re.compile(r"^(sticker:|exterior:|tradable after|posted for sale)", re.I)
    notes: list[str] = []
    listed = {row["name"].lower() for row in (contents if contents is not None else _inv_contents(desc))}
    rows = desc.get("descriptions")
    if not isinstance(rows, list):
        return notes
    for row in rows:
        value = row.get("value") if isinstance(row, dict) else row
        blob = str(value or "")
        if "sticker_info" in blob.lower() or ("<img" in blob.lower() and "sticker" in blob.lower()):
            continue
        text = _inv_plain_text(value)
        if not text or skip.search(text) or text in notes:
            continue
        if _INV_CONTAINS_RE.search(text) or text.lower() in listed:
            continue
        if "|" in text and listed:
            continue
        notes.append(text)
        if len(notes) >= 12:
            break
    return notes


def _inv_nametag(desc: dict[str, Any]) -> str:
    warnings = desc.get("fraudwarnings")
    rows = warnings if isinstance(warnings, list) else [warnings] if warnings else []
    for row in rows:
        text = _inv_plain_text(row)
        found = re.search(r"name tag:\s*['\"](.+?)['\"]", text, re.I)
        if found:
            return found.group(1).strip()
        if text:
            return text
    return ""


def _inv_inspect(desc: dict[str, Any], steamid: str, assetid: str, props: list[dict[str, Any]] | None = None) -> str:
    values: dict[str, str] = {}
    for row in props or []:
        if not isinstance(row, dict):
            continue
        try:
            pid = int(row.get("propertyid") if row.get("propertyid") is not None else row.get("id"))
        except (TypeError, ValueError):
            continue
        text = _prop_value(row)
        if text:
            values[str(pid)] = text
    link = ""
    for key in ("actions", "market_actions"):
        rows = desc.get(key)
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            candidate = str(row.get("link") or "").strip()
            label = str(row.get("name") or "").lower()
            if "csgo_econ_action_preview" not in candidate and "inspect" not in label:
                continue
            link = candidate
            break
        if link:
            break
    if not link:
        return ""
    link = link.replace("%owner_steamid%", steamid).replace("%assetid%", assetid)
    link = re.sub(r"%propid:(\d+)%", lambda match: values.get(match.group(1) or "", match.group(0)), link)
    if "%propid:" in link:
        return ""
    return link


def _inv_rarity_class(name: str) -> str:
    key = "".join(ch for ch in name.lower() if ch.isalnum())
    if "highgrade" in key:
        return "milspec"
    if "remarkable" in key:
        return "restricted"
    if "exotic" in key:
        return "classified"
    if "contraband" in key:
        return "gold"
    if "sticker" in key and "extraordinary" in key:
        return "covert"
    if "extraordinary" in key or "gold" in key:
        return "gold"
    if "covert" in key or "ancient" in key:
        return "covert"
    if "classified" in key or "legendary" in key:
        return "classified"
    if "restricted" in key or "mythical" in key:
        return "restricted"
    if "milspec" in key or ("rare" in key and "remarkable" not in key):
        return "milspec"
    if "industrial" in key or "uncommon" in key:
        return "industrial"
    if "consumer" in key or "common" in key or "basegrade" in key:
        return "consumer"
    return "other"


def _inv_category(type_name: str, tags: dict[str, str], item_name: str) -> str:
    blob = f"{type_name} {tags.get('type', '')} {tags.get('weapon', '')} {item_name}".lower()
    if "★" in item_name or "knife" in blob:
        return "knives"
    if "glove" in blob:
        return "gloves"
    if "agent" in blob:
        return "agents"
    if "sticker" in blob:
        return "stickers"
    if "music kit" in blob:
        return "music"
    if "graffiti" in blob:
        return "graffiti"
    if "container" in blob or "case" in blob or "package" in blob:
        return "cases"
    if tags.get("weapon") or any(word in blob for word in ("rifle", "pistol", "smg", "shotgun", "sniper", "machinegun", "gun")):
        return "weapons"
    return "other"


def _steam_icon_url(icon: object, size: str | None = "96fx96f") -> str:
    token = str(icon or "").strip().lstrip("/")
    if not token:
        return ""
    if token.startswith("http://") or token.startswith("https://"):
        if size is None:
            return re.sub(r"/\d+f?x\d+f?/?$", "", token)
        if re.search(r"/\d+f?x\d+f?/?$", token):
            return token
        return f"{token}/{size}"
    if size is None:
        return f"{STEAM_ICON_CDN}/{token}"
    return f"{STEAM_ICON_CDN}/{token}/{size}"


def _slim_inventory_item(
    asset: dict[str, Any],
    descriptions: list[dict[str, Any]],
    contextid: str,
    steamid: str = "",
    extra_props: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    classid = str(asset.get("classid") or "")
    instanceid = str(asset.get("instanceid") or "0")
    desc = None
    for row in descriptions:
        if str(row.get("classid") or "") == classid and str(row.get("instanceid") or "0") == instanceid:
            desc = row
            break
    if desc is None and classid:
        for row in descriptions:
            if str(row.get("classid") or "") == classid:
                desc = row
                break
    merged = dict(desc or {})
    assetid = str(asset.get("assetid") or asset.get("id") or "")
    if not assetid:
        return None
    tags = _inv_tag_map(merged.get("tags"))
    name = str(merged.get("market_hash_name") or merged.get("market_name") or merged.get("name") or "Unknown")
    short = str(merged.get("name") or name)
    type_name = str(merged.get("type") or tags.get("type") or "")
    rarity_name = tags.get("rarity") or ""
    category = _inv_category(type_name, tags, name)
    own_props: list[dict[str, Any]] = []
    for row in [*(extra_props or []), *(asset.get("asset_properties") if isinstance(asset.get("asset_properties"), list) else [])]:
        if not isinstance(row, dict):
            continue
        inner = row.get("asset_properties")
        if isinstance(inner, list) and row.get("propertyid") is None:
            own_props.extend(item for item in inner if isinstance(item, dict))
        else:
            own_props.append(row)
    wear, pattern, prop_nametag = _parse_asset_props(own_props)
    contents = _inv_contents(merged)
    notes = _inv_notes(merged, contents)
    if wear is None:
        found = re.search(r"(?:float(?:\s*value)?|wear(?:\s*rating)?)\s*[:=]\s*(0\.\d+)", " ".join(notes), re.I)
        if found:
            try:
                wear = float(found.group(1))
            except ValueError:
                wear = None
    if pattern is None:
        found = re.search(r"(?:paint\s*seed|pattern(?:\s*template)?)\s*[:=]\s*(\d+)", " ".join(notes), re.I)
        if found:
            try:
                pattern = int(found.group(1))
            except ValueError:
                pattern = None
    icon_small = merged.get("icon_url") or merged.get("icon_url_large")
    icon_large = merged.get("icon_url_large") or merged.get("icon_url")
    try:
        amount = int(asset.get("amount") or 1)
    except (TypeError, ValueError):
        amount = 1
    quality = tags.get("quality") or ""
    return {
        "id": assetid,
        "classId": classid,
        "instanceId": instanceid,
        "name": name,
        "shortName": short,
        "type": type_name,
        "category": category,
        "rarity": _inv_rarity_class(f"{rarity_name} {type_name}"),
        "rarityName": rarity_name,
        "quality": quality if quality.lower() not in {"", "unique", "normal"} else "",
        "exterior": tags.get("exterior") or "",
        "weapon": tags.get("weapon") or "",
        "collection": tags.get("itemset") or tags.get("collection") or "",
        "tournament": tags.get("tournament") or tags.get("tournamentevent") or "",
        "team": tags.get("tournamentteam") or tags.get("team") or "",
        "icon": _steam_icon_url(icon_small),
        "iconLarge": _steam_icon_url(icon_large, None),
        "amount": amount,
        "wear": wear,
        "pattern": pattern,
        "nametag": prop_nametag or _inv_nametag(merged),
        "stickers": _inv_stickers(merged),
        "contents": contents,
        "notes": notes,
        "inspect": _inv_inspect(merged, steamid, assetid, own_props),
        "tradable": bool(int(merged["tradable"])) if str(merged.get("tradable", "")).isdigit() else bool(merged.get("tradable")),
        "marketable": bool(int(merged["marketable"])) if str(merged.get("marketable", "")).isdigit() else bool(merged.get("marketable")),
        "statTrak": "stattrak" in name.lower().replace("-", "") or "strange" in quality.lower(),
        "souvenir": "souvenir" in name.lower() or "tournament" in quality.lower(),
        "contextId": str(merged.get("contextid") or asset.get("contextid") or contextid),
    }


def _steam_inventory_page(steamid: str, start: str, count: int | None = None) -> dict[str, Any]:
    query: dict[str, str] = {}
    if start:
        query["start_assetid"] = start
    if count:
        query["l"] = "english"
        query["count"] = str(int(count))
    url = f"https://steamcommunity.com/inventory/{steamid}/{CS2_APPID}/{CS2_CONTEXTID}"
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"
    referrer = f"https://steamcommunity.com/profiles/{steamid}/inventory"
    window = _steam_community_window()
    bridge = _steam_bridge()
    bridge.reset()
    _pace_steam_inventory_request()
    script = (
        "(function(){"
        "var c=new AbortController();"
        "setTimeout(function(){try{c.abort()}catch(e){}},20000);"
        f"return fetch({json.dumps(url)},{{credentials:\"include\",referrer:{json.dumps(referrer)},"
        "headers:{Accept:\"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\"},signal:c.signal})"
        ".then(function(r){return r.text().then(function(t){"
        "window.__omegaInvBody=t;"
        "var api=window.pywebview&&pywebview.api;"
        "if(!(api&&api.begin&&api.push&&api.finish)){"
        "return {status:r.status,retryAfter:r.headers.get('Retry-After')||'',length:t.length,bridge:false};"
        "}"
        "var i=0,n=6000;"
        "return Promise.resolve(api.begin(r.status,r.headers.get('Retry-After')||'',t.length))"
        ".then(function step(){"
        "if(i>=t.length) return api.finish().then(function(){return {status:r.status,length:t.length,bridge:true};});"
        "var s=t.slice(i,i+n); i+=n;"
        "return api.push({t:s}).then(step);"
        "});"
        "});})"
        ".catch(function(e){"
        "try{if(window.pywebview&&pywebview.api&&pywebview.api.fail) pywebview.api.fail(String(e))}catch(x){}"
        "return {status:0,error:String(e),length:0,bridge:false};"
        "});"
        "})()"
    )
    meta = _steam_eval_object(_steam_eval_promise(window, script, timeout=35))
    body = ""
    retry_after = str(meta.get("retryAfter") or "")
    if bridge.event.wait(1):
        if bridge.error:
            raise ValueError(bridge.error)
        body = bridge.body()
        retry_after = bridge.retry_after or retry_after
        try:
            status = int(bridge.status or meta.get("status") or 0)
        except (TypeError, ValueError):
            status = 0
    else:
        try:
            status = int(meta.get("status") or 0)
        except (TypeError, ValueError):
            status = 0
        body = _steam_read_inv_body(window, meta.get("length") or 0)
    if not body:
        err = str(meta.get("error") or "").strip()
        if "abort" in err.lower():
            raise ValueError("Steam inventory request timed out.")
        raise ValueError(err or "Could not read Steam inventory through the browser view.")
    if status == 429:
        wait = _mark_inventory_cooldown(_retry_after_seconds(retry_after))
        raise ValueError(_inventory_wait_error(wait))
    if status in {401, 403}:
        raise ValueError("This Steam inventory is private. Set CS2 to public in Steam privacy settings.")
    if status == 400:
        raise ValueError("Steam could not find that inventory.")
    if status not in {0, 200}:
        raise ValueError(f"Steam inventory request failed (HTTP {status}).")
    return _parse_inventory_payload(body)


def _inventory_page_stub(raw: dict[str, Any]) -> bool:
    assets = raw.get("assets") if isinstance(raw.get("assets"), list) else []
    descriptions = raw.get("descriptions") if isinstance(raw.get("descriptions"), list) else []
    try:
        count = int(raw.get("total_inventory_count") or 0)
    except (TypeError, ValueError):
        count = 0
    return bool(count) and not assets and not descriptions


def _inventory_more_items(raw: dict[str, Any]) -> bool:
    value = raw.get("more_items")
    if value in {1, True, "1", "true", "True"}:
        return True
    try:
        return int(value) > 0
    except (TypeError, ValueError):
        return bool(value)


def _fetch_cs2_inventory(steamid: str) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    total = 0
    start = ""
    page_size: int | None = None
    stagnant = 0
    for _ in range(40):
        raw = _steam_inventory_page(steamid, start, page_size)
        if raw.get("success") in {0, False, "0", "false"}:
            raise ValueError("This Steam inventory is private or unavailable.")
        if page_size is None and _inventory_page_stub(raw):
            page_size = 75
            start = ""
            continue
        try:
            count = int(raw.get("total_inventory_count") or 0)
        except (TypeError, ValueError):
            count = 0
        if count:
            total = count
        assets = raw.get("assets") if isinstance(raw.get("assets"), list) else []
        descriptions = raw.get("descriptions") if isinstance(raw.get("descriptions"), list) else []
        prop_index = _index_asset_properties(raw)
        if count == 0 and not assets:
            break
        if not assets and not descriptions and count:
            if items:
                break
            raise ValueError("Steam sent an inventory count but no items. Wait a bit, then hit Refresh once.")
        added = 0
        last_asset = ""
        for asset in assets:
            if not isinstance(asset, dict):
                continue
            aid = str(asset.get("assetid") or asset.get("id") or "")
            if aid:
                last_asset = aid
            extra = prop_index.get(aid) or []
            item = _slim_inventory_item(asset, descriptions, str(CS2_CONTEXTID), steamid, extra)
            if not item:
                continue
            ident = str(item.get("id") or "")
            if not ident or ident in seen:
                continue
            seen.add(ident)
            items.append(item)
            added += 1
        more = _inventory_more_items(raw)
        last = str(raw.get("last_assetid") or last_asset or "")
        if total and len(items) >= total:
            break
        if added == 0 and not more:
            stagnant += 1
            if stagnant >= 2:
                break
        else:
            stagnant = 0
        nxt = last
        if (more or (total and len(items) < total)) and nxt and nxt != start:
            start = nxt
            page_size = page_size or 75
            continue
        break
    unique = items
    unique.sort(
        key=lambda row: int(re.sub(r"\D", "", str(row.get("id") or "0")) or 0),
        reverse=True,
    )
    return {
        "steam64": steamid,
        "appId": CS2_APPID,
        "total": total or len(unique),
        "count": len(unique),
        "complete": True,
        "items": unique,
        "fetchedAt": int(time.time() * 1000),
    }


SENS_SYSTEM = """You are an aim coach. You are given CS2 aim telemetry from OmegaDash.

Default is KEEP the current sensitivity. Do not recommend a new number just because you were asked. Only recommend a change when the flicks themselves give a clear too-high or too-low reason.

Current setup is in pack.setup (sens, DPI, eDPI, cm/360). Fights are in pack.overall, pack.flickBySize, pack.weapons, pack.matches. CS2 yaw is 0.022.

pack.signals.worthChanging is the gate:
- false: flicks are mixed or balanced. verdict = "keep". Do not set suggestedSens. Headline should say keep this sens and point at the real leak (pre-aim, counter-strafe, reaction, first-shot) if there is one.
- true: large flicks lean undershoot (too low) or overshoot (too high) vs small flicks. You MAY recommend a new 2-decimal sens in that direction, with the stats as the reason. If the lean is mild or the sample is thin, you may still keep — that is preferred over a weak nudge.

A good reason is: usable n on large flicks, under/over split or signed error clearly one way, and small flicks not showing the opposite problem.
Not a reason: pre-aim offset, head-level, TTK, first-shot, counter-strafe, path efficiency, eDPI band alone, "snappier", or wanting to give the user something to try.

If you recommend a number:
- Same DPI, 2 decimal places (example 1.18).
- Lower if overshooting, higher if undershooting.
- Use new = current × (1 + E/F) from large-flick avgSignedError E and avgFlickDeg F, then round to 2 decimals. suggestedSens MUST be that rounded value. Do not pick a bigger step than the formula.
- Modest because E/F is modest — not because you walked past the calculated value.
- verdict = "change". Never say too high/too low and then keep the same number.
- mathWork.method = "flicks", with flickDeg, errorDeg, and sens equal to that rounded value.

If you keep:
- verdict = "keep". Leave suggestedSens unused.
- headline: keep this sens, and why.

Findings: 4–8 items that cite numbers. Always cover flick-by-size when n is usable.
Actions: 3–6 specific practice items. A new sens is an action only if you actually recommended one.
Weigh Prem/Comp highest. DM and practice are noisier. Return JSON only."""


SENS_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "verdict": {"type": "STRING", "enum": ["keep", "try", "change"]},
        "primaryIssue": {
            "type": "STRING",
            "enum": ["sensitivity", "preaim", "counterstrafe", "reaction", "mixed", "insufficient"],
        },
        "confidence": {"type": "INTEGER"},
        "suggestedSens": {"type": "NUMBER"},
        "optionalSens": {"type": "NUMBER"},
        "optionalWhy": {"type": "STRING"},
        "headline": {"type": "STRING"},
        "summary": {"type": "STRING"},
        "findings": {"type": "ARRAY", "items": {"type": "STRING"}},
        "actions": {"type": "ARRAY", "items": {"type": "STRING"}},
        "mathWork": {
            "type": "OBJECT",
            "properties": {
                "method": {"type": "STRING", "enum": ["flicks", "setup"]},
                "flickDeg": {"type": "NUMBER"},
                "errorDeg": {"type": "NUMBER"},
                "setupStep": {"type": "NUMBER"},
                "equation": {"type": "STRING"},
                "steps": {"type": "ARRAY", "items": {"type": "STRING"}},
                "sens": {"type": "NUMBER"},
            },
        },
    },
    "required": ["verdict", "primaryIssue", "confidence", "headline", "summary", "findings", "actions"],
}

REFRAG_CATALOG = (
    {
        "id": "aimbotz",
        "category": "aim",
        "name": "Aimbotz",
        "blurb": "Aimbotz on real, in-game maps builds practical aim fundamentals. Warm up your aim on real maps, against static bots that won't shoot back, in a low-pressure environment.",
    },
    {
        "id": "waves",
        "category": "aim",
        "name": "Waves",
        "blurb": "Waves builds consistency under pressure. Face waves of rushing bots, running at you with knives and respawning endlessly, and sharpen your aim, improve movement, and reactions.",
    },
    {
        "id": "angle_trainer",
        "category": "peek",
        "name": "Angle Trainer",
        "blurb": "Angle Trainer builds discipline, precision, and visualization. Diligently clear your corners through a long path, as you find the two bots hiding somewhere along the route. Train your clears, learn your angles, and peek your opponents with confidence.",
    },
    {
        "id": "prefire",
        "category": "peek",
        "name": "Prefire",
        "blurb": "Prefire is the best way to learn common angles, master crosshair placement, and practice your pre-aim. Clear out every common angle on a set path, learning how to clear every spot. The only Prefire mode that has truly random bot placement in common places, forcing you to be as diligent as possible.",
    },
    {
        "id": "xfire",
        "category": "peek",
        "name": "Xfire",
        "blurb": "Xfire trains your dynamic fight response on real maps. Clear static bots on common paths, with some bots peeking you along the way. Master the art of dynamic fighting, pathing, and raw aim in common situations on familiar maps.",
    },
    {
        "id": "repeek",
        "category": "peek",
        "name": "Repeek",
        "blurb": "Repeek tests the strength of your peeks. Spawn anywhere in the map and peek against a single, randomized target. Learn to peek into a fight correctly, with low margin for error.",
    },
    {
        "id": "blitz",
        "category": "hold",
        "name": "Blitz",
        "blurb": "Deal with fast-peeking, aggressive bots swinging you in quick succession. Train your reactions, recoil, and positioning in realistic fights.",
    },
    {
        "id": "crossfire",
        "category": "hold",
        "name": "Crossfire",
        "blurb": "Simulate real, in-game pressure with bots swinging you aggressively and in quick succession. Master your reactions, aim, and multifrags.",
    },
    {
        "id": "defender",
        "category": "hold",
        "name": "Defender",
        "blurb": "Defend against aggressive rushes, react to utility and swings, and learn to hold your own in high-pressure situations.",
    },
    {
        "id": "rush",
        "category": "hold",
        "name": "Rush",
        "blurb": "Take on 5 aggressive bots charging straight at you from all angles. Designed to mirror real enemy behavior. Sharpen your tracking, crosshair placement, and defensive positioning under pressure.",
    },
    {
        "id": "awp_flick",
        "category": "awp",
        "name": "AWP Flick",
        "blurb": "AWP Flick mode sharpens your reaction speed and precision, as bots peek you from multiple angles in quick succession. Practice flicks in tailored arenas across all competitive maps to refine your AWP mechanics.",
    },
    {
        "id": "awp_hold",
        "category": "awp",
        "name": "AWP Hold",
        "blurb": "AWP Hold develops consistency in your defensive AWPing, as bots peek you from a single angle. Practice angles, positioning, and reactive AWPing in custom arenas across competitive maps.",
    },
)
_REFRAG_BY_ID = {item["id"]: item for item in REFRAG_CATALOG}
_REFRAG_ALIASES = {
    "aimbotz": "aimbotz",
    "aim botz": "aimbotz",
    "waves": "waves",
    "angle trainer": "angle_trainer",
    "angletrainer": "angle_trainer",
    "prefire": "prefire",
    "xfire": "xfire",
    "repeek": "repeek",
    "blitz": "blitz",
    "crossfire": "crossfire",
    "defender": "defender",
    "rush": "rush",
    "awp flick": "awp_flick",
    "awp-flick": "awp_flick",
    "awpflick": "awp_flick",
    "awp hold": "awp_hold",
    "awp-hold": "awp_hold",
    "awphold": "awp_hold",
}
WORKSHOP_MAPS = {
    "aim botz": "Aim Botz",
    "fast aim": "Fast Aim / Reflex Training",
    "fast aim / reflex training": "Fast Aim / Reflex Training",
    "reflex training": "Fast Aim / Reflex Training",
    "recoil master": "Recoil Master - Spray Training",
    "recoil master - spray training": "Recoil Master - Spray Training",
    "training aim cs2": "Training Aim CS2",
    "training_aim_csgo2": "Training Aim CS2",
    "training aim": "Training Aim CS2",
}

ROUTINE_SYSTEM = """You are a CS2 aim coach recommending practice from OmegaDash telemetry and the latest Sensitivity Finder read.

Recommend specific modes — not a timed session and not a sequence. Stats decide what to include. Skip anything that is not a leak.

Platforms (use exactly these values):
- refrag — Refrag.gg only, from the catalog below
- workshop — standalone workshop maps (never Yprac)

Allowed Refrag modes (name must match exactly; category is fixed):

Aim
- Aimbotz — static bots on real maps; low-pressure aim fundamentals.
- Waves — rushing knife bots in waves; consistency, movement, reactions under pressure.

Peek
- Angle Trainer — long path, two bots hiding; corner clears, angles, visualization.
- Prefire — common-angle path with random bot placement; crosshair placement and pre-aim.
- Xfire — static bots on common paths, some peek you; dynamic fights and pathing.
- Repeek — spawn anywhere vs one randomized target; peek into the fight cleanly.

Hold
- Blitz — fast-peeking bots swinging in succession; reactions, recoil, positioning.
- Crossfire — aggressive multi-swings; reactions, aim, multifrags.
- Defender — hold vs rushes and utility; high-pressure site holds.
- Rush — five bots charging from all angles; tracking, placement, defensive positioning.

AWP (only if pack.awpMain is true — they mainly AWPed in this sample)
- AWP Flick — bots peek from multiple angles; AWP reaction and precision.
- AWP Hold — bots peek a single angle; defensive AWP consistency.
If pack.awpMain is false, do not recommend AWP Flick or AWP Hold.

Allowed workshop maps only:
- Aim Botz
- Fast Aim / Reflex Training
- Recoil Master - Spray Training
- Training Aim CS2 / training_aim_csgo2

Rules:
- 5–10 items. Mix Refrag and workshop when both help; do not pad.
- For Refrag, name must be a catalog mode. category must be aim, peek, hold, or awp.
- mode = the competitive map to run it on when the pack has map leaks (Mirage, Inferno, etc.). Leave it the mode name if no map applies.
- setup = exact settings (weapon, difficulty, head-only, movement).
- why = the stat that earned this recommendation. how = what to focus on.
- If the verdict is change or try, one Aimbotz or Waves item can confirm the new number.
- Do not invent Refrag modes, Yprac maps, or numbers. Return JSON only."""

ROUTINE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "title": {"type": "STRING"},
        "intro": {"type": "STRING"},
        "items": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "platform": {"type": "STRING", "enum": ["refrag", "workshop"]},
                    "category": {"type": "STRING", "enum": ["aim", "peek", "hold", "awp", "workshop"]},
                    "name": {"type": "STRING"},
                    "mode": {"type": "STRING"},
                    "setup": {"type": "STRING"},
                    "why": {"type": "STRING"},
                    "how": {"type": "STRING"},
                },
                "required": ["platform", "name", "setup", "why", "how"],
            },
        },
    },
    "required": ["title", "intro", "items"],
}

LEAK_RESULT_PATH = APP_DIR / "omega-leak-last.json"
WEAPON_NAME_ALIASES = {
    "ak": "ak-47",
    "ak47": "ak-47",
    "m4": "m4a4",
    "m4a1": "m4a1-s",
    "m4a1s": "m4a1-s",
    "usp": "usp-s",
    "deagle": "desert eagle",
    "glock": "glock-18",
}

MAP_LEAK_SYSTEM = """You are a CS2 coach reading OmegaDash map telemetry only.

Pick the SINGLE weakest map, or verdict = "ok" if nothing is clearly weak. Do not mention weapons.

Win rate is Prem/Comp (and untagged) only — DM/practice/casual are excluded from win rate. Also use K/D, pre-aim (degrees, lower is better), reaction (ms, lower is better). Compare each played map to pack.overall, not to a pro standard.

Sample size is the gate:
- pack.maps[].share is percent of the player's games. Weight leaks by share and played count.
- Only pick from maps with eligible=true. Those have enough games to trust.
- A map with 1–2 games (or a tiny share) can look ugly by chance. Do not call that the leak.
- Prefer maps with enough games. A modest gap on a high-share map beats a huge gap on a map they barely play.
- Ignore unplayed maps.

High pre-aim or slow reaction vs their own averages on a well-played map = weak awareness / crosshair placement there.
Low win rate on a well-played map can be the leak even with decent K/D.

verdict:
- map — one map is the leak. focusName must match a pack map name exactly.
- ok — maps look acceptable for the sample. Recommend how to keep improving. No focus.

reason: winrate | preaim | reaction | kd | mixed | none
headline: one sentence. summary: 2–4 sentences with numbers (include games played / share).
findings: 3–6 bullets that cite numbers. actions: 2–4 specific practice items.
Do not invent maps or stats. Return JSON only."""

WEAPON_LEAK_SYSTEM = """You are a CS2 coach reading OmegaDash weapon telemetry only.

Pick the SINGLE weakest weapon, or verdict = "ok" if nothing is clearly weak. Do not mention maps.

Use K/D, fights, share (% of fights), reaction, pre-aim, first-shot, counter-strafe, head-level, landing under/on/over. Compare to pack.overall, not a pro standard.

Usage is the gate:
- pack.weapons[].share is percent of fights. Weight leaks by share.
- Only pick from weapons with eligible=true. Those are guns they actually use.
- The guns they actually use matter. A rarely used gun with a bad K/D is not the leak.
- A modest gap on a high-share gun beats a huge gap on a 2% pistol.
- Do not prefer rifles or pistols by name. Volume decides.

verdict:
- weapon — one weapon is the leak. focusName must match a pack weapon name exactly. focusId = that weapon's id.
- ok — weapons look acceptable for the sample. Recommend how to keep improving. No focus.

reason: preaim | reaction | kd | mixed | none
headline: one sentence. summary: 2–4 sentences with numbers (include fights / share).
findings: 3–6 bullets that cite numbers. actions: 2–4 specific practice items.
Do not invent guns or stats. Return JSON only."""


def _leak_schema(kind: str) -> dict[str, Any]:
    verdict = ["map", "ok"] if kind == "map" else ["weapon", "ok"]
    reasons = (
        ["winrate", "preaim", "reaction", "kd", "mixed", "none"]
        if kind == "map"
        else ["preaim", "reaction", "kd", "mixed", "none"]
    )
    return {
        "type": "OBJECT",
        "properties": {
            "verdict": {"type": "STRING", "enum": verdict},
            "reason": {"type": "STRING", "enum": reasons},
            "confidence": {"type": "INTEGER"},
            "focusName": {"type": "STRING"},
            "focusId": {"type": "STRING"},
            "headline": {"type": "STRING"},
            "summary": {"type": "STRING"},
            "findings": {"type": "ARRAY", "items": {"type": "STRING"}},
            "actions": {"type": "ARRAY", "items": {"type": "STRING"}},
        },
        "required": ["verdict", "reason", "confidence", "headline", "summary", "findings", "actions"],
    }


def _as_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _clip_text(value: Any, limit: int) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def _clip_list(value: Any, count: int, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        text = _clip_text(item, limit)
        if text:
            out.append(text)
        if len(out) >= count:
            break
    return out


def _load_leak_result() -> dict[str, Any] | None:
    try:
        if not LEAK_RESULT_PATH.is_file():
            return None
        parsed = json.loads(LEAK_RESULT_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _save_leak_result(payload: dict[str, Any]) -> None:
    LEAK_RESULT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _leak_store(raw: dict[str, Any] | None) -> dict[str, Any]:
    empty: dict[str, Any] = {"maps": None, "weapons": None}
    if not isinstance(raw, dict):
        return empty
    maps = raw.get("maps")
    weapons = raw.get("weapons")
    if isinstance(maps, dict) or isinstance(weapons, dict):
        return {
            "maps": maps if isinstance(maps, dict) else None,
            "weapons": weapons if isinstance(weapons, dict) else None,
        }
    analysis = raw.get("analysis")
    if isinstance(analysis, dict):
        verdict = str(analysis.get("verdict") or "")
        if verdict == "map":
            empty["maps"] = raw
        elif verdict == "weapon":
            empty["weapons"] = raw
    return empty


def _save_leak_kind(kind: str, result: dict[str, Any]) -> None:
    store = _leak_store(_load_leak_result())
    key = "maps" if kind == "map" else "weapons"
    store[key] = result
    _save_leak_result(store)


def _slim_leak_maps(rows: object) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in rows or []:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "id": item.get("id"),
                "name": item.get("name"),
                "pool": item.get("pool"),
                "played": int(item.get("played") or 0),
                "wins": int(item.get("wins") or 0),
                "losses": int(item.get("losses") or 0),
                "draws": int(item.get("draws") or 0),
                "winRate": item.get("winRate"),
                "kd": item.get("kd"),
                "kills": item.get("kills"),
                "deaths": item.get("deaths"),
                "reaction": item.get("reaction"),
                "preaim": item.get("preaim"),
                "share": 0,
            }
        )
    return out


def _slim_leak_weapons(rows: object) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in rows or []:
        if not isinstance(item, dict):
            continue
        landing = item.get("landing") if isinstance(item.get("landing"), dict) else {}
        row = {
            "id": str(item.get("id") or ""),
            "weaponId": item.get("weaponId"),
            "name": item.get("name"),
            "class": item.get("class"),
            "fights": int(item.get("fights") or 0),
            "kills": item.get("kills"),
            "deaths": item.get("deaths"),
            "kd": item.get("kd"),
            "share": item.get("share"),
            "reaction": item.get("reaction"),
            "preaim": item.get("preaim"),
            "headLevel": item.get("headLevel"),
            "firstShot": item.get("firstShot"),
            "counterStrafe": item.get("counterStrafe"),
            "preAimed": item.get("preAimed"),
            "ttk": item.get("ttk"),
            "landing": {
                "under": landing.get("under"),
                "target": landing.get("target"),
                "over": landing.get("over"),
            },
        }
        out.append(row)
    return out


def _leak_overall(player: dict[str, Any]) -> dict[str, Any]:
    return {
        "matches": player.get("matches"),
        "fights": player.get("engagements"),
        "kd": player.get("kd"),
        "hs": player.get("hs"),
        "reaction": player.get("reaction"),
        "preaim": player.get("placementOffset"),
        "headLevel": player.get("headLevel"),
        "firstShot": player.get("firstShot"),
        "counterStrafe": player.get("counterStrafe"),
    }


def _mark_map_eligible(maps: list[dict[str, Any]]) -> None:
    total = sum(int(row.get("played") or 0) for row in maps)
    for row in maps:
        played = int(row.get("played") or 0)
        if total < 6:
            row["eligible"] = played > 0
        else:
            row["eligible"] = played >= 3


def _mark_weapon_eligible(weapons: list[dict[str, Any]]) -> None:
    shares = [float(row.get("share") or 0) for row in weapons]
    max_share = max(shares) if shares else 0
    for row in weapons:
        fights = int(row.get("fights") or 0)
        share = float(row.get("share") or 0)
        row["eligible"] = fights > 0 and (
            share >= 5 or (max_share > 0 and share >= max_share * 0.35)
        )


def _build_leak_pack(modes: list[str] | None, kind: str) -> dict[str, Any]:
    state = telemetry.get_dashboard_state(modes)
    player = state.get("player") if isinstance(state.get("player"), dict) else {}
    overall = _leak_overall(player)
    if kind == "map":
        maps = _slim_leak_maps(state.get("maps"))
        total = sum(int(row.get("played") or 0) for row in maps)
        for row in maps:
            played = int(row.get("played") or 0)
            row["share"] = round(played / total * 100, 1) if total else 0
        _mark_map_eligible(maps)
        return {
            "kind": "map",
            "overall": {**overall, "gamesOnMaps": total},
            "maps": maps,
            "notes": {
                "winRate": "Prem/Comp and untagged only. DM, practice, and casual are excluded from win rate.",
                "sample": "Weight by maps[].share (percent of games) and played count. Only eligible=true maps. Do not flag a barely-played map.",
            },
        }
    weapons = _slim_leak_weapons(state.get("weapons"))
    _mark_weapon_eligible(weapons)
    return {
        "kind": "weapon",
        "overall": overall,
        "weapons": weapons,
        "notes": {
            "sample": "Weight by weapons[].share (percent of fights). Only eligible=true guns. The guns they use most matter most.",
        },
    }


def _fold_key(value: object) -> str:
    return "".join(ch for ch in str(value or "").lower() if ch.isalnum())


def _match_leak_map(name: object, maps: list[dict[str, Any]]) -> dict[str, Any] | None:
    needle = _fold_key(name)
    if not needle:
        return None
    played = [row for row in maps if int(row.get("played") or 0) > 0]
    for row in played:
        if _fold_key(row.get("name")) == needle or _fold_key(row.get("id")) == needle:
            return row
    for row in played:
        key = _fold_key(row.get("name"))
        ident = _fold_key(row.get("id"))
        if needle in key or key in needle or needle in ident:
            return row
    return None


def _match_leak_weapon(name: object, wid: object, weapons: list[dict[str, Any]]) -> dict[str, Any] | None:
    ident = str(wid or "").strip()
    if ident:
        for row in weapons:
            if str(row.get("id") or "") == ident or str(row.get("weaponId") or "") == ident:
                return row
    needle = _fold_key(name)
    needle = _fold_key(WEAPON_NAME_ALIASES.get(needle, needle))
    if not needle:
        return None
    for row in weapons:
        if _fold_key(row.get("name")) == needle:
            return row
    for row in weapons:
        key = _fold_key(row.get("name"))
        if needle in key or key in needle:
            return row
    return None


def _normalize_leak_analysis(raw: dict[str, Any], pack: dict[str, Any], kind: str) -> dict[str, Any]:
    allowed = {"ok", kind}
    verdict = str(raw.get("verdict") or "").strip().lower()
    if verdict not in allowed:
        verdict = "ok"
    reason = str(raw.get("reason") or "").strip().lower()
    allowed_reasons = (
        {"winrate", "preaim", "reaction", "kd", "mixed", "none"}
        if kind == "map"
        else {"preaim", "reaction", "kd", "mixed", "none"}
    )
    if reason not in allowed_reasons:
        reason = "mixed" if verdict != "ok" else "none"
    try:
        confidence = max(0, min(100, int(raw.get("confidence") or 0)))
    except (TypeError, ValueError):
        confidence = 0
    maps = pack.get("maps") if isinstance(pack.get("maps"), list) else []
    weapons = pack.get("weapons") if isinstance(pack.get("weapons"), list) else []
    focus_name = ""
    focus_id = ""
    if verdict == "map":
        hit = _match_leak_map(raw.get("focusName") or raw.get("focusId"), maps)
        if hit and hit.get("eligible") is not False:
            focus_name = str(hit.get("name") or "")
            focus_id = str(hit.get("id") or "")
        else:
            verdict = "ok"
            reason = "none"
    elif verdict == "weapon":
        hit = _match_leak_weapon(raw.get("focusName"), raw.get("focusId"), weapons)
        if hit and hit.get("eligible") is not False:
            focus_name = str(hit.get("name") or "")
            focus_id = str(hit.get("id") or "")
        else:
            verdict = "ok"
            reason = "none"
    if verdict == "ok":
        focus_name = ""
        focus_id = ""
        if reason != "none":
            reason = "none"
    return {
        "verdict": verdict,
        "reason": reason,
        "confidence": confidence,
        "focusName": focus_name,
        "focusId": focus_id,
        "headline": _clip_text(raw.get("headline"), 160) or "Aim read",
        "summary": _clip_text(raw.get("summary"), 800),
        "findings": _clip_list(raw.get("findings"), 8, 240),
        "actions": _clip_list(raw.get("actions"), 6, 240),
    }


SAMPLE_MODE_DEFAULT = ["prem_comp", "practice", "casual", "deathmatch", ""]


def _clean_sample_modes(value: object) -> list[str]:
    allowed = {"prem_comp", "practice", "casual", "deathmatch", ""}
    if not isinstance(value, list):
        return list(SAMPLE_MODE_DEFAULT)
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        if item is None:
            key = ""
        else:
            raw = str(item).strip()
            if raw == "" or raw.lower() in {"untagged", "none", "tag"}:
                key = ""
            else:
                key = telemetry.normalize_match_mode(raw)
                if not key:
                    continue
        if key not in allowed or key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out if out else list(SAMPLE_MODE_DEFAULT)


def _load_sens_result() -> dict[str, Any] | None:
    try:
        if not SENS_RESULT_PATH.is_file():
            return None
        parsed = json.loads(SENS_RESULT_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _save_sens_result(payload: dict[str, Any]) -> None:
    SENS_RESULT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _parse_gemini_json(text: str) -> dict[str, Any] | None:
    raw = str(text or "").strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1]
        if raw.endswith("```"):
            raw = raw[: raw.rfind("```")]
        raw = raw.strip()
        if raw.lower().startswith("json"):
            raw = raw[4:].strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            parsed = json.loads(raw[start : end + 1])
        except json.JSONDecodeError:
            return None
    return parsed if isinstance(parsed, dict) else None


def _clean_sens_value(value: Any, current: float) -> float | None:
    n = _as_float(value)
    if n is None or n < 0.05:
        return None
    n = telemetry.round_sens_suggest(n)
    if n < 0.05 or n > 20:
        return None
    if abs(n - round(float(current), 2)) < 0.005:
        return None
    return n


def _sens_number_forms(value: float) -> list[str]:
    forms = {
        f"{value:g}",
        f"{value:.2f}",
        f"{value:.5f}".rstrip("0").rstrip("."),
    }
    return sorted((form for form in forms if form and form != "0"), key=len, reverse=True)


def _replace_sens_number(text: str, old: float, new: float) -> str:
    if not text or abs(old - new) < 0.005:
        return text
    out = text
    listed = f"{new:.2f}"
    for form in _sens_number_forms(old):
        out = re.sub(rf"(?<![\d.]){re.escape(form)}(?![\d.])", listed, out)
    return out


def _align_sens_copy(text: str, discarded: list[float], listed: float, current: float) -> str:
    out = text
    for old in discarded:
        if abs(old - listed) < 0.005 or abs(old - current) < 0.005:
            continue
        out = _replace_sens_number(out, old, listed)
    return out


def _normalize_sens_analysis(
    raw: dict[str, Any],
    sens: float,
    dpi: int,
    signals: dict[str, Any] | None = None,
    math: dict[str, Any] | None = None,
) -> dict[str, Any]:
    math = math if isinstance(math, dict) else {}
    signals = signals if isinstance(signals, dict) else {}
    worth = bool(signals.get("worthChanging"))
    lean = str(signals.get("direction") or "").strip().lower()
    gemini_verdict = str(raw.get("verdict") or "").strip().lower()

    math_listed = _clean_sens_value(math.get("listedSens") or math.get("sens"), sens)
    gemini_listed = (
        _clean_sens_value(raw.get("suggestedSens"), sens)
        or _clean_sens_value(raw.get("optionalSens"), sens)
    )
    # Verified F/E (or eDPI) arithmetic wins when Gemini wants a change.
    # It may not invent a farther step than the formula.
    suggested = None
    if gemini_verdict != "keep":
        suggested = math_listed or gemini_listed
    stripped = False
    if suggested and not worth:
        suggested = None
        stripped = True
    elif suggested and lean == "too_high" and suggested >= float(sens):
        suggested = None
        stripped = True
    elif suggested and lean == "too_low" and suggested <= float(sens):
        suggested = None
        stripped = True

    if suggested:
        verdict = "change"
        direction = "too_high" if suggested < float(sens) else "too_low"
        try_source = "flicks"
    else:
        verdict = "keep"
        direction = "none"
        try_source = "flicks"

    issue = str(raw.get("primaryIssue") or raw.get("issue") or "mixed").strip().lower()
    if issue not in {"sensitivity", "preaim", "counterstrafe", "reaction", "mixed", "insufficient"}:
        issue = "mixed"
    if verdict == "change":
        issue = "sensitivity"
    try:
        confidence = int(raw.get("confidence") or 0)
    except (TypeError, ValueError):
        confidence = 0
    confidence = max(0, min(100, confidence))

    discarded = [value for value in (gemini_listed,) if value is not None]
    why = ""
    if suggested:
        why = str(math.get("reason") or raw.get("optionalWhy") or "").strip()
        why = _align_sens_copy(why, discarded, suggested, float(sens))

    headline = _clip_text(raw.get("headline"), 140)
    summary = _clip_text(raw.get("summary"), 1200)
    findings = _clip_list(raw.get("findings"), 8, 420)
    actions = _clip_list(raw.get("actions"), 6, 360)
    if suggested:
        headline = _align_sens_copy(headline, discarded, suggested, float(sens))
        summary = _align_sens_copy(summary, discarded, suggested, float(sens))
        findings = [_align_sens_copy(item, discarded, suggested, float(sens)) for item in findings]
        actions = [_align_sens_copy(item, discarded, suggested, float(sens)) for item in actions]
    if stripped:
        headline = "Keep this sens — flicks don’t show a clear reason to change"
    elif not headline:
        headline = f"Try {suggested:.2f}" if suggested else "Keep this sens"

    out = {
        "verdict": verdict,
        "primaryIssue": issue,
        "confidence": confidence,
        "direction": direction,
        "trySource": try_source if verdict == "change" else "",
        "suggestedSens": suggested,
        "suggestedCm360": telemetry.cm360(suggested, dpi) if suggested else None,
        "optionalSens": None,
        "optionalCm360": None,
        "optionalWhy": why,
        "headline": headline,
        "summary": summary,
        "findings": findings,
        "actions": actions,
        "math": math or None,
    }
    return out


def _guide_key(value: Any) -> str:
    return " ".join(str(value or "").lower().replace("_", " ").replace("-", " ").split())


def _lookup_refrag(name: str) -> dict[str, str] | None:
    key = _guide_key(name)
    mode_id = _REFRAG_ALIASES.get(key)
    if not mode_id:
        compact = key.replace(" ", "")
        mode_id = _REFRAG_ALIASES.get(compact)
    return _REFRAG_BY_ID.get(mode_id or "")


def _lookup_workshop(name: str) -> str | None:
    key = _guide_key(name)
    if "yprac" in key:
        return None
    if key in WORKSHOP_MAPS:
        return WORKSHOP_MAPS[key]
    for alias, label in WORKSHOP_MAPS.items():
        if alias in key or key in alias:
            return label
    return None


def _normalize_guide(raw: dict[str, Any], *, awp_main: bool = False) -> dict[str, Any]:
    items = []
    seen: set[tuple[str, str]] = set()
    raw_items = raw.get("items") if isinstance(raw.get("items"), list) else []
    if not raw_items and isinstance(raw.get("blocks"), list):
        raw_items = raw.get("blocks") or []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        given = _clip_text(item.get("name"), 80)
        if not given:
            continue
        platform = str(item.get("platform") or "").strip().lower()
        blob = f"{given} {item.get('mode') or ''}".lower()
        if "yprac" in blob:
            continue
        refrag = _lookup_refrag(given) or _lookup_refrag(item.get("mode") or "")
        workshop = _lookup_workshop(given)
        if platform == "workshop":
            if not workshop:
                continue
            platform = "workshop"
            name = workshop
            category = "workshop"
            blurb = ""
        elif refrag:
            if refrag["category"] == "awp" and not awp_main:
                continue
            platform = "refrag"
            name = refrag["name"]
            category = refrag["category"]
            blurb = refrag["blurb"]
        elif workshop:
            platform = "workshop"
            name = workshop
            category = "workshop"
            blurb = ""
        else:
            continue
        mode = _clip_text(item.get("mode") or "", 80)
        if mode.lower() in {name.lower(), "workshop"}:
            mode = ""
        key = (platform, name.lower(), mode.lower())
        if key in seen:
            continue
        seen.add(key)
        items.append(
            {
                "platform": platform,
                "category": category,
                "name": name,
                "mode": mode,
                "blurb": blurb,
                "setup": _clip_text(item.get("setup"), 280),
                "why": _clip_text(item.get("why"), 240),
                "how": _clip_text(item.get("how"), 320),
            }
        )
        if len(items) >= 10:
            break
    return {
        "title": _clip_text(raw.get("title"), 80) or "Practice guide",
        "intro": _clip_text(raw.get("intro"), 500),
        "items": items,
        "builtAt": int(time.time() * 1000),
    }


def _routine_prompt_pack(saved: dict[str, Any]) -> dict[str, Any]:
    setup = saved.get("setup") if isinstance(saved.get("setup"), dict) else {}
    sample = saved.get("sample") if isinstance(saved.get("sample"), dict) else {}
    analysis = saved.get("analysis") if isinstance(saved.get("analysis"), dict) else {}
    pack: dict[str, Any] | None = None
    try:
        games = int(sample.get("requested") or sample.get("matches") or 8)
        sens = float(setup.get("sens") or 0)
        dpi = int(float(setup.get("dpi") or 0))
        if sens > 0 and dpi > 0:
            modes = sample.get("filter")
            if not isinstance(modes, list):
                modes = sample.get("modes")
            if not isinstance(modes, list):
                modes = None
            pack = telemetry.build_sens_pack(games, sens, dpi, modes)
    except (TypeError, ValueError, OSError, sqlite3.Error):
        pack = None
    source = pack if isinstance(pack, dict) else {}
    weapons = []
    for item in (source.get("weapons") or [])[:6]:
        if isinstance(item, dict):
            weapons.append(item)
    maps = []
    for item in source.get("matches") or []:
        if not isinstance(item, dict):
            continue
        maps.append(
            {
                "map": item.get("map"),
                "mode": item.get("mode"),
                "modeLabel": item.get("modeLabel"),
                "preaim": item.get("preaim"),
                "reaction": item.get("reaction"),
                "firstShot": item.get("firstShot"),
                "landing": item.get("landing"),
                "kd": item.get("kd") if "kd" in item else None,
                "kills": item.get("kills"),
                "deaths": item.get("deaths"),
            }
        )
    total_fights = 0
    awp_fights = 0
    for row in weapons:
        fights = int(row.get("fights") or 0)
        total_fights += fights
        weapon = str(row.get("weapon") or "").lower()
        klass = str(row.get("class") or "").lower()
        if "awp" in weapon or klass == "sniper":
            if "awp" in weapon:
                awp_fights += fights
            elif klass == "sniper" and "ssg" not in weapon and "scout" not in weapon:
                awp_fights += fights
    fight_n = int(sample.get("fights") or total_fights or 0)
    awp_share = (awp_fights / fight_n) if fight_n else 0.0
    top = str((weapons[0] or {}).get("weapon") or "").lower() if weapons else ""
    awp_main = bool(awp_share >= 0.25 or top.startswith("awp"))
    return {
        "setup": setup,
        "sample": sample,
        "signals": saved.get("signals") or {},
        "analysis": {
            "verdict": analysis.get("verdict"),
            "primaryIssue": analysis.get("primaryIssue"),
            "direction": analysis.get("direction"),
            "trySource": analysis.get("trySource"),
            "suggestedSens": analysis.get("suggestedSens"),
            "optionalSens": analysis.get("optionalSens"),
            "headline": analysis.get("headline"),
            "summary": analysis.get("summary"),
            "findings": analysis.get("findings"),
            "actions": analysis.get("actions"),
        },
        "overall": source.get("overall") or saved.get("overall") or {},
        "flickBySize": source.get("flickBySize") or saved.get("flickBySize") or {},
        "weapons": weapons,
        "maps": maps,
        "awpMain": awp_main,
        "awpShare": round(awp_share, 3),
    }


def _gemini_generate(
    prompt: str,
    *,
    system: str | None = None,
    schema: dict[str, Any] | None = None,
    max_output: int = 2048,
    timeout: int = 75,
) -> dict[str, Any]:
    key = _secret("gemini")
    if not key:
        raise FileNotFoundError("Gemini API key is not set")
    last_error = "Gemini returned no text"
    system_text = system if system is not None else SENS_SYSTEM
    schema_obj = schema if schema is not None else SENS_SCHEMA
    configs = [
        {
            "temperature": 0.25,
            "maxOutputTokens": max_output,
            "responseMimeType": "application/json",
            "responseSchema": schema_obj,
        },
        {
            "temperature": 0.25,
            "maxOutputTokens": max_output,
            "responseMimeType": "application/json",
        },
    ]
    for model in GEMINI_MODELS:
        for config in configs:
            body = {
                "systemInstruction": {"parts": [{"text": system_text}]},
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": config,
            }
            payload = json.dumps(body).encode("utf-8")
            request = urllib.request.Request(
                GEMINI_URL.format(model=model),
                data=payload,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "User-Agent": "OmegaDash/1.0",
                    "x-goog-api-key": key,
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    raw = json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                last_error = _http_error_message(exc, "Gemini request failed")
                if exc.code in GEMINI_LIMIT_CODES:
                    break
                if exc.code in {400, 404}:
                    continue
                raise RuntimeError(last_error) from exc
            except urllib.error.URLError as exc:
                raise RuntimeError("Could not reach Gemini") from exc
            except json.JSONDecodeError:
                last_error = "Gemini returned an invalid response"
                continue
            if not isinstance(raw, dict):
                continue
            candidates = raw.get("candidates")
            if not isinstance(candidates, list) or not candidates:
                last_error = "Gemini returned no candidates"
                continue
            parts = ((candidates[0] or {}).get("content") or {}).get("parts") or []
            text = ""
            for part in parts:
                if isinstance(part, dict) and part.get("text"):
                    text += str(part.get("text") or "")
            parsed = _parse_gemini_json(text)
            if parsed:
                return parsed
            last_error = "Gemini returned JSON we could not read"
    raise RuntimeError(last_error)


def _public_widget(raw: dict) -> dict:
    steam = raw.get("steam") if isinstance(raw.get("steam"), dict) else {}
    rank = raw.get("rank") if isinstance(raw.get("rank"), dict) else {}
    session = raw.get("session") if isinstance(raw.get("session"), dict) else {}
    astrology = raw.get("astrology") if isinstance(raw.get("astrology"), dict) else {}
    loot = raw.get("loot") if isinstance(raw.get("loot"), dict) else {}
    return {
        "rank": {"name": rank.get("name"), "progress": rank.get("progress")},
        "astrology": {
            "sign": astrology.get("sign"),
            "xp": astrology.get("xp"),
            "gain": astrology.get("gain"),
        },
        "protection": raw.get("protection"),
        "session": {
            "frozen": bool(session.get("frozen")),
            "last_activity": session.get("last_activity"),
        },
        "steam": {
            "id": _as_steam64(steam.get("id")) or str(steam.get("id") or ""),
            "persona": steam.get("persona") or "",
        },
        "discord": str(raw.get("discord") or ""),
        "loot": {
            "last_roll": loot.get("last_roll"),
            "can_roll": bool(loot.get("can_roll")),
            "next_roll": loot.get("next_roll"),
        },
    }


def _safe_avatar(url: object) -> str:
    if not isinstance(url, str):
        return ""
    if url.startswith("https://constelia.ai/") or url.startswith("https://i.constelia.ai/"):
        return url
    return ""


LIBRARY_CATEGORY_KEYS = {"dependency/library", "dependancy/library"}
_ENCYCLOPEDIA = {"at": 0.0, "items": [], "library_ids": set()}
_ENCYCLOPEDIA_LOCK = threading.Lock()
ENCYCLOPEDIA_TTL = 15 * 60
_COMMUNITY = {"at": 0.0, "by_id": {}, "users": {}}
_COMMUNITY_LOCK = threading.Lock()
COMMUNITY_TTL = 15 * 60


def _as_script_id(value: object) -> int | None:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _is_library_category(names: object) -> bool:
    if not isinstance(names, list):
        return False
    for name in names:
        key = "".join(str(name or "").lower().split())
        if key in LIBRARY_CATEGORY_KEYS:
            return True
    return False


def _clip_setting(value: object) -> Any:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    if value is None:
        return None
    if isinstance(value, dict):
        return {str(key): _clip_setting(val) for key, val in list(value.items())[:48]}
    if isinstance(value, list):
        return [_clip_setting(item) for item in value[:48]]
    text = str(value)
    if len(text) > 240:
        return text[:237] + "..."
    return text


def _omega_configs(raw: dict) -> dict[str, dict]:
    configuration = raw.get("configuration")
    omega = configuration.get("omega") if isinstance(configuration, dict) else None
    if not isinstance(omega, dict):
        return {}
    out: dict[str, dict] = {}
    for name, cfg in omega.items():
        if not isinstance(cfg, dict):
            continue
        out[str(name).strip().lower()] = {
            "name": str(name),
            "enabled": None if "enabled" not in cfg else bool(cfg.get("enabled")),
            "settings": {str(key): _clip_setting(val) for key, val in cfg.items()},
        }
    return out


def _script_name_aliases(name: str) -> set[str]:
    base = str(name or "").strip().lower()
    if not base:
        return set()
    aliases = {base}
    if base.endswith(".lua"):
        aliases.add(base[:-4])
    else:
        aliases.add(base + ".lua")
    return aliases


def _member_configuration(raw: dict) -> dict:
    cfg = raw.get("configuration")
    if isinstance(cfg, str):
        try:
            cfg = json.loads(cfg)
        except json.JSONDecodeError as exc:
            raise ValueError("Cloud configuration is not valid JSON") from exc
    if cfg is None:
        return {}
    if not isinstance(cfg, dict):
        raise ValueError("Cloud configuration is invalid")
    return cfg


def _installed_script_name(raw: dict, script_id: int | None) -> str:
    if script_id is None:
        return ""
    data = raw.get("scripts_data")
    if not isinstance(data, dict):
        return ""
    for entry in data.values():
        if not isinstance(entry, dict):
            continue
        if _as_script_id(entry.get("id")) == script_id:
            return str(entry.get("name") or "")
    return ""


def _find_omega_script_key(omega: dict, *names: str) -> str | None:
    aliases: set[str] = set()
    for name in names:
        aliases |= _script_name_aliases(name)
    if not aliases:
        return None
    for key in omega:
        if str(key).strip().lower() in aliases:
            return key if isinstance(key, str) else str(key)
    return None


def _json_setting(value: object, depth: int = 0) -> Any:
    if depth > 6:
        raise ValueError("Config value is too nested")
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError("Config number is invalid")
        return value
    if value is None:
        return None
    if isinstance(value, str):
        if len(value) > 8000:
            raise ValueError("Config text is too long")
        return value
    if isinstance(value, dict):
        if len(value) > 48:
            raise ValueError("Config object is too large")
        return {str(key): _json_setting(val, depth + 1) for key, val in list(value.items())[:48]}
    if isinstance(value, list):
        if len(value) > 48:
            raise ValueError("Config list is too large")
        return [_json_setting(item, depth + 1) for item in value[:48]]
    raise ValueError("Config value is invalid")


def _incoming_settings(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict) or isinstance(raw, list):
        raise ValueError("Invalid script settings")
    if len(raw) > 128:
        raise ValueError("Too many config fields")
    out: dict[str, Any] = {}
    for key, val in list(raw.items())[:128]:
        name = str(key).strip()
        if not name or len(name) > 80:
            continue
        out[name] = _json_setting(val)
    if not out:
        raise ValueError("No config fields to save")
    return out


def _merge_script_settings(existing: dict, incoming: dict[str, Any]) -> dict:
    merged = dict(existing)
    for key, value in incoming.items():
        current = existing.get(key, None)
        if key in existing and _clip_setting(current) == value:
            continue
        if isinstance(current, bool):
            if not isinstance(value, bool):
                raise ValueError(f"{key} must be on or off")
            merged[key] = value
            continue
        if isinstance(current, int) and not isinstance(current, bool):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{key} must be a whole number")
            if isinstance(value, float) and not value.is_integer():
                raise ValueError(f"{key} must be a whole number")
            merged[key] = int(value)
            continue
        if isinstance(current, float):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{key} must be a number")
            merged[key] = float(value)
            continue
        merged[key] = value
    return merged


def _omega_target(config: dict) -> dict:
    omega = config.get("omega")
    if isinstance(omega, dict):
        return omega
    return config


def _apply_script_config(raw: dict, script_id: int | None, name_hint: str, incoming: dict[str, Any]) -> dict:
    config = _member_configuration(raw)
    target = _omega_target(config)
    if not isinstance(target, dict):
        raise ValueError("Cloud configuration is invalid")
    installed = _installed_script_name(raw, script_id)
    key = _find_omega_script_key(target, installed, name_hint)
    if key is None:
        label = installed or name_hint or "script"
        raise ValueError(f"Could not find {label} in cloud config")
    current = target.get(key)
    if not isinstance(current, dict):
        current = {}
    target[key] = _merge_script_settings(current, incoming)
    return config


def _encyclopedia_state(force: bool = False) -> dict:
    with _ENCYCLOPEDIA_LOCK:
        now = time.time()
        if not force and _ENCYCLOPEDIA["items"] and now - _ENCYCLOPEDIA["at"] < ENCYCLOPEDIA_TTL:
            return {
                "items": _ENCYCLOPEDIA["items"],
                "library_ids": _ENCYCLOPEDIA["library_ids"],
            }
    try:
        items = _public_encyclopedia(_constelia_get("getEncyclopedia"))
    except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError, OSError, ValueError):
        with _ENCYCLOPEDIA_LOCK:
            return {
                "items": _ENCYCLOPEDIA["items"],
                "library_ids": _ENCYCLOPEDIA["library_ids"],
            }
    library_ids = {
        item["id"]
        for item in items
        if item.get("id") is not None and _is_library_category(item.get("category_names"))
    }
    with _ENCYCLOPEDIA_LOCK:
        _ENCYCLOPEDIA["at"] = time.time()
        _ENCYCLOPEDIA["items"] = items
        _ENCYCLOPEDIA["library_ids"] = library_ids
        return {
            "items": _ENCYCLOPEDIA["items"],
            "library_ids": _ENCYCLOPEDIA["library_ids"],
        }


def _safe_forum(url: object) -> str:
    forum = str(url or "")
    if forum.startswith(("https://", "http://")):
        return forum
    return ""


def _public_cloud_entry(entry: dict, encyclopedia: dict | None = None) -> dict | None:
    sid = _as_script_id(entry.get("id"))
    if sid is None:
        return None
    notes = str(entry.get("update_notes") or "").strip()
    if len(notes) > 500:
        notes = notes[:497] + "..."
    forum = ""
    categories = []
    if isinstance(encyclopedia, dict):
        forum = _safe_forum(encyclopedia.get("forums"))
        categories = list(encyclopedia.get("category_names") or [])
    if not forum:
        forum = _safe_forum(entry.get("forums"))
    return {
        "id": sid,
        "name": str(entry.get("name") or ""),
        "author": str(entry.get("author") or ""),
        "last_update": entry.get("last_update"),
        "update_notes": notes,
        "forums": forum,
        "category_names": categories,
    }


def _split_installed_scripts(raw: dict) -> tuple[list[dict], list[dict]]:
    data = raw.get("scripts_data")
    if not isinstance(data, dict):
        data = {}
    state = _encyclopedia_state()
    index = {
        item["id"]: item
        for item in state["items"]
        if item.get("id") is not None
    }
    library_ids = state["library_ids"]
    scripts: list[dict] = []
    libs: list[dict] = []
    for entry in data.values():
        if not isinstance(entry, dict):
            continue
        sid = _as_script_id(entry.get("id"))
        item = _public_cloud_entry(entry, index.get(sid) if sid is not None else None)
        if not item:
            continue
        if item["id"] in library_ids:
            libs.append(item)
        else:
            scripts.append(item)
    omega = _omega_configs(raw)
    used = set()

    def apply_omega(item: dict) -> dict:
        key = str(item.get("name") or "").strip().lower()
        cfg = omega.get(key)
        if cfg:
            used.add(key)
            item["enabled"] = cfg["enabled"]
            item["settings"] = cfg["settings"]
        return item

    encyclopedia_names = {
        str(item.get("name") or "").strip().lower()
        for item in state["items"]
        if str(item.get("name") or "").strip()
    }
    scripts = [apply_omega(item) for item in scripts]
    libs = [apply_omega(item) for item in libs]
    for cfg in omega.values():
        key = str(cfg["name"]).strip().lower()
        if key in used or key in encyclopedia_names:
            continue
        scripts.append({
            "name": cfg["name"],
            "id": None,
            "author": "",
            "last_update": None,
            "update_notes": "",
            "forums": "",
            "category_names": [],
            "enabled": cfg["enabled"],
            "settings": cfg["settings"],
        })
    scripts.sort(key=lambda item: (
        0 if item.get("id") is None else 1,
        item["name"].lower(),
    ))
    libs.sort(key=lambda item: (item["id"], item["name"].lower()))
    users = _community_users()
    if users:
        scripts = [_stamp_script_users(item, users) for item in scripts]
        libs = [_stamp_script_users(item, users) for item in libs]
    return scripts, libs


PROTECTION_NAMES = {
    0: "Standard (usermode)",
    1: "IPC/Zombie",
    2: "Kernel Mode Protection",
    3: "Minimum (Usermode)",
    4: "Minimum (Kernel)",
    5: "Rootlink",
}


def _public_member(raw: dict) -> dict:
    try:
        level = int(raw.get("protection"))
    except (TypeError, ValueError):
        level = None
    if level not in PROTECTION_NAMES:
        level = None
    name = str(raw.get("protection_name") or "").strip()
    if not name and level is not None:
        name = PROTECTION_NAMES[level]
    scripts, libs = _split_installed_scripts(raw)
    directory = _remember_omega_dir(_member_directory_value(raw))
    return {
        "username": str(raw.get("username") or ""),
        "avatar": _safe_avatar(raw.get("avatar")),
        "unread_conversations": int(raw.get("unread_conversations") or 0),
        "unread_alerts": int(raw.get("unread_alerts") or 0),
        "protection": level,
        "protection_name": name,
        "directory": directory,
        "steam64": _member_steam64(raw),
        "scripts": scripts,
        "libs": libs,
    }


def _prime_omega_dir() -> None:
    global _OMEGA_DIR, _MEMBER_DIR
    telemetry.load_omega_root()
    try:
        if _secret("constelia"):
            _public_member(_constelia_post("getMember", {"include_hidden": ""}))
    except (FileNotFoundError, OSError, ValueError, urllib.error.URLError, json.JSONDecodeError):
        pass
    if _OMEGA_DIR is not None and _looks_like_omega_root(_OMEGA_DIR):
        return
    root = telemetry.omega_root()
    if root and _looks_like_omega_root(root):
        _OMEGA_DIR = root
        return
    if root and _looks_like_omega_root(root / "omega"):
        if _MEMBER_DIR is None:
            declared = _omega_dir_from_value(root)
            if declared:
                _MEMBER_DIR = declared
        _remember_omega_dir(str(root / "omega"), from_member=False)
        return
    _ensure_omega_dir()


def _omega_dir_from_value(value: object) -> Path | None:
    text = str(value or "").strip().strip('"')
    if not text:
        return None
    try:
        path = Path(text).expanduser().resolve()
    except (OSError, RuntimeError):
        return None
    if not path.is_dir():
        return None
    return path


def _same_fs_path(left: Path | None, right: Path | None) -> bool:
    if left is None or right is None:
        return False
    try:
        return os.path.normcase(str(left.resolve())) == os.path.normcase(str(right.resolve()))
    except (OSError, RuntimeError):
        return False


def _looks_like_omega_root(path: Path | None) -> bool:
    return telemetry.looks_like_omega_install(path)


def _is_omega_payload_home(path: Path | None) -> bool:
    """Constellation root (earthbound + random 8-char exe) or nested omega/."""
    if path is None:
        return False
    try:
        base = Path(path).expanduser().resolve()
    except (OSError, RuntimeError):
        return False
    if _looks_like_omega_root(base) or _looks_like_omega_root(base / "omega"):
        return True
    if _omega_launcher(base) is not None:
        return True
    if _MEMBER_DIR is not None and _same_fs_path(base, _MEMBER_DIR):
        return True
    if _OMEGA_DIR is not None and _same_fs_path(base, _OMEGA_DIR.parent):
        return True
    return False


def _dev_omega_fallback() -> Path | None:
    fallback = APP_DIR.parent / "omega"
    return fallback if _looks_like_omega_root(fallback) else None


def _resolve_declared_omega_root(value: object) -> Path | None:
    path = _omega_dir_from_value(value)
    if path is None:
        return None
    chain = [path / "omega", path]
    name = path.name.lower()
    if name in {"resources", "scripts", "omegadash"}:
        chain.append(path.parent)
        chain.append(path.parent / "omega")
        if name == "omegadash":
            chain.append(path.parent.parent)
            chain.append(path.parent.parent / "omega")
    seen: set[str] = set()
    for cand in chain:
        try:
            resolved = cand.resolve()
        except (OSError, RuntimeError):
            continue
        key = os.path.normcase(str(resolved))
        if key in seen:
            continue
        seen.add(key)
        if _looks_like_omega_root(resolved):
            return resolved
    return None


def _member_directory_value(raw: dict) -> object:
    for key in (
        "directory",
        "dir",
        "path",
        "omega_directory",
        "install_directory",
        "session_directory",
        "sessions_directory",
    ):
        value = raw.get(key)
        if value:
            return value
    for nest in ("member", "user", "omega", "session"):
        block = raw.get(nest)
        if isinstance(block, dict):
            for key in ("directory", "dir", "path", "session_directory"):
                value = block.get(key)
                if value:
                    return value
    return None


def _remember_omega_dir(value: object, *, from_member: bool = True) -> str:
    global _OMEGA_DIR, _MEMBER_DIR
    declared = _omega_dir_from_value(value)
    if declared and from_member:
        previous = _MEMBER_DIR
        _MEMBER_DIR = declared
        path = _resolve_declared_omega_root(value)
        if path:
            _OMEGA_DIR = path
            telemetry.set_omega_root(path)
        elif previous is None or not _same_fs_path(previous, declared):
            nested = declared / "omega"
            target = nested if nested.is_dir() else declared
            _OMEGA_DIR = target
            telemetry.set_omega_root(target)
        return str(_MEMBER_DIR or _OMEGA_DIR or "")
    path = _resolve_declared_omega_root(value)
    if path:
        _OMEGA_DIR = path
        telemetry.set_omega_root(path)
    elif _OMEGA_DIR is None:
        loaded = telemetry.omega_root()
        if loaded:
            _OMEGA_DIR = loaded
    return str(_MEMBER_DIR or _OMEGA_DIR or "")


def _omega_launcher(root: Path | None) -> Path | None:
    if root is None:
        return None
    try:
        base = root.resolve()
        exe = (base / OMEGA_EXE_NAME).resolve()
    except (OSError, RuntimeError):
        return None
    if exe.name.lower() != OMEGA_EXE_NAME.lower() or not exe.is_file():
        return None
    try:
        exe.relative_to(base)
    except ValueError:
        return None
    return exe


def _iter_omega_search_roots() -> list[Path]:
    roots: list[Path] = []
    seen: set[str] = set()

    def add(item: Path | None) -> None:
        if item is None:
            return
        try:
            path = Path(item).expanduser().resolve()
        except (OSError, RuntimeError):
            return
        if not path.is_dir():
            return
        key = str(path).lower()
        if key in seen:
            return
        seen.add(key)
        roots.append(path)

    add(_OMEGA_DIR)
    add(_MEMBER_DIR)
    add(telemetry.omega_root())
    if _OMEGA_DIR is not None:
        add(_OMEGA_DIR / "omega")
        add(_OMEGA_DIR.parent)
        exe = _omega_launcher(_OMEGA_DIR)
        add(exe.parent if exe else None)
    if _MEMBER_DIR is not None:
        add(_MEMBER_DIR / "omega")
    add(_dev_omega_fallback())
    for home in _running_omega_homes():
        add(home)
        add(home / "omega")
    return roots


def _resolve_omega_launcher() -> Path | None:
    _ensure_omega_dir()
    for root in _iter_omega_search_roots():
        exe = _omega_launcher(root)
        if exe:
            return exe
        nested = _omega_launcher(root / "omega")
        if nested:
            return nested
    return None


LAST_SESSION_LOG = "0000-00-00 (last_session).txt"
LOG_MAX_BYTES = 8_000_000


def _last_session_log() -> Path | None:
    _ensure_omega_dir()
    for root in _iter_omega_search_roots():
        for rel in (Path("logs") / LAST_SESSION_LOG, Path("omega") / "logs" / LAST_SESSION_LOG):
            candidate = root / rel
            if candidate.is_file():
                return candidate
        for folder in (root / "logs", root / "omega" / "logs"):
            if not folder.is_dir():
                continue
            matches = sorted(
                (p for p in folder.glob("*last_session*.txt") if p.is_file() and "errors" not in p.parts),
                key=lambda item: item.stat().st_mtime,
                reverse=True,
            )
            if matches:
                return matches[0]
    return None


_RANDOM_OMEGA_EXE = re.compile(r"^[a-z0-9]{8}\.exe$", re.I)
ROOTLINK_PENDING = "rootlink successfully launched, but execution is still pending"
ROOTLINK_NO_TITLE = "no officially supported title found"
OMEGA_SESSION_START = "omega launched at"
ROOTLINK_STALL_S = 1.0
ROOTLINK_RESTART_WINDOW_S = 15 * 60
ROOTLINK_RESTART_MAX = 3
_WATCH_LOCK = threading.Lock()
_WATCH_NOTICE = ""
_WATCH_STOP = threading.Event()


if sys.platform == "win32":
    class _PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_void_p),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]


def _ui_flag(name: str, default: bool = True) -> bool:
    try:
        raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return default
    if not isinstance(raw, dict) or name not in raw:
        return default
    return bool(raw.get(name))


def _set_watch_notice(message: str) -> None:
    global _WATCH_NOTICE
    with _WATCH_LOCK:
        _WATCH_NOTICE = message


def _take_watch_notice() -> str:
    global _WATCH_NOTICE
    with _WATCH_LOCK:
        message = _WATCH_NOTICE
        _WATCH_NOTICE = ""
        return message


def _process_image_path(pid: int) -> Path | None:
    if sys.platform != "win32" or pid <= 0:
        return None
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    ]
    kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        handle = kernel32.OpenProcess(0x0400, False, pid)
    if not handle:
        return None
    try:
        size = wintypes.DWORD(32768)
        buf = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return None
        try:
            return Path(buf.value).expanduser().resolve()
        except (OSError, RuntimeError):
            return None
    finally:
        kernel32.CloseHandle(handle)


def _running_omega_homes() -> list[Path]:
    if sys.platform != "win32":
        return []
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]
    kernel32.Process32FirstW.restype = wintypes.BOOL
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]
    kernel32.Process32NextW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    snap = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    if not snap or snap == wintypes.HANDLE(-1).value:
        return []
    homes: list[Path] = []
    seen: set[str] = set()
    try:
        entry = _PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
        more = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while more:
            name = (entry.szExeFile or "").lower()
            pid = int(entry.th32ProcessID)
            if pid > 0 and pid != os.getpid() and (_is_named_omega(name) or _RANDOM_OMEGA_EXE.match(name)):
                image = _process_image_path(pid)
                if image is not None:
                    home = image.parent
                    if _is_named_omega(name) or _is_omega_payload_home(home):
                        key = str(home).lower()
                        if key not in seen:
                            seen.add(key)
                            homes.append(home)
            more = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return homes


def _ensure_omega_dir() -> Path | None:
    global _OMEGA_DIR
    if _OMEGA_DIR is not None:
        try:
            if _looks_like_omega_root(_OMEGA_DIR):
                return _OMEGA_DIR
            nested = _OMEGA_DIR / "omega"
            if _looks_like_omega_root(nested):
                _remember_omega_dir(str(nested), from_member=False)
                return _OMEGA_DIR
        except OSError:
            _OMEGA_DIR = None
    loaded = telemetry.omega_root()
    if loaded and _looks_like_omega_root(loaded):
        _OMEGA_DIR = loaded
        return loaded
    if loaded and _looks_like_omega_root(loaded / "omega"):
        _remember_omega_dir(str(loaded / "omega"), from_member=False)
        return _OMEGA_DIR
    for home in _running_omega_homes():
        if _MEMBER_DIR is not None:
            break
        _remember_omega_dir(str(home), from_member=False)
        if _OMEGA_DIR is not None and _looks_like_omega_root(_OMEGA_DIR):
            return _OMEGA_DIR
    return _OMEGA_DIR


def _terminate_pid(pid: int) -> bool:
    if sys.platform != "win32" or pid <= 0 or pid == os.getpid():
        return False
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.TerminateProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel32.OpenProcess(0x0001, False, pid)
    if handle:
        try:
            if kernel32.TerminateProcess(handle, 1):
                return True
        finally:
            kernel32.CloseHandle(handle)
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        result = subprocess.run(
            ["taskkill", "/F", "/PID", str(pid)],
            capture_output=True,
            timeout=5,
            creationflags=flags,
        )
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _omega_payload_dirs() -> list[Path]:
    dirs: list[Path] = []
    seen: set[str] = set()

    def add(item: Path | None) -> None:
        if item is None:
            return
        try:
            path = item.expanduser().resolve()
        except (OSError, RuntimeError):
            return
        key = str(path).lower()
        if key in seen or not path.is_dir():
            return
        seen.add(key)
        dirs.append(path)

    add(_OMEGA_DIR)
    add(_MEMBER_DIR)
    add(telemetry.omega_root())
    add(_dev_omega_fallback())
    if _OMEGA_DIR is not None:
        add(_OMEGA_DIR.parent)
        exe = _omega_launcher(_OMEGA_DIR)
        add(exe.parent if exe else None)
        parent_exe = _omega_launcher(_OMEGA_DIR.parent)
        add(parent_exe.parent if parent_exe else None)
        add(_OMEGA_DIR / "omega")
    if _MEMBER_DIR is not None:
        add(_MEMBER_DIR / "omega")
        exe = _omega_launcher(_MEMBER_DIR)
        add(exe.parent if exe else None)
    return dirs


def _is_named_omega(name: str) -> bool:
    n = name.lower()
    if n in {OMEGA_EXE_NAME.lower(), "fantasy.omega.exe"}:
        return True
    return n.startswith("fantasy.") and n.endswith(".exe") and "troubleshooter" not in n


def _is_random_omega_payload(name: str, image: Path | None, payload_dirs: list[Path]) -> bool:
    if not _RANDOM_OMEGA_EXE.match(name):
        return False
    parent = None
    if image is not None:
        try:
            parent = image.parent.resolve()
        except (OSError, RuntimeError):
            parent = None
        if parent is not None and _is_omega_payload_home(parent):
            return True
        if parent is not None and any(_same_fs_path(parent, folder) for folder in payload_dirs):
            return True
    stem = Path(name)
    return any((folder / stem).is_file() for folder in payload_dirs)


def _omega_runtime() -> dict[str, Any]:
    empty = {"pids": [], "payload": False, "named": False, "running": False}
    if sys.platform != "win32":
        return empty
    _ensure_omega_dir()
    payload_dirs = _omega_payload_dirs()
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]
    kernel32.Process32FirstW.restype = wintypes.BOOL
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_PROCESSENTRY32W)]
    kernel32.Process32NextW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    snap = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    if not snap or snap == wintypes.HANDLE(-1).value:
        return empty
    pids: list[int] = []
    payload = False
    named = False
    try:
        entry = _PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
        more = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while more:
            name = (entry.szExeFile or "").lower()
            pid = int(entry.th32ProcessID)
            if pid > 0 and pid != os.getpid() and (_is_named_omega(name) or _RANDOM_OMEGA_EXE.match(name)):
                image = _process_image_path(pid)
                is_named = _is_named_omega(name)
                is_payload = _is_random_omega_payload(name, image, payload_dirs)
                keep = False
                if is_named:
                    keep = True
                    if image is not None and _MEMBER_DIR is None and _is_omega_payload_home(image.parent):
                        _remember_omega_dir(str(image.parent), from_member=False)
                        payload_dirs = _omega_payload_dirs()
                        is_payload = _is_random_omega_payload(name, image, payload_dirs)
                elif is_payload:
                    keep = True
                    if image is not None and _MEMBER_DIR is None and _is_omega_payload_home(image.parent):
                        _remember_omega_dir(str(image.parent), from_member=False)
                if keep:
                    pids.append(pid)
                    if is_payload:
                        payload = True
                    if is_named:
                        named = True
            more = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return {"pids": pids, "payload": payload, "named": named, "running": bool(pids)}


def _omega_process_pids() -> list[int]:
    return _omega_runtime()["pids"]


def _stop_omega_processes() -> int:
    stopped = 0
    for pid in _omega_process_pids():
        if _terminate_pid(pid):
            stopped += 1
    return stopped


def _spawn_omega() -> str | None:
    exe = _resolve_omega_launcher()
    if not exe:
        return "fantasy.earthbound.exe was not found"
    kwargs: dict[str, Any] = {
        "args": [str(exe)],
        "cwd": str(exe.parent),
        "close_fds": True,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if sys.platform == "win32":
        kwargs["creationflags"] = (
            subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        )
    subprocess.Popen(**kwargs)
    return None


def _restart_omega_after_stall() -> str:
    _stop_omega_processes()
    time.sleep(1.2)
    error = _spawn_omega()
    if error:
        return error
    return ""


def _rootlink_watch_loop() -> None:
    offset = 0
    log_path = ""
    saw_pending = False
    saw_no_title = False
    stall_from = 0.0
    handled = False
    capped_notice = False
    restarts: list[float] = []
    while not _WATCH_STOP.wait(0.8):
        if not _ui_flag("omegaRestartOnStall", True):
            offset = 0
            saw_pending = False
            saw_no_title = False
            stall_from = 0.0
            handled = False
            capped_notice = False
            continue
        path = _last_session_log()
        if path is None or not path.is_file():
            continue
        key = str(path)
        try:
            size = path.stat().st_size
        except OSError:
            continue
        if key != log_path or size < offset:
            log_path = key
            offset = 0
            saw_pending = False
            saw_no_title = False
            stall_from = 0.0
            handled = False
        try:
            with path.open("rb") as fh:
                fh.seek(offset)
                raw = fh.read()
                offset = fh.tell()
        except OSError:
            continue
        text = raw.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
        grew = False
        for line in text.split("\n"):
            if OMEGA_SESSION_START in line:
                saw_pending = False
                saw_no_title = False
                stall_from = 0.0
                handled = False
                capped_notice = False
            if ROOTLINK_PENDING in line:
                saw_pending = True
            if ROOTLINK_NO_TITLE in line and saw_pending:
                saw_no_title = True
                stall_from = time.time()
            elif saw_no_title and line.strip() and ROOTLINK_NO_TITLE not in line:
                saw_no_title = False
                stall_from = 0.0
            if line.strip():
                grew = True
        if grew and not saw_no_title:
            stall_from = 0.0
        if handled or not (saw_pending and saw_no_title and stall_from):
            continue
        if time.time() - stall_from < ROOTLINK_STALL_S:
            continue
        try:
            fresh = time.time() - path.stat().st_mtime < 90
        except OSError:
            fresh = False
        if not _omega_process_pids() and not fresh:
            handled = True
            continue
        now = time.time()
        restarts = [stamp for stamp in restarts if now - stamp < ROOTLINK_RESTART_WINDOW_S]
        if len(restarts) >= ROOTLINK_RESTART_MAX:
            if not capped_notice:
                _set_watch_notice("Omega stalled 3 times — not relaunching again yet")
                capped_notice = True
            handled = True
            continue
        handled = True
        error = _restart_omega_after_stall()
        restarts.append(now)
        _set_watch_notice("Could not relaunch Omega" if error else "Omega stalled — relaunching")


def _refresh_stale_csfloat_prices() -> None:
    cached = _load_inventory_result()
    if not isinstance(cached, dict):
        return
    items = cached.get("items") if isinstance(cached.get("items"), list) else []
    if items:
        _queue_csfloat_from_items(items)


def _value_watch_loop() -> None:
    while not _WATCH_STOP.is_set() and not _QUIT_STARTED:
        try:
            _refresh_stale_csfloat_prices()
            _maybe_record_inventory_value()
        except Exception:
            pass
        if _WATCH_STOP.wait(60):
            return


def _start_rootlink_watch() -> None:
    threading.Thread(target=_rootlink_watch_loop, name="omega-rootlink-watch", daemon=True).start()
    threading.Thread(target=_value_watch_loop, name="omega-value-watch", daemon=True).start()


def _constelia_query(params: dict) -> str:
    parts = []
    for name, value in params.items():
        key = urllib.parse.quote_plus(str(name))
        if value is None or value == "":
            parts.append(key)
        else:
            parts.append(f"{key}={urllib.parse.quote_plus(str(value))}")
    return "&".join(parts)


def _constelia_failure(raw: dict) -> str | None:
    if raw.get("success") is True:
        return None
    if raw.get("error"):
        return str(raw.get("error"))
    if raw.get("success") is False:
        return str(raw.get("message") or "Constelia request failed")
    if raw.get("message") and not raw.get("steam") and not raw.get("username"):
        return str(raw.get("message"))
    return None


def _constelia_post(
    cmd: str,
    extra_query: dict | None = None,
    extra_body: dict | None = None,
    *,
    lenient: bool = False,
) -> dict:
    key = _constelia_key()
    if not key:
        raise ValueError("Constelia API key is empty")
    params = {"cmd": cmd}
    if extra_query:
        params.update(extra_query)
    url = f"{CONSTELIA_API}?{_constelia_query(params)}"
    payload = {"key": key}
    if extra_body:
        for name, value in extra_body.items():
            if value is None:
                continue
            payload[str(name)] = "" if value == "" else str(value)
    body = urllib.parse.urlencode(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = json.loads(response.read().decode("utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("Unexpected Constelia response")
    err = _constelia_failure(raw)
    if err and not (lenient and raw.get("success") is not False and not raw.get("error")):
        raise ValueError(err)
    return raw


def _constelia_get(cmd: str) -> dict:
    url = f"{CONSTELIA_API}?cmd={urllib.parse.quote_plus(cmd)}"
    request = urllib.request.Request(
        url,
        method="GET",
        headers={"User-Agent": "OmegaDash/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = json.loads(response.read().decode("utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("Unexpected Constelia response")
    if raw.get("success") is False:
        raise ValueError(str(raw.get("message") or raw.get("error") or "Constelia request failed"))
    if raw.get("error") and "scripts" not in raw:
        raise ValueError(str(raw.get("error")))
    return raw


def _public_encyclopedia(raw: dict) -> list[dict]:
    scripts = raw.get("scripts")
    if not isinstance(scripts, list):
        return []
    items = []
    for entry in scripts:
        if not isinstance(entry, dict):
            continue
        categories = []
        seen = set()
        for name in entry.get("category_names") or []:
            text = str(name or "").strip()
            if not text or text in seen:
                continue
            seen.add(text)
            categories.append(text)
        forum = _safe_forum(entry.get("forums"))
        notes = str(entry.get("update_notes") or entry.get("notes") or "").strip()
        if len(notes) > 500:
            notes = notes[:497] + "..."
        try:
            sid = int(entry.get("id"))
        except (TypeError, ValueError):
            sid = None
        items.append({
            "id": sid,
            "name": str(entry.get("name") or ""),
            "author": str(entry.get("author") or ""),
            "last_update": entry.get("last_update"),
            "update_notes": notes,
            "forums": forum,
            "category_names": categories,
        })
    items.sort(key=lambda item: (
        (item["category_names"][0] if item["category_names"] else "\uffff").lower(),
        item["name"].lower(),
    ))
    return items


def _parse_script_users(raw: object) -> dict[int, int]:
    blob = raw.get("script_users") if isinstance(raw, dict) else None
    if not isinstance(blob, dict):
        return {}
    out: dict[int, int] = {}
    for key, value in blob.items():
        sid = _as_script_id(key)
        if sid is None:
            continue
        try:
            count = int(value)
        except (TypeError, ValueError):
            continue
        if count >= 0:
            out[sid] = count
    return out


def _stamp_script_users(item: dict, users: dict[int, int]) -> dict:
    sid = _as_script_id(item.get("id"))
    if sid is None or sid not in users:
        return item
    merged = dict(item)
    merged["users"] = users[sid]
    return merged


def _community_script_meta(force: bool = False) -> dict[int, dict[str, Any]]:
    """Map cloud script id -> notes/author. Drops full source from getCommunity."""
    with _COMMUNITY_LOCK:
        now = time.time()
        if not force and _COMMUNITY["at"] and now - _COMMUNITY["at"] < COMMUNITY_TTL:
            return _COMMUNITY["by_id"]
    try:
        raw = _constelia_post("getCommunity")
    except (FileNotFoundError, urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError, OSError, ValueError):
        with _COMMUNITY_LOCK:
            return _COMMUNITY["by_id"]
    by_id: dict[int, dict[str, Any]] = {}
    scripts = raw.get("scripts") if isinstance(raw, dict) else None
    if isinstance(scripts, list):
        for entry in scripts:
            if not isinstance(entry, dict):
                continue
            sid = _as_script_id(entry.get("id"))
            if sid is None:
                continue
            notes = str(entry.get("update_notes") or "").strip()
            if len(notes) > 4000:
                notes = notes[:3997] + "..."
            by_id[sid] = {
                "update_notes": notes,
                "author": str(entry.get("author") or ""),
                "last_update": entry.get("last_update"),
            }
    users = _parse_script_users(raw)
    with _COMMUNITY_LOCK:
        _COMMUNITY["at"] = time.time()
        _COMMUNITY["by_id"] = by_id
        _COMMUNITY["users"] = users
        return by_id


def _community_users() -> dict[int, int]:
    _community_script_meta()
    with _COMMUNITY_LOCK:
        return dict(_COMMUNITY["users"])


def _with_community_notes(items: list[dict]) -> list[dict]:
    meta = _community_script_meta()
    users = _community_users()
    if not meta and not users:
        return items
    out = []
    for item in items:
        sid = _as_script_id(item.get("id"))
        extra = meta.get(sid) if sid is not None else None
        merged = dict(item) if extra or (sid is not None and sid in users) else item
        if extra:
            if extra.get("update_notes"):
                merged["update_notes"] = extra["update_notes"]
            if extra.get("author") and not merged.get("author"):
                merged["author"] = extra["author"]
            if merged.get("last_update") is None and extra.get("last_update") is not None:
                merged["last_update"] = extra["last_update"]
        if sid is not None and sid in users:
            merged["users"] = users[sid]
        out.append(merged)
    return out


WM_NCLBUTTONDOWN = 0x00A1
HTCAPTION = 2
HTLEFT = 10
HTRIGHT = 11
HTTOP = 12
HTTOPLEFT = 13
HTTOPRIGHT = 14
HTBOTTOM = 15
HTBOTTOMLEFT = 16
HTBOTTOMRIGHT = 17
SW_SHOWMINIMIZED = 2
SW_SHOWMAXIMIZED = 3
SW_MINIMIZE = 6
SW_SHOWMINNOACTIVE = 7
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_FRAMECHANGED = 0x0020
SWP_SHOWWINDOW = 0x0040
HWND_TOP = 0
MONITOR_DEFAULTTONEAREST = 2
DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWA_BORDER_COLOR = 34
DWMWCP_DEFAULT = 0
DWMWCP_DONOTROUND = 1
DWMWA_COLOR_NONE = 0xFFFFFFFE
DWMWA_COLOR_DEFAULT = 0xFFFFFFFF
RESIZE_HITS = {
    "n": HTTOP,
    "s": HTBOTTOM,
    "e": HTRIGHT,
    "w": HTLEFT,
    "ne": HTTOPRIGHT,
    "nw": HTTOPLEFT,
    "se": HTBOTTOMRIGHT,
    "sw": HTBOTTOMLEFT,
}


class _POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_int), ("y", ctypes.c_int)]


class _RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_int),
        ("top", ctypes.c_int),
        ("right", ctypes.c_int),
        ("bottom", ctypes.c_int),
    ]


class _WINDOWPLACEMENT(ctypes.Structure):
    _fields_ = [
        ("length", ctypes.c_uint),
        ("flags", ctypes.c_uint),
        ("showCmd", ctypes.c_uint),
        ("ptMinPosition", _POINT),
        ("ptMaxPosition", _POINT),
        ("rcNormalPosition", _RECT),
    ]


class _MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_uint),
        ("rcMonitor", _RECT),
        ("rcWork", _RECT),
        ("dwFlags", ctypes.c_uint),
    ]


def _app_window() -> webview.Window | None:
    return webview.windows[0] if webview.windows else None


def _native_form():
    return getattr(_app_window(), "native", None)


def _hwnd() -> int | None:
    handle = getattr(_native_form(), "Handle", None)
    if handle is None:
        return None
    try:
        if hasattr(handle, "ToInt32"):
            return int(handle.ToInt32())
        if hasattr(handle, "ToInt64"):
            return int(handle.ToInt64())
        return int(handle)
    except (TypeError, ValueError, OverflowError, AttributeError):
        return None


def _run_on_ui(fn) -> None:
    form = _native_form()
    if form is not None:
        try:
            from System.Windows.Forms import MethodInvoker

            form.BeginInvoke(MethodInvoker(fn))
            return
        except Exception:
            pass
    fn()


def _nchit(hit: int) -> dict:
    if sys.platform != "win32":
        return {"ok": False}
    hwnd = _hwnd()
    if not hwnd:
        return {"ok": False}

    def _run() -> None:
        ctypes.windll.user32.ReleaseCapture()
        ctypes.windll.user32.SendMessageW(hwnd, WM_NCLBUTTONDOWN, hit, 0)

    _run_on_ui(_run)
    return {"ok": True}


def _hide_native_caption() -> None:
    """Keep the DWM shadow, but don't draw a light Windows caption strip."""
    _run_on_ui(_apply_window_chrome)


def _window_placement() -> _WINDOWPLACEMENT | None:
    if sys.platform != "win32":
        return None
    hwnd = _hwnd()
    if not hwnd:
        return None
    place = _WINDOWPLACEMENT()
    place.length = ctypes.sizeof(_WINDOWPLACEMENT)
    if not ctypes.windll.user32.GetWindowPlacement(hwnd, ctypes.byref(place)):
        return None
    return place


def _monitor_info(hwnd: int) -> _MONITORINFO | None:
    if sys.platform != "win32":
        return None
    user32 = ctypes.windll.user32
    monitor = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
    if not monitor:
        return None
    info = _MONITORINFO()
    info.cbSize = ctypes.sizeof(_MONITORINFO)
    if not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
        return None
    return info


_fitting_max = False
_fullscreen_chrome = False


def _dwm_set_int(hwnd: int, attr: int, value: int) -> None:
    dwmapi = ctypes.windll.dwmapi
    dwmapi.DwmSetWindowAttribute.argtypes = [
        wintypes.HWND,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    number = ctypes.c_int(value)
    dwmapi.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(number), 4)


def _mark_taskbar_fullscreen(hwnd: int, enabled: bool) -> None:
    """Tell Explorer this window is fullscreen so the taskbar hides."""
    if sys.platform != "win32" or not hwnd:
        return

    class GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", ctypes.c_uint32),
            ("Data2", ctypes.c_uint16),
            ("Data3", ctypes.c_uint16),
            ("Data4", ctypes.c_ubyte * 8),
        ]

    def guid(d1: int, d2: int, d3: int, d4: tuple[int, ...]) -> GUID:
        value = GUID()
        value.Data1 = d1
        value.Data2 = d2
        value.Data3 = d3
        value.Data4[:] = d4
        return value

    clsid = guid(0x56FDF344, 0xFD6D, 0x11D0, (0x95, 0x8A, 0x00, 0x60, 0x97, 0xC9, 0xA0, 0x90))
    iid = guid(0x602D4995, 0xB13A, 0x429B, (0xA6, 0x6E, 0x19, 0x35, 0xE4, 0x4F, 0x43, 0x17))
    punk = ctypes.c_void_p()
    ole32 = ctypes.WinDLL("ole32")
    ole32.CoCreateInstance.restype = ctypes.HRESULT
    ole32.CoCreateInstance.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
    ]
    try:
        hr = ole32.CoCreateInstance(
            ctypes.byref(clsid),
            None,
            1,
            ctypes.byref(iid),
            ctypes.byref(punk),
        )
    except OSError:
        return
    if hr != 0 or not punk.value:
        return
    vptr = ctypes.cast(punk, ctypes.POINTER(ctypes.c_void_p))[0]
    vtbl = ctypes.cast(vptr, ctypes.POINTER(ctypes.c_void_p))
    hr_init = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p)(vtbl[3])
    mark = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, wintypes.HWND, wintypes.BOOL)(vtbl[8])
    release = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(vtbl[2])
    try:
        hr_init(punk)
        mark(punk, hwnd, enabled)
    except OSError:
        pass
    finally:
        release(punk)


def _set_borderless_fullscreen(hwnd: int | None, enabled: bool) -> None:
    global _fullscreen_chrome
    if sys.platform != "win32" or not hwnd:
        return
    if enabled == _fullscreen_chrome:
        return
    try:
        _dwm_set_int(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            DWMWCP_DONOTROUND if enabled else DWMWCP_DEFAULT,
        )
        _dwm_set_int(
            hwnd,
            DWMWA_BORDER_COLOR,
            DWMWA_COLOR_NONE if enabled else DWMWA_COLOR_DEFAULT,
        )
        _mark_taskbar_fullscreen(hwnd, enabled)
        _fullscreen_chrome = enabled
    except OSError:
        pass


def _apply_maximized_bounds() -> None:
    """Fit a maximized window to the monitor (fullscreen) or the work area."""
    global _fitting_max
    if sys.platform != "win32" or _fitting_max or _form_mode() != "maximized":
        return
    hwnd = _hwnd()
    if not hwnd:
        return
    info = _monitor_info(hwnd)
    if info is None:
        return
    fullscreen = _ui_flag("fullscreenMaximize", True)
    target = info.rcMonitor if fullscreen else info.rcWork
    user32 = ctypes.windll.user32
    current = _RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(current)):
        return
    width = target.right - target.left
    height = target.bottom - target.top
    already = (
        current.left == target.left
        and current.top == target.top
        and current.right == target.right
        and current.bottom == target.bottom
    )
    if not already:
        _fitting_max = True
        try:
            if not fullscreen:
                _set_borderless_fullscreen(hwnd, False)
            user32.SetWindowPos(
                hwnd,
                HWND_TOP,
                target.left,
                target.top,
                width,
                height,
                SWP_SHOWWINDOW | SWP_FRAMECHANGED,
            )
        finally:
            _fitting_max = False
    _set_borderless_fullscreen(hwnd, fullscreen)


def _apply_dwm_chrome() -> None:
    if sys.platform != "win32":
        return
    class _Margins(ctypes.Structure):
        _fields_ = [
            ("cxLeftWidth", ctypes.c_int),
            ("cxRightWidth", ctypes.c_int),
            ("cyTopHeight", ctypes.c_int),
            ("cyBottomHeight", ctypes.c_int),
        ]

    hwnd = _hwnd()
    if not hwnd:
        return
    dwmapi = ctypes.windll.dwmapi
    dark = ctypes.c_int(1)
    dwmapi.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(dark), 4)
    margins = _Margins(1, 1, 0, 1)
    dwmapi.DwmExtendFrameIntoClientArea(hwnd, ctypes.byref(margins))


def _apply_window_chrome() -> None:
    _apply_dwm_chrome()
    if _restore_maximized:
        win = _app_window()
        if win:
            win.maximize()
        _apply_maximized_bounds()


def _sync_geometry_from_hwnd() -> None:
    place = _window_placement()
    if place is None:
        return
    rc = place.rcNormalPosition
    width = max(MIN_WINDOW["width"], int(rc.right - rc.left))
    height = max(MIN_WINDOW["height"], int(rc.bottom - rc.top))
    with _geometry_lock:
        _geometry["x"] = int(rc.left)
        _geometry["y"] = int(rc.top)
        _geometry["width"] = width
        _geometry["height"] = height
        _geometry["maximized"] = place.showCmd == SW_SHOWMAXIMIZED


_geometry_lock = threading.Lock()
_geometry: dict = {}
_geometry_timer: threading.Timer | None = None
_restore_maximized = False


def _load_window_state() -> dict:
    try:
        parsed = json.loads(WINDOW_STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return dict(DEFAULT_WINDOW)
    if not isinstance(parsed, dict):
        return dict(DEFAULT_WINDOW)
    out = dict(DEFAULT_WINDOW)
    try:
        out["width"] = max(MIN_WINDOW["width"], int(parsed.get("width") or DEFAULT_WINDOW["width"]))
        out["height"] = max(MIN_WINDOW["height"], int(parsed.get("height") or DEFAULT_WINDOW["height"]))
    except (TypeError, ValueError):
        pass
    for key in ("x", "y"):
        try:
            out[key] = int(parsed[key])
        except (KeyError, TypeError, ValueError):
            pass
    out["maximized"] = bool(parsed.get("maximized"))
    return out


def _write_window_state() -> None:
    with _geometry_lock:
        data = dict(_geometry)
    try:
        WINDOW_STATE_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except OSError:
        pass


def _schedule_window_state() -> None:
    global _geometry_timer
    with _geometry_lock:
        if _geometry_timer is not None:
            _geometry_timer.cancel()
        _geometry_timer = threading.Timer(0.3, _write_window_state)
        _geometry_timer.daemon = True
        _geometry_timer.start()


def _form_mode() -> str:
    place = _window_placement()
    if place is not None:
        if place.showCmd in (SW_SHOWMINIMIZED, SW_MINIMIZE, SW_SHOWMINNOACTIVE):
            return "minimized"
        if place.showCmd == SW_SHOWMAXIMIZED:
            return "maximized"
        return "normal"
    state = str(getattr(_native_form(), "WindowState", "") or "")
    if state.endswith("Maximized"):
        return "maximized"
    if state.endswith("Minimized"):
        return "minimized"
    return "normal"


def _on_screen(x: int, y: int, width: int, height: int) -> bool:
    if sys.platform != "win32":
        return True
    user32 = ctypes.windll.user32
    vx = int(user32.GetSystemMetrics(76))
    vy = int(user32.GetSystemMetrics(77))
    vw = int(user32.GetSystemMetrics(78))
    vh = int(user32.GetSystemMetrics(79))
    return not (x + width < vx + 40 or y + 40 < vy or x > vx + vw - 40 or y > vy + vh - 40)


def _on_resized(width: int, height: int) -> None:
    if _form_mode() == "minimized":
        return
    if _form_mode() == "maximized":
        _apply_maximized_bounds()
    else:
        _set_borderless_fullscreen(_hwnd(), False)
    _sync_geometry_from_hwnd()
    _schedule_window_state()


def _on_moved(x: int, y: int) -> None:
    if _form_mode() == "minimized":
        return
    _sync_geometry_from_hwnd()
    _schedule_window_state()


def _hide_native_windows() -> None:
    if sys.platform != "win32":
        return
    user32 = ctypes.windll.user32
    for win in list(getattr(webview, "windows", None) or []):
        native = getattr(win, "native", None)
        handle = getattr(native, "Handle", None)
        if handle is None:
            continue
        try:
            if hasattr(handle, "ToInt32"):
                hwnd = int(handle.ToInt32())
            elif hasattr(handle, "ToInt64"):
                hwnd = int(handle.ToInt64())
            else:
                hwnd = int(handle)
        except (TypeError, ValueError, OverflowError, AttributeError):
            continue
        if hwnd:
            user32.ShowWindow(hwnd, 0)


def _kill_process() -> None:
    if sys.platform == "win32":
        try:
            ctypes.windll.kernel32.TerminateProcess(ctypes.windll.kernel32.GetCurrentProcess(), 0)
        except Exception:
            pass
    os._exit(0)


def _request_quit() -> None:
    """Hide immediately, then kill the process off the WebView/UI thread.

    Calling os._exit from the close/JS-API thread lets WebView2 unwind on that
    same thread, which takes seconds. TerminateProcess from a helper thread
    does not wait for Chromium teardown.
    """
    global _QUIT_STARTED
    with _QUIT_LOCK:
        if _QUIT_STARTED:
            return
        _QUIT_STARTED = True
    try:
        _hide_native_windows()
    except Exception:
        pass
    _WATCH_STOP.set()

    def _die() -> None:
        try:
            _write_window_state()
        except Exception:
            pass
        time.sleep(0.02)
        _kill_process()

    threading.Thread(target=_die, name="omega-exit", daemon=True).start()


def _on_closing() -> None:
    _request_quit()


def _on_closed() -> None:
    _request_quit()


class DashboardApi:
    """Small native bridge exposed to the dashboard as window.pywebview.api."""

    def __init__(self) -> None:
        self._maximized = False
        self._stat_modes: list[str] | None = None

    def _dashboard_state(self) -> dict:
        return telemetry.get_dashboard_state(self._stat_modes)

    def window_minimize(self) -> dict:
        win = _app_window()
        if win:
            win.minimize()
        return {"ok": True}

    def window_toggle_max(self) -> dict:
        win = _app_window()
        if not win:
            return {"ok": False, "maximized": False}
        if self._maximized:
            _set_borderless_fullscreen(_hwnd(), False)
            win.restore()
            self._maximized = False
        else:
            win.maximize()
            self._maximized = True
            _apply_maximized_bounds()
        _sync_geometry_from_hwnd()
        with _geometry_lock:
            _geometry["maximized"] = self._maximized
        _schedule_window_state()
        return {"ok": True, "maximized": self._maximized}

    def window_close(self) -> dict:
        _request_quit()
        return {"ok": True}

    def window_state(self) -> dict:
        self._maximized = _form_mode() == "maximized"
        return {"ok": True, "maximized": self._maximized}

    def window_begin_drag(self) -> dict:
        return _nchit(HTCAPTION)

    def launch_omega(self) -> dict:
        try:
            if _OMEGA_DIR is None:
                try:
                    _public_member(_constelia_post("getMember", {"include_hidden": ""}))
                except (FileNotFoundError, OSError, ValueError, urllib.error.URLError, json.JSONDecodeError):
                    pass
            runtime = _omega_runtime()
            relaunch = bool(runtime.get("payload") or runtime.get("named"))
            if relaunch:
                _stop_omega_processes()
                time.sleep(0.8)
            error = _spawn_omega()
            if error:
                return {"ok": False, "error": error, "relaunch": relaunch}
            return {"ok": True, "relaunch": relaunch}
        except OSError as exc:
            return {"ok": False, "error": str(exc) or "Could not launch Omega"}

    def omega_status(self) -> dict:
        runtime = _omega_runtime()
        return {
            "ok": True,
            "running": bool(runtime.get("payload") or runtime.get("named")),
            "payload": bool(runtime.get("payload")),
            "named": bool(runtime.get("named")),
        }

    def read_omega_log(self, payload: str = "") -> dict:
        try:
            parsed = json.loads(payload) if payload else {}
        except json.JSONDecodeError:
            parsed = {}
        if not isinstance(parsed, dict):
            parsed = {}
        try:
            offset = int(parsed.get("offset") or 0)
        except (TypeError, ValueError):
            offset = 0
        path = _last_session_log()
        if path is None:
            return {
                "ok": False,
                "error": "Omega folder was not found",
                "path": "",
                "offset": 0,
                "size": 0,
                "text": "",
                "reset": True,
            }
        if not path.is_file():
            return {
                "ok": False,
                "error": "Omega last-session log was not found",
                "path": str(path),
                "offset": 0,
                "size": 0,
                "text": "",
                "reset": True,
            }
        try:
            with path.open("rb") as fh:
                size = fh.seek(0, os.SEEK_END)
                reset = False
                start = offset
                if start < 0 or start > size:
                    start = 0
                    reset = True
                if start == 0 and size > LOG_MAX_BYTES:
                    start = size - LOG_MAX_BYTES
                    reset = True
                fh.seek(start)
                if start > 0:
                    fh.readline()
                raw = fh.read()
                new_offset = fh.tell()
        except OSError as exc:
            return {
                "ok": False,
                "error": str(exc) or "Could not read Omega log",
                "path": str(path),
                "offset": offset,
                "size": 0,
                "text": "",
                "reset": True,
            }
        text = raw.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
        return {
            "ok": True,
            "path": str(path),
            "offset": new_offset,
            "size": size,
            "text": text,
            "reset": reset,
            "truncated": start > 0,
            "omegaRestart": _take_watch_notice(),
        }

    def window_begin_resize(self, edge: str = "se") -> dict:
        hit = RESIZE_HITS.get(str(edge or "").lower())
        if not hit:
            return {"ok": False}
        return _nchit(hit)

    def export_data(self, payload: str) -> dict[str, str | bool]:
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            return {"ok": False, "error": "Invalid telemetry payload"}

        root = Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        filename = filedialog.asksaveasfilename(
            parent=root,
            title="Export telemetry",
            defaultextension=".json",
            filetypes=[("JSON telemetry", "*.json"), ("All files", "*.*")],
            initialfile="omegadash-export.json",
        )
        root.destroy()

        if not filename:
            return {"ok": False, "error": "cancelled"}

        Path(filename).write_text(json.dumps(parsed, indent=2), encoding="utf-8")
        return {"ok": True, "path": filename}

    def export_log(self, payload: str) -> dict[str, str | bool]:
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            return {"ok": False, "error": "Invalid log payload"}
        if not isinstance(parsed, dict):
            return {"ok": False, "error": "Invalid log payload"}
        kind = str(parsed.get("format") or "").strip().lower()
        content = parsed.get("content")
        if kind not in {"html", "txt"}:
            return {"ok": False, "error": "Invalid export format"}
        if not isinstance(content, str) or not content.strip():
            return {"ok": False, "error": "Nothing to export"}
        if len(content) > 40_000_000:
            return {"ok": False, "error": "Log is too large to export"}
        stamp = time.strftime("%Y-%m-%d")
        if kind == "html":
            title = "Export log (HTML)"
            ext = ".html"
            types = [("HTML log", "*.html"), ("All files", "*.*")]
            initial = f"omegadash-log-{stamp}.html"
        else:
            title = "Export log (text)"
            ext = ".txt"
            types = [("Text log", "*.txt"), ("All files", "*.*")]
            initial = f"omegadash-log-{stamp}.txt"

        root = Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        filename = filedialog.asksaveasfilename(
            parent=root,
            title=title,
            defaultextension=ext,
            filetypes=types,
            initialfile=initial,
        )
        root.destroy()

        if not filename:
            return {"ok": False, "error": "cancelled"}

        Path(filename).write_text(content, encoding="utf-8")
        return {"ok": True, "path": filename}

    def get_forum_widget(self) -> dict:
        try:
            return {"ok": True, "data": _public_widget(_constelia_post("getForumWidget"))}
        except FileNotFoundError:
            return {"ok": False, "error": "Constelia API key is not set"}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "error": _http_error_message(exc, "Could not load Constelia profile")}
        except urllib.error.URLError:
            return {"ok": False, "error": "Could not reach Constelia"}
        except json.JSONDecodeError:
            return {"ok": False, "error": "Constelia returned an invalid response"}
        except (OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc) or "Could not load Constelia profile"}

    def get_cs2_inventory(self, payload: str = "") -> dict:
        force = False
        if payload:
            try:
                parsed = json.loads(payload) if payload else {}
            except json.JSONDecodeError:
                parsed = {}
            if isinstance(parsed, dict):
                force = bool(parsed.get("force"))
        cached = _load_inventory_result()
        has_cache = isinstance(cached, dict) and isinstance(cached.get("items"), list)
        if not force:
            if has_cache:
                return _finish_inventory_api({"ok": True, "data": cached, "cached": True})
            return _finish_inventory_api({"ok": True, "data": None, "cached": True})
        remaining = _inventory_cooldown_left()
        if remaining > 0:
            err = _inventory_wait_error(remaining)
            if has_cache:
                return _finish_inventory_api({"ok": True, "data": cached, "cached": True, "notice": err})
            return _finish_inventory_api({"ok": False, "error": err})
        global _inventory_fetching
        with _INVENTORY_FETCH_LOCK:
            if _inventory_fetching:
                err = "Inventory is already loading. Wait for that request to finish."
                if has_cache:
                    return _finish_inventory_api({"ok": True, "data": cached, "cached": True, "notice": err})
                return _finish_inventory_api({"ok": False, "error": err})
            _inventory_fetching = True
        try:
            try:
                steamid = _resolve_self_steam64()
            except FileNotFoundError:
                return _finish_inventory_api({"ok": False, "error": "Add a Constelia API key in Settings first."})
            if not steamid:
                return _finish_inventory_api({"ok": False, "error": "No Steam ID on this Constelia account. Link Steam, then try again."})
            try:
                result = _fetch_cs2_inventory(steamid)
            except ValueError as exc:
                if has_cache:
                    return _finish_inventory_api({"ok": True, "data": cached, "cached": True, "notice": str(exc) or "Could not refresh inventory"})
                return _finish_inventory_api({"ok": False, "error": str(exc) or "Could not load CS2 inventory"})
            except urllib.error.HTTPError as exc:
                if exc.code == 429:
                    wait = _mark_inventory_cooldown()
                    err = _inventory_wait_error(wait)
                    if has_cache:
                        return _finish_inventory_api({"ok": True, "data": cached, "cached": True, "notice": err})
                    return _finish_inventory_api({"ok": False, "error": err})
                return _finish_inventory_api({"ok": False, "error": _http_error_message(exc, "Steam inventory request failed")})
            except urllib.error.URLError:
                return _finish_inventory_api({"ok": False, "error": "Could not reach Steam"})
            except json.JSONDecodeError:
                return _finish_inventory_api({"ok": False, "error": "Steam returned a page we could not read"})
            except OSError as exc:
                return _finish_inventory_api({"ok": False, "error": str(exc) or "Could not load CS2 inventory"})
            _clear_inventory_cooldown()
            try:
                _save_inventory_result(result)
            except OSError:
                pass
            return _finish_inventory_api({"ok": True, "data": result, "cached": False})
        finally:
            with _INVENTORY_FETCH_LOCK:
                _inventory_fetching = False

    def get_csfloat_prices(self) -> dict:
        cache = _load_csfloat_cache()
        with _CSFLOAT_LOCK:
            pending = len(_CSFLOAT_QUEUE)
            snapshot = dict(cache)
        prices = {
            name: _public_csfloat_row(row)
            for name, row in snapshot.items()
            if isinstance(row, dict)
        }
        if pending <= 0:
            _maybe_record_inventory_value()
        cached = _load_inventory_result()
        steam64 = str(cached.get("steam64") or "") if isinstance(cached, dict) else ""
        return {
            "ok": True,
            "data": {
                "prices": prices,
                "pending": pending,
                "hasKey": bool(_secret("csfloat")),
                "authError": bool(_CSFLOAT_AUTH_BAD),
                "value": _inventory_value_stats(
                    cached.get("items") if isinstance(cached, dict) and isinstance(cached.get("items"), list) else [],
                    snapshot,
                ),
                "history": _public_value_history(steam64),
            },
        }

    def get_inventory_value_history(self) -> dict:
        _maybe_record_inventory_value()
        cached = _load_inventory_result()
        steam64 = str(cached.get("steam64") or "") if isinstance(cached, dict) else ""
        cache = _load_csfloat_cache()
        items = cached.get("items") if isinstance(cached, dict) and isinstance(cached.get("items"), list) else []
        return {
            "ok": True,
            "data": {
                "value": _inventory_value_stats(items, cache),
                "history": _public_value_history(steam64),
            },
        }

    def read_packet_log(self, payload: str = "") -> dict:
        try:
            parsed = json.loads(payload) if payload else {}
        except json.JSONDecodeError:
            parsed = {}
        after = 0
        if isinstance(parsed, dict):
            try:
                after = int(parsed.get("after") or 0)
            except (TypeError, ValueError):
                after = 0
        try:
            return telemetry.read_packet_log(after)
        except (OSError, ValueError):
            return {"ok": False, "error": "Could not read packet log", "after": after, "text": "", "reset": True}

    def get_member(self) -> dict:
        try:
            return {
                "ok": True,
                "data": _public_member(_constelia_post("getMember", {"include_hidden": ""})),
            }
        except FileNotFoundError:
            return {"ok": False, "error": "Constelia API key is not set"}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "error": _http_error_message(exc, "Could not load Constelia member")}
        except urllib.error.URLError:
            return {"ok": False, "error": "Could not reach Constelia"}
        except json.JSONDecodeError:
            return {"ok": False, "error": "Constelia returned an invalid response"}
        except (OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc) or "Could not load Constelia member"}

    def get_encyclopedia(self) -> dict:
        try:
            items = _encyclopedia_state()["items"]
            if not items:
                items = _encyclopedia_state(force=True)["items"]
            if not items:
                return {"ok": False, "error": "Could not load cloud scripts"}
            return {"ok": True, "data": _with_community_notes(items)}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "error": _http_error_message(exc, "Could not load cloud scripts")}
        except urllib.error.URLError:
            return {"ok": False, "error": "Could not reach Constelia"}
        except json.JSONDecodeError:
            return {"ok": False, "error": "Constelia returned an invalid response"}
        except (OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc) or "Could not load cloud scripts"}

    def set_script(self, script_id: object) -> dict:
        sid = _as_script_id(script_id)
        if sid is None:
            return {"ok": False, "error": "Invalid script id"}
        try:
            _constelia_post("setMember", {"option": "script"}, {"id": str(sid)})
            return {
                "ok": True,
                "data": _public_member(
                    _constelia_post("getMember", {"needs_update": "", "include_hidden": ""})
                ),
            }
        except FileNotFoundError:
            return {"ok": False, "error": "Constelia API key is not set"}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "error": _http_error_message(exc, "Could not toggle script")}
        except urllib.error.URLError:
            return {"ok": False, "error": "Could not reach Constelia"}
        except json.JSONDecodeError:
            return {"ok": False, "error": "Constelia returned an invalid response"}
        except (OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc) or "Could not toggle script"}

    def set_script_config(self, payload: object) -> dict:
        if isinstance(payload, str):
            try:
                parsed = json.loads(payload)
            except json.JSONDecodeError:
                return {"ok": False, "error": "Invalid config"}
        elif isinstance(payload, dict):
            parsed = payload
        else:
            return {"ok": False, "error": "Invalid config"}
        if not isinstance(parsed, dict):
            return {"ok": False, "error": "Invalid config"}
        try:
            incoming = _incoming_settings(parsed.get("settings"))
            script_id = _as_script_id(parsed.get("id"))
            if script_id is None:
                key = str(parsed.get("key") or "")
                if key.startswith("id:"):
                    script_id = _as_script_id(key[3:])
            name_hint = str(parsed.get("name") or "")
            if not name_hint:
                key = str(parsed.get("key") or "")
                if key.startswith("name:"):
                    name_hint = key[5:]
            member = _constelia_post("getMember", {"include_hidden": ""})
            config = _apply_script_config(member, script_id, name_hint, incoming)
            blob = json.dumps(config, separators=(",", ":"), ensure_ascii=False)
            if len(blob.encode("utf-8")) > 500_000:
                return {"ok": False, "error": "Cloud configuration is too large"}
            _constelia_post(
                "setMember",
                {"option": "configuration", "sync": "", "needs_sync": ""},
                {"value": blob},
                lenient=True,
            )
            return {
                "ok": True,
                "data": _public_member(
                    _constelia_post("getMember", {"needs_update": "", "include_hidden": ""})
                ),
            }
        except FileNotFoundError:
            return {"ok": False, "error": "Constelia API key is not set"}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "error": _http_error_message(exc, "Could not save script config")}
        except urllib.error.URLError:
            return {"ok": False, "error": "Could not reach Constelia"}
        except json.JSONDecodeError:
            return {"ok": False, "error": "Constelia returned an invalid response"}
        except (OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc) or "Could not save script config"}

    def sync_member(self) -> dict:
        try:
            return {
                "ok": True,
                "data": _public_member(_constelia_post("getMember", {"needs_update": "", "include_hidden": ""})),
            }
        except FileNotFoundError:
            return {"ok": False, "error": "Constelia API key is not set"}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "error": _http_error_message(exc, "Could not sync Omega")}
        except urllib.error.URLError:
            return {"ok": False, "error": "Could not reach Constelia"}
        except json.JSONDecodeError:
            return {"ok": False, "error": "Constelia returned an invalid response"}
        except (OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc) or "Could not sync Omega"}

    def set_protection(self, level: object) -> dict:
        try:
            n = int(level)
        except (TypeError, ValueError):
            return {"ok": False, "error": "Invalid protection level"}
        if n not in PROTECTION_NAMES:
            return {"ok": False, "error": "Invalid protection level"}
        try:
            _constelia_post("setMember", {"option": "protection"}, {"level": str(n)})
            return {
                "ok": True,
                "data": {
                    "protection": n,
                    "protection_name": PROTECTION_NAMES[n],
                },
            }
        except FileNotFoundError:
            return {"ok": False, "error": "Constelia API key is not set"}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "error": _http_error_message(exc, "Could not set protection")}
        except urllib.error.URLError:
            return {"ok": False, "error": "Could not reach Constelia"}
        except json.JSONDecodeError:
            return {"ok": False, "error": "Constelia returned an invalid response"}
        except (OSError, ValueError) as exc:
            return {"ok": False, "error": str(exc) or "Could not set protection"}

    def open_forum(self, kind: str) -> dict[str, bool | str]:
        url = FORUM_LINKS.get(kind)
        if not url:
            return {"ok": False, "error": "Unknown forum link"}
        webbrowser.open(url)
        return {"ok": True}

    def open_url(self, url: str) -> dict:
        text = str(url or "").strip()
        parsed = urllib.parse.urlparse(text)
        if parsed.scheme not in {"http", "https", "steam"}:
            return {"ok": False, "error": "That link cannot be opened"}
        webbrowser.open(text)
        return {"ok": True}

    def get_api_keys(self) -> dict:
        return {"ok": True, "data": _api_key_status()}

    def save_api_keys(self, payload: str) -> dict:
        global _CSFLOAT_AUTH_BAD
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            return {"ok": False, "error": "Invalid keys"}
        if not isinstance(parsed, dict):
            return {"ok": False, "error": "Invalid keys"}
        if "csfloat" in parsed:
            _CSFLOAT_AUTH_BAD = False
        secrets = _load_secrets()
        for name in SECRET_NAMES:
            if name not in parsed:
                continue
            value = parsed.get(name)
            if value is None:
                continue
            text = str(value).strip()
            if name == "constelia" and text and len(text) < 560:
                return {
                    "ok": False,
                    "error": f"Constelia key looks truncated ({len(text)} characters). Paste the full key, then save.",
                }
            if len(text) > MAX_SECRET_LEN:
                return {"ok": False, "error": f"{name} key is too long"}
            if text:
                secrets[name] = text
            else:
                secrets.pop(name, None)
        try:
            _save_secrets(secrets)
        except OSError:
            return {"ok": False, "error": "Could not encrypt API keys"}
        data = _api_key_status()
        if secrets.get("constelia"):
            try:
                _public_member(_constelia_post("getMember", {"include_hidden": ""}))
            except (FileNotFoundError, OSError, ValueError, urllib.error.URLError, json.JSONDecodeError):
                pass
            _ensure_omega_dir()
        leetify_key = secrets.get("leetify") or ""
        if leetify_key:
            code = _validate_leetify_key(leetify_key)
            data["leetify"]["valid"] = code == 200
            if code == 401:
                data["leetify"]["error"] = "Invalid Leetify key"
            elif code != 200:
                data["leetify"]["error"] = "Could not validate Leetify key"
        csfloat_key = secrets.get("csfloat") or ""
        if csfloat_key:
            code = _validate_csfloat_key(csfloat_key)
            data["csfloat"]["valid"] = code in {200, 429}
            if code in {401, 403}:
                _CSFLOAT_AUTH_BAD = True
                data["csfloat"]["error"] = "Invalid CSFloat key" if code == 401 else "CSFloat rejected this key"
            elif code not in {200, 429}:
                data["csfloat"]["error"] = "Could not validate CSFloat key"
            elif data["csfloat"].get("valid"):
                cached = _load_inventory_result()
                if isinstance(cached, dict):
                    _queue_csfloat_from_items(cached.get("items") or [])
        else:
            with _CSFLOAT_LOCK:
                _CSFLOAT_QUEUE.clear()
                _CSFLOAT_QUEUED.clear()
        return {"ok": True, "data": data}

    def reveal_api_key(self, name: str) -> dict:
        if name not in SECRET_NAMES:
            return {"ok": False, "error": "Unknown key"}
        value = _secret(str(name))
        if not value:
            return {"ok": False, "error": "No key saved"}
        return {"ok": True, "data": {"name": name, "value": value}}

    def load_ui_settings(self) -> dict:
        try:
            if not SETTINGS_PATH.is_file():
                return {"ok": True, "data": {}}
            parsed = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            return {"ok": True, "data": parsed if isinstance(parsed, dict) else {}}
        except (OSError, json.JSONDecodeError):
            return {"ok": True, "data": {}}

    def save_ui_settings(self, payload: str) -> dict[str, bool | str]:
        try:
            parsed = json.loads(payload)
            if not isinstance(parsed, dict):
                return {"ok": False, "error": "Invalid settings"}
            allowed = {"theme", "liveSync", "compactNav", "reduceMotion", "themeSpeed", "simulateLoot", "staticGradients", "sens", "dpi", "sampleGames", "sampleModes", "statModes", "hiddenScripts", "hiddenScriptFields", "scriptBaselines", "cloudSortPopular", "cloudHideLibraries", "omegaRestartOnStall", "fullscreenMaximize"}
            clean = {key: parsed[key] for key in allowed if key in parsed}
            if "themeSpeed" in clean:
                try:
                    clean["themeSpeed"] = max(1, min(10, int(clean["themeSpeed"])))
                except (TypeError, ValueError):
                    clean.pop("themeSpeed", None)
            if "sens" in clean:
                try:
                    clean["sens"] = max(0.001, min(20.0, float(clean["sens"])))
                except (TypeError, ValueError):
                    clean.pop("sens", None)
            if "dpi" in clean:
                try:
                    clean["dpi"] = max(100, min(20000, int(float(clean["dpi"]))))
                except (TypeError, ValueError):
                    clean.pop("dpi", None)
            if "sampleGames" in clean:
                try:
                    clean["sampleGames"] = max(1, min(20, int(clean["sampleGames"])))
                except (TypeError, ValueError):
                    clean.pop("sampleGames", None)
            if "sampleModes" in clean:
                clean["sampleModes"] = _clean_sample_modes(clean.get("sampleModes"))
            if "statModes" in clean:
                clean["statModes"] = _clean_sample_modes(clean.get("statModes"))
            if "hiddenScripts" in clean:
                raw = clean.get("hiddenScripts")
                if isinstance(raw, list):
                    keys: list[str] = []
                    seen: set[str] = set()
                    for item in raw:
                        key = str(item).strip()[:80]
                        if not key or key in seen or key == "name:":
                            continue
                        if not (key.startswith("id:") or key.startswith("name:")):
                            continue
                        seen.add(key)
                        keys.append(key)
                        if len(keys) >= 200:
                            break
                    clean["hiddenScripts"] = keys
                else:
                    clean.pop("hiddenScripts", None)
            if "hiddenScriptFields" in clean:
                raw = clean.get("hiddenScriptFields")
                if isinstance(raw, dict):
                    hidden_fields: dict[str, dict[str, bool]] = {}
                    for key, fields in raw.items():
                        name = str(key).strip()[:80]
                        if not name or name == "name:" or name in hidden_fields:
                            continue
                        if not (name.startswith("id:") or name.startswith("name:")):
                            continue
                        src = fields if isinstance(fields, dict) else {}
                        kept: dict[str, bool] = {}
                        for field, on in list(src.items())[:80]:
                            fname = str(field).strip()[:80]
                            if fname and on:
                                kept[fname] = True
                        if kept:
                            hidden_fields[name] = kept
                        if len(hidden_fields) >= 200:
                            break
                    clean["hiddenScriptFields"] = hidden_fields
                else:
                    clean.pop("hiddenScriptFields", None)
            if "scriptBaselines" in clean:
                raw = clean.get("scriptBaselines")
                if isinstance(raw, dict):
                    baselines: dict[str, dict] = {}
                    for key, cfg in raw.items():
                        name = str(key).strip()[:80]
                        if not name or name == "name:" or name in baselines:
                            continue
                        if not (name.startswith("id:") or name.startswith("name:")):
                            continue
                        if not isinstance(cfg, dict):
                            continue
                        baselines[name] = {
                            str(field): _clip_setting(val)
                            for field, val in list(cfg.items())[:48]
                        }
                        if len(baselines) >= 200:
                            break
                    clean["scriptBaselines"] = baselines
                else:
                    clean.pop("scriptBaselines", None)
            SETTINGS_PATH.write_text(json.dumps(clean, indent=2), encoding="utf-8")
            if _form_mode() == "maximized":
                _apply_maximized_bounds()
            return {"ok": True}
        except (OSError, json.JSONDecodeError):
            return {"ok": False, "error": "Could not save settings"}

    def get_sens_analysis(self) -> dict:
        return {"ok": True, "data": _load_sens_result()}

    def analyze_sensitivity(self, payload: str) -> dict:
        try:
            parsed = json.loads(payload) if payload else {}
        except json.JSONDecodeError:
            return {"ok": False, "error": "Invalid setup"}
        if not isinstance(parsed, dict):
            return {"ok": False, "error": "Invalid setup"}
        try:
            sens = max(0.001, min(20.0, float(parsed.get("sens") or 0)))
            dpi = max(100, min(20000, int(float(parsed.get("dpi") or 0))))
            games = max(1, min(20, int(parsed.get("games") or parsed.get("sampleGames") or 8)))
        except (TypeError, ValueError):
            return {"ok": False, "error": "Enter a valid sensitivity, DPI, and game count"}
        modes = _clean_sample_modes(parsed.get("modes") or parsed.get("sampleModes"))
        if not modes:
            return {"ok": False, "error": "Pick at least one match type"}
        pack = telemetry.build_sens_pack(games, sens, dpi, modes)
        sample = pack.get("sample") or {}
        if not sample.get("fights"):
            return {"ok": False, "error": "No fights in those match types. Tag games in Last 20, or include more types."}
        setup = pack.get("setup") or {
            "sens": telemetry.round_sens(sens),
            "dpi": dpi,
            "edpi": telemetry.edpi(sens, dpi),
            "cm360": telemetry.cm360(sens, dpi),
        }
        by_mode = sample.get("byMode") or {}
        prompt_pack = dict(pack)
        prompt = (
            f"Here is the aim data. Current setup: {setup.get('sens')} in-game sensitivity at "
            f"{setup.get('dpi')} DPI ({setup.get('edpi')} eDPI, {setup.get('cm360')} cm/360). "
            f"Sample: {sample.get('matches')} matches, {sample.get('fights')} fights. "
            f"Types: {json.dumps(by_mode, ensure_ascii=False)}. Prem/Comp is the most trustworthy.\n"
            "Default is keep. Only suggest a new 2-decimal sens if pack.signals.worthChanging is true "
            "and the flick stats give a real too-high or too-low reason. Do not change sens for the sake of it.\n\n"
            + json.dumps(prompt_pack, ensure_ascii=False, separators=(",", ":"))
        )
        try:
            raw = _gemini_generate(prompt)
        except FileNotFoundError:
            return {"ok": False, "error": "Add a Gemini API key in Settings first."}
        except RuntimeError as exc:
            return {"ok": False, "error": str(exc) or "Gemini could not analyze this sample"}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "error": _http_error_message(exc, "Gemini request failed")}
        except urllib.error.URLError:
            return {"ok": False, "error": "Could not reach Gemini"}
        work = raw.get("mathWork") if isinstance(raw.get("mathWork"), dict) else None
        math = telemetry.verify_sens_work(sens, dpi, work) if work else None
        analysis = _normalize_sens_analysis(raw, sens, dpi, pack.get("signals"), math)
        result = {
            "setup": setup,
            "sample": sample,
            "signals": pack.get("signals") or {},
            "math": math,
            "overall": pack.get("overall") or {},
            "flickBySize": pack.get("flickBySize") or {},
            "analysis": analysis,
            "analyzedAt": int(time.time() * 1000),
        }
        try:
            _save_sens_result(result)
        except OSError:
            pass
        return {"ok": True, "data": result}

    def analyze_sens_routine(self) -> dict:
        saved = _load_sens_result()
        if not saved or not isinstance(saved.get("analysis"), dict):
            return {"ok": False, "error": "Analyze aim first, then generate practice recommendations."}
        pack = _routine_prompt_pack(saved)
        prompt = (
            "Recommend specific Refrag modes and workshop maps from this Sensitivity Finder pack. "
            "Use only catalog Refrag modes (Aimbotz, Waves, Angle Trainer, Prefire, Xfire, Repeek, "
            "Blitz, Crossfire, Defender, Rush, and AWP Flick/Hold only if awpMain is true). "
            "Never recommend Yprac. Not a timed routine. Cite the stats that earned each item.\n\n"
            + json.dumps(pack, ensure_ascii=False, separators=(",", ":"))
        )
        try:
            raw = _gemini_generate(
                prompt,
                system=ROUTINE_SYSTEM,
                schema=ROUTINE_SCHEMA,
                max_output=3072,
                timeout=90,
            )
        except FileNotFoundError:
            return {"ok": False, "error": "Add a Gemini API key in Settings first."}
        except RuntimeError as exc:
            return {"ok": False, "error": str(exc) or "Gemini could not build a practice guide"}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "error": _http_error_message(exc, "Gemini request failed")}
        except urllib.error.URLError:
            return {"ok": False, "error": "Could not reach Gemini"}
        guide = _normalize_guide(raw, awp_main=bool(pack.get("awpMain")))
        if len(guide["items"]) < 3:
            return {"ok": False, "error": "Gemini returned a thin guide. Try again."}
        saved["guide"] = guide
        saved.pop("routine", None)
        try:
            _save_sens_result(saved)
        except OSError:
            pass
        return {"ok": True, "data": saved}

    def analyze_sens_guide(self) -> dict:
        return self.analyze_sens_routine()

    def get_leak_analysis(self) -> dict:
        return {"ok": True, "data": _leak_store(_load_leak_result())}

    def analyze_leaks(self, payload: str = "") -> dict:
        modes = self._stat_modes
        kind = "map"
        if payload:
            try:
                parsed = json.loads(payload) if payload else {}
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, dict):
                raw_kind = str(parsed.get("kind") or parsed.get("scope") or "").strip().lower()
                if raw_kind in {"map", "maps"}:
                    kind = "map"
                elif raw_kind in {"weapon", "weapons"}:
                    kind = "weapon"
                if "modes" in parsed:
                    modes = _clean_sample_modes(parsed.get("modes"))
            elif isinstance(parsed, list):
                modes = _clean_sample_modes(parsed)
        pack = _build_leak_pack(modes, kind)
        if kind == "map":
            played = [row for row in pack.get("maps") or [] if int(row.get("played") or 0) > 0]
            if not played:
                return {"ok": False, "error": "No map games yet. Play some tagged matches first."}
            prompt = (
                "Find the single weakest map in this telemetry. Maps only. "
                "Weight by games played and share. Do not flag a barely-played map. "
                "If the well-played maps look acceptable, verdict is ok. Cite numbers.\n\n"
            )
            system = MAP_LEAK_SYSTEM
            empty_error = "Gemini could not analyze maps"
        else:
            weapons = [row for row in pack.get("weapons") or [] if int(row.get("fights") or 0) > 0]
            if not weapons:
                return {"ok": False, "error": "No weapon fights yet. Play some tagged matches first."}
            prompt = (
                "Find the single weakest weapon in this telemetry. Weapons only. "
                "Weight by fight share. Do not flag a rarely used gun. "
                "If the guns they actually use look acceptable, verdict is ok. Cite numbers.\n\n"
            )
            system = WEAPON_LEAK_SYSTEM
            empty_error = "Gemini could not analyze weapons"
        prompt += json.dumps(pack, ensure_ascii=False, separators=(",", ":"))
        try:
            raw = _gemini_generate(
                prompt,
                system=system,
                schema=_leak_schema(kind),
                max_output=2048,
                timeout=75,
            )
        except FileNotFoundError:
            return {"ok": False, "error": "Add a Gemini API key in Settings first."}
        except RuntimeError as exc:
            return {"ok": False, "error": str(exc) or empty_error}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "error": _http_error_message(exc, "Gemini request failed")}
        except urllib.error.URLError:
            return {"ok": False, "error": "Could not reach Gemini"}
        analysis = _normalize_leak_analysis(raw, pack, kind)
        result = {
            "analysis": analysis,
            "overall": pack.get("overall") or {},
            "analyzedAt": int(time.time() * 1000),
        }
        try:
            _save_leak_kind(kind, result)
        except OSError:
            pass
        store = _leak_store(_load_leak_result())
        store["maps" if kind == "map" else "weapons"] = result
        return {"ok": True, "data": store}

    def get_state(self, payload: str = "") -> dict:
        try:
            modes = self._stat_modes
            if payload:
                try:
                    parsed = json.loads(payload)
                except json.JSONDecodeError:
                    parsed = None
                if isinstance(parsed, dict) and "modes" in parsed:
                    modes = _clean_sample_modes(parsed.get("modes"))
                    self._stat_modes = modes
                elif isinstance(parsed, list):
                    modes = _clean_sample_modes(parsed)
                    self._stat_modes = modes
            return {"ok": True, "data": telemetry.get_dashboard_state(modes), "omegaRestart": _take_watch_notice()}
        except (OSError, sqlite3.Error, json.JSONDecodeError, ValueError):
            return {"ok": False, "error": "Could not load telemetry"}

    def delete_match(self, match_id: str) -> dict:
        try:
            telemetry.delete_match(str(match_id or ""))
            return {"ok": True, "data": self._dashboard_state()}
        except ValueError:
            return {"ok": False, "error": "Invalid match"}
        except (OSError, sqlite3.Error, json.JSONDecodeError):
            return {"ok": False, "error": "Could not delete match"}

    def set_match_mode(self, match_id: str, mode: str = "") -> dict:
        try:
            telemetry.set_match_mode(str(match_id or ""), mode)
            return {"ok": True, "mode": telemetry.normalize_match_mode(mode)}
        except ValueError as exc:
            return {"ok": False, "error": str(exc) or "Invalid match"}
        except (OSError, sqlite3.Error):
            return {"ok": False, "error": "Could not tag match"}

    def clear_telemetry(self) -> dict:
        try:
            telemetry.clear_telemetry()
            return {"ok": True, "data": self._dashboard_state()}
        except (OSError, sqlite3.Error, json.JSONDecodeError):
            return {"ok": False, "error": "Could not clear telemetry"}

    def get_leetify_profiles(self, payload: str) -> dict:
        try:
            parsed = json.loads(payload) if payload else []
        except json.JSONDecodeError:
            return {"ok": False, "error": "Invalid Steam IDs", "data": {}}
        if isinstance(parsed, dict):
            parsed = parsed.get("ids") or parsed.get("steam64") or []
        if not isinstance(parsed, list):
            return {"ok": False, "error": "Invalid Steam IDs", "data": {}}
        ids = []
        seen = set()
        for item in parsed:
            sid = _as_steam64(item)
            if not sid or sid in seen:
                continue
            seen.add(sid)
            ids.append(sid)
            if len(ids) >= 20:
                break
        out: dict[str, dict] = {}
        for sid in ids:
            cached = telemetry.get_leetify_profile(sid)
            if telemetry.leetify_profile_fresh(cached):
                out[sid] = cached
                continue
            out[sid] = cached or {"steam64": sid, "status": "loading"}
            _queue_leetify_fetch(sid)
        return {"ok": True, "data": out}

    def get_loot_history(self) -> dict:
        try:
            return {"ok": True, "data": telemetry.list_loot_rolls()}
        except (OSError, sqlite3.Error):
            return {"ok": False, "error": "Could not load loot history", "data": []}

    def roll_loot(self, simulate: bool = False) -> dict:
        try:
            extra = {"option": "roll_loot"}
            simulating = simulate is True or simulate == 1 or str(simulate).lower() == "true"
            if simulating:
                extra["sim"] = ""
            raw = _constelia_post("setMember", extra)
            if "success" in raw:
                success = bool(raw.get("success"))
            else:
                success = bool(raw.get("message")) and not raw.get("error")
            message = str(raw.get("message") or raw.get("error") or "")
            if not message and not success:
                message = "Loot roll failed"
            if success:
                telemetry.record_loot_roll(simulating, True, message)
            return {
                "ok": success,
                "success": success,
                "message": message,
                "data": {"success": success, "message": message},
                "history": telemetry.list_loot_rolls(),
            }
        except FileNotFoundError:
            return {"ok": False, "success": False, "message": "Constelia API key is not set"}
        except urllib.error.HTTPError as exc:
            return {"ok": False, "success": False, "message": _http_error_message(exc, "Could not roll loot")}
        except urllib.error.URLError:
            return {"ok": False, "success": False, "message": "Could not reach Constelia"}
        except json.JSONDecodeError:
            return {"ok": False, "success": False, "message": "Constelia returned an invalid response"}
        except (OSError, ValueError) as exc:
            return {"ok": False, "success": False, "message": str(exc) or "Could not roll loot"}


def main() -> None:
    global _geometry, _OMEGA_DIR, _restore_maximized
    os.chdir(APP_DIR)
    _filter_chromium_stderr()
    _prime_omega_dir()
    ingest_url = telemetry.start()
    _ensure_omega_dir()
    print(f"OmegaDash ingest: {ingest_url}", flush=True)
    state = _load_window_state()
    _geometry = dict(state)
    api = DashboardApi()
    api._maximized = bool(state.get("maximized"))
    _restore_maximized = bool(state.get("maximized"))
    _start_rootlink_watch()
    create_args = {
        "width": state["width"],
        "height": state["height"],
        "min_size": (MIN_WINDOW["width"], MIN_WINDOW["height"]),
        "background_color": "#080b0f",
        "text_select": False,
        "frameless": True,
        "easy_drag": False,
        "shadow": True,
        "resizable": True,
    }
    if "x" in state and "y" in state and _on_screen(
        state["x"], state["y"], state["width"], state["height"]
    ):
        create_args["x"] = state["x"]
        create_args["y"] = state["y"]
    window = webview.create_window(
        APP_TITLE,
        url=(BUNDLE_DIR / "index.html").as_uri(),
        js_api=api,
        **create_args,
    )
    window.events.shown += _hide_native_caption
    window.events.resized += _on_resized
    window.events.moved += _on_moved
    window.events.closing += _on_closing
    window.events.closed += _on_closed

    # WebView2 is used automatically on Windows when its runtime is available.
    icon = BUNDLE_DIR / "icons" / "omegadash.ico"
    webview.start(
        debug="--debug" in sys.argv,
        private_mode=False,
        icon=str(icon) if icon.is_file() else None,
    )


if __name__ == "__main__":
    main()
