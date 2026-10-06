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
  uv run scripts/post_to_slack.py --channel C0B86EU1Y03 "<text>"
  printf '%s' "<text>" | uv run scripts/post_to_slack.py -
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
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


def _split_entries(text: str) -> list[str]:
    return [b.strip() for b in text.split("\n\n") if b.strip()]


def _looks_like_headline(entry: str) -> bool:
    return len(entry) < 250 and "<http" not in entry and not entry.lstrip().startswith(("-", "*", "•"))


def _chunk_entries(entries: list[str], max_chars: int = 2800) -> list[str]:
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for entry in entries:
        entry_len = len(entry) + 2
        if current and current_len + entry_len > max_chars:
            chunks.append("\n\n".join(current))
            current, current_len = [], 0
        current.append(entry)
        current_len += entry_len
    if current:
        chunks.append("\n\n".join(current))
    return chunks


def _slack_post_message(token: str, channel: str, text: str, thread_ts: str | None = None) -> dict:
    payload: dict = {"channel": channel, "text": text, "mrkdwn": True}
    if thread_ts:
        payload["thread_ts"] = thread_ts
    request = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def post(text: str, channel: str | None = None) -> None:
    """Long-output rule (2026-10-06): more than 10 entries (blank-line
    blocks) or 3000+ chars posts a short summary message with the entries as
    thread replies instead of one giant flat message -- see
    app/backend/script_runner.py's identical rule for the Execute/Schedule
    auto-poster, kept in sync here for Mode 0's direct posts."""
    token = os.environ.get("SLACK_BOT_TOKEN", "")
    channel = channel or os.environ.get("CHU_SLACK_CHANNEL_ID", "")
    if not token or not channel:
        print("ERROR: SLACK_BOT_TOKEN or CHU_SLACK_CHANNEL_ID is not set -- see app/.env.example", file=sys.stderr)
        sys.exit(1)

    body = text.strip() or "(no content)"
    text = _to_slack_mrkdwn(body)
    entries = _split_entries(text)

    if (len(entries) > 10 or len(text) > SLACK_MESSAGE_MAX_CHARS) and len(entries) > 1:
        headline, items = (entries[0], entries[1:]) if _looks_like_headline(entries[0]) else (None, entries)
        summary = f"{headline}\n({len(items)} item(s) — see thread)" if headline else f"{len(items)} item(s) below:"
        try:
            parent = _slack_post_message(token, channel, summary)
        except (urllib.error.HTTPError, urllib.error.URLError) as exc:
            print(f"ERROR: Slack request failed: {exc}", file=sys.stderr)
            sys.exit(1)
        if not parent.get("ok"):
            print(f"ERROR: Slack API error: {parent.get('error', 'unknown_error')}", file=sys.stderr)
            sys.exit(1)
        thread_ts = parent.get("ts")
        for chunk in _chunk_entries(items):
            time.sleep(1.0)
            try:
                reply = _slack_post_message(token, channel, chunk, thread_ts=thread_ts)
            except (urllib.error.HTTPError, urllib.error.URLError) as exc:
                print(f"ERROR: Slack request failed mid-thread: {exc}", file=sys.stderr)
                sys.exit(1)
            if not reply.get("ok"):
                print(f"ERROR: Slack API error mid-thread: {reply.get('error', 'unknown_error')}", file=sys.stderr)
                sys.exit(1)
        print("OK: posted to Slack (summary + thread)")
        return

    if len(text) > SLACK_MESSAGE_MAX_CHARS:
        text = text[:SLACK_MESSAGE_MAX_CHARS] + "\n... (truncated)"
    try:
        result = _slack_post_message(token, channel, text)
    except (urllib.error.HTTPError, urllib.error.URLError) as exc:
        print(f"ERROR: Slack request failed: {exc}", file=sys.stderr)
        sys.exit(1)
    if not result.get("ok"):
        print(f"ERROR: Slack API error: {result.get('error', 'unknown_error')}", file=sys.stderr)
        sys.exit(1)
    print("OK: posted to Slack")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("text", help='text to post, or "-" to read stdin')
    parser.add_argument(
        "--channel",
        default=None,
        help="Slack channel ID to post to (overrides CHU_SLACK_CHANNEL_ID). "
             "See system_prompt.md's Mode 0 -- always pass this explicitly.",
    )
    args = parser.parse_args()
    text = sys.stdin.read() if args.text == "-" else args.text
    post(text, channel=args.channel)


if __name__ == "__main__":
    main()
