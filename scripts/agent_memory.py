#!/usr/bin/env python3
"""Episodic memory: a persistent, cross-session log of real mistakes found and
the correct rule that replaced them -- so the agent doesn't repeat the same
mistake in a later chat (built 2026-10-06, same spirit as the "lessons
learned" entries already accumulating by hand in docs/jira_fields.md, but a
dedicated, systematic store instead of prose buried in a field-reference doc).

Why this lives under USERS_ROOT, not docs/: docs/ is part of the git repo --
anything the agent writes there at runtime is lost on the next redeploy (the
container filesystem is ephemeral; see scripts/slack_user_lookup.py's own
docstring on this exact problem). USERS_ROOT (/data/users) is the one
confirmed-persistent volume (cron_jobs.py and execution_history.py already
rely on it surviving restarts/redeploys) -- this reuses it as a shared,
cross-user memory store, since a lesson about CHU/Jira isn't specific to one
user.

Usage:
    uv run scripts/agent_memory.py list
    uv run scripts/agent_memory.py add "<lesson text>"

Read every entry (via `list`) before building or auditing any automation.
Add a new entry (via `add`) whenever a real mistake is found or corrected --
by a human, by live investigation, or by re-checking your own prior output --
phrased as the durable rule, not just a description of the one incident
(e.g. "a same-project issue link is never a valid product-ticket link" not
"CHU-474 was wrongly skipped").
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

_STORE_PATH = Path(os.environ.get("USERS_ROOT", "/data/users")).parent / "agent_memory.jsonl"


def _load() -> list[dict]:
    if not _STORE_PATH.exists():
        return []
    entries = []
    with _STORE_PATH.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def add_lesson(text: str) -> dict:
    entry = {"date": time.strftime("%Y-%m-%d"), "lesson": text.strip()}
    _STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _STORE_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
    return entry


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="print every recorded lesson, oldest first")
    add_p = sub.add_parser("add", help="record a new lesson")
    add_p.add_argument("text", help="the durable rule learned, not just the one incident")
    args = parser.parse_args()

    if args.cmd == "list":
        entries = _load()
        if not entries:
            print("(no lessons recorded yet)")
            return
        for e in entries:
            print(f"[{e.get('date', '?')}] {e.get('lesson', '')}")
    elif args.cmd == "add":
        entry = add_lesson(args.text)
        print(f"recorded: [{entry['date']}] {entry['lesson']}")


if __name__ == "__main__":
    sys.exit(main())
