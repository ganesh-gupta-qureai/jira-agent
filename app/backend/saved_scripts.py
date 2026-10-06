"""Per-chat "save this script for later" store -- explicitly NOT an execution
path (see main.py: no endpoint here ever runs saved code, only script_runner's
own /api/execute-script does, and only on a human's own click). One JSON file
per user under USERS_ROOT, same pattern as execution_history.py/cron_jobs.py.
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
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


def _write_all(user_id: str, records: list[dict]) -> None:
    _path(user_id).write_text(json.dumps(records), encoding="utf-8")


def list_saved(user_id: str, thread_id: str) -> list[dict]:
    """Newest first, scoped to one chat (thread_id)."""
    records = [r for r in _read_all(user_id) if r["thread_id"] == thread_id]
    return sorted(records, key=lambda r: r["created_at"], reverse=True)


def add_saved(user_id: str, thread_id: str, code: str, title: str) -> dict:
    records = _read_all(user_id)
    record = {
        "id": uuid.uuid4().hex,
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
