"""Drive `claude auth login` from FastAPI.

Two-step flow:
    POST /api/auth/start    -> spawns the CLI, returns the auth URL it prints
    POST /api/auth/complete -> writes the pasted code to the CLI's stdin

The CLI prints (on stderr):
    Opening browser to sign in…
    If the browser didn't open, visit: <URL>
    Paste code here if prompted >
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from dataclasses import dataclass

from users import user_config_dir

# session_id -> live subprocess waiting on stdin
_pending: dict[str, "LoginSession"] = {}

_URL_RE = re.compile(r"https://\S+")


def _claude_env(user_id: str) -> dict[str, str]:
    """Parent env + CLAUDE_CONFIG_DIR pointing at the user's per-user dir.

    Auth state must be read/written from the same dir `claude_runner.py` uses
    when it later runs the chat, otherwise login appears successful but
    `run_claude` reports "Not logged in".
    """
    env = dict(os.environ)
    env["CLAUDE_CONFIG_DIR"] = str(user_config_dir(user_id))
    return env


@dataclass
class LoginSession:
    proc: asyncio.subprocess.Process
    url: str


async def get_status(user_id: str = "default") -> dict:
    """Run `claude auth status --json` and return the parsed object."""
    proc = await asyncio.create_subprocess_exec(
        "claude", "auth", "status", "--json",
        env=_claude_env(user_id),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await proc.communicate()
    try:
        return json.loads(out.decode())
    except json.JSONDecodeError:
        return {"loggedIn": False}


async def start_login(user_id: str = "default") -> dict:
    """Spawn `claude auth login`, capture the URL, return it with a session id."""
    proc = await asyncio.create_subprocess_exec(
        "claude", "auth", "login", "--claudeai",
        env=_claude_env(user_id),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,  # merge so we read one stream
    )
    assert proc.stdout is not None

    url: str | None = None
    # Read lines until the URL appears or the prompt is reached.
    while True:
        try:
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=8)
        except asyncio.TimeoutError:
            break
        if not line:
            break
        text = line.decode(errors="replace")
        m = _URL_RE.search(text)
        if m:
            url = m.group(0)
            break

    if url is None:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
        raise RuntimeError("did not get an auth URL from `claude auth login`")

    session_id = str(uuid.uuid4())
    _pending[session_id] = LoginSession(proc=proc, url=url)
    return {"session_id": session_id, "url": url}


async def complete_login(session_id: str, code: str) -> dict:
    """Send the pasted code to the waiting CLI; report success."""
    sess = _pending.pop(session_id, None)
    if sess is None:
        return {"ok": False, "error": "unknown or expired session"}

    proc = sess.proc
    assert proc.stdin is not None

    try:
        proc.stdin.write((code.strip() + "\n").encode())
        await proc.stdin.drain()
        proc.stdin.close()
    except (BrokenPipeError, ConnectionResetError):
        pass

    # Drain any remaining output so we can report errors clearly.
    tail = b""
    if proc.stdout is not None:
        try:
            tail = await asyncio.wait_for(proc.stdout.read(), timeout=10)
        except asyncio.TimeoutError:
            pass

    try:
        await asyncio.wait_for(proc.wait(), timeout=10)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()

    ok = proc.returncode == 0
    return {
        "ok": ok,
        "returncode": proc.returncode,
        "message": tail.decode(errors="replace").strip(),
    }
