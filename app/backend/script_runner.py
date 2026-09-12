"""Execute a script the agent has already generated and printed in chat, when
a human clicks the UI's Execute button. Never called by the agent itself --
the agent's own hard rules (system_prompt.md) forbid it from running a
generated script via its own Bash tool; this is a separate, explicitly
human-triggered path with its own endpoint.

Trust boundary: this runs the exact code the human is looking at in the chat
transcript, as a plain subprocess in the same container the agent's own
scripts/ already run in (same JIRA/Slack credentials, same network access).
It is not sandboxed beyond that -- accepted per the security review that added
this feature: the risk is the same class as `scripts/` itself, and only ever
executes after a human reads the code and clicks Execute.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

from execution_history import record_execution
from users import user_workspace

EXECUTE_TIMEOUT_S = 90
OUTPUT_MAX_BYTES = 64 * 1024
# Slack's own message-length limits make a 64KB dump unreadable anyway --
# capped separately and much shorter for what actually gets posted.
SLACK_MESSAGE_MAX_CHARS = 3_000

# Matches a plain-text report's ASCII section divider, e.g.
# "=== CHU: Issues & Incidents Report ===" or "--- By Status ---".
_ASCII_HEADER_RE = re.compile(r'^(?:=|-){2,}\s*(.+?)\s*(?:=|-){2,}$', re.MULTILINE)


def _to_slack_mrkdwn(body: str) -> str:
    """Turn a plain-text report's ASCII section dividers into Slack bold
    headers. Deliberately does NOT try to fabricate hyperlinked counts the
    way scripts/chu_weekly_report.py's own hand-built Slack formatting does
    -- that requires the script itself to compute JQL search links; this
    only reformats what's already there. Slack already renders a leading
    "- " as a native bullet, so those lines need no change."""
    return _ASCII_HEADER_RE.sub(lambda m: f"*{m.group(1)}*", body)


def _post_to_slack(stdout: str) -> str | None:
    """Post a successful run's output to the configured CHU Slack channel.
    Returns an error string on failure, None on success -- never raises, so a
    Slack-posting problem never hides the fact that the script itself ran
    fine (the caller still reports ok/exit_code/stdout independent of this)."""
    token = os.environ.get("SLACK_BOT_TOKEN", "")
    channel = os.environ.get("CHU_SLACK_CHANNEL_ID", "")
    if not token or not channel:
        return "SLACK_BOT_TOKEN or CHU_SLACK_CHANNEL_ID is not set -- see app/.env.example"

    body = stdout.strip() or "(script ran successfully, no output)"
    truncated = len(body) > SLACK_MESSAGE_MAX_CHARS
    if truncated:
        body = body[:SLACK_MESSAGE_MAX_CHARS] + "\n... (truncated, see full output in the chat)"
    # No code fence, no added "Executed script result:" label -- a fenced
    # block renders as a flat monospace dump with none of Slack's own mrkdwn
    # (bold, bullets) applied inside it, and a mechanical label reads like a
    # bot notification instead of a real report. Post exactly what the
    # script printed (see system_prompt.md's instruction that a script
    # meant for Slack should open with its own natural greeting line).
    text = _to_slack_mrkdwn(body)

    payload = json.dumps({"channel": channel, "text": text, "mrkdwn": True}).encode("utf-8")
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
        return f"Slack request failed: {exc}"
    if not result.get("ok"):
        return f"Slack API error: {result.get('error', 'unknown_error')}"
    return None


async def execute_script(user_id: str, code: str) -> dict:
    """Write `code` to a throwaway file in the user's own workspace (so it
    sees the same scripts/.env/docs symlinks a `uv run scripts/...` call
    would) and run it via `uv run`, same as a human would from a terminal."""
    ws = user_workspace(user_id)
    generated_dir = ws / "generated"
    generated_dir.mkdir(exist_ok=True)
    script_path = generated_dir / f"script-{int(time.time() * 1000)}.py"
    script_path.write_text(code, encoding="utf-8")

    env = dict(os.environ)
    env.pop("VIRTUAL_ENV", None)  # use the workspace venv, not the backend's own
    # Every script modeled on scripts/jira_search.py's own documented pattern
    # does `sys.path.insert(0, str(Path(__file__).resolve().parent))` to
    # import _jira_client -- that only adds the SCRIPT's own directory, which
    # is generated_dir here, not scripts/ where _jira_client.py actually lives
    # (confirmed live: ModuleNotFoundError: No module named '_jira_client').
    # PYTHONPATH is added to sys.path by the interpreter at startup, before
    # the script's own sys.path.insert runs, so this works regardless of what
    # the generated script's own import trick does.
    scripts_dir = str(ws / "scripts")
    env["PYTHONPATH"] = os.pathsep.join(filter(None, [scripts_dir, env.get("PYTHONPATH")]))

    try:
        proc = await asyncio.create_subprocess_exec(
            "uv", "run", str(script_path),
            cwd=str(ws),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=EXECUTE_TIMEOUT_S)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            result = {
                "ok": False,
                "timed_out": True,
                "exit_code": None,
                "stdout": "",
                "stderr": f"execution timed out after {EXECUTE_TIMEOUT_S}s",
                "posted_to_slack": False,
                "slack_error": None,
            }
            record_execution(user_id, code, result)
            return result
        ok = proc.returncode == 0
        stdout_text = stdout.decode("utf-8", errors="replace")[:OUTPUT_MAX_BYTES]
        # Only a genuinely successful run gets broadcast -- a failed script's
        # traceback goes to the human in the chat UI, not to the shared channel.
        slack_error = _post_to_slack(stdout_text) if ok else None
        result = {
            "ok": ok,
            "timed_out": False,
            "exit_code": proc.returncode,
            "stdout": stdout_text,
            "stderr": stderr.decode("utf-8", errors="replace")[:OUTPUT_MAX_BYTES],
            "posted_to_slack": ok and slack_error is None,
            "slack_error": slack_error,
        }
        record_execution(user_id, code, result)
        return result
    finally:
        try:
            script_path.unlink()
        except OSError:
            pass
