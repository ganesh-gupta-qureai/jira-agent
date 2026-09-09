"""Re-export the AG-UI translator from the shared component (agui-sync).

The implementation now lives in `agui_sync/` (synced from the agui-sync repo).
This shim keeps existing imports (`from agui import translate`) working.
"""
from agui_sync import translate  # noqa: F401
