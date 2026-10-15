#!/usr/bin/env python3
"""List or delete this bot's own recent Slack messages in a channel. A
first-class agent tool, like post_to_slack.py -- the agent may call it
itself via Bash, but ONLY the two ways system_prompt.md's Mode -1 spells
out: list first to find and show the exact message, then delete only after
the human has explicitly confirmed that exact message in that reply. It
never fires on its own, and --delete is never the first call in a turn.

Deletion only ever works on a message this bot itself posted -- Slack's
chat.delete rejects anything else with cant_delete_message.

Usage:
  uv run scripts/slack_manage_messages.py --list --channel C0B86EU1Y03
  uv run scripts/slack_manage_messages.py --delete --channel C0B86EU1Y03 --ts 1792080318.675319
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")


def _token() -> str:
    token = os.environ.get("SLACK_BOT_TOKEN", "")
    if not token:
        sys.exit("ERROR: SLACK_BOT_TOKEN is not set -- see app/.env.example")
    return token


def _get(method: str, params: dict) -> dict:
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(
        f"https://slack.com/api/{method}?{qs}",
        headers={"Authorization": f"Bearer {_token()}"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def _post(method: str, payload: dict) -> dict:
    req = urllib.request.Request(
        f"https://slack.com/api/{method}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {_token()}", "Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def _bot_user_id() -> str:
    body = _get("auth.test", {})
    if not body.get("ok"):
        sys.exit(f"ERROR: auth.test failed: {body.get('error', 'unknown_error')}")
    return body["user_id"]


def list_messages(channel: str, limit: int) -> None:
    bot_id = _bot_user_id()
    body = _get("conversations.history", {"channel": channel, "limit": 100})
    if not body.get("ok"):
        sys.exit(f"ERROR: conversations.history failed: {body.get('error', 'unknown_error')}")
    shown = 0
    for m in body.get("messages", []):
        if m.get("user") != bot_id:
            continue
        when = datetime.fromtimestamp(float(m["ts"]), IST).strftime("%Y-%m-%d %H:%M IST")
        text = (m.get("text") or "").replace("\n", " ")[:200]
        print(f"ts={m['ts']}  {when}  {text}")
        shown += 1
        if shown >= limit:
            break
    if shown == 0:
        print(f"No messages from this bot found in {channel}.", file=sys.stderr)


def delete_message(channel: str, ts: str) -> None:
    body = _post("chat.delete", {"channel": channel, "ts": ts})
    if not body.get("ok"):
        sys.exit(f"ERROR: Slack API error: {body.get('error', 'unknown_error')}")
    print(f"OK: deleted message {ts} from {channel}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--channel", required=True)
    parser.add_argument("--list", action="store_true", help="show this bot's recent messages in the channel")
    parser.add_argument("--delete", action="store_true", help="delete one message (requires --ts)")
    parser.add_argument("--ts", default=None, help="the message's ts, from --list's output")
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()

    if args.list == args.delete:
        sys.exit("ERROR: pass exactly one of --list or --delete")
    if args.delete and not args.ts:
        sys.exit("ERROR: --delete requires --ts (run --list first to find it)")

    if args.list:
        list_messages(args.channel, args.limit)
    else:
        delete_message(args.channel, args.ts)


if __name__ == "__main__":
    main()
