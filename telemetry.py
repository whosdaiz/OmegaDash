"""SQLite history + localhost ingest for OmegaDash.

Lua POSTs match JSON (every engagement, every field) to /ingest.
The dashboard reads a UI-shaped snapshot from get_dashboard_state().
Raw payloads are kept in full so later UI changes can use data we
already stored.
"""

from __future__ import annotations

import json
import math
import sqlite3
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


def _frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def bundle_dir() -> Path:
    """Packaged HTML / icons. One-file builds unpack here for the process lifetime."""
    if _frozen():
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def data_dir() -> Path:
    """Writable files (sqlite, secrets, settings). Next to the exe when frozen."""
    if _frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


BUNDLE_DIR = bundle_dir()
APP_DIR = data_dir()
DB_PATH = APP_DIR / "omegadash.sqlite"
OMEGA_ROOT_FILE = APP_DIR / "omega-root.json"
INGEST_HOST = "127.0.0.1"
INGEST_PORT = 27182
HISTORY_MATCHES = 20
GHOST_MATCH_MS = 4000
EPHEMERAL_LIVE_MS = 1500
FLICK_POINTS_PLOT = 100
PLACEMENT_POINTS = 100
PLACEMENT_X_MAX = 12.0
PLACEMENT_Y_MAX = 6.0
REACTION_HISTORY = 30

SIDECAR_CURRENT = "omegadash_current.json"
SIDECAR_LAST = "omegadash_last.json"
SIDECAR_ARCHIVE = "omegadash_archive.jsonl"
SIDECAR_INGEST = "omegadash_ingest.json"
LEGACY_MATCH_JSON = ("omegastats_current.json", "omegastats_last.json")
LEGACY_ARCHIVE = "omegastats_archive.jsonl"
LEGACY_INGEST = "omegastats_ingest.json"

MATCH_MODES = ("prem_comp", "practice", "casual", "deathmatch")
MATCH_MODE_LABELS = {
    "prem_comp": "Prem/Comp",
    "practice": "Practice",
    "casual": "Casual",
    "deathmatch": "Deathmatch",
}
MATCH_MODE_WEIGHTS = {
    "prem_comp": 1.0,
    "casual": 0.7,
    "practice": 0.45,
    "deathmatch": 0.35,
}
MAP_WINRATE_EXCLUDE_MODES = frozenset({"practice", "casual", "deathmatch"})

TEAM_T, TEAM_CT = 2, 3

MAP_LABELS = {
    "de_mirage": "Mirage",
    "de_inferno": "Inferno",
    "de_dust2": "Dust2",
    "de_ancient": "Ancient",
    "de_nuke": "Nuke",
    "de_anubis": "Anubis",
    "de_overpass": "Overpass",
    "de_vertigo": "Vertigo",
    "de_train": "Train",
    "de_cache": "Cache",
    "de_italy": "Italy",
    "cs_office": "Office",
    "cs_italy": "Italy",
}

# Active Duty first, then the rest of Valve's official competitive maps.
OFFICIAL_MAPS = [
    ("de_ancient", "Ancient", "Active Duty"),
    ("de_anubis", "Anubis", "Active Duty"),
    ("de_cache", "Cache", "Active Duty"),
    ("de_dust2", "Dust2", "Active Duty"),
    ("de_inferno", "Inferno", "Active Duty"),
    ("de_mirage", "Mirage", "Active Duty"),
    ("de_nuke", "Nuke", "Active Duty"),
    ("de_overpass", "Overpass", "Competitive"),
    ("de_train", "Train", "Competitive"),
    ("de_vertigo", "Vertigo", "Competitive"),
    ("cs_italy", "Italy", "Competitive"),
    ("cs_office", "Office", "Competitive"),
]

HEAD_RADIUS = 4.0  # same units as Lua; used to reconstruct head-level on old records
HEAD_LEVEL_SLACK_DEG = 0.4
TARGET_RADIUS = 14.0
LAND_TOL_FLOOR_DEG = 0.75
LAND_TOL_MAX_DEG = 4.0
LAND_TOL_SLACK_DEG = 0.25

# Horizontal speed still accurate enough to count as a counter-strafe (u/s).
CS_LIMIT_RIFLE = 50.0
CS_LIMIT_HEAVY_PISTOL = 70.0
CS_LIMIT_SMG = 160.0
HEAVY_PISTOL_IDS = {1, 64}  # Deagle, R8
MOBILE_PISTOL_IDS = {4, 30, 63}  # Glock, Tec-9, CZ75

WEAPON_CATALOG = {
    1: ("Desert Eagle", "pistol"),
    2: ("Dual Berettas", "pistol"),
    3: ("Five-SeveN", "pistol"),
    4: ("Glock-18", "pistol"),
    7: ("AK-47", "rifle"),
    8: ("AUG", "rifle"),
    9: ("AWP", "sniper"),
    10: ("FAMAS", "rifle"),
    11: ("G3SG1", "sniper"),
    13: ("Galil AR", "rifle"),
    14: ("M249", "lmg"),
    16: ("M4A4", "rifle"),
    17: ("MAC-10", "smg"),
    19: ("P90", "smg"),
    23: ("MP5-SD", "smg"),
    24: ("UMP-45", "smg"),
    25: ("XM1014", "shotgun"),
    26: ("PP-Bizon", "smg"),
    27: ("MAG-7", "shotgun"),
    28: ("Negev", "lmg"),
    29: ("Sawed-Off", "shotgun"),
    30: ("Tec-9", "pistol"),
    31: ("Zeus x27", "other"),
    32: ("P2000", "pistol"),
    33: ("MP7", "smg"),
    34: ("MP9", "smg"),
    35: ("Nova", "shotgun"),
    36: ("P250", "pistol"),
    38: ("SCAR-20", "sniper"),
    39: ("SG 553", "rifle"),
    40: ("SSG 08", "sniper"),
    43: ("Flashbang", "nade"),
    44: ("HE Grenade", "nade"),
    45: ("Smoke", "nade"),
    46: ("Molotov", "nade"),
    47: ("Decoy", "nade"),
    48: ("Incendiary", "nade"),
    49: ("C4", "other"),
    60: ("M4A1-S", "rifle"),
    61: ("USP-S", "pistol"),
    63: ("CZ75-Auto", "pistol"),
    64: ("R8 Revolver", "pistol"),
}
KNIFE_IDS = {
    41, 42, 59, 500, 503, 505, 506, 507, 508, 509, 512, 514, 515, 516, 517, 518, 519, 520, 521, 522, 523, 525
}

_lock = threading.Lock()
_http: ThreadingHTTPServer | None = None
_ingest_url = f"http://{INGEST_HOST}:{INGEST_PORT}/ingest"
_last_ingest_at = 0.0
_latest_webapp_ver = ""
_file_mtimes: dict[str, float] = {}
_watch_stop = threading.Event()
_packet_lock = threading.Lock()
_packet_log: deque[dict[str, Any]] = deque(maxlen=800)
_packet_seq = 0
_omega_root: Path | None = None
_steam_inv_lock = threading.Lock()
_steam_inv_event = threading.Event()
_steam_inv_status = 0
_steam_inv_retry_after = ""
_steam_inv_body = ""


def _valid_omega_root(value: object) -> Path | None:
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


def looks_like_omega_install(path: Path | None) -> bool:
    """True for Omega's solution folder (resources + scripts), not the constellation root."""
    if path is None:
        return False
    try:
        base = Path(path).expanduser().resolve()
    except (OSError, RuntimeError):
        return False
    try:
        if not base.is_dir():
            return False
        if (base / "resources").is_dir() and (base / "scripts").is_dir():
            return True
    except OSError:
        return False
    return False


def omega_root() -> Path | None:
    return _omega_root


def load_omega_root() -> Path | None:
    global _omega_root
    if _omega_root is not None and _omega_root.is_dir():
        return _omega_root
    try:
        if OMEGA_ROOT_FILE.is_file():
            raw = json.loads(OMEGA_ROOT_FILE.read_text(encoding="utf-8"))
            directory = raw.get("directory") if isinstance(raw, dict) else None
            path = _valid_omega_root(directory)
            if path:
                _omega_root = path
                return path
    except (OSError, json.JSONDecodeError):
        pass
    return _omega_root


def set_omega_root(value: object) -> Path | None:
    global _omega_root
    path = _valid_omega_root(value)
    if path is None:
        return _omega_root
    changed = _omega_root is None or path != _omega_root
    _omega_root = path
    try:
        OMEGA_ROOT_FILE.write_text(
            json.dumps({"directory": str(path)}, indent=2),
            encoding="utf-8",
        )
    except OSError:
        pass
    if changed and _http is not None:
        write_ingest_pointer(_ingest_url)
        import_local_files()
    return path


def _fallback_omega_root() -> Path:
    return APP_DIR.parent / "omega"


def _known_omega_root(*, allow_fallback: bool = True) -> Path | None:
    """Omega solution folder (resources/scripts). Never the constellation root that only has the launcher."""
    candidates: list[Path | None] = [_omega_root]
    if allow_fallback:
        candidates.append(_fallback_omega_root())
    for candidate in candidates:
        if candidate is None:
            continue
        try:
            path = Path(candidate).expanduser().resolve()
        except (OSError, RuntimeError, TypeError):
            continue
        nested = path / "omega"
        if looks_like_omega_install(nested):
            return nested
        if looks_like_omega_install(path):
            return path
    return None


def omega_dash_dir() -> Path | None:
    root = _known_omega_root(allow_fallback=False)
    if root is None:
        return None
    return root / "resources" / "OmegaDash"


def _legacy_stats_dir() -> Path | None:
    root = _known_omega_root()
    if root is None:
        return None
    return root / "resources" / "OmegaStats"


def _rename_if_needed(src: Path, dest: Path) -> None:
    if not src.exists() or dest.exists():
        return
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dest)
    except OSError:
        return


def migrate_legacy_names() -> None:
    old_db = APP_DIR / "omega-aim.sqlite"
    _rename_if_needed(old_db, DB_PATH)
    for extra in ("-wal", "-shm"):
        _rename_if_needed(old_db.with_name(old_db.name + extra), DB_PATH.with_name(DB_PATH.name + extra))

    old_dir = _legacy_stats_dir()
    new_dir = omega_dash_dir()
    rename_map = {
        "omegastats_current.json": SIDECAR_CURRENT,
        "omegastats_last.json": SIDECAR_LAST,
        "omegastats_archive.jsonl": SIDECAR_ARCHIVE,
        "omegastats_ingest.json": SIDECAR_INGEST,
    }
    if old_dir is not None and new_dir is not None and old_dir.is_dir():
        new_dir.mkdir(parents=True, exist_ok=True)
        for src_name, dest_name in rename_map.items():
            _rename_if_needed(old_dir / src_name, new_dir / dest_name)
        try:
            if old_dir.is_dir() and not any(old_dir.iterdir()):
                old_dir.rmdir()
        except OSError:
            pass
    if new_dir is not None and new_dir.is_dir():
        for src_name, dest_name in rename_map.items():
            _rename_if_needed(new_dir / src_name, new_dir / dest_name)


def omega_dirs() -> list[Path]:
    root = _known_omega_root()
    dirs: list[Path] = []
    dash = omega_dash_dir()
    legacy = _legacy_stats_dir()
    if dash is not None:
        dirs.append(dash)
    if legacy is not None:
        dirs.append(legacy)
    if root is not None:
        dirs.append(root)
        dirs.append(root / "scripts")
    dirs.append(APP_DIR)
    seen: set[Path] = set()
    out: list[Path] = []
    for path in dirs:
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        out.append(path)
    return out


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    migrate_legacy_names()
    with _lock:
        conn = _connect()
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS matches (
                    id TEXT PRIMARY KEY,
                    map TEXT,
                    started_at INTEGER,
                    ended_at INTEGER,
                    last_seen_at INTEGER,
                    started_wall_ms INTEGER,
                    ended_wall_ms INTEGER,
                    close_reason TEXT,
                    duration_ms INTEGER,
                    team INTEGER,
                    rounds INTEGER,
                    warmup INTEGER,
                    score_ct INTEGER,
                    score_t INTEGER,
                    kills INTEGER,
                    deaths INTEGER,
                    assists INTEGER,
                    headshots INTEGER,
                    damage INTEGER,
                    flashed INTEGER,
                    closed INTEGER NOT NULL DEFAULT 0,
                    mode TEXT,
                    ingested_at INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS engagements (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    match_id TEXT NOT NULL,
                    seq INTEGER NOT NULL,
                    result TEXT,
                    round INTEGER,
                    team INTEGER,
                    reaction_ms REAL,
                    ttk_ms REAL,
                    preaim_deg REAL,
                    flick_deg REAL,
                    flick_verdict TEXT,
                    first_shot_hit INTEGER,
                    firing_velocity REAL,
                    origin_x REAL,
                    origin_y REAL,
                    origin_z REAL,
                    end_x REAL,
                    end_y REAL,
                    end_z REAL,
                    payload_json TEXT NOT NULL,
                    FOREIGN KEY(match_id) REFERENCES matches(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_eng_match ON engagements(match_id, seq);
                CREATE INDEX IF NOT EXISTS idx_match_wall ON matches(started_wall_ms);
                CREATE INDEX IF NOT EXISTS idx_match_ingest ON matches(ingested_at);
                CREATE TABLE IF NOT EXISTS loot_rolls (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    rolled_at INTEGER NOT NULL,
                    simulate INTEGER NOT NULL DEFAULT 0,
                    success INTEGER NOT NULL DEFAULT 1,
                    message TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_loot_rolled ON loot_rolls(rolled_at DESC);
                CREATE TABLE IF NOT EXISTS leetify_profiles (
                    steam64 TEXT PRIMARY KEY,
                    fetched_at INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS deleted_matches (
                    id TEXT PRIMARY KEY,
                    deleted_at INTEGER NOT NULL
                );
                """
            )
            cols = {row[1] for row in conn.execute("PRAGMA table_info(matches)")}
            if "mode" not in cols:
                conn.execute("ALTER TABLE matches ADD COLUMN mode TEXT")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS deleted_matches (
                    id TEXT PRIMARY KEY,
                    deleted_at INTEGER NOT NULL
                )
                """
            )
            conn.commit()
        finally:
            conn.close()


LOOT_HISTORY_MAX = 200


def record_loot_roll(simulate: bool, success: bool, message: str) -> None:
    now = int(time.time())
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO loot_rolls (rolled_at, simulate, success, message) VALUES (?, ?, ?, ?)",
                (now, 1 if simulate else 0, 1 if success else 0, str(message or "")),
            )
            conn.execute(
                """
                DELETE FROM loot_rolls WHERE id NOT IN (
                    SELECT id FROM (
                        SELECT id FROM loot_rolls ORDER BY rolled_at DESC, id DESC LIMIT ?
                    )
                )
                """,
                (LOOT_HISTORY_MAX,),
            )
            conn.commit()
        finally:
            conn.close()


def list_loot_rolls(limit: int = 80) -> list[dict[str, Any]]:
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT id, rolled_at, simulate, success, message FROM loot_rolls ORDER BY rolled_at DESC, id DESC LIMIT ?",
                (max(1, min(limit, LOOT_HISTORY_MAX)),),
            ).fetchall()
        finally:
            conn.close()
    return [
        {
            "id": row["id"],
            "rolledAt": row["rolled_at"],
            "simulate": bool(row["simulate"]),
            "success": bool(row["success"]),
            "message": row["message"] or "",
        }
        for row in rows
    ]


LEETIFY_OK_TTL = 30 * 60
LEETIFY_ERROR_TTL = 60
STEAM64_BASE = 76561197960265728


def get_leetify_profile(steam64: str) -> dict[str, Any] | None:
    sid = _steam64(steam64)
    if not sid:
        return None
    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT fetched_at, status, payload_json FROM leetify_profiles WHERE steam64 = ?",
                (sid,),
            ).fetchone()
        finally:
            conn.close()
    if not row:
        return None
    try:
        payload = json.loads(row["payload_json"] or "{}")
    except json.JSONDecodeError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    payload["steam64"] = sid
    payload["status"] = row["status"] or payload.get("status") or "error"
    payload["fetchedAt"] = row["fetched_at"]
    return payload


def leetify_profile_fresh(profile: dict[str, Any] | None) -> bool:
    if not profile:
        return False
    fetched = _int(profile.get("fetchedAt")) or 0
    age = max(0, int(time.time()) - fetched)
    status = str(profile.get("status") or "")
    if status in {"ok", "missing", "private"}:
        if status == "ok" and "competitive" not in profile:
            return False
        return age < LEETIFY_OK_TTL
    if status == "error":
        return age < LEETIFY_ERROR_TTL
    return False


def save_leetify_profile(steam64: str, profile: dict[str, Any]) -> None:
    sid = _steam64(steam64)
    if not sid:
        return
    payload = dict(profile or {})
    payload["steam64"] = sid
    status = str(payload.get("status") or "error")
    now = int(time.time())
    payload["fetchedAt"] = now
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                """
                INSERT INTO leetify_profiles (steam64, fetched_at, status, payload_json)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(steam64) DO UPDATE SET
                    fetched_at=excluded.fetched_at,
                    status=excluded.status,
                    payload_json=excluded.payload_json
                """,
                (sid, now, status, json.dumps(payload, separators=(",", ":"))),
            )
            conn.commit()
        finally:
            conn.close()


def _num(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _int(value: Any) -> int | None:
    n = _num(value)
    return int(n) if n is not None else None


def _steam64(value: Any) -> str | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        text = str(value)
    elif isinstance(value, float):
        text = str(int(value)) if value.is_integer() else ""
    else:
        text = str(value or "").strip()
    if text.isdigit() and text.startswith("7656119") and len(text) >= 17:
        return text
    if text.isdigit() and 1 <= len(text) <= 16:
        account = int(text)
        if 0 < account < STEAM64_BASE:
            return str(account + STEAM64_BASE)
    return None


def _bool_int(value: Any) -> int | None:
    if value is None:
        return None
    return 1 if value else 0


def _vec(value: Any) -> dict[str, float] | None:
    if not isinstance(value, dict):
        return None
    x, y, z = _num(value.get("x")), _num(value.get("y")), _num(value.get("z"))
    if x is None or y is None or z is None:
        return None
    return {"x": x, "y": y, "z": z}


def _is_ephemeral_match(
    payload: dict[str, Any], engagements: list[Any], closed: bool
) -> bool:
    """Ghost sessions from a team-switch reset loop: empty, sub-second, or a short reset."""
    if engagements:
        return False
    duration = max(0, _int(payload.get("duration_ms")) or 0)
    kills = _int(payload.get("kills")) or 0
    deaths = _int(payload.get("deaths")) or 0
    if not kills and not deaths:
        if duration < EPHEMERAL_LIVE_MS:
            return True
        if closed and duration < GHOST_MATCH_MS:
            return True
    reason = str(payload.get("close_reason") or "").strip().lower()
    return bool(closed and reason == "reset" and duration < 10_000)


def _purge_match_rows(conn: sqlite3.Connection, match_id: str) -> None:
    conn.execute("DELETE FROM engagements WHERE match_id = ?", (match_id,))
    conn.execute("DELETE FROM matches WHERE id = ?", (match_id,))


def ingest_match(payload: dict[str, Any]) -> dict[str, Any]:
    match_id = str(payload.get("id") or "").strip()
    if not match_id:
        raise ValueError("match id missing")

    engagements = payload.get("engagements")
    if not isinstance(engagements, list):
        engagements = []

    now_ms = int(time.time() * 1000)
    closed = bool(payload.get("closed") or payload.get("ended_at"))
    started_wall = _int(payload.get("started_wall_ms")) or now_ms

    with _lock:
        conn = _connect()
        try:
            try:
                deleted = conn.execute(
                    "SELECT 1 FROM deleted_matches WHERE id = ?", (match_id,)
                ).fetchone()
            except sqlite3.OperationalError:
                deleted = None
            if deleted:
                return {
                    "ok": True,
                    "id": match_id,
                    "engagements": 0,
                    "closed": closed,
                    "ignored": True,
                }
            if _is_ephemeral_match(payload, engagements, closed):
                if closed:
                    _purge_match_rows(conn, match_id)
                    conn.commit()
                return {
                    "ok": True,
                    "id": match_id,
                    "engagements": 0,
                    "closed": closed,
                    "ignored": True,
                }
            conn.execute(
                """
                INSERT INTO matches (
                    id, map, started_at, ended_at, last_seen_at,
                    started_wall_ms, ended_wall_ms, close_reason, duration_ms,
                    team, rounds, warmup, score_ct, score_t,
                    kills, deaths, assists, headshots, damage, flashed,
                    closed, ingested_at, payload_json
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                    map=excluded.map,
                    started_at=excluded.started_at,
                    ended_at=excluded.ended_at,
                    last_seen_at=excluded.last_seen_at,
                    started_wall_ms=COALESCE(excluded.started_wall_ms, matches.started_wall_ms),
                    ended_wall_ms=excluded.ended_wall_ms,
                    close_reason=excluded.close_reason,
                    duration_ms=excluded.duration_ms,
                    team=excluded.team,
                    rounds=excluded.rounds,
                    warmup=excluded.warmup,
                    score_ct=excluded.score_ct,
                    score_t=excluded.score_t,
                    kills=excluded.kills,
                    deaths=excluded.deaths,
                    assists=excluded.assists,
                    headshots=excluded.headshots,
                    damage=excluded.damage,
                    flashed=excluded.flashed,
                    closed=excluded.closed,
                    ingested_at=excluded.ingested_at,
                    payload_json=excluded.payload_json
                """,
                (
                    match_id,
                    str(payload.get("map") or ""),
                    _int(payload.get("started_at")),
                    _int(payload.get("ended_at")),
                    _int(payload.get("last_seen_at")),
                    started_wall,
                    _int(payload.get("ended_wall_ms")),
                    payload.get("close_reason"),
                    _int(payload.get("duration_ms")),
                    _int(payload.get("team")),
                    _int(payload.get("rounds")),
                    _bool_int(payload.get("warmup")) or 0,
                    _int(payload.get("score_ct")),
                    _int(payload.get("score_t")),
                    _int(payload.get("kills")) or 0,
                    _int(payload.get("deaths")) or 0,
                    _int(payload.get("assists")) or 0,
                    _int(payload.get("headshots")) or 0,
                    _int(payload.get("damage")) or 0,
                    _int(payload.get("flashed")) or 0,
                    1 if closed else 0,
                    now_ms,
                    json.dumps(payload, ensure_ascii=False),
                ),
            )
            conn.execute("DELETE FROM engagements WHERE match_id = ?", (match_id,))
            rows = []
            for i, raw in enumerate(engagements, start=1):
                if not isinstance(raw, dict):
                    continue
                origin = _vec(raw.get("origin"))
                end = _vec(raw.get("end_origin")) or origin
                seq = _int(raw.get("seq") or raw.get("id")) or i
                rows.append(
                    (
                        match_id,
                        seq,
                        raw.get("result"),
                        _int(raw.get("round")),
                        _int(raw.get("team")),
                        _num(raw.get("reaction_ms")),
                        _num(raw.get("ttk_ms")),
                        _num(raw.get("preaim_deg")),
                        _num(raw.get("flick_deg")),
                        raw.get("flick_verdict"),
                        _bool_int(raw.get("first_shot_hit")),
                        _num(raw.get("firing_velocity")),
                        origin["x"] if origin else None,
                        origin["y"] if origin else None,
                        origin["z"] if origin else None,
                        end["x"] if end else None,
                        end["y"] if end else None,
                        end["z"] if end else None,
                        json.dumps(raw, ensure_ascii=False),
                    )
                )
            conn.executemany(
                """
                INSERT INTO engagements (
                    match_id, seq, result, round, team, reaction_ms, ttk_ms,
                    preaim_deg, flick_deg, flick_verdict, first_shot_hit,
                    firing_velocity, origin_x, origin_y, origin_z,
                    end_x, end_y, end_z, payload_json
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                rows,
            )
            conn.commit()
        finally:
            conn.close()

    global _last_ingest_at
    _last_ingest_at = time.time()
    return {"ok": True, "id": match_id, "engagements": len(engagements), "closed": closed}


def _fmt_packet_bytes(n: int) -> str:
    if n < 1024:
        return f"{n}b"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f}kb"
    return f"{n / (1024 * 1024):.1f}mb"


def _append_packet(src: str, nbytes: int, payload: dict[str, Any] | None, result: dict[str, Any]) -> None:
    global _packet_seq
    stamp = time.strftime("%H:%M:%S")
    tag = "file" if src == "file" else "ingest"
    error = str(result.get("error") or "").strip()
    if error or result.get("ok") is False:
        msg = f"error {error or 'failed'} {_fmt_packet_bytes(nbytes)}"
    elif result.get("ignored"):
        msg = f"ignored empty {_fmt_packet_bytes(nbytes)}"
    elif result.get("kind") == "hello":
        body = payload or {}
        ver = _clip_webapp_ver(body.get("Latest_WebApp_Ver")) or _clip_webapp_ver(
            body.get("latestWebAppVer")
        )
        msg = f"version {ver or '—'} · hello · {_fmt_packet_bytes(nbytes)}"
    else:
        body = payload or {}
        fights = result.get("engagements")
        if not isinstance(fights, int):
            raw_eng = body.get("engagements")
            fights = len(raw_eng) if isinstance(raw_eng, list) else 0
        state = "closed" if result.get("closed") else "live"
        mid = str(result.get("id") or body.get("id") or "")[:8]
        msg = f"{_map_label(str(body.get('map') or ''))} · {fights} fights · {state} · {_fmt_packet_bytes(nbytes)}"
        if mid:
            msg += f" · {mid}"
    text = f"[{stamp}] [{tag}] {msg}"
    with _packet_lock:
        _packet_seq += 1
        _packet_log.append({"seq": _packet_seq, "text": text})


def read_packet_log(after: int = 0) -> dict[str, Any]:
    try:
        cursor = int(after or 0)
    except (TypeError, ValueError):
        cursor = 0
    with _packet_lock:
        seq = _packet_seq
        items = list(_packet_log)
        url = _ingest_url
    if not items:
        return {"ok": True, "after": seq, "text": "", "reset": False, "url": url}
    oldest = int(items[0]["seq"])
    reset = cursor > 0 and cursor < oldest
    start = oldest - 1 if (reset or cursor < 0) else cursor
    text = "\n".join(str(item["text"]) for item in items if int(item["seq"]) > start)
    return {"ok": True, "after": seq, "text": text, "reset": reset, "url": url}


def _clip_webapp_ver(value: object) -> str:
    text = str(value or "").strip()
    if not text or len(text) > 32:
        return ""
    return text


def _note_latest_webapp_ver(payload: dict[str, Any]) -> None:
    global _latest_webapp_ver
    ver = _clip_webapp_ver(payload.get("Latest_WebApp_Ver")) or _clip_webapp_ver(
        payload.get("latestWebAppVer")
    )
    if ver:
        _latest_webapp_ver = ver


def _is_hello_payload(payload: dict[str, Any]) -> bool:
    kind = str(payload.get("kind") or "").strip().lower()
    if kind in {"hello", "version"}:
        return True
    if payload.get("id"):
        return False
    return bool(
        _clip_webapp_ver(payload.get("Latest_WebApp_Ver"))
        or _clip_webapp_ver(payload.get("latestWebAppVer"))
    )


def ingest_json_text(raw: str, *, src: str = "http", log: bool = True) -> dict[str, Any]:
    nbytes = len(raw.encode("utf-8")) if raw else 0
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("match JSON must be an object")
        _note_latest_webapp_ver(payload)
        if _is_hello_payload(payload):
            global _last_ingest_at
            _last_ingest_at = time.time()
            result = {"ok": True, "kind": "hello"}
            if log:
                _append_packet(src, nbytes, payload, result)
            return result
        result = ingest_match(payload)
        if log:
            _append_packet(src, nbytes, payload, result)
        return result
    except (json.JSONDecodeError, ValueError) as exc:
        if log:
            _append_packet(src, nbytes, None, {"ok": False, "error": str(exc)})
        raise


def _bytes_to_text(data: bytes) -> str:
    if not data:
        return ""
    return data.decode("utf-8", errors="replace")


def _path_text(path: Path) -> str:
    return _bytes_to_text(path.read_bytes())


def _sidecar_names() -> tuple[str, ...]:
    return (
        SIDECAR_ARCHIVE, SIDECAR_LAST, SIDECAR_CURRENT, SIDECAR_INGEST,
        LEGACY_ARCHIVE, *LEGACY_MATCH_JSON, LEGACY_INGEST,
    )


def _match_json_names() -> tuple[str, ...]:
    return (SIDECAR_CURRENT, SIDECAR_LAST, *LEGACY_MATCH_JSON)


def _archive_names() -> tuple[str, ...]:
    return (SIDECAR_ARCHIVE, LEGACY_ARCHIVE)


def _forget_sidecar(path: Path) -> None:
    try:
        _file_mtimes.pop(str(path.resolve()), None)
    except OSError:
        _file_mtimes.pop(str(path), None)


def _payload_id(raw: str) -> str:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return ""
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("id") or "").strip()


def _strip_match_from_sidecars(match_id: str) -> None:
    for folder in omega_dirs():
        for name in _archive_names():
            archive = folder / name
            if not archive.is_file():
                continue
            try:
                kept: list[str] = []
                for line in _path_text(archive).splitlines():
                    raw = line.strip()
                    if not raw:
                        continue
                    if _payload_id(raw) == match_id:
                        continue
                    kept.append(raw)
                archive.write_text(("\n".join(kept) + "\n") if kept else "", encoding="utf-8")
                _file_mtimes[str(archive.resolve())] = archive.stat().st_mtime
            except OSError:
                pass
        for name in _match_json_names():
            path = folder / name
            if not path.is_file():
                continue
            try:
                if _payload_id(_path_text(path)) == match_id:
                    path.unlink()
                    _forget_sidecar(path)
            except OSError:
                continue


def _wipe_sidecar_files() -> None:
    for folder in omega_dirs():
        for name in _sidecar_names():
            path = folder / name
            try:
                if path.is_file():
                    path.unlink()
                _forget_sidecar(path)
            except OSError:
                continue


def prune_ephemeral_matches() -> int:
    with _lock:
        conn = _connect()
        try:
            ids = [
                row[0]
                for row in conn.execute(
                    """
                    SELECT m.id
                    FROM matches m
                    LEFT JOIN engagements e ON e.match_id = m.id
                    GROUP BY m.id
                    HAVING COUNT(e.rowid) = 0
                       AND (
                            COALESCE(MAX(m.duration_ms), 0) < 1500
                            OR (
                                MAX(m.closed) = 1
                                AND COALESCE(MAX(m.duration_ms), 0) < 4000
                                AND COALESCE(MAX(m.kills), 0) = 0
                                AND COALESCE(MAX(m.deaths), 0) = 0
                            )
                            OR (
                                MAX(m.close_reason) = 'reset'
                                AND COALESCE(MAX(m.duration_ms), 0) < 10000
                            )
                       )
                    """
                )
            ]
            for match_id in ids:
                _purge_match_rows(conn, match_id)
            conn.commit()
            return len(ids)
        finally:
            conn.close()


def delete_match(match_id: str) -> None:
    match_id = str(match_id or "").strip()
    if not match_id:
        raise ValueError("match id required")
    now_ms = int(time.time() * 1000)
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO deleted_matches (id, deleted_at) VALUES (?, ?)",
                (match_id, now_ms),
            )
            _purge_match_rows(conn, match_id)
            conn.commit()
        finally:
            conn.close()
    _strip_match_from_sidecars(match_id)


def normalize_match_mode(value: object) -> str:
    key = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "prem": "prem_comp",
        "premcomp": "prem_comp",
        "premier": "prem_comp",
        "comp": "prem_comp",
        "competitive": "prem_comp",
        "dm": "deathmatch",
        "death_match": "deathmatch",
    }
    key = aliases.get(key, key)
    return key if key in MATCH_MODES else ""


def parse_match_modes(modes: object | None) -> set[str] | None:
    if modes is None:
        return None
    if not isinstance(modes, (list, tuple, set)):
        return set()
    allowed: set[str] = set()
    for item in modes:
        if item is None:
            allowed.add("")
            continue
        raw = str(item).strip()
        if raw == "" or raw.lower() in {"untagged", "none", "tag"}:
            allowed.add("")
            continue
        key = normalize_match_mode(raw)
        if key:
            allowed.add(key)
    return allowed


def set_match_mode(match_id: str, mode: object) -> None:
    match_id = str(match_id or "").strip()
    if not match_id:
        raise ValueError("match id required")
    key = normalize_match_mode(mode) or None
    with _lock:
        conn = _connect()
        try:
            cur = conn.execute("UPDATE matches SET mode = ? WHERE id = ?", (key, match_id))
            if cur.rowcount == 0:
                raise ValueError("match not found")
            conn.commit()
        finally:
            conn.close()
    _strip_match_from_sidecars(match_id)


def clear_telemetry() -> None:
    with _lock:
        conn = _connect()
        try:
            conn.execute("DELETE FROM engagements")
            conn.execute("DELETE FROM matches")
            conn.execute("DELETE FROM deleted_matches")
            conn.commit()
        finally:
            conn.close()
    _wipe_sidecar_files()


def write_ingest_pointer(url: str) -> None:
    body = json.dumps({"url": url, "port": urlparse(url).port}, indent=2)
    folder = omega_dash_dir()
    if folder is None:
        return
    try:
        folder.mkdir(parents=True, exist_ok=True)
        (folder / SIDECAR_INGEST).write_text(body, encoding="utf-8")
    except OSError:
        return


def steam_inventory_capture_url() -> str:
    base = _ingest_url.rsplit("/", 1)[0]
    return f"{base}/steam-inventory"


def prepare_steam_inventory_capture() -> None:
    global _steam_inv_status, _steam_inv_retry_after, _steam_inv_body
    with _steam_inv_lock:
        _steam_inv_event.clear()
        _steam_inv_status = 0
        _steam_inv_retry_after = ""
        _steam_inv_body = ""


def store_steam_inventory_capture(status: int, retry_after: str, body: str) -> None:
    global _steam_inv_status, _steam_inv_retry_after, _steam_inv_body
    with _steam_inv_lock:
        _steam_inv_status = int(status or 0)
        _steam_inv_retry_after = str(retry_after or "")
        _steam_inv_body = str(body or "")
        _steam_inv_event.set()


def take_steam_inventory_capture(timeout: float = 60) -> tuple[int, str, str]:
    if not _steam_inv_event.wait(timeout):
        raise TimeoutError("Steam inventory request timed out.")
    with _steam_inv_lock:
        return _steam_inv_status, _steam_inv_retry_after, _steam_inv_body


def import_local_files() -> int:
    imported = 0
    seen: set[str] = set()
    for folder in omega_dirs():
        for name in _match_json_names():
            path = folder / name
            if not path.is_file():
                continue
            key = str(path.resolve())
            if key in seen:
                continue
            seen.add(key)
            try:
                ingest_json_text(_path_text(path), src="file", log=False)
                imported += 1
                _file_mtimes[key] = path.stat().st_mtime
            except (OSError, json.JSONDecodeError, ValueError):
                continue
        for name in _archive_names():
            archive = folder / name
            if not archive.is_file():
                continue
            key = str(archive.resolve())
            if key in seen:
                continue
            seen.add(key)
            try:
                for line in _path_text(archive).splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ingest_json_text(line, src="file", log=False)
                        imported += 1
                    except (json.JSONDecodeError, ValueError):
                        continue
                _file_mtimes[key] = archive.stat().st_mtime
            except OSError:
                continue
    return imported


def watch_local_files(interval: float = 2.0) -> None:
    while not _watch_stop.wait(interval):
        for folder in omega_dirs():
            for name in _match_json_names():
                path = folder / name
                if not path.is_file():
                    continue
                key = str(path.resolve())
                try:
                    mtime = path.stat().st_mtime
                except OSError:
                    continue
                if _file_mtimes.get(key) == mtime:
                    continue
                try:
                    ingest_json_text(_path_text(path), src="file")
                    _file_mtimes[key] = mtime
                except (OSError, json.JSONDecodeError, ValueError):
                    _file_mtimes[key] = mtime


class _IngestHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        return

    def _cors(self) -> None:
        origin = str(self.headers.get("Origin") or "").strip()
        if origin.startswith("https://steamcommunity.com"):
            self.send_header("Access-Control-Allow-Origin", origin)
        else:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Steam-Status, X-Steam-Retry-After")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] in ("/health", "/"):
            body = json.dumps({"ok": True, "url": _ingest_url, "lastIngestAt": _last_ingest_at})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))
            return
        if self.path.split("?", 1)[0] == "/api/state":
            body = json.dumps(get_dashboard_state())
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))
            return
        self.send_response(404)
        self._cors()
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        route = self.path.split("?", 1)[0]
        if route == "/steam-inventory":
            length = int(self.headers.get("Content-Length") or 0)
            raw = _bytes_to_text(self.rfile.read(length)) if length else ""
            try:
                status = int(self.headers.get("X-Steam-Status") or 200)
            except (TypeError, ValueError):
                status = 200
            store_steam_inventory_capture(
                status,
                str(self.headers.get("X-Steam-Retry-After") or ""),
                raw,
            )
            self.send_response(204)
            self._cors()
            self.end_headers()
            return
        if route not in ("/ingest", "/telemetry"):
            self.send_response(404)
            self._cors()
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = _bytes_to_text(self.rfile.read(length)) if length else ""
        try:
            result = ingest_json_text(raw)
            body = json.dumps(result)
            self.send_response(200)
        except (json.JSONDecodeError, ValueError) as exc:
            body = json.dumps({"ok": False, "error": str(exc)})
            self.send_response(400)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))


def start_http() -> str:
    global _http, _ingest_url
    last_error: OSError | None = None
    for port in range(INGEST_PORT, INGEST_PORT + 8):
        try:
            server = ThreadingHTTPServer((INGEST_HOST, port), _IngestHandler)
            _http = server
            _ingest_url = f"http://{INGEST_HOST}:{port}/ingest"
            thread = threading.Thread(target=server.serve_forever, daemon=True, name="omega-ingest")
            thread.start()
            write_ingest_pointer(_ingest_url)
            return _ingest_url
        except OSError as exc:
            last_error = exc
            continue
    raise RuntimeError(f"Could not bind ingest port: {last_error}")


def start_watch() -> None:
    thread = threading.Thread(target=watch_local_files, daemon=True, name="omega-watch")
    thread.start()


def start() -> str:
    load_omega_root()
    init_db()
    import_local_files()
    prune_ephemeral_matches()
    url = start_http()
    start_watch()
    return url


def stop() -> None:
    global _http
    _watch_stop.set()
    server = _http
    _http = None
    if server is None:
        return

    def _halt() -> None:
        try:
            server.shutdown()
        except Exception:
            pass
        try:
            server.server_close()
        except Exception:
            pass

    thread = threading.Thread(target=_halt, name="omega-http-stop", daemon=True)
    thread.start()
    thread.join(1.5)


def _map_label(raw: str | None) -> str:
    if not raw:
        return "Unknown"
    name = raw.strip()
    key = name.lower().replace("\\", "/").split("/")[-1]
    if key in MAP_LABELS:
        return MAP_LABELS[key]
    pretty = key.replace("de_", "").replace("cs_", "")
    return pretty[:1].upper() + pretty[1:] if pretty else name


def _fmt_duration(ms: int | None) -> str:
    if not ms or ms < 0:
        return "--"
    seconds = int(ms / 1000)
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)
    if hours:
        return f"{hours}h {minutes}m"
    if minutes:
        return f"{minutes}m"
    return f"{seconds}s"


def _fmt_date(wall_ms: int | None) -> str:
    if not wall_ms:
        return ""
    stamp = wall_ms / 1000
    now = time.time()
    local = time.localtime(stamp)
    today = time.localtime(now)
    clock = time.strftime("%H:%M", local)
    if local.tm_yday == today.tm_yday and local.tm_year == today.tm_year:
        return f"Today, {clock}"
    return time.strftime("%d %b", local) + f", {clock}"


def _safe_div(num: float, den: float) -> float:
    if not den:
        return 0.0
    return num / den


def _pct_change(current: float, previous: float) -> float | None:
    if previous == 0:
        return None
    return round((current - previous) / abs(previous) * 100, 1)


def _land_tol(distance: float | None) -> float:
    if not distance or distance <= 1:
        return LAND_TOL_MAX_DEG
    deg = math.degrees(math.atan(TARGET_RADIUS / distance))
    return max(LAND_TOL_FLOOR_DEG, min(LAND_TOL_MAX_DEG, deg))


def _flick_plot_point(eng: dict[str, Any]) -> dict[str, Any] | None:
    """Plot real degrees: under left, over right, on-target near the origin."""
    landing = _landing_key(eng)
    if landing not in ("target", "under", "over"):
        return None
    miss = _landing_error_deg(eng)
    error = _num(eng.get("flick_error_deg"))
    yaw = _num(eng.get("flick_land_yaw"))
    pitch = _num(eng.get("flick_land_pitch"))
    if miss is None and error is not None:
        miss = abs(error)
    if miss is None and yaw is None and pitch is None:
        return None
    if miss is None:
        miss = math.hypot(yaw or 0.0, pitch or 0.0)

    if landing == "target":
        along = yaw or 0.0
        vert = pitch or 0.0
    elif landing == "over":
        along = miss
        vert = pitch if pitch is not None else 0.0
    else:
        along = -miss
        vert = pitch if pitch is not None else 0.0

    x_max, y_max = 4.5, 2.5
    clipped = abs(along) > x_max or abs(vert) > y_max
    distance = _num(eng.get("distance")) or _num(eng.get("preaim_distance"))
    cone = _land_tol(distance) + LAND_TOL_SLACK_DEG
    return {
        "x": round(along, 2),
        "y": round(vert, 2),
        "alongDeg": round(along, 2),
        "vertDeg": round(vert, 2),
        "fovDeg": round(miss, 2),
        "coneDeg": round(cone, 2) if cone else 0.0,
        "clipped": clipped,
    }


def _flick_plot_xy(eng: dict[str, Any]) -> tuple[float, float] | None:
    point = _flick_plot_point(eng)
    if point is None:
        return None
    return point["x"], point["y"]


def _landing_error_deg(eng: dict[str, Any]) -> float | None:
    end_deg = _num(eng.get("flick_end_deg"))
    if end_deg is not None:
        return abs(end_deg)
    yaw = _num(eng.get("flick_land_yaw"))
    pitch = _num(eng.get("flick_land_pitch"))
    if yaw is None or pitch is None:
        return None
    return math.hypot(yaw, pitch)


def _empty_flick_stats() -> dict[str, int]:
    return {"target": 0, "under": 0, "over": 0, "clipped": 0, "total": 0}


def _add_flick_stat(bucket: dict[str, int], landing: str, clipped: bool) -> None:
    if landing not in ("target", "under", "over"):
        return
    bucket[landing] += 1
    bucket["total"] += 1
    if clipped:
        bucket["clipped"] += 1


def _flick_stamp_row(match: dict[str, Any]) -> dict[str, Any]:
    return {
        "started_wall_ms": match.get("startedWallMs"),
        "ingested_at": match.get("ingestedAt"),
    }


def _flick_days_ago(match: dict[str, Any], now_ms: int) -> float | None:
    stamp = _row_stamp_ms(_flick_stamp_row(match))
    if not stamp:
        return None
    return max(0.0, (now_ms - stamp) / 86_400_000)


def _collect_flicks(
    matches: list[dict[str, Any]],
    engagement_map: dict[str, list[dict[str, Any]]],
    now_ms: int,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, int]]]:
    """Every graded opening flick for side totals; newest N dots for the graph."""
    stats = {key: _empty_flick_stats() for key in ("7", "30", "all")}
    points: list[dict[str, Any]] = []
    for match in matches:
        stamp_row = _flick_stamp_row(match)
        in7 = _in_window(stamp_row, now_ms, 7)
        in30 = _in_window(stamp_row, now_ms, 30)
        days_ago = _flick_days_ago(match, now_ms)
        for eng in engagement_map.get(match["id"], []):
            if not _aim_scored(eng) or not _flick_detected(eng) or eng.get("preaim_shot"):
                continue
            xy = _flick_plot_point(eng)
            if xy is None:
                continue
            landing = _landing_key(eng)
            clipped = bool(xy.get("clipped"))
            if in7:
                _add_flick_stat(stats["7"], landing, clipped)
            if in30:
                _add_flick_stat(stats["30"], landing, clipped)
            _add_flick_stat(stats["all"], landing, clipped)
            if len(points) < FLICK_POINTS_PLOT:
                point = {**xy, "type": landing}
                if days_ago is not None:
                    point["daysAgo"] = round(days_ago, 4)
                points.append(point)
    return points, stats


def _flick_detected(eng: dict[str, Any]) -> bool:
    """True when this fight has a graded throw. 0° / missing is not a land."""
    if not isinstance(eng, dict) or eng.get("unattributed"):
        return False
    if eng.get("flick_detected") is False:
        return False
    deg = _num(eng.get("flick_deg"))
    if deg is None or deg < 1.5:
        return False
    if eng.get("flick_detected") is True:
        return True
    return bool(eng.get("flick_verdict"))


def _landing_key(eng: dict[str, Any]) -> str:
    if eng.get("unattributed"):
        return "unattributed"
    if not _flick_detected(eng):
        return "none"
    if eng.get("preaim_shot"):
        return "target"
    verdict = str(eng.get("flick_verdict") or "")
    # Lua latches overshoot when the throw goes past. A later correction can
    # land on the bot (tiny flick_end_deg) — that must not become on-target.
    if verdict == "overshoot":
        return "over"
    if verdict == "undershoot":
        return "under"
    if verdict == "on target":
        return "target"
    error = _num(eng.get("flick_error_deg"))
    if error is not None:
        return "over" if error < 0 else "under"
    return "target"


def _head_cone(distance: float | None) -> float:
    if not distance or distance <= 1:
        return 3.0 + HEAD_LEVEL_SLACK_DEG
    deg = math.degrees(math.atan(HEAD_RADIUS / distance))
    return max(0.15, min(3.0, deg)) + HEAD_LEVEL_SLACK_DEG


def _is_head_level(eng: dict[str, Any]) -> bool:
    """Pitch-only: crosshair height was already at their head on first peek."""
    pitch = _num(eng.get("preaim_pitch"))
    if pitch is not None:
        return abs(pitch) <= _head_cone(_num(eng.get("preaim_distance")))
    flagged = eng.get("head_level")
    if flagged is True:
        return True
    if flagged is False:
        return False
    return False


def _weapon_known(weapon_id: int | None, name: str) -> bool:
    if weapon_id is not None:
        return True
    cleaned = (name or "").strip()
    return bool(cleaned) and cleaned.casefold() not in {"unknown", "other"}


def _weapon_meta(eng: dict[str, Any]) -> tuple[int | None, str, str]:
    weapon_id = _int(eng.get("weapon_id"))
    name = str(eng.get("weapon_name") or "").strip()
    class_name = str(eng.get("weapon_class") or "").strip()
    if name.casefold() == "unknown":
        name = ""
    if weapon_id in KNIFE_IDS:
        return weapon_id, name or "Knife", class_name or "knife"
    if weapon_id in WEAPON_CATALOG:
        catalog_name, catalog_class = WEAPON_CATALOG[weapon_id]
        return weapon_id, name or catalog_name, class_name or catalog_class
    if not name and weapon_id is not None:
        name = f"weapon_{weapon_id}"
    if not name and not class_name:
        return weapon_id, "", ""
    return weapon_id, name, class_name or "other"


def _is_awp(eng: dict[str, Any]) -> bool:
    weapon_id, name, _class = _weapon_meta(eng)
    if weapon_id == 9:
        return True
    return str(name or "").casefold() in {"awp", "weapon_awp"}


def _cs_limit(eng: dict[str, Any]) -> float:
    weapon_id, _name, class_name = _weapon_meta(eng)
    if weapon_id in MOBILE_PISTOL_IDS or class_name == "smg":
        return CS_LIMIT_SMG
    if weapon_id in HEAVY_PISTOL_IDS:
        return CS_LIMIT_HEAVY_PISTOL
    return CS_LIMIT_RIFLE


def _cs_ok(eng: dict[str, Any]) -> bool | None:
    vel = _num(eng.get("firing_velocity"))
    if vel is None:
        stored = eng.get("counterstrafe_ok")
        if stored is None:
            return None
        return bool(stored)
    return vel < _cs_limit(eng)


def _load_rows() -> tuple[list[dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    with _lock:
        conn = _connect()
        try:
            matches = [dict(row) for row in conn.execute("SELECT * FROM matches ORDER BY ingested_at DESC")]
            engagements: dict[str, list[dict[str, Any]]] = {}
            for row in conn.execute("SELECT * FROM engagements ORDER BY match_id, seq"):
                item = dict(row)
                raw = json.loads(item["payload_json"]) if item.get("payload_json") else {}
                if not isinstance(raw, dict):
                    raw = {}
                raw["_seq"] = item["seq"]
                engagements.setdefault(item["match_id"], []).append(raw)
        finally:
            conn.close()
    return matches, engagements


def _zero_based_rounds(engagements: list[dict[str, Any]]) -> bool:
    nums = [_int(item.get("round")) for item in engagements]
    nums = [n for n in nums if n is not None]
    return bool(nums) and min(nums) == 0


def _round_display(value: Any, offset: int) -> int | None:
    rnd = _int(value)
    if rnd is None or rnd < 0:
        return None
    return rnd + offset


def _aim_scored(eng: dict[str, Any]) -> bool:
    return not eng.get("unattributed")


def _preaim_eligible(eng: dict[str, Any]) -> bool:
    """A real peek: not a kill-transfer and not someone else's fight."""
    if not _aim_scored(eng):
        return False
    if eng.get("preaim_already_visible") or eng.get("preaim_occupied"):
        return False
    return True


def _preaim_scored(eng: dict[str, Any]) -> bool:
    if not _preaim_eligible(eng):
        return False
    if eng.get("preaim_settled") is False:
        return False
    return _num(eng.get("preaim_deg")) is not None


def _ui_engagement(raw: dict[str, Any], seq: int, round_offset: int = 0) -> dict[str, Any]:
    detected = _flick_detected(raw)
    landing = _landing_key(raw)
    out = dict(raw)
    out["id"] = seq
    out["seq"] = seq
    out["round"] = _round_display(raw.get("round"), round_offset)
    held = bool(raw.get("preaim_already_visible") or raw.get("preaim_occupied"))
    out["preaimHeld"] = held
    out["preaim"] = round(_num(raw.get("preaim_deg")) or 0, 1)
    out["flickDetected"] = detected
    out["flick"] = round(_num(raw.get("flick_deg")), 1) if detected and _num(raw.get("flick_deg")) is not None else None
    out["landing"] = landing
    out["landingDeg"] = round(_num(raw.get("flick_end_deg")) or 0, 2) if detected else None
    out["reaction"] = int(round(_num(raw.get("reaction_ms")) or 0))
    ttk = _num(raw.get("ttk_ms"))
    out["ttk"] = int(round(ttk)) if ttk is not None else None
    out["firstShot"] = bool(raw.get("first_shot_hit"))
    out["velocity"] = round(_num(raw.get("firing_velocity")) or 0, 1)
    pe = _path_eff(raw)
    out["pathEff"] = round(pe) if pe is not None else None
    weapon_id, weapon_name, weapon_class = _weapon_meta(raw)
    out["weaponId"] = weapon_id
    out["weapon"] = weapon_name
    out["weaponClass"] = weapon_class
    out["headLevel"] = _is_head_level(raw)
    out["unattributed"] = bool(raw.get("unattributed"))
    out["unattributedWhy"] = raw.get("unattributed_why") or raw.get("why")
    if out["unattributed"]:
        out["landing"] = "unattributed"
        out["preaimHeld"] = False
        out["firstShot"] = None
        out["reaction"] = None
        out["flick"] = None
        out["flickDetected"] = False
        out["preaim"] = None
        out["pathEff"] = None
        out["ttk"] = None
        out["velocity"] = None
        out["landingDeg"] = None
    return out


def _locations(engagements: list[dict[str, Any]], round_offset: int = 0) -> list[dict[str, Any]]:
    points = []
    for i, eng in enumerate(engagements, start=1):
        result = str(eng.get("result") or "")
        kind = "kill" if result == "KILL" else "death" if result == "DEATH" else None
        if not kind:
            continue
        pos = _vec(eng.get("end_origin")) or _vec(eng.get("origin"))
        if not pos:
            continue
        points.append(
            {
                "id": i,
                "type": kind,
                "worldX": pos["x"],
                "worldY": pos["y"],
                "worldZ": pos["z"],
                "x": pos["x"],
                "y": pos["y"],
                "round": _round_display(eng.get("round"), round_offset),
            }
        )
    return points


def _side_split(row: dict[str, Any], engagements: list[dict[str, Any]]) -> dict[str, Any]:
    sides = {
        "ct": {"rounds": set(), "kills": 0, "deaths": 0, "reaction": [], "kd": 0, "reaction_avg": 0},
        "t": {"rounds": set(), "kills": 0, "deaths": 0, "reaction": [], "kd": 0, "reaction_avg": 0},
    }
    for eng in engagements:
        team = _int(eng.get("team"))
        key = "ct" if team == TEAM_CT else "t" if team == TEAM_T else None
        if not key:
            continue
        rnd = _int(eng.get("round"))
        if rnd is not None:
            sides[key]["rounds"].add(rnd)
        if eng.get("result") == "KILL":
            sides[key]["kills"] += 1
        elif eng.get("result") == "DEATH":
            sides[key]["deaths"] += 1
        if _aim_scored(eng) and eng.get("reaction_valid") is not False and _num(eng.get("reaction_ms")) is not None:
            sides[key]["reaction"].append(_num(eng.get("reaction_ms")) or 0)

    def pack(side: dict[str, Any]) -> dict[str, Any]:
        deaths = side["deaths"] or 0
        kd = round(_safe_div(side["kills"], deaths or 1 if side["kills"] else 0) if (side["kills"] or deaths) else 0, 2)
        if side["kills"] and not deaths:
            kd = float(side["kills"])
        rx = int(round(sum(side["reaction"]) / len(side["reaction"]))) if side["reaction"] else 0
        return {"rounds": len(side["rounds"]), "kd": kd, "reaction": rx}

    packed = {"ct": pack(sides["ct"]), "t": pack(sides["t"])}
    if packed["ct"]["rounds"] == 0 and packed["t"]["rounds"] == 0:
        team = _int(row.get("team"))
        rounds = _int(row.get("rounds")) or 0
        if team == TEAM_CT:
            packed["ct"]["rounds"] = rounds
        elif team == TEAM_T:
            packed["t"]["rounds"] = rounds
    return packed


def _path_eff(eng: dict[str, Any]) -> float | None:
    stored = _num(eng.get("path_eff"))
    if stored is not None:
        return max(0.0, min(100.0, stored))
    path_deg = _num(eng.get("path_deg"))
    flick = _num(eng.get("flick_deg"))
    if path_deg is None or path_deg <= 0.01 or flick is None:
        return None
    return max(0.0, min(100.0, flick / path_deg * 100.0))


def _match_aim(engagements: list[dict[str, Any]]) -> dict[str, Any]:
    reactions = []
    ttks = []
    preaims = []
    first_hits = 0
    first_n = 0
    cs_ok = 0
    cs_n = 0
    land = {"under": 0, "target": 0, "over": 0}
    preaimed = 0
    head_n = 0
    head_ok = 0
    paths = []
    eligible = 0
    for eng in engagements:
        if not _aim_scored(eng):
            continue
        if _preaim_eligible(eng):
            eligible += 1
        if eng.get("reaction_valid") is not False and _num(eng.get("reaction_ms")) is not None:
            reactions.append(_num(eng.get("reaction_ms")) or 0)
        if _num(eng.get("ttk_ms")) is not None:
            ttks.append(_num(eng.get("ttk_ms")) or 0)
        if _preaim_scored(eng):
            preaims.append(_num(eng.get("preaim_deg")) or 0)
            if not _is_awp(eng):
                head_n += 1
                if _is_head_level(eng):
                    head_ok += 1
        if eng.get("first_shot_hit") is not None:
            first_n += 1
            if eng.get("first_shot_hit"):
                first_hits += 1
        ok = _cs_ok(eng)
        if ok is not None:
            cs_n += 1
            if ok:
                cs_ok += 1
        if eng.get("preaim_shot"):
            preaimed += 1
        elif _flick_detected(eng):
            land[_landing_key(eng)] = land.get(_landing_key(eng), 0) + 1
        pe = _path_eff(eng)
        if pe is not None:
            paths.append(pe)
    total_land = sum(land.values()) or 1
    return {
        "reaction": int(round(sum(reactions) / len(reactions))) if reactions else 0,
        "ttk": int(round(sum(ttks) / len(ttks))) if ttks else 0,
        "preaim": round(sum(preaims) / len(preaims), 1) if preaims else 0,
        "firstShot": round(_safe_div(first_hits, first_n) * 100, 1) if first_n else 0,
        "counterStrafe": round(_safe_div(cs_ok, cs_n) * 100, 1) if cs_n else 0,
        "pathEff": round(sum(paths) / len(paths), 1) if paths else 0,
        "landing": {
            "under": round(land["under"] / total_land * 100),
            "target": round(land["target"] / total_land * 100),
            "over": round(land["over"] / total_land * 100),
        },
        "preAimed": round(_safe_div(preaimed, eligible) * 100, 1) if eligible else 0,
        "headLevel": round(_safe_div(head_ok, head_n) * 100, 1) if head_n else 0,
        "reactionN": len(reactions),
        "ttkN": len(ttks),
    }


def _payload_dict(row: dict[str, Any]) -> dict[str, Any]:
    raw = row.get("payload_json")
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _as_rows(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=lambda key: int(key) if str(key).isdigit() else str(key))
        return [value[key] for key in keys]
    return []


def _ui_board_row(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name") or "Player").strip()[:32] or "Player"
    kills = _int(raw.get("kills")) or 0
    deaths = _int(raw.get("deaths")) or 0
    assists = _int(raw.get("assists")) or 0
    damage = _int(raw.get("dmg") if raw.get("dmg") is not None else raw.get("damage")) or 0
    rounds = _int(raw.get("rounds"))
    adr = _num(raw.get("adr"))
    if adr is None:
        adr = round(_safe_div(damage, rounds), 1) if rounds else damage
    kd = _num(raw.get("kd"))
    if kd is None:
        kd = round(_safe_div(kills, deaths) if deaths else float(kills), 2)
    team = _int(raw.get("team"))
    health = _int(raw.get("health"))
    if health is None:
        health = 0
    health = max(0, min(health, 200))
    money = _int(raw.get("money"))
    armor = _int(raw.get("armor")) or 0
    headshots = _int(raw.get("headshots") if raw.get("headshots") is not None else raw.get("hs_kills")) or 0
    hs = _num(raw.get("hs") if raw.get("hs") is not None else raw.get("hs_pct"))
    if hs is None:
        hs = round(_safe_div(headshots, kills) * 100, 1) if kills else 0.0
    return {
        "id": _int(raw.get("id")) or name,
        "name": name,
        "team": team,
        "you": bool(raw.get("you")),
        "alive": bool(raw.get("alive")) if raw.get("alive") is not None else health > 0,
        "health": health,
        "money": money,
        "armor": max(0, min(armor, 200)),
        "helmet": bool(raw.get("helmet")),
        "kit": bool(raw.get("kit") or raw.get("defuser")),
        "primary": str(raw.get("primary") or "").strip() or None,
        "primaryId": _int(raw.get("primary_id") if raw.get("primary_id") is not None else raw.get("primaryId")),
        "secondary": str(raw.get("secondary") or "").strip() or None,
        "secondaryId": _int(raw.get("secondary_id") if raw.get("secondary_id") is not None else raw.get("secondaryId")),
        "kills": kills,
        "deaths": deaths,
        "assists": assists,
        "kd": round(float(kd), 2),
        "headshots": headshots,
        "hs": round(float(hs), 1),
        "dmg": damage,
        "adr": round(float(adr), 1) if adr is not None else 0,
        "ud": _int(raw.get("ud") if raw.get("ud") is not None else raw.get("utility")) or 0,
        "flashed": _int(raw.get("flashed")) or 0,
        "steam64": _steam64(raw.get("steam64") if raw.get("steam64") is not None else raw.get("steam_id")),
    }


def _ui_scoreboard(row: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any] | None:
    raw = payload.get("scoreboard") if isinstance(payload, dict) else None
    if not isinstance(raw, dict):
        return None
    you = [item for item in (_ui_board_row(item) for item in _as_rows(raw.get("you"))) if item]
    them = [item for item in (_ui_board_row(item) for item in _as_rows(raw.get("them"))) if item]
    if not you and not them:
        return None
    team = _int(raw.get("team")) or _int(row.get("team"))
    score_ct = _int(raw.get("score_ct") if raw.get("score_ct") is not None else raw.get("scoreCt"))
    if score_ct is None:
        score_ct = _int(row.get("score_ct"))
    score_t = _int(raw.get("score_t") if raw.get("score_t") is not None else raw.get("scoreT"))
    if score_t is None:
        score_t = _int(row.get("score_t"))
    rounds = _int(raw.get("rounds")) or _int(row.get("rounds")) or 0
    return {
        "team": team,
        "scoreCt": score_ct,
        "scoreT": score_t,
        "rounds": rounds,
        "you": you,
        "them": them,
    }


def _ui_match(row: dict[str, Any], engagements: list[dict[str, Any]]) -> dict[str, Any]:
    kills = _int(row.get("kills")) or 0
    deaths = _int(row.get("deaths")) or 0
    assists = _int(row.get("assists")) or 0
    headshots = _int(row.get("headshots")) or 0
    damage = _int(row.get("damage")) or 0
    rounds = _int(row.get("rounds")) or 0
    team = _int(row.get("team"))
    score_ct = _int(row.get("score_ct"))
    score_t = _int(row.get("score_t"))
    own = score_ct if team == TEAM_CT else score_t if team == TEAM_T else score_ct
    enemy = score_t if team == TEAM_CT else score_ct if team == TEAM_T else score_t
    won = None
    if own is not None and enemy is not None:
        won = own > enemy
    if own is None:
        own = "--"
    if enemy is None:
        enemy = "--"
    aim = _match_aim(engagements)
    round_offset = 1 if _zero_based_rounds(engagements) else 0
    ui_eng = [_ui_engagement(eng, i, round_offset) for i, eng in enumerate(engagements, start=1)]
    closed = bool(row.get("closed") or row.get("ended_at"))
    return {
        "id": row["id"],
        "map": _map_label(row.get("map")),
        "mapId": row.get("map"),
        "date": _fmt_date(_int(row.get("started_wall_ms")) or _int(row.get("ingested_at"))),
        "duration": _fmt_duration(_int(row.get("duration_ms"))),
        "durationMs": _int(row.get("duration_ms")) or 0,
        "won": bool(won) if won is not None else False,
        "draw": won is None,
        "score": f"{own} : {enemy}",
        "kills": kills,
        "deaths": deaths,
        "assists": assists,
        "kd": round(_safe_div(kills, deaths) if deaths else float(kills), 2),
        "hs": round(_safe_div(headshots, kills) * 100, 1) if kills else 0,
        "adr": round(_safe_div(damage, rounds), 1) if rounds else damage,
        "reaction": aim["reaction"],
        "firstShot": round(aim["firstShot"]),
        "counterStrafe": round(aim["counterStrafe"]),
        "preaim": aim["preaim"],
        "ttk": aim["ttk"],
        "headLevel": aim["headLevel"],
        "pathEff": aim["pathEff"],
        "landing": aim["landing"],
        "side": _side_split(row, engagements),
        "engagements": ui_eng,
        "locations": _locations(engagements, round_offset),
        "rounds": rounds,
        "live": not closed,
        "closeReason": row.get("close_reason"),
        "startedWallMs": _int(row.get("started_wall_ms")),
        "ingestedAt": _int(row.get("ingested_at")),
        "scoreboard": _ui_scoreboard(row, _payload_dict(row)),
        "scoreCt": score_ct,
        "scoreT": score_t,
        "team": team,
        "mode": normalize_match_mode(row.get("mode")),
    }


def _aggregate(matches: list[dict[str, Any]], engagement_map: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    kills = sum(_int(m.get("kills")) or 0 for m in matches)
    deaths = sum(_int(m.get("deaths")) or 0 for m in matches)
    headshots = sum(_int(m.get("headshots")) or 0 for m in matches)
    hours = sum(_int(m.get("duration_ms")) or 0 for m in matches) / 3_600_000
    reactions = []
    first_hits = 0
    first_n = 0
    cs_ok = 0
    cs_n = 0
    velocities = []
    moving = 0
    vel_n = 0
    preaims = []
    head_level = 0
    head_n = 0
    preaim_n = 0
    preaimed = 0
    fights = 0
    eligible = 0
    paths = []
    for match in matches:
        for eng in engagement_map.get(match["id"], []):
            fights += 1
            if not _aim_scored(eng):
                continue
            if _preaim_eligible(eng):
                eligible += 1
            if eng.get("reaction_valid") is not False and _num(eng.get("reaction_ms")) is not None:
                reactions.append(_num(eng.get("reaction_ms")) or 0)
            if eng.get("first_shot_hit") is not None:
                first_n += 1
                if eng.get("first_shot_hit"):
                    first_hits += 1
            ok = _cs_ok(eng)
            if ok is not None:
                cs_n += 1
                if ok:
                    cs_ok += 1
            vel = _num(eng.get("firing_velocity"))
            if vel is not None:
                velocities.append(vel)
                vel_n += 1
                if not ok:
                    moving += 1
            if _preaim_scored(eng):
                preaims.append(_num(eng.get("preaim_deg")) or 0)
                preaim_n += 1
                if not _is_awp(eng):
                    head_n += 1
                    if _is_head_level(eng):
                        head_level += 1
            if eng.get("preaim_shot"):
                preaimed += 1
            pe = _path_eff(eng)
            if pe is not None:
                paths.append(pe)
    return {
        "matches": len(matches),
        "engagements": fights,
        "hoursTracked": round(hours, 1),
        "kd": round(_safe_div(kills, deaths) if deaths else float(kills), 2),
        "hs": round(_safe_div(headshots, kills) * 100, 1) if kills else 0.0,
        "reaction": int(round(sum(reactions) / len(reactions))) if reactions else 0,
        "firstShot": round(_safe_div(first_hits, first_n) * 100, 1) if first_n else 0.0,
        "counterStrafe": round(_safe_div(cs_ok, cs_n) * 100, 1) if cs_n else 0.0,
        "pathEff": round(sum(paths) / len(paths), 1) if paths else 0.0,
        "avgVelocity": round(sum(velocities) / len(velocities), 1) if velocities else 0.0,
        "movingShots": round(_safe_div(moving, vel_n) * 100, 1) if vel_n else 0.0,
        "placementOffset": round(sum(preaims) / len(preaims), 1) if preaims else 0.0,
        "headLevel": round(_safe_div(head_level, head_n) * 100) if head_n else 0,
        "preAimed": round(_safe_div(preaimed, eligible) * 100) if eligible else 0,
    }


def _row_stamp_ms(row: dict[str, Any]) -> int:
    return _int(row.get("started_wall_ms")) or _int(row.get("ingested_at")) or 0


def _in_window(row: dict[str, Any], now_ms: int, days: int | None) -> bool:
    if days is None:
        return True
    return _row_stamp_ms(row) >= now_ms - days * 86_400_000


def _in_prev_window(row: dict[str, Any], now_ms: int, days: int) -> bool:
    stamp = _row_stamp_ms(row)
    older = now_ms - days * 86_400_000
    newer = now_ms - 2 * days * 86_400_000
    return newer <= stamp < older


def _weapon_rows(engagement_map: dict[str, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    total = 0
    for engagements in engagement_map.values():
        for eng in engagements:
            weapon_id, name, class_name = _weapon_meta(eng)
            if not _weapon_known(weapon_id, name):
                continue
            total += 1
            key = str(weapon_id) if weapon_id is not None else name
            bucket = buckets.get(key)
            if not bucket:
                bucket = {
                    "id": key,
                    "weaponId": weapon_id,
                    "name": name,
                    "class": class_name,
                    "fights": 0,
                    "kills": 0,
                    "deaths": 0,
                    "reactions": [],
                    "ttks": [],
                    "preaims": [],
                    "head_n": 0,
                    "head_ok": 0,
                    "first_n": 0,
                    "first_hits": 0,
                    "cs_n": 0,
                    "cs_ok": 0,
                    "land": {"under": 0, "target": 0, "over": 0},
                    "preaimed": 0,
                    "eligible": 0,
                }
                buckets[key] = bucket
            bucket["fights"] += 1
            if _preaim_eligible(eng):
                bucket["eligible"] += 1
            if eng.get("result") == "KILL":
                bucket["kills"] += 1
            elif eng.get("result") == "DEATH":
                bucket["deaths"] += 1
            if eng.get("reaction_valid") is not False and _num(eng.get("reaction_ms")) is not None:
                bucket["reactions"].append(_num(eng.get("reaction_ms")) or 0)
            if _num(eng.get("ttk_ms")) is not None:
                bucket["ttks"].append(_num(eng.get("ttk_ms")) or 0)
            if _preaim_scored(eng):
                bucket["preaims"].append(_num(eng.get("preaim_deg")) or 0)
                if not _is_awp(eng):
                    bucket["head_n"] += 1
                    if _is_head_level(eng):
                        bucket["head_ok"] += 1
            if eng.get("first_shot_hit") is not None:
                bucket["first_n"] += 1
                if eng.get("first_shot_hit"):
                    bucket["first_hits"] += 1
            ok = _cs_ok(eng)
            if ok is not None:
                bucket["cs_n"] += 1
                if ok:
                    bucket["cs_ok"] += 1
            if eng.get("preaim_shot"):
                bucket["preaimed"] += 1
            elif _aim_scored(eng) and _flick_detected(eng):
                land_key = _landing_key(eng)
                bucket["land"][land_key] = bucket["land"].get(land_key, 0) + 1

    rows = []
    for bucket in buckets.values():
        fights = bucket["fights"]
        kills = bucket["kills"]
        deaths = bucket["deaths"]
        land_total = sum(bucket["land"].values()) or 1
        kd = round(_safe_div(kills, deaths) if deaths else float(kills), 2)
        rows.append(
            {
                "id": bucket["id"],
                "weaponId": bucket["weaponId"],
                "name": bucket["name"],
                "class": bucket["class"],
                "fights": fights,
                "kills": kills,
                "deaths": deaths,
                "kd": kd,
                "share": round(_safe_div(fights, total) * 100, 1) if total else 0,
                "reaction": int(round(sum(bucket["reactions"]) / len(bucket["reactions"]))) if bucket["reactions"] else 0,
                "ttk": int(round(sum(bucket["ttks"]) / len(bucket["ttks"]))) if bucket["ttks"] else 0,
                "preaim": round(sum(bucket["preaims"]) / len(bucket["preaims"]), 1) if bucket["preaims"] else 0,
                "headLevel": round(_safe_div(bucket["head_ok"], bucket["head_n"]) * 100, 1) if bucket["head_n"] else 0,
                "firstShot": round(_safe_div(bucket["first_hits"], bucket["first_n"]) * 100, 1) if bucket["first_n"] else 0,
                "counterStrafe": round(_safe_div(bucket["cs_ok"], bucket["cs_n"]) * 100, 1) if bucket["cs_n"] else 0,
                "preAimed": round(_safe_div(bucket["preaimed"], bucket["eligible"]) * 100, 1) if bucket["eligible"] else 0,
                "landing": {
                    "under": round(bucket["land"]["under"] / land_total * 100),
                    "target": round(bucket["land"]["target"] / land_total * 100),
                    "over": round(bucket["land"]["over"] / land_total * 100),
                },
            }
        )
    rows.sort(key=lambda row: (-row["fights"], row["name"]))
    return rows


def _empty_map_bucket(map_id: str, name: str, pool: str) -> dict[str, Any]:
    return {
        "id": map_id,
        "name": name,
        "pool": pool,
        "played": 0,
        "wins": 0,
        "losses": 0,
        "draws": 0,
        "kills": 0,
        "deaths": 0,
        "reaction_sum": 0.0,
        "reaction_w": 0,
        "preaim_sum": 0.0,
        "preaim_w": 0,
    }


def _map_rows(ui_matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    official_names = {name for _, name, _ in OFFICIAL_MAPS}
    buckets: dict[str, dict[str, Any]] = {
        name: _empty_map_bucket(map_id, name, pool) for map_id, name, pool in OFFICIAL_MAPS
    }
    for match in ui_matches:
        if match.get("live"):
            continue
        name = str(match.get("map") or "Unknown")
        if name not in buckets:
            buckets[name] = _empty_map_bucket(str(match.get("mapId") or name), name, "Other")
        bucket = buckets[name]
        bucket["played"] += 1
        bucket["kills"] += _int(match.get("kills")) or 0
        bucket["deaths"] += _int(match.get("deaths")) or 0
        weight = len(match.get("engagements") or []) or 1
        reaction = _num(match.get("reaction"))
        if reaction is not None:
            bucket["reaction_sum"] += reaction * weight
            bucket["reaction_w"] += weight
        preaim = _num(match.get("preaim"))
        if preaim is not None:
            bucket["preaim_sum"] += preaim * weight
            bucket["preaim_w"] += weight
        if normalize_match_mode(match.get("mode")) not in MAP_WINRATE_EXCLUDE_MODES:
            if match.get("draw"):
                bucket["draws"] += 1
            elif match.get("won"):
                bucket["wins"] += 1
            else:
                bucket["losses"] += 1

    rows = []
    order = [name for _, name, _ in OFFICIAL_MAPS]
    extra = sorted(name for name in buckets if name not in official_names)
    for name in order + extra:
        bucket = buckets[name]
        decided = bucket["wins"] + bucket["losses"]
        played = bucket["played"]
        deaths = bucket["deaths"]
        rows.append(
            {
                "id": bucket["id"],
                "name": bucket["name"],
                "pool": bucket["pool"],
                "played": played,
                "wins": bucket["wins"],
                "losses": bucket["losses"],
                "draws": bucket["draws"],
                "winRate": round(_safe_div(bucket["wins"], decided) * 100, 1) if decided else None,
                "reaction": int(round(bucket["reaction_sum"] / bucket["reaction_w"])) if bucket["reaction_w"] else None,
                "preaim": round(bucket["preaim_sum"] / bucket["preaim_w"], 1) if bucket["preaim_w"] else None,
                "kd": round(_safe_div(bucket["kills"], deaths) if deaths else float(bucket["kills"]), 2) if played else None,
                "kills": bucket["kills"],
                "deaths": bucket["deaths"],
            }
        )
    return rows


def _scoreboard_has_players(match: dict[str, Any] | None) -> bool:
    board = (match or {}).get("scoreboard") or {}
    return bool((board.get("you") or []) or (board.get("them") or []))


def _pick_last_match(ui_matches: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not ui_matches:
        return None
    newest = ui_matches[0]
    if _scoreboard_has_players(newest) or not newest.get("live"):
        return newest
    for match in ui_matches[1:]:
        if _scoreboard_has_players(match):
            return match
    return newest


def get_dashboard_state(modes: list[str] | None = None) -> dict[str, Any]:
    rows, engagement_map = _load_rows()
    ui_matches = [_ui_match(row, engagement_map.get(row["id"], [])) for row in rows]
    last = _pick_last_match(ui_matches)
    history = ui_matches[:HISTORY_MATCHES]
    allowed = parse_match_modes(modes)
    if allowed is not None:
        stat_rows = [row for row in rows if normalize_match_mode(row.get("mode")) in allowed]
        stat_ids = {row["id"] for row in stat_rows}
        stat_eng = {mid: engs for mid, engs in engagement_map.items() if mid in stat_ids}
        stat_ui = [match for match in ui_matches if normalize_match_mode(match.get("mode")) in allowed]
    else:
        stat_rows = rows
        stat_eng = engagement_map
        stat_ui = ui_matches
    now_ms = int(time.time() * 1000)

    def window(days: int | None) -> list[dict[str, Any]]:
        return [row for row in stat_rows if _in_window(row, now_ms, days)]

    cur7 = _aggregate(window(7), stat_eng)
    cur30 = _aggregate(window(30), stat_eng)
    prev7 = _aggregate([row for row in stat_rows if _in_prev_window(row, now_ms, 7)], stat_eng)
    prev30 = _aggregate([row for row in stat_rows if _in_prev_window(row, now_ms, 30)], stat_eng)
    all_stats = _aggregate(stat_rows, stat_eng)
    all_prev = cur30 if cur30.get("matches") else prev30
    weapons = _weapon_rows(stat_eng)

    def pack_range(stats: dict[str, Any], prev: dict[str, Any] | None = None) -> dict[str, Any]:
        out = {
            "kd": stats["kd"],
            "hs": stats["hs"],
            "reaction": stats["reaction"],
            "firstShot": stats["firstShot"],
            "counterStrafe": stats["counterStrafe"],
            "pathEff": stats.get("pathEff") or 0,
        }
        if prev and (prev.get("matches") or 0) > 0:
            out["kdDelta"] = _pct_change(stats["kd"], prev["kd"])
            out["hsDelta"] = _pct_change(stats["hs"], prev["hs"])
            out["reactionDelta"] = _pct_change(stats["reaction"], prev["reaction"])
            out["firstShotDelta"] = _pct_change(stats["firstShot"], prev["firstShot"])
            out["counterStrafeDelta"] = _pct_change(stats["counterStrafe"], prev["counterStrafe"])
            out["pathEffDelta"] = _pct_change(stats.get("pathEff") or 0, prev.get("pathEff") or 0)
        return out

    flick_points, flick_stats = _collect_flicks(stat_ui, stat_eng, now_ms)
    placement_points = []
    for match in stat_ui:
        for eng in stat_eng.get(match["id"], []):
            py = _num(eng.get("preaim_yaw"))
            pp = _num(eng.get("preaim_pitch"))
            if py is not None and pp is not None and not eng.get("preaim_already_visible") and not eng.get("preaim_occupied"):
                # Head at origin. x = left/right of their head, y = high/low.
                # Lua yaw_off > 0 means you still need to turn right (aimed left).
                x = round(-py, 2)
                y = round(pp, 2)
                placement_points.append({
                    "x": x,
                    "y": y,
                    "clipped": abs(x) > PLACEMENT_X_MAX or abs(y) > PLACEMENT_Y_MAX,
                })
    placement_stats = {
        "total": len(placement_points),
        "clipped": sum(1 for point in placement_points if point.get("clipped")),
    }

    reaction_history = []
    chronological = list(reversed(stat_ui[:REACTION_HISTORY]))
    for i, match in enumerate(chronological, start=1):
        reaction_history.append({"label": f"M{i}", "value": match["reaction"]})

    player = {
        "name": "Whos",
        **all_stats,
    }

    last_packet = "never"
    if _last_ingest_at:
        ago = max(0, int(time.time() - _last_ingest_at))
        if ago < 3:
            last_packet = "just now"
        elif ago < 60:
            last_packet = f"{ago}s ago"
        else:
            last_packet = f"{ago // 60}m ago"

    return {
        "source": "live",
        "player": player,
        "ranges": {
            "7": pack_range(cur7, prev7),
            "30": pack_range(cur30, prev30),
            "all": pack_range(all_stats, all_prev if all_prev.get("matches") else None),
        },
        "reactionHistory": reaction_history,
        "flickPoints": flick_points,
        "flickStats": flick_stats,
        "placementPoints": placement_points[:PLACEMENT_POINTS],
        "placementStats": placement_stats,
        "lastMatch": last,
        "matches": history,
        "maps": _map_rows(stat_ui),
        "weapons": weapons,
        "live": {
            "ingestUrl": _ingest_url,
            "lastIngestAt": _last_ingest_at,
            "lastPacket": last_packet,
            "matchCount": len(rows),
            "connected": bool(_last_ingest_at and (time.time() - _last_ingest_at) < 30),
            "latestWebAppVer": _latest_webapp_ver,
        },
    }


CS2_YAW = 0.022
SENS_MAX_GAMES = 20
SENS_MAX_FIGHTS = 90


def cm360(sens: float, dpi: float) -> float:
    denom = sens * dpi * CS2_YAW
    if denom <= 0:
        return 0.0
    return round(360.0 / denom * 2.54, 2)


def edpi(sens: float, dpi: float) -> float:
    return round(sens * dpi, 2)


def setup_context(sens: float, dpi: float) -> dict[str, Any]:
    e = edpi(sens, dpi)
    cm = cm360(sens, dpi)
    if e <= 0:
        band, intensity, label = "typical", "normal", "typical"
    elif e < 500:
        band, intensity, label = "low", "very", "very low"
    elif e < 700:
        band, intensity, label = "low", "mild", "low"
    elif e <= 1100:
        band, intensity, label = "typical", "normal", "typical"
    elif e < 1600:
        band, intensity, label = "high", "mild", "high"
    else:
        band, intensity, label = "high", "very", "very high"
    direction = "too_low" if band == "low" else "too_high" if band == "high" else "none"
    return {
        "sens": round(float(sens), 5),
        "dpi": int(dpi),
        "edpi": e,
        "cm360": cm,
        "band": band,
        "intensity": intensity,
        "label": label,
        "direction": direction,
        "typicalEdpi": "700–1100",
        "typicalCm360": "42–58 cm/360",
    }


def _flick_size(deg: float | None) -> str | None:
    if deg is None:
        return None
    if deg < 4:
        return "small"
    if deg < 12:
        return "medium"
    return "large"


def _land_counts(engagements: list[dict[str, Any]]) -> dict[str, int]:
    land = {"under": 0, "target": 0, "over": 0}
    for eng in engagements:
        if not _flick_detected(eng) or eng.get("preaim_shot"):
            continue
        key = _landing_key(eng)
        if key in land:
            land[key] += 1
    return land


def _pct_int(part: int, total: int) -> int:
    if total <= 0:
        return 0
    return int(round(part / total * 100))


def _mean(values: list[float]) -> float | None:
    if not values:
        return None
    return round(sum(values) / len(values), 2)


def _compact_fight(eng: dict[str, Any]) -> dict[str, Any]:
    flick = _num(eng.get("flick_deg"))
    _, weapon_name, weapon_class = _weapon_meta(eng)
    pe = _path_eff(eng)
    detected = _flick_detected(eng)
    if not _aim_scored(eng):
        landing = "unattributed"
    elif not detected:
        landing = "none"
    else:
        landing = _landing_key(eng)
    return {
        "result": eng.get("result"),
        "weapon": weapon_name,
        "class": weapon_class,
        "landing": landing,
        "flickDeg": round(flick, 1) if detected and flick is not None else None,
        "flickSize": _flick_size(flick) if detected else None,
        "errorDeg": round(_num(eng.get("flick_error_deg")) or 0, 2) if detected and _num(eng.get("flick_error_deg")) is not None else None,
        "preaimDeg": round(_num(eng.get("preaim_deg")) or 0, 1) if _num(eng.get("preaim_deg")) is not None else None,
        "preaimHeld": bool(eng.get("preaim_already_visible") or eng.get("preaim_occupied")),
        "preaimShot": bool(eng.get("preaim_shot")),
        "headLevel": _is_head_level(eng),
        "reactionMs": int(round(_num(eng.get("reaction_ms")) or 0)) if _num(eng.get("reaction_ms")) is not None else None,
        "ttkMs": int(round(_num(eng.get("ttk_ms")) or 0)) if _num(eng.get("ttk_ms")) is not None else None,
        "firstShot": bool(eng.get("first_shot_hit")) if eng.get("first_shot_hit") is not None else None,
        "pathEff": round(pe, 2) if pe is not None else None,
        "csOk": _cs_ok(eng),
        "velocity": round(_num(eng.get("firing_velocity")) or 0, 1) if _num(eng.get("firing_velocity")) is not None else None,
    }


def _sample_fights(engagements: list[dict[str, Any]], limit: int = SENS_MAX_FIGHTS) -> list[dict[str, Any]]:
    resolved = [
        eng
        for eng in engagements
        if str(eng.get("result") or "") in {"KILL", "DEATH"} and _aim_scored(eng)
    ]
    buckets: dict[str, list[dict[str, Any]]] = {"under": [], "target": [], "over": []}
    for eng in resolved:
        if not _flick_detected(eng):
            continue
        key = _landing_key(eng)
        if key not in buckets:
            continue
        buckets[key].append(eng)
    for key in buckets:
        buckets[key].sort(key=lambda item: _num(item.get("flick_deg")) or 0, reverse=True)
    picked: list[dict[str, Any]] = []
    indexes = {key: 0 for key in buckets}
    while len(picked) < limit:
        progressed = False
        for key in ("under", "over", "target"):
            i = indexes[key]
            items = buckets[key]
            if i >= len(items):
                continue
            picked.append(items[i])
            indexes[key] = i + 1
            progressed = True
            if len(picked) >= limit:
                break
        if not progressed:
            break
    return [_compact_fight(eng) for eng in picked]


def _flick_size_stats(engagements: list[dict[str, Any]]) -> dict[str, Any]:
    sizes: dict[str, list[dict[str, Any]]] = {"small": [], "medium": [], "large": []}
    for eng in engagements:
        if eng.get("preaim_shot") or not _flick_detected(eng):
            continue
        size = _flick_size(_num(eng.get("flick_deg")))
        if size:
            sizes[size].append(eng)
    out: dict[str, Any] = {}
    for size, items in sizes.items():
        land = _land_counts(items)
        n = len(items)
        errors = [_num(eng.get("flick_error_deg")) for eng in items]
        errors = [value for value in errors if value is not None]
        reactions = [
            _num(eng.get("reaction_ms"))
            for eng in items
            if eng.get("reaction_valid") is not False and _num(eng.get("reaction_ms")) is not None
        ]
        reactions = [value for value in reactions if value is not None]
        ttks = [_num(eng.get("ttk_ms")) for eng in items if _num(eng.get("ttk_ms")) is not None]
        ttks = [value for value in ttks if value is not None]
        paths = [_path_eff(eng) for eng in items]
        paths = [value for value in paths if value is not None]
        first_n = sum(1 for eng in items if eng.get("first_shot_hit") is not None)
        first_hits = sum(1 for eng in items if eng.get("first_shot_hit"))
        flicks = [_num(eng.get("flick_deg")) for eng in items if _num(eng.get("flick_deg")) is not None]
        out[size] = {
            "n": n,
            "under": _pct_int(land["under"], n),
            "on": _pct_int(land["target"], n),
            "over": _pct_int(land["over"], n),
            "avgSignedError": _mean(errors),
            "avgFlickDeg": _mean(flicks),
            "reactionMs": int(round(sum(reactions) / len(reactions))) if reactions else None,
            "ttkMs": int(round(sum(ttks) / len(ttks))) if ttks else None,
            "firstShotPct": round(_safe_div(first_hits, first_n) * 100, 1) if first_n else None,
            "pathEff": _mean(paths),
        }
    return out


def _weapon_aim_rows(engagements: list[dict[str, Any]], limit: int = 8) -> list[dict[str, Any]]:
    buckets: dict[str, list[dict[str, Any]]] = {}
    for eng in engagements:
        weapon_id, name, class_name = _weapon_meta(eng)
        if not _weapon_known(weapon_id, name):
            continue
        key = name
        buckets.setdefault(key, {"class": class_name, "items": []})
        buckets[key]["items"].append(eng)
    rows = []
    for name, bucket in buckets.items():
        items = bucket["items"]
        aim = _match_aim(items)
        rows.append(
            {
                "weapon": name,
                "class": bucket["class"],
                "fights": len(items),
                "landing": aim["landing"],
                "preaim": aim["preaim"],
                "firstShot": aim["firstShot"],
                "reaction": aim["reaction"],
            }
        )
    rows.sort(key=lambda row: row["fights"], reverse=True)
    return rows[:limit]


def _sens_signals(
    flick_sizes: dict[str, Any],
    overall: dict[str, Any],
    fight_n: int,
    setup: dict[str, Any] | None = None,
) -> dict[str, Any]:
    large = flick_sizes.get("large") or {}
    medium = flick_sizes.get("medium") or {}
    small = flick_sizes.get("small") or {}

    def pts(bucket: dict[str, Any]) -> int:
        return int(bucket.get("under") or 0) - int(bucket.get("over") or 0)

    def bias_label(score: int) -> str:
        if score >= 8:
            return "undershoot"
        if score <= -8:
            return "overshoot"
        return "balanced"

    def direction_of(score: int) -> str:
        if score >= 8:
            return "too_low"
        if score <= -8:
            return "too_high"
        return "none"

    large_n = int(large.get("n") or 0)
    small_n = int(small.get("n") or 0)
    large_pts = pts(large)
    small_pts = pts(small)
    medium_pts = pts(medium)
    large_err = large.get("avgSignedError")
    large_bias = bias_label(large_pts)
    small_bias = bias_label(small_pts)
    direction = direction_of(large_pts)

    if isinstance(large_err, (int, float)):
        if large_err >= 0.7 and direction == "too_high":
            direction = "none"
        elif large_err <= -0.7 and direction == "too_low":
            direction = "none"

    preaim = float(overall.get("preaim") or 0)
    head = float(overall.get("headLevel") or 0)
    cs = float(overall.get("counterStrafe") or 0)
    preaim_weak = preaim >= 5.5 or head <= 45
    cs_weak = cs > 0 and cs < 70
    sample_thin = fight_n < 25
    small_clearer = small_n >= 8 and abs(small_pts) >= abs(large_pts)
    flick_lean = (
        direction != "none"
        and large_n >= 8
        and abs(large_pts) > abs(small_pts) + 3
        and not small_clearer
    )
    strong = flick_lean and large_n >= 10 and abs(large_pts) >= 18 and abs(small_pts) <= 12
    worth_changing = bool(flick_lean)

    if not worth_changing:
        call = "keep"
        direction = "none"
    elif strong:
        call = "change"
    else:
        call = "try"

    setup = setup if isinstance(setup, dict) else {}
    setup_band = str(setup.get("band") or "typical")
    setup_dir = str(setup.get("direction") or "none")
    setup_label = str(setup.get("label") or "typical")
    setup_agrees = bool(
        call in {"change", "try"}
        and direction in {"too_low", "too_high"}
        and direction == setup_dir
    )
    setup_conflicts = bool(
        call in {"change", "try"}
        and direction in {"too_low", "too_high"}
        and setup_dir in {"too_low", "too_high"}
        and direction != setup_dir
    )

    if call == "change":
        read = (
            "Large flicks undershoot while small flicks stay balanced — sensitivity looks too low."
            if direction == "too_low"
            else "Large flicks overshoot while small flicks stay balanced — sensitivity looks too high."
        )
    elif call == "try":
        read = (
            "Bigger flicks lean short more than they sail past."
            if direction == "too_low"
            else "Bigger flicks lean past the target more than they fall short."
        )
    elif sample_thin:
        read = "Sample is thin (under 25 fights)."
    elif preaim_weak:
        read = "Pre-aim / head-level looks weaker than flick speed."
    elif cs_weak:
        read = "Counter-strafe looks weaker than flick speed."
    else:
        read = "Large vs small flick landing is mixed or balanced."

    edpi_n = setup.get("edpi")
    cm = setup.get("cm360")
    if setup_band in {"low", "high"} and edpi_n is not None:
        setup_note = (
            f" Setup is {setup_label}: {edpi_n} eDPI ({cm} cm/360). Typical CS2 rifler range is about 700–1100 eDPI."
        )
        if call == "keep":
            read = f"Flicks look fine. {setup_note.strip()}"
        else:
            read = read + setup_note
            if setup_conflicts:
                read += " Flicks and eDPI point opposite ways — follow the flicks, keep the nudge small."
            elif setup_agrees:
                read += " Flicks and eDPI agree on the direction."

    return {
        "call": call,
        "direction": direction,
        "largeFlickBias": large_bias,
        "mediumFlickBias": bias_label(medium_pts),
        "smallFlickBias": small_bias,
        "largePts": large_pts,
        "smallPts": small_pts,
        "preaimLooksWeak": preaim_weak,
        "counterstrafeLooksWeak": cs_weak,
        "sensitivityPattern": call != "keep",
        "sampleThin": sample_thin,
        "worthChanging": worth_changing,
        "setup": setup or None,
        "setupAgrees": setup_agrees,
        "setupConflicts": setup_conflicts,
        "read": read,
    }


TYPICAL_EDPI = 900.0
SENS_MAX_GAIN = 0.22


def round_sens(value: float) -> float:
    return round(max(0.001, min(20.0, float(value))), 5)


def round_sens_suggest(value: float) -> float:
    return round(max(0.01, min(20.0, float(value))), 2)


def verify_sens_work(
    sens: float | None,
    dpi: float | None,
    work: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Check Gemini's own F/E (or eDPI step). Do not pick those inputs for it.

    CS2: degrees = counts × 0.022 × sens, so extra/missing degrees scale 1:1 with
    sens: new = current × (1 + E/F). The in-game listing is that result at
    2 decimals.
    """
    if not isinstance(work, dict):
        return None
    if sens is None or dpi is None or float(sens) <= 0 or float(dpi) <= 0:
        return None
    current = float(sens)
    dpi_n = float(dpi)
    method = str(work.get("method") or work.get("kind") or "").strip().lower()
    if method in {"edpi", "edpi_band", "band"}:
        method = "setup"
    if not method:
        has_f = _num(work.get("flickDeg") or work.get("F") or work.get("avgFlickDeg"))
        has_e = _num(work.get("errorDeg") or work.get("E") or work.get("avgSignedError"))
        has_step = _num(work.get("setupStep") or work.get("step"))
        method = "setup" if has_step is not None and (has_f is None or has_e is None) else "flicks"
    claimed = _num(work.get("sens"))

    def cm_of(value: float) -> float:
        return cm360(value, dpi_n)

    if method == "setup":
        step = _num(work.get("setupStep") or work.get("step"))
        if step is None:
            step = 0.25
        if step > 1:
            step = step / 100.0
        step = max(0.05, min(0.5, step))
        current_edpi = current * dpi_n
        gap = TYPICAL_EDPI - current_edpi
        if abs(gap) < 15:
            return None
        new_edpi = current_edpi + step * gap
        nxt = round_sens(new_edpi / dpi_n)
        if abs(nxt - current) < 1e-5:
            return None
        toward = "higher" if nxt > current else "lower"
        listed = round_sens_suggest(nxt)
        steps = [
            f"Arithmetic: gap to 900 eDPI = {TYPICAL_EDPI:.0f} − {current_edpi:.2f} = {gap:+.2f}.",
            f"new eDPI = {current_edpi:.2f} + {step:.2f} × ({gap:+.2f}) = {new_edpi:.2f}.",
            f"new sens = {new_edpi:.2f} / {int(dpi_n)} = {nxt:.5f} ({toward}). cm/360 {cm_of(current)} → {cm_of(nxt)}.",
            f"Round to two in-game decimals: {listed:.2f}.",
        ]
        claimed_new = claimed is not None and abs(claimed - current) > 1e-4
        if claimed_new and abs(round_sens_suggest(claimed) - listed) > 0.005:
            steps.append(
                f"A different listing {claimed:g} did not match this arithmetic, so the suggestion is {listed:.2f}."
            )
        return {
            "kind": "setup",
            "source": "gemini",
            "currentSens": round_sens(current),
            "sens": nxt,
            "listedSens": listed,
            "dpi": int(dpi_n),
            "setupStep": round(step, 4),
            "targetEdpi": TYPICAL_EDPI,
            "gapEdpi": round(gap, 2),
            "formula": "new_edpi = current_edpi + step × (900 − current_edpi);  sens = new_edpi / DPI",
            "equation": f"{current_edpi:.2f} + {step:.2f} × ({gap:+.2f}) = {new_edpi:.2f} eDPI → {nxt:.5f}",
            "steps": steps,
            "edpiFrom": edpi(current, dpi_n),
            "edpiTo": edpi(nxt, dpi_n),
            "cm360From": cm_of(current),
            "cm360To": cm_of(nxt),
            "claimedSens": claimed,
            "reason": (
                f"{edpi(current, dpi_n)} eDPI is outside 700–1100. "
                f"A {step * 100:.0f}% step toward 900 eDPI is {listed:.2f}."
            ),
        }

    flick_deg = _num(work.get("flickDeg") or work.get("F") or work.get("avgFlickDeg"))
    error_deg = _num(work.get("errorDeg") or work.get("E") or work.get("avgSignedError"))
    if flick_deg is None or error_deg is None or flick_deg < 1.5:
        return None
    raw_gain = error_deg / flick_deg
    mag = min(SENS_MAX_GAIN, abs(raw_gain))
    if mag < 0.004:
        return None
    signed = mag if raw_gain >= 0 else -mag
    factor = 1.0 + signed
    nxt = round_sens(current * factor)
    if abs(nxt - current) < 1e-5:
        return None
    toward = "higher" if nxt > current else "lower"
    sign = "undershoot / fell short" if error_deg >= 0 else "overshoot / swept past"
    clamped = abs(raw_gain) > SENS_MAX_GAIN + 1e-9
    equation = (
        f"{current:g} × (1 {signed:+.5f}) = {nxt:.5f}"
        if clamped
        else f"{current:g} × (1 + ({error_deg:.3f} / {flick_deg:.3f})) = {nxt:.5f}"
    )
    listed = round_sens_suggest(nxt)
    steps = [
        f"CS2 yaw is {CS2_YAW}. Degrees = mouse counts × {CS2_YAW} × sens, so E/F scales 1:1 with sens.",
        f"F = {flick_deg:.3f}°, E = {error_deg:+.3f}° ({sign}). Gain = E/F = {raw_gain:+.5f} ({raw_gain * 100:+.2f}%).",
    ]
    if clamped:
        steps.append(f"One step is capped at {SENS_MAX_GAIN * 100:.0f}%: applied gain = {signed:+.5f}.")
    steps.append(
        f"new = current × (1 + E/F) = {equation}. Same DPI {int(dpi_n)}. "
        f"eDPI {edpi(current, dpi_n)} → {edpi(nxt, dpi_n)}. cm/360 {cm_of(current)} → {cm_of(nxt)}."
    )
    steps.append(f"Round to two in-game decimals: {listed:.2f}.")
    claimed_new = claimed is not None and abs(claimed - current) > 1e-4
    if claimed_new and abs(round_sens_suggest(claimed) - listed) > 0.005:
        steps.append(
            f"A different listing {claimed:g} did not match this arithmetic, so the suggestion is {listed:.2f}."
        )
    return {
        "kind": "flicks",
        "source": "gemini",
        "currentSens": round_sens(current),
        "sens": nxt,
        "listedSens": listed,
        "dpi": int(dpi_n),
        "factor": round(factor, 5),
        "gain": round(signed, 5),
        "rawGain": round(raw_gain, 5),
        "flickDeg": round(flick_deg, 3),
        "errorDeg": round(error_deg, 3),
        "formula": "new = current × (1 + E/F)",
        "equation": equation,
        "steps": steps,
        "edpiFrom": edpi(current, dpi_n),
        "edpiTo": edpi(nxt, dpi_n),
        "cm360From": cm_of(current),
        "cm360To": cm_of(nxt),
        "claimedSens": claimed,
        "reason": (
            f"Flicks of {flick_deg:.2f}° landed {abs(error_deg):.2f}° {sign.split(' / ')[0]}, "
            f"so gain is {abs(raw_gain) * 100:.2f}% too {'low' if nxt > current else 'high'}. "
            f"{toward.capitalize()} to {listed:.2f}."
        ),
    }


def build_sens_pack(
    game_count: int,
    sens: float | None = None,
    dpi: float | None = None,
    modes: list[str] | None = None,
) -> dict[str, Any]:
    requested = max(1, min(SENS_MAX_GAMES, int(game_count or 8)))
    rows, engagement_map = _load_rows()
    allowed = parse_match_modes(modes)

    def mode_ok(row: dict[str, Any]) -> bool:
        if allowed is None:
            return True
        return normalize_match_mode(row.get("mode")) in allowed

    rows = [row for row in rows if mode_ok(row)]
    closed = [row for row in rows if row.get("closed") or row.get("ended_at")]
    live = [row for row in rows if not (row.get("closed") or row.get("ended_at"))]
    picked = closed[:requested]
    if len(picked) < requested and live:
        picked = (live + picked)[:requested]
    fights: list[dict[str, Any]] = []
    matches = []
    by_mode: dict[str, dict[str, int]] = {}
    for row in picked:
        engs = engagement_map.get(row["id"], [])
        fights.extend(engs)
        ui = _ui_match(row, engs)
        mode = normalize_match_mode(row.get("mode"))
        mode_key = mode or "untagged"
        bucket = by_mode.setdefault(mode_key, {"matches": 0, "fights": 0})
        bucket["matches"] += 1
        bucket["fights"] += len(engs)
        matches.append(
            {
                "map": ui.get("map"),
                "score": ui.get("score"),
                "live": bool(ui.get("live")),
                "mode": mode or None,
                "modeLabel": MATCH_MODE_LABELS.get(mode) or "Untagged",
                "weight": MATCH_MODE_WEIGHTS.get(mode, 0.55),
                "kills": ui.get("kills"),
                "deaths": ui.get("deaths"),
                "fights": len(engs),
                "landing": ui.get("landing"),
                "preaim": ui.get("preaim"),
                "reaction": ui.get("reaction"),
                "firstShot": ui.get("firstShot"),
                "counterStrafe": ui.get("counterStrafe"),
            }
        )
    overall = _match_aim(fights)
    overall["kd"] = _aggregate(picked, {row["id"]: engagement_map.get(row["id"], []) for row in picked}).get("kd")
    flick_sizes = _flick_size_stats(fights)
    setup = None
    if sens is not None and dpi is not None and float(sens) > 0 and float(dpi) > 0:
        setup = setup_context(float(sens), float(dpi))
    pack = {
        "glossary": {
            "signedError": "Positive flick_error_deg = undershoot (fell short of the head). Negative = overshoot (swept past).",
            "flickSize": "small < 4°, medium 4–12°, large > 12°.",
            "preaim": "Crosshair offset to the target the moment they first appeared. High pre-aim is placement, not mouse speed.",
            "call": "change = flicks prove too high or too low. try = milder flick lean or a low/high eDPI setup. keep = no new sens.",
            "setup": "eDPI = in-game sens × DPI. Typical CS2 rifler range is about 700–1100 eDPI (roughly 42–58 cm/360). 600 eDPI is low; 1200 is high.",
            "math": "You must derive the next sens. CS2 yaw is 0.022, so degrees = counts × 0.022 × sens and extra/missing degrees scale 1:1 with sens: new = current × (1 + E/F). Positive E = undershoot → raise. Negative E = overshoot → lower. For a setup-only try, pick a fraction of the eDPI gap toward 900 and show the multiply. Do not pick a round 1.1 / 1.2 unless the arithmetic equals that.",
        },
        "sample": {
            "requested": requested,
            "available": len(rows),
            "matches": len(picked),
            "fights": len(fights),
            "byMode": by_mode,
            "filter": sorted(allowed) if allowed is not None else None,
        },
        "setup": setup,
        "overall": overall,
        "flickBySize": flick_sizes,
        "weapons": _weapon_aim_rows(fights),
        "matches": matches,
        "fights": _sample_fights(fights),
    }
    pack["signals"] = _sens_signals(flick_sizes, overall, len(fights), setup)
    return pack
