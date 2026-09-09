#!/usr/bin/env python3
"""PreToolUse hook that makes AskUserQuestion work in headless `claude -p`.

Claude Code invokes this on every tool call (matched to AskUserQuestion via
settings.json). It reads the hook payload on stdin and writes a decision on
stdout:

- No answers available yet  → `defer`. `claude -p` exits with
  `stop_reason: "tool_deferred"` + `deferred_tool_use`, and the backend surfaces
  the question to the UI.
- Answers available (the backend wrote ASKQ_ANSWER_FILE before resuming) →
  `allow` with `updatedInput` echoing the original questions plus an `answers`
  map (question text → chosen label). The tool then resolves with the real
  answer — no is_error, no assumption.

See docs/claude_stream_events.md for the full round trip.
"""
import json
import os
import sys


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return  # malformed payload — stay silent, let Claude use defaults

    if payload.get("tool_name") != "AskUserQuestion":
        return  # only AskUserQuestion is deferred; everything else passes through

    answers = None
    answer_file = os.environ.get("ASKQ_ANSWER_FILE")
    if answer_file and os.path.exists(answer_file):
        try:
            with open(answer_file) as f:
                answers = json.load(f)
        except Exception:
            answers = None

    if answers:
        decision = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "updatedInput": {**payload.get("tool_input", {}), "answers": answers},
            }
        }
    else:
        decision = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "defer",
            }
        }

    sys.stdout.write(json.dumps(decision))


if __name__ == "__main__":
    main()
