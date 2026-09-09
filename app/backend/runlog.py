"""Per (user, thread) RunLog registry.

The RunLog itself comes from the shared component (agui_sync); this keeps the
small registry plus the claude session_id (resume id) tracked per thread.

A `thread_id` is the stable conversation key the client owns: a fresh uuid for a
new chat (session_id is None until claude assigns one), or the existing
session_id when an old conversation is reopened from the inbox.
"""
from __future__ import annotations

from collections.abc import Callable

from agui_sync import InMemoryStore, RunLog

_logs: dict[tuple[str, str], RunLog] = {}


def get_runlog(
    user: str,
    thread_id: str,
    *,
    session_id: str | None = None,
    seed: Callable[[], list[dict]] | None = None,
) -> RunLog:
    key = (user, thread_id)
    log = _logs.get(key)
    if log is None:
        log = RunLog(InMemoryStore(), seed=seed or (lambda: []))
        log.session_id = session_id  # claude resume id; None for a brand-new thread
        _logs[key] = log
    elif session_id and not getattr(log, "session_id", None):
        log.session_id = session_id
    return log
