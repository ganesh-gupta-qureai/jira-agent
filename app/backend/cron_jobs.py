"""Persistent per-user cron job definitions. One JSON file per user under
USERS_ROOT, same pattern as execution_history.py. A job pairs a script (the
exact code the human reviewed in chat, same as the Execute button) with a
cron expression -- created only via the UI's "Schedule" action, never by the
agent itself, so the human-in-the-loop boundary that already gates Execute
(see script_runner.py) extends to scheduling too: a human decided this
specific script should run on this specific schedule, once, at creation
time -- the agent never adds, edits, or removes a job on its own.
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

from users import USERS_ROOT

# Must match app/frontend/src/slackChannels.ts's DEFAULT_SLACK_CHANNEL --
# the safe, test-only channel a job falls back to when it has no explicit
# channel recorded. Root-caused 2026-09-29: a job stored with channel=None
# silently fell through to a bare CHU_SLACK_CHANNEL_ID env var at run time,
# which resolved to the real production channel. A job's channel is never
# allowed to be empty/None past this point -- normalized on both write
# (create_job) and read (_read_all, so an already-stored null-channel job
# self-heals on its very next run without needing manual data surgery).
DEFAULT_TEST_CHANNEL = "C0B86EU1Y03"  # #jira-automation-test-channel


def _jobs_path(user_id: str) -> Path:
    d = USERS_ROOT / user_id
    d.mkdir(parents=True, exist_ok=True)
    return d / "cron_jobs.json"


def _read_all(user_id: str) -> list[dict]:
    path = _jobs_path(user_id)
    if not path.exists():
        return []
    try:
        jobs = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    changed = False
    for j in jobs:
        if not j.get("channel"):
            j["channel"] = DEFAULT_TEST_CHANNEL
            changed = True
    if changed:
        _write_all(user_id, jobs)
    return jobs


def _write_all(user_id: str, jobs: list[dict]) -> None:
    _jobs_path(user_id).write_text(json.dumps(jobs), encoding="utf-8")


def list_jobs(user_id: str) -> list[dict]:
    """Newest first."""
    return sorted(_read_all(user_id), key=lambda j: j["created_at"], reverse=True)


def get_job(user_id: str, job_id: str) -> dict | None:
    for j in _read_all(user_id):
        if j["id"] == job_id:
            return j
    return None


def create_job(
    user_id: str,
    name: str,
    code: str,
    cron_expr: str,
    start_date: str | None = None,
    end_date: str | None = None,
    channel: str | None = None,
    send: bool = False,
) -> dict:
    job = {
        "id": uuid.uuid4().hex,
        "name": name,
        "code": code,
        "cron_expr": cron_expr,
        "start_date": start_date,  # ISO date (YYYY-MM-DD) or None -- runs start firing immediately
        "end_date": end_date,      # ISO date (YYYY-MM-DD) or None -- runs indefinitely
        "channel": channel or DEFAULT_TEST_CHANNEL,  # never null -- see DEFAULT_TEST_CHANNEL's comment
        "send": send,              # sets CHU_REPORT_SEND=1 on every scheduled run (see script_runner.py)
        "created_at": time.time(),
        "enabled": True,
        "last_run_at": None,
        "last_run_ok": None,
    }
    jobs = _read_all(user_id)
    jobs.append(job)
    _write_all(user_id, jobs)
    return job


def delete_job(user_id: str, job_id: str) -> bool:
    jobs = _read_all(user_id)
    filtered = [j for j in jobs if j["id"] != job_id]
    if len(filtered) == len(jobs):
        return False
    _write_all(user_id, filtered)
    return True


def set_enabled(user_id: str, job_id: str, enabled: bool) -> dict | None:
    jobs = _read_all(user_id)
    for j in jobs:
        if j["id"] == job_id:
            j["enabled"] = enabled
            _write_all(user_id, jobs)
            return j
    return None


def record_run(user_id: str, job_id: str, ok: bool) -> None:
    jobs = _read_all(user_id)
    for j in jobs:
        if j["id"] == job_id:
            j["last_run_at"] = time.time()
            j["last_run_ok"] = ok
            break
    _write_all(user_id, jobs)


def all_user_ids() -> list[str]:
    """Every user directory that has a cron_jobs.json -- used once at process
    startup to re-register jobs that need to survive a restart/redeploy."""
    if not USERS_ROOT.is_dir():
        return []
    return [p.parent.name for p in USERS_ROOT.glob("*/cron_jobs.json")]
