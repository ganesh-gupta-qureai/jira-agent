"""Persistent per-user log of every script run via the UI's Execute button --
backs the History tab. One JSON file per user under USERS_ROOT (small scale;
a single user's own Execute clicks are sequential, so no locking beyond a
plain read-modify-write).
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

from users import USERS_ROOT


def _history_path(user_id: str) -> Path:
    d = USERS_ROOT / user_id
    d.mkdir(parents=True, exist_ok=True)
    return d / "execution_history.json"


def _read_all(user_id: str) -> list[dict]:
    path = _history_path(user_id)
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []


def _write_all(user_id: str, records: list[dict]) -> None:
    _history_path(user_id).write_text(json.dumps(records), encoding="utf-8")


def record_execution(user_id: str, code: str, result: dict) -> dict:
    """Called by script_runner.py after every Execute run, success or not."""
    record = {
        "id": uuid.uuid4().hex,
        "timestamp": time.time(),
        "code": code,
        "ok": result.get("ok", False),
        "timed_out": result.get("timed_out", False),
        "exit_code": result.get("exit_code"),
        "stdout": result.get("stdout", ""),
        "stderr": result.get("stderr", ""),
        "posted_to_slack": result.get("posted_to_slack", False),
        "slack_error": result.get("slack_error"),
    }
    records = _read_all(user_id)
    records.append(record)
    _write_all(user_id, records)
    return record


def list_executions(user_id: str) -> list[dict]:
    """Newest first."""
    return sorted(_read_all(user_id), key=lambda r: r["timestamp"], reverse=True)


def delete_execution(user_id: str, exec_id: str) -> bool:
    records = _read_all(user_id)
    filtered = [r for r in records if r["id"] != exec_id]
    if len(filtered) == len(records):
        return False
    _write_all(user_id, filtered)
    return True


def clear_executions(user_id: str) -> int:
    records = _read_all(user_id)
    _write_all(user_id, [])
    return len(records)
