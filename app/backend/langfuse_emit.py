"""Emit one Langfuse trace per chat turn, directly from the backend.

We already parse the whole turn in main.py (user message, assistant text, tool
calls), so we build the trace here with the public Langfuse SDK. This replaces
the Stop-hook approach, which doesn't reliably fire when claude is spawned from
the web-request context. No-op unless LANGFUSE_PUBLIC_KEY/SECRET_KEY are set.
"""
from __future__ import annotations

import os

_client = None
_init_failed = False


def _get_client():
    """Lazily build a singleton Langfuse client (the backend is long-lived)."""
    global _client, _init_failed
    if _client is not None or _init_failed:
        return _client
    pk = os.environ.get("LANGFUSE_PUBLIC_KEY")
    sk = os.environ.get("LANGFUSE_SECRET_KEY")
    if not pk or not sk:
        _init_failed = True
        return None
    try:
        from langfuse import Langfuse

        _client = Langfuse(
            public_key=pk,
            secret_key=sk,
            host=os.environ.get("LANGFUSE_BASE_URL", "https://cloud.langfuse.com"),
        )
    except Exception:
        _init_failed = True
        return None
    return _client


def emit_turn(
    *,
    user_id: str,
    session_id: str | None,
    user_message: str,
    assistant_text: str,
    tool_calls: list[dict],
) -> None:
    """Build + send one trace. Tool calls: [{name, args, result}]. Best-effort —
    never raises, so tracing can't break a chat turn. Blocking (~1s flush); call
    it off the event loop (asyncio.to_thread)."""
    lf = _get_client()
    if lf is None:
        return
    try:
        from langfuse import propagate_attributes

        with propagate_attributes(
            session_id=session_id or None,
            user_id=user_id or None,
            trace_name="Agent — Turn",
            tags=["agent"],
        ):
            root = lf.start_observation(
                name="Agent — Turn", as_type="span", input=user_message
            )
            try:
                for tc in tool_calls:
                    child = root.start_observation(
                        name=f"Tool: {tc.get('name', 'tool')}",
                        as_type="tool",
                        input=tc.get("args"),
                    )
                    child.update(output=tc.get("result"))
                    child.end()
            finally:
                root.update(output=assistant_text)
                root.end()
        lf.flush()
    except Exception:
        pass
