"""Browse and delete this bot's own recent Slack messages in a channel.

Added 2026-10-15 after the Automation 4 incident (a test Execute click
posted for real to #us-operations with no way to undo it). This works
directly against Slack's own channel history rather than our own execution
logs, so it also covers messages posted before this feature existed, by any
path (Execute's auto-poster, a script's own direct chat.postMessage calls,
Mode 0's post_to_slack.py, or a real cron-triggered run) -- anything the bot
itself posted, not just ones made through a code path we instrumented.

Three UI/agent surfaces share these two functions:
  - the Scheduled tab's "Recent Slack posts" browser (per-message delete)
  - a chat-side "Undo last post" button (deletes list_bot_messages()[0])
  - scripts/slack_manage_messages.py (the agent's own --list/--delete, see
    system_prompt.md's Mode -1)
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

_BOT_USER_ID: str | None = None  # cached after the first auth.test call


class SlackConfigError(RuntimeError):
    pass


def _token() -> str:
    token = os.environ.get("SLACK_BOT_TOKEN", "")
    if not token:
        raise SlackConfigError("SLACK_BOT_TOKEN is not set -- see app/.env.example")
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
    global _BOT_USER_ID
    if _BOT_USER_ID is None:
        body = _get("auth.test", {})
        if not body.get("ok"):
            raise SlackConfigError(f"auth.test failed: {body.get('error', 'unknown_error')}")
        _BOT_USER_ID = body["user_id"]
    return _BOT_USER_ID


def list_bot_messages(channel: str, limit: int = 20) -> list[dict]:
    """This bot's own last `limit` messages in `channel`, newest first, each
    as {ts, text, posted_at (unix seconds)}. Only top-level channel messages
    -- thread replies aren't included (conversations.history doesn't return
    them inline; deleting a thread parent is already a clear, visible action
    without also surfacing every reply as a separate deletable row)."""
    bot_id = _bot_user_id()
    body = _get("conversations.history", {"channel": channel, "limit": 100})
    if not body.get("ok"):
        raise SlackConfigError(f"conversations.history failed: {body.get('error', 'unknown_error')}")
    out = []
    for m in body.get("messages", []):
        if m.get("user") != bot_id:
            continue
        out.append({
            "ts": m["ts"],
            "text": (m.get("text") or "")[:500],
            "posted_at": float(m["ts"]),
        })
        if len(out) >= limit:
            break
    return out


def delete_message(channel: str, ts: str) -> str | None:
    """Deletes one message this bot posted. Returns an error string on
    failure, None on success. `chat.delete` only works for a message the
    calling bot/token itself posted -- Slack rejects anything else with
    `cant_delete_message` or `message_not_found`, which surfaces here as a
    plain error string, never silently ignored."""
    try:
        body = _post("chat.delete", {"channel": channel, "ts": ts})
    except (urllib.error.HTTPError, urllib.error.URLError) as exc:
        return f"Slack request failed: {exc}"
    if not body.get("ok"):
        return f"Slack API error: {body.get('error', 'unknown_error')}"
    return None
