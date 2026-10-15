""""Save this script for later" store -- explicitly NOT an execution path
(see main.py: no endpoint here ever runs saved code, only script_runner's own
/api/execute-script does, and only on a human's own click). One JSON file per
user under USERS_ROOT, same pattern as execution_history.py/cron_jobs.py.

Shared across the 3-person ops team since 2026-10-15 (same reasoning as
cron_jobs.py's list_all_jobs): a script one of them saves from chat should be
visible and runnable/schedulable by the other two from the Scheduled tab's
"Saved" list, not siloed to the original chat/account. list_saved (per-thread)
still backs the per-chat 📑 panel -- that's still useful "what came from this
conversation" context -- while list_all_saved backs the shared Scheduled-tab
view across every user and every chat.
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

from users import USERS_ROOT


def _path(user_id: str) -> Path:
    d = USERS_ROOT / user_id
    d.mkdir(parents=True, exist_ok=True)
    return d / "saved_scripts.json"


def _read_all(user_id: str) -> list[dict]:
    path = _path(user_id)
    if not path.exists():
        return []
    try:
        records = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    changed = False
    for r in records:
        if not r.get("owner"):
            r["owner"] = user_id  # self-heal records saved before "owner" existed
            changed = True
    if changed:
        _write_all(user_id, records)
    return records


def _write_all(user_id: str, records: list[dict]) -> None:
    _path(user_id).write_text(json.dumps(records), encoding="utf-8")


def list_saved(user_id: str, thread_id: str) -> list[dict]:
    """Newest first, scoped to one chat (thread_id) -- the per-chat 📑 panel."""
    records = [r for r in _read_all(user_id) if r["thread_id"] == thread_id]
    return sorted(records, key=lambda r: r["created_at"], reverse=True)


def add_saved(user_id: str, thread_id: str, code: str, title: str) -> dict:
    records = _read_all(user_id)
    record = {
        "id": uuid.uuid4().hex,
        "owner": user_id,  # who saved it -- see list_all_saved/find_saved_owner
        "thread_id": thread_id,
        "title": title.strip() or "Untitled script",
        "code": code,
        "created_at": time.time(),
    }
    records.append(record)
    _write_all(user_id, records)
    return record


def delete_saved(user_id: str, saved_id: str) -> bool:
    records = _read_all(user_id)
    filtered = [r for r in records if r["id"] != saved_id]
    if len(filtered) == len(records):
        return False
    _write_all(user_id, filtered)
    return True


def _all_user_ids() -> list[str]:
    if not USERS_ROOT.is_dir():
        return []
    return [p.parent.name for p in USERS_ROOT.glob("*/saved_scripts.json")]


def list_all_saved() -> list[dict]:
    """Every saved script across every user, newest first -- backs the
    Scheduled tab's shared "Saved" view."""
    records: list[dict] = []
    for uid in _all_user_ids():
        records.extend(_read_all(uid))
    return sorted(records, key=lambda r: r["created_at"], reverse=True)


def find_saved_owner(saved_id: str) -> str | None:
    """Which user's file a saved script actually lives in -- needed because
    the Scheduled tab's Saved view shows everyone's, so a delete from
    anyone's tab must look it up across all users, not just the caller's own
    file (same pattern as cron_jobs.find_owner)."""
    for uid in _all_user_ids():
        if any(r["id"] == saved_id for r in _read_all(uid)):
            return uid
    return None
