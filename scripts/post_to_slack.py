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
# Keep in sync with app/backend/script_runner.py's identical set -- two
# copies because this runs in the workspace's `uv run` env, that one in the
# backend's, not because the logic is meant to diverge.
_MD_HEADING_RE = re.compile(r'^#{1,6}\s+(.+)$', re.MULTILINE)
_MD_BOLD_RE = re.compile(r'\*\*([^*]+)\*\*|__([^_]+)__')
_MD_LINK_RE = re.compile(r'\[([^\]]+)\]\(([^)]+)\)')
_TABLE_ROW_RE = re.compile(r'^\s*\|(.+)\|\s*$')
_TABLE_SEP_CELL_RE = re.compile(r'^:?-{2,}:?$')
_SECOND_PERSON_RE = re.compile(r"\byour?\b", re.IGNORECASE)


def _parse_table_row(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip('|').split('|')]


def _is_table_separator_row(cells: list[str]) -> bool:
    return bool(cells) and all(_TABLE_SEP_CELL_RE.match(c) for c in cells if c)


def _render_table_block(rows: list[list[str]]) -> str:
    ncols = max(len(r) for r in rows)
    rows = [r + [""] * (ncols - len(r)) for r in rows]
    widths = [max(len(r[c]) for r in rows) for c in range(ncols)]
    header, *body_rows = rows
    lines = ["  ".join(cell.ljust(widths[c]) for c, cell in enumerate(header)).rstrip()]
    lines.append("  ".join("-" * widths[c] for c in range(ncols)))
    for row in body_rows:
        lines.append("  ".join(cell.ljust(widths[c]) for c, cell in enumerate(row)).rstrip())
    return "```\n" + "\n".join(lines) + "\n```"


def _convert_tables(text: str) -> str:
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if _TABLE_ROW_RE.match(line) and i + 1 < len(lines) and _TABLE_ROW_RE.match(lines[i + 1]):
            if _is_table_separator_row(_parse_table_row(lines[i + 1])):
                rows = [_parse_table_row(line)]
                j = i + 2
                while j < len(lines) and _TABLE_ROW_RE.match(lines[j]):
                    rows.append(_parse_table_row(lines[j]))
                    j += 1
                out.append(_render_table_block(rows))
                i = j
                continue
        out.append(line)
        i += 1
    return "\n".join(out)


def _strip_chatty_tail(body: str) -> str:
    tail_start = max(0, len(body) - 400)
    m = _SECOND_PERSON_RE.search(body, tail_start)
    if not m:
        return body
    idx = m.start()
    cutoff = -1
    for sep in (". ", ".\n", "! ", "!\n", "? ", "?\n", "\n\n"):
        pos = body.rfind(sep, 0, idx)
        if pos != -1:
            cutoff = max(cutoff, pos + 1)
    return body[:cutoff].rstrip() if cutoff > 0 else body


def _to_slack_mrkdwn(body: str) -> str:
    body = _strip_chatty_tail(body)
    body = _ASCII_HEADER_RE.sub(lambda m: f"*{m.group(1)}*", body)
    body = _MD_HEADING_RE.sub(lambda m: f"*{m.group(1)}*", body)
    body = _MD_BOLD_RE.sub(lambda m: f"*{m.group(1) or m.group(2)}*", body)
    body = _MD_LINK_RE.sub(lambda m: f"<{m.group(2)}|{m.group(1)}>", body)
    return _convert_tables(body)


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
