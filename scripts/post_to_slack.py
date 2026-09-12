#!/usr/bin/env python3
"""Post text to the configured CHU Slack channel via chat.postMessage with a
bot token. Unlike a Mode 2/3 generated script, this is a first-class agent
tool -- like jira_search.py -- that the agent may call itself via Bash when a
user explicitly asks to post/send/share something to Slack (see
system_prompt.md Hard Rule #3). It never fires on its own.

Applies the same ASCII-header-to-bold conversion and length cap as the UI's
Execute-button auto-poster (app/backend/script_runner.py's _post_to_slack) so
both paths read the same regardless of which one posted.

Usage:
  uv run scripts/post_to_slack.py "<text>"
  printf '%s' "<text>" | uv run scripts/post_to_slack.py -
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request

SLACK_MESSAGE_MAX_CHARS = 3_000
_ASCII_HEADER_RE = re.compile(r'^(?:=|-){2,}\s*(.+?)\s*(?:=|-){2,}$', re.MULTILINE)


def _to_slack_mrkdwn(body: str) -> str:
    return _ASCII_HEADER_RE.sub(lambda m: f"*{m.group(1)}*", body)


def post(text: str) -> None:
    token = os.environ.get("SLACK_BOT_TOKEN", "")
    channel = os.environ.get("CHU_SLACK_CHANNEL_ID", "")
    if not token or not channel:
        print("ERROR: SLACK_BOT_TOKEN or CHU_SLACK_CHANNEL_ID is not set -- see app/.env.example", file=sys.stderr)
        sys.exit(1)

    body = text.strip() or "(no content)"
    if len(body) > SLACK_MESSAGE_MAX_CHARS:
        body = body[:SLACK_MESSAGE_MAX_CHARS] + "\n... (truncated)"

    payload = json.dumps({"channel": channel, "text": _to_slack_mrkdwn(body), "mrkdwn": True}).encode("utf-8")
    request = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=payload,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.loads(response.read().decode("utf-8", errors="replace"))
    except (urllib.error.HTTPError, urllib.error.URLError) as exc:
        print(f"ERROR: Slack request failed: {exc}", file=sys.stderr)
        sys.exit(1)
    if not result.get("ok"):
        print(f"ERROR: Slack API error: {result.get('error', 'unknown_error')}", file=sys.stderr)
        sys.exit(1)
    print("OK: posted to Slack")


def main() -> None:
    if len(sys.argv) < 2:
        print('usage: post_to_slack.py "<text>"   (or "-" to read stdin)', file=sys.stderr)
        sys.exit(2)
    text = sys.stdin.read() if sys.argv[1] == "-" else sys.argv[1]
    post(text)


if __name__ == "__main__":
    main()
