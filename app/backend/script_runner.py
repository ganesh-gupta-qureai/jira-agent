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
import os
import time
from pathlib import Path

from users import user_workspace

EXECUTE_TIMEOUT_S = 90
OUTPUT_MAX_BYTES = 64 * 1024


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
            return {
                "ok": False,
                "timed_out": True,
                "exit_code": None,
                "stdout": "",
                "stderr": f"execution timed out after {EXECUTE_TIMEOUT_S}s",
            }
        return {
            "ok": proc.returncode == 0,
            "timed_out": False,
            "exit_code": proc.returncode,
            "stdout": stdout.decode("utf-8", errors="replace")[:OUTPUT_MAX_BYTES],
            "stderr": stderr.decode("utf-8", errors="replace")[:OUTPUT_MAX_BYTES],
        }
    finally:
        try:
            script_path.unlink()
        except OSError:
            pass
