"""Spawn the `claude` CLI as a subprocess and yield stream-json events line-by-line.

The CLI emits one JSON object per line when invoked with
`--output-format stream-json --verbose`. Event shapes (the ones we care about):

    {"type": "system",    "subtype": "init", "session_id": "..."}
    {"type": "stream_event", "event": {"type": "content_block_delta", "delta": {...}}}
    {"type": "assistant", "message": {"content": [{"type": "text", "text": "..."}, ...]}}
    {"type": "user",      "message": {"content": [{"type": "tool_result", ...}]}}
    {"type": "result",    "subtype": "success", "session_id": "...", ...}
"""
from __future__ import annotations

import asyncio
import functools
import json
import os
from collections.abc import AsyncIterator
from pathlib import Path

from agui_sync import stream_claude
from users import user_config_dir, user_workspace

_HOOK = Path(__file__).resolve().parent / "askq_hook.py"
_SETTINGS = Path(__file__).resolve().parent / "claude_settings.json"


def _ensure_settings() -> str:
    """Write a settings.json registering the AskUserQuestion PreToolUse hook.

    Defers AskUserQuestion so the UI can collect an answer, and on the resume
    turn resolves it from ASKQ_ANSWER_FILE. See askq_hook.py. (Langfuse tracing
    is done in the backend, not via a Stop hook — see langfuse_emit.py.)
    """
    settings = {
        "hooks": {
            "PreToolUse": [
                {
                    "matcher": "AskUserQuestion",
                    "hooks": [{"type": "command", "command": f"python3 {_HOOK}"}],
                }
            ],
        }
    }
    _SETTINGS.write_text(json.dumps(settings))
    return str(_SETTINGS)


def _subprocess_env(user_id: str, answer_file: str | None = None) -> dict[str, str]:
    """Parent env, scoped for this user's claude subprocess.

    CLAUDE_CONFIG_DIR isolates each user's `claude` auth + transcripts on disk.
    """
    env = dict(os.environ)
    env.pop("VIRTUAL_ENV", None)  # use the workspace venv, not the backend one
    env["CLAUDE_CONFIG_DIR"] = str(user_config_dir(user_id))

    # Present only on answer turns — the hook resolves AskUserQuestion from it.
    if answer_file:
        env["ASKQ_ANSWER_FILE"] = answer_file
    else:
        env.pop("ASKQ_ANSWER_FILE", None)

    return env


def run_claude(
    prompt: str,
    user_id: str,
    session_id: str | None = None,
    answer_file: str | None = None,
) -> AsyncIterator[dict]:
    """Spawn claude with stream-json output and yield each parsed event.

    answer_file: path to a JSON {question_text: chosen_label} map. When set
    (answer turns), the AskUserQuestion hook resolves the deferred question
    from it instead of deferring again.
    """
    # Per-user workspace still gets created (for future multi-tenant scratch
    # writes) but the subprocess cwd is SHARED_ROOT — that's where uv finds
    # pyproject.toml / .venv to run `uv run scripts/run_query.py`. Without
    # this, uv tries to bootstrap a fresh venv every invocation.
    user_workspace(user_id)
    cwd = os.environ.get("SHARED_ROOT", "/shared")
    system_prompt = Path(cwd) / "system_prompt.md"

    args = [
        "claude",
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        # The user's workspace contains symlinks to /workspace (mounted shared
        # assets: schema doc, scripts, .env). Pre-allow that dir.
        "--add-dir",
        os.environ.get("SHARED_ROOT", "/shared"),
        # Auto-approve the tools the SQL agent legitimately needs in headless
        # mode. Safety: read-only DB connection, per-user workspace.
        "--allowed-tools",
        "Bash",
        "Read",
        "Glob",
        "Grep",
        "Write",
        "Edit",
        # PreToolUse hook that defers AskUserQuestion so the UI can answer it.
        "--settings",
        _ensure_settings(),
    ]
    if system_prompt.exists():
        args += ["--append-system-prompt-file", str(system_prompt)]
    if session_id:
        args += ["--resume", session_id]

    # spawn + stream-json parse + reap now live in agui_sync.stream_claude; we
    # only supply the argv and the per-user cwd/env (auth via CLAUDE_CONFIG_DIR
    # or the shared CLAUDE_CODE_OAUTH_TOKEN inherited from the environment).
    env = _subprocess_env(user_id, answer_file)
    return stream_claude(
        args, exec=functools.partial(asyncio.create_subprocess_exec, cwd=cwd, env=env)
    )
