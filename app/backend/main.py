"""FastAPI app: claude -> AG-UI over a resumable SSE log (agui-sync).

`POST /api/chat` *triggers* a background turn that appends AG-UI events to a per
(user, thread) RunLog; clients subscribe via `GET /api/events?thread_id=...`
(resumable SSE). The run is independent of any connection, so a refresh or a
second tab re-attaches to the in-progress run — same model as ryureflect.

In prod (single-image deploy) it also serves the built Vite SPA from ./static.
All routes are mounted under APP_PREFIX so requests proxied through Hive
(/apps/sql-agent/...) hit the right handlers.
"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from agui import translate
from agui_sync import drive_turn, resume_point, sse_response
from auth import complete_login, get_status, start_login
from claude_runner import run_claude
from conversations import get_conversation, list_conversations
from langfuse_emit import emit_turn
from runlog import get_runlog
from script_runner import execute_script


class _TurnTrace:
    """Accumulates a turn's content from the AG-UI event stream so we can emit
    one Langfuse trace per turn (input/output + tool spans) — see langfuse_emit."""

    def __init__(self, user_id: str, session_id: str | None, user_message: str):
        self.user_id = user_id
        self.session_id = session_id
        self.user_message = user_message
        self._text: list[str] = []
        self._tools: dict[str, dict] = {}
        self._order: list[str] = []

    def observe(self, event: dict) -> None:
        t = event.get("type")
        if t == "SESSION":
            self.session_id = event.get("session_id") or self.session_id
        elif t == "TEXT_MESSAGE_CONTENT":
            self._text.append(event.get("delta", ""))
        elif t == "TOOL_CALL_START":
            tid = event.get("tool_call_id", "")
            self._tools[tid] = {"name": event.get("tool_call_name", "tool"), "args": "", "result": None}
            self._order.append(tid)
        elif t == "TOOL_CALL_ARGS":
            tid = event.get("tool_call_id", "")
            if tid in self._tools:
                self._tools[tid]["args"] += event.get("delta", "")
        elif t == "TOOL_CALL_RESULT":
            tid = event.get("tool_call_id", "")
            if tid in self._tools:
                self._tools[tid]["result"] = event.get("content")

    def emit(self) -> None:
        """Fire-and-forget the trace off the event loop (flush is blocking)."""
        asyncio.create_task(
            asyncio.to_thread(
                emit_turn,
                user_id=self.user_id,
                session_id=self.session_id,
                user_message=self.user_message,
                assistant_text="".join(self._text),
                tool_calls=[self._tools[t] for t in self._order],
            )
        )


def current_user(x_user_id: str | None = Header(default=None)) -> str:
    """Resolve the calling user. Hive's proxy will set X-User-Id; until that's
    wired everyone shares the "default" workspace. See per-user-claude-creds."""
    return x_user_id or "default"


# Empty string in local dev (Vite proxies /api to us directly).
# Set to e.g. "/apps/sql-agent" in prod so we match the path Hive proxies in.
APP_PREFIX = os.environ.get("APP_PREFIX", "").rstrip("/")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174"],
    allow_methods=["*"],
    allow_headers=["*"],
)

router = APIRouter()


class ChatRequest(BaseModel):
    message: str
    # Stable conversation key the client owns (a fresh uuid for a new chat, or an
    # existing session_id when reopening). The RunLog + /events are keyed on it.
    thread_id: str
    # The claude session to resume (set when reopening an existing conversation).
    session_id: str | None = None


class AnswerRequest(BaseModel):
    thread_id: str
    session_id: str | None = None
    # question text -> chosen label (comma-joined for multi-select).
    answers: dict[str, str]


class LoginComplete(BaseModel):
    session_id: str
    code: str


class ExecuteScriptRequest(BaseModel):
    # The exact script text shown in chat -- the human has already read it and
    # is choosing to run it now via the Execute button.
    code: str


@router.get("/api/health")
async def health() -> dict:
    return {"ok": True}


@router.get("/api/auth/status")
async def auth_status(user: str = Depends(current_user)) -> dict:
    return await get_status(user)


@router.post("/api/auth/start")
async def auth_start(user: str = Depends(current_user)) -> dict:
    return await start_login(user)


@router.post("/api/auth/complete")
async def auth_complete(req: LoginComplete) -> dict:
    return await complete_login(req.session_id, req.code)


def _seed_items(user: str, session_id: str) -> list[dict]:
    """Map a replayed transcript into the frontend's TimelineItem shapes so the
    SYNC frame seeds the UI directly (assistant_text uses `segments`)."""
    out: list[dict] = []
    for it in get_conversation(user, session_id) or []:
        k = it.get("kind")
        if k == "assistant_text":
            out.append({"kind": "assistant_text", "id": it["id"], "segments": [it.get("text", "")], "done": True})
        elif k == "user":
            out.append({"kind": "user", "id": it["id"], "text": it.get("text", "")})
        elif k == "tool_call":
            out.append({"kind": "tool_call", "id": it["id"], "name": it.get("name", ""),
                        "args": it.get("args", ""), "result": it.get("result"), "done": True})
    return out


def _log(user: str, thread_id: str, session_id: str | None = None):
    """Get (or create + seed) the per-(user, thread) RunLog. When a session_id is
    given (reopening a conversation) the log is seeded from claude's transcript."""
    seed = (lambda: _seed_items(user, session_id)) if session_id else None
    return get_runlog(user, thread_id, session_id=session_id, seed=seed)


async def _traced(events: AsyncIterator[dict], trace: _TurnTrace) -> AsyncIterator[dict]:
    """Tee the event stream into the Langfuse trace without consuming it."""
    async for ev in events:
        trace.observe(ev)
        yield ev


async def run_turn(user: str, thread_id: str, message: str, *, answer_file: str | None = None) -> None:
    """Drive one turn as a background task: fold AG-UI events into the log
    (agui_sync.drive_turn handles running-state, terminal events, reaping), keep
    the Langfuse trace + session-id persistence, then drain the queued message."""
    log = get_runlog(user, thread_id)
    run_id = str(uuid.uuid4())
    resume = getattr(log, "session_id", None)
    trace = _TurnTrace(user, resume, message or "(answer)")

    def on_session(sid: str) -> None:
        if sid:
            log.session_id = sid

    events = _traced(
        translate(
            run_claude(message, user_id=user, session_id=resume, answer_file=answer_file),
            thread_id=resume or thread_id,
            run_id=run_id,
        ),
        trace,
    )
    try:
        await drive_turn(log, events, on_session=on_session)
    finally:
        trace.session_id = getattr(log, "session_id", None) or trace.session_id
        trace.emit()
        if answer_file:
            try:
                os.remove(answer_file)
            except OSError:
                pass
        if log.queue:
            nxt = log.queue.pop(0)
            log.task = asyncio.create_task(run_turn(user, thread_id, nxt))


@router.post("/api/chat")
async def chat(req: ChatRequest, user: str = Depends(current_user)) -> dict:
    log = _log(user, req.thread_id, req.session_id)
    # echo the user message into the log so every tab + a refresh sees it
    await log.append({"type": "USER_MESSAGE", "text": req.message, "images": []})
    if log.running:
        log.queue.append(req.message)
        return {"queued": True}
    log.task = asyncio.create_task(run_turn(user, req.thread_id, req.message))
    return {"ok": True}


@router.post("/api/answer")
async def answer(req: AnswerRequest, user: str = Depends(current_user)) -> dict:
    """Resume a deferred AskUserQuestion with the user's structured answers.

    Writes the answers to a temp file the PreToolUse hook reads, then resumes the
    session with an empty prompt so the deferred tool resolves cleanly."""
    log = _log(user, req.thread_id, req.session_id)
    if log.running:
        raise HTTPException(status_code=409, detail="a turn is already running")
    fd, answer_file = tempfile.mkstemp(suffix=".json", prefix="askq-")
    with os.fdopen(fd, "w") as f:
        json.dump(req.answers, f)
    log.task = asyncio.create_task(run_turn(user, req.thread_id, "", answer_file=answer_file))
    return {"ok": True}


@router.get("/api/events")
async def events(
    thread_id: str,
    request: Request,
    user: str = Depends(current_user),
    session_id: str | None = None,
):
    """Resumable SSE — SYNC + backlog + live tail, served by agui_sync. Pass
    session_id when reopening a conversation so its transcript seeds the log."""
    log = _log(user, thread_id, session_id)
    return sse_response(log, resume_point(request))


@router.post("/api/execute-script")
async def execute_script_route(req: ExecuteScriptRequest, user: str = Depends(current_user)) -> dict:
    """Human-triggered only (the UI's Execute button under a generated script)
    -- the agent itself never calls this; see script_runner.py."""
    if not req.code.strip():
        raise HTTPException(status_code=400, detail="no script content")
    return await execute_script(user, req.code)


@router.get("/api/conversations")
async def conversations(user: str = Depends(current_user)) -> list[dict]:
    """The user's past conversations (the inbox/recents list), newest first."""
    return list_conversations(user)


@router.get("/api/conversations/{session_id}")
async def conversation(session_id: str, user: str = Depends(current_user)) -> dict:
    """Replay one conversation as renderable timeline items."""
    items = get_conversation(user, session_id)
    if items is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    return {"session_id": session_id, "items": items}


app.include_router(router, prefix=APP_PREFIX)


# --- Static SPA (only in single-image / prod builds) -----------------------
STATIC_DIR = Path(__file__).resolve().parent / "static"
if STATIC_DIR.is_dir():
    app.mount(
        f"{APP_PREFIX}/assets",
        StaticFiles(directory=STATIC_DIR / "assets"),
        name="assets",
    )

    @app.get(f"{APP_PREFIX}/{{full_path:path}}", include_in_schema=False)
    async def spa_fallback(full_path: str) -> FileResponse:
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        candidate = STATIC_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(STATIC_DIR / "index.html")
