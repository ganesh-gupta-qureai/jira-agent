"""List and replay past conversations from Claude Code's JSONL transcripts.

Claude persists every session to
    <CLAUDE_CONFIG_DIR>/projects/<cwd-slug>/<session-id>.jsonl
(one JSON object per line). We don't keep our own message store — these files
are the source of truth. See docs/conversation_storage.md.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from users import user_config_dir


def _project_dir(user_id: str) -> Path:
    """The dir holding this user's session transcripts.

    The slug is the subprocess cwd (SHARED_ROOT) with '/' -> '-', matching how
    Claude Code names project dirs. We run claude from SHARED_ROOT, so all of a
    user's sessions land in this one dir.
    """
    cwd = os.environ.get("SHARED_ROOT", "/shared")
    slug = cwd.replace("/", "-")
    return user_config_dir(user_id).parent / ".claude" / "projects" / slug


def _first_user_text(path: Path) -> str | None:
    """Title = first user turn with plain-string content."""
    try:
        with path.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if e.get("type") == "user":
                    content = e.get("message", {}).get("content")
                    if isinstance(content, str) and content.strip():
                        return content.strip()
    except OSError:
        return None
    return None


def list_conversations(user_id: str) -> list[dict]:
    """All of a user's conversations, newest first.

    Cheap: reads only each file's head for a title + uses mtime for recency.
    """
    pdir = _project_dir(user_id)
    if not pdir.is_dir():
        return []

    out: list[dict] = []
    for path in pdir.glob("*.jsonl"):
        title = _first_user_text(path)
        if title is None:
            # Skip empty/never-prompted sessions.
            continue
        out.append(
            {
                "session_id": path.stem,
                "title": title[:80],
                "updated_at": path.stat().st_mtime,
            }
        )
    out.sort(key=lambda c: c["updated_at"], reverse=True)
    return out


def get_conversation(user_id: str, session_id: str) -> list[dict] | None:
    """Replay one transcript as timeline items the frontend can render.

    Returns items shaped like the frontend's TimelineItem:
        {kind: "user", id, text}
        {kind: "assistant_text", id, text}
        {kind: "tool_call", id, name, args, result}

    NOTE: uses file order, correct for linear conversations. Rewound sessions
    (branching via parentUuid) could interleave branches — see the caveat in
    docs/conversation_storage.md. Good enough for v1.
    """
    # Guard against path traversal via a crafted session_id.
    if "/" in session_id or ".." in session_id:
        return None
    path = _project_dir(user_id) / f"{session_id}.jsonl"
    if not path.is_file():
        return None

    items: list[dict] = []
    tool_by_id: dict[str, dict] = {}

    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            etype = e.get("type")
            uid = e.get("uuid", "")

            if etype == "user":
                content = e.get("message", {}).get("content")
                if isinstance(content, str):
                    if content.strip():
                        items.append({"kind": "user", "id": uid, "text": content})
                elif isinstance(content, list):
                    for b in content:
                        if not isinstance(b, dict):
                            continue
                        if b.get("type") == "tool_result":
                            tid = b.get("tool_use_id")
                            res = b.get("content")
                            if isinstance(res, list):
                                res = "".join(
                                    c.get("text", "") for c in res if isinstance(c, dict)
                                )
                            if tid in tool_by_id:
                                tool_by_id[tid]["result"] = res

            elif etype == "assistant":
                content = e.get("message", {}).get("content", [])
                if isinstance(content, str):
                    if content.strip():
                        items.append({"kind": "assistant_text", "id": uid, "text": content})
                elif isinstance(content, list):
                    for j, b in enumerate(content):
                        if not isinstance(b, dict):
                            continue
                        if b.get("type") == "text" and b.get("text", "").strip():
                            items.append(
                                {"kind": "assistant_text", "id": f"{uid}-{j}", "text": b["text"]}
                            )
                        elif b.get("type") == "tool_use":
                            item = {
                                "kind": "tool_call",
                                "id": b.get("id", f"{uid}-{j}"),
                                "name": b.get("name", ""),
                                "args": json.dumps(b.get("input", {})),
                                "result": None,
                            }
                            tool_by_id[item["id"]] = item
                            items.append(item)

    return items
