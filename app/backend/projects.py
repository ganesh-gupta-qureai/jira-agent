"""Project spaces: group chats + reference docs + custom instructions, same
shape as ChatGPT/Claude "Projects" (see the 2026-10-06 feature request this
was built from). One JSON file per user under USERS_ROOT, same persistence
pattern as cron_jobs.py/execution_history.py -- survives restarts/redeploys.

A project's "docs" are plain text notes (title + content), not file uploads
-- kept deliberately simple for v1. Its "custom instructions" + docs are
injected into the Claude subprocess's prompt on every turn of an assigned
chat (see main.py's run_turn) by prepending a context block -- there is no
native multi-file --append-system-prompt-file support to lean on here, and
re-prepending every turn (not just the first) means moving an EXISTING chat
into a project, or editing a project's docs/instructions later, takes effect
on the very next message rather than only chats created after the edit.
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

from users import USERS_ROOT


def _path(user_id: str) -> Path:
    d = USERS_ROOT / user_id
    d.mkdir(parents=True, exist_ok=True)
    return d / "projects.json"


def _read(user_id: str) -> dict:
    path = _path(user_id)
    if not path.exists():
        return {"projects": [], "chat_project": {}, "docs": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"projects": [], "chat_project": {}, "docs": {}}
    data.setdefault("projects", [])
    data.setdefault("chat_project", {})
    data.setdefault("docs", {})
    return data


def _write(user_id: str, data: dict) -> None:
    _path(user_id).write_text(json.dumps(data), encoding="utf-8")


def list_projects(user_id: str) -> list[dict]:
    """Newest first, each with its chat count for the sidebar."""
    data = _read(user_id)
    counts: dict[str, int] = {}
    for pid in data["chat_project"].values():
        counts[pid] = counts.get(pid, 0) + 1
    projects = sorted(data["projects"], key=lambda p: p["created_at"], reverse=True)
    for p in projects:
        p["chat_count"] = counts.get(p["id"], 0)
        p["doc_count"] = len(data["docs"].get(p["id"], []))
    return projects


def get_project(user_id: str, project_id: str) -> dict | None:
    for p in _read(user_id)["projects"]:
        if p["id"] == project_id:
            return p
    return None


def create_project(user_id: str, name: str, instructions: str = "") -> dict:
    data = _read(user_id)
    project = {
        "id": uuid.uuid4().hex,
        "name": name.strip() or "Untitled project",
        "instructions": instructions.strip(),
        "created_at": time.time(),
    }
    data["projects"].append(project)
    _write(user_id, data)
    return project


def update_project(user_id: str, project_id: str, name: str | None = None, instructions: str | None = None) -> dict | None:
    data = _read(user_id)
    for p in data["projects"]:
        if p["id"] == project_id:
            if name is not None:
                p["name"] = name.strip() or p["name"]
            if instructions is not None:
                p["instructions"] = instructions.strip()
            _write(user_id, data)
            return p
    return None


def delete_project(user_id: str, project_id: str) -> bool:
    data = _read(user_id)
    before = len(data["projects"])
    data["projects"] = [p for p in data["projects"] if p["id"] != project_id]
    if len(data["projects"]) == before:
        return False
    # Unassign any chats pointing at the deleted project, drop its docs.
    data["chat_project"] = {sid: pid for sid, pid in data["chat_project"].items() if pid != project_id}
    data["docs"].pop(project_id, None)
    _write(user_id, data)
    return True


def assign_chat(user_id: str, session_id: str, project_id: str | None) -> None:
    """project_id=None removes the chat from whatever project it was in."""
    data = _read(user_id)
    if project_id is None:
        data["chat_project"].pop(session_id, None)
    else:
        data["chat_project"][session_id] = project_id
    _write(user_id, data)


def get_chat_project_id(user_id: str, session_id: str | None) -> str | None:
    if not session_id:
        return None
    return _read(user_id)["chat_project"].get(session_id)


def chat_project_map(user_id: str) -> dict[str, str]:
    """session_id -> project_id, for annotating the conversations list."""
    return dict(_read(user_id)["chat_project"])


def list_docs(user_id: str, project_id: str) -> list[dict]:
    return list(_read(user_id)["docs"].get(project_id, []))


def add_doc(user_id: str, project_id: str, title: str, content: str) -> dict:
    data = _read(user_id)
    doc = {"id": uuid.uuid4().hex, "title": title.strip() or "Untitled", "content": content, "created_at": time.time()}
    data["docs"].setdefault(project_id, []).append(doc)
    _write(user_id, data)
    return doc


def delete_doc(user_id: str, project_id: str, doc_id: str) -> bool:
    data = _read(user_id)
    docs = data["docs"].get(project_id, [])
    before = len(docs)
    data["docs"][project_id] = [d for d in docs if d["id"] != doc_id]
    if len(data["docs"][project_id]) == before:
        return False
    _write(user_id, data)
    return True


def build_context_block(user_id: str, project_id: str) -> str:
    """Instructions + docs, formatted to prepend onto a prompt. Empty string
    if the project has neither (nothing to inject)."""
    project = get_project(user_id, project_id)
    if not project:
        return ""
    parts: list[str] = []
    if project["instructions"]:
        parts.append(f"Project custom instructions:\n{project['instructions']}")
    docs = list_docs(user_id, project_id)
    if docs:
        doc_text = "\n\n".join(f"### {d['title']}\n{d['content']}" for d in docs)
        parts.append(f"Project reference docs:\n{doc_text}")
    if not parts:
        return ""
    return (
        f"[This chat belongs to project \"{project['name']}\" -- the following is "
        "project-scoped context, in addition to your normal system prompt:]\n\n"
        + "\n\n".join(parts)
        + "\n\n[End of project context. Now the actual message:]\n\n"
    )
