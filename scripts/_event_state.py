"""Shared dedup-by-ID helper for event-triggered automations: a script that
polls Jira on a short interval looking for something NEW (a ticket entering a
status, a new ticket matching a filter) rather than running on a fixed
daily/weekly schedule.

Jira gives this agent no real push/webhook -- _jira_client.py is read-only
search/get only -- so "event-triggered" here always means "poll via JQL on a
short interval, then skip anything already notified." This module is the
"already notified" half of that: it tracks which item keys (ticket keys, or
any other stable string) a given automation has already acted on, so the
same JQL window matching the same ticket across two overlapping polls never
re-notifies it.

State lives under /data (USERS_ROOT's parent), not /shared -- same reasoning
as chu_insufficient_info_reminder.py's STATE_FILE: /shared is rebuilt from
git on every redeploy and would silently forget what was already notified,
re-firing on every matching ticket since the beginning of time.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

_STATE_DIR = Path(os.environ.get("USERS_ROOT", "/data/users")).parent / "event_state"
_MAX_SEEN = 5000  # per automation -- oldest entries dropped once exceeded, see mark_seen


def _safe_key(automation_key: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", automation_key) or "automation"


def _path(automation_key: str) -> Path:
    return _STATE_DIR / f"{_safe_key(automation_key)}.json"


def _load(automation_key: str) -> list[str]:
    try:
        return json.loads(_path(automation_key).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


def unseen(automation_key: str, item_keys: list[str]) -> list[str]:
    """Items from item_keys not already marked seen for this automation,
    in the same order given. Read-only -- call mark_seen() afterwards with
    whichever of these you actually acted on (e.g. actually posted), so a
    Slack failure doesn't silently mark something seen that was never sent."""
    seen = set(_load(automation_key))
    return [k for k in item_keys if k not in seen]


def mark_seen(automation_key: str, item_keys: list[str]) -> None:
    seen = _load(automation_key)
    existing = set(seen)
    for k in item_keys:
        if k not in existing:
            seen.append(k)
            existing.add(k)
    if len(seen) > _MAX_SEEN:
        seen = seen[-_MAX_SEEN:]
    _STATE_DIR.mkdir(parents=True, exist_ok=True)
    _path(automation_key).write_text(json.dumps(seen), encoding="utf-8")
