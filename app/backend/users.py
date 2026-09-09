"""Per-user identity, credential dirs, and workspace bootstrap.

JWT validation happens upstream (gateway / middleware). This module assumes the
authenticated user_id arrives on the `X-User-Id` request header and just plumbs
it through.

Layout on disk:

    /data/users/<user_id>/
        .claude/                # CLAUDE_CONFIG_DIR for this user
            .credentials.json   # written by `claude auth login`
        workspace/              # per-user cwd for the `claude` subprocess
            system_prompt.md    # symlink → /shared/system_prompt.md
            docs/               # symlink → /shared/docs
            scripts/            # symlink → /shared/scripts
            .env                # symlink → /shared/.env  (DB creds)
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import Header, HTTPException

# Roots are configurable so local dev works without Docker.
USERS_ROOT = Path(os.environ.get("USERS_ROOT", "/data/users"))
SHARED_ROOT = Path(os.environ.get("SHARED_ROOT", "/shared"))

# Files/dirs from SHARED_ROOT to expose into each user's workspace as symlinks.
_SHARED_LINKS = ("system_prompt.md", "docs", "scripts", ".env")


def get_current_user(x_user_id: str | None = Header(default=None)) -> str:
    """FastAPI dependency. Replace with real JWT validation as needed.

    Today: trusts the upstream gateway to set X-User-Id after validating the JWT.
    """
    if not x_user_id:
        raise HTTPException(status_code=401, detail="missing X-User-Id")
    # Basic shape check — avoid path traversal via crafted headers.
    if "/" in x_user_id or ".." in x_user_id or not x_user_id.strip():
        raise HTTPException(status_code=400, detail="invalid user id")
    return x_user_id


def user_config_dir(user_id: str) -> Path:
    """Path the `claude` CLI uses as CLAUDE_CONFIG_DIR for this user."""
    d = USERS_ROOT / user_id / ".claude"
    d.mkdir(parents=True, exist_ok=True)
    return d


def user_workspace(user_id: str) -> Path:
    """Per-user working dir, initialized lazily with symlinks to shared assets."""
    ws = USERS_ROOT / user_id / "workspace"
    if not ws.exists():
        ws.mkdir(parents=True, exist_ok=True)
        for name in _SHARED_LINKS:
            src = SHARED_ROOT / name
            dst = ws / name
            if src.exists() and not dst.exists():
                dst.symlink_to(src)
    return ws
