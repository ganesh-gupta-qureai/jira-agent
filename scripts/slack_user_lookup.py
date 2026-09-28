"""One-shot helper: best-effort match Jira CHU ticket owners to real Slack
member IDs, to populate scripts/slack_user_map.json.

Why this can't just run automatically and save the file: this script's own
subprocess environment (a container workspace) isn't guaranteed to persist
back into the git repo, and slack_user_map.json is meant to be a reviewed,
committed file, not something silently overwritten by a background job. So
this only ever PRINTS a suggested mapping -- a human copies the entries they
trust into slack_user_map.json and commits it.

Matching is by NAME only, not email: Jira's assignee object doesn't expose
emailAddress for this workspace (confirmed live 2026-09-28 -- the field key
exists but is always None), so this can't do a reliable email-based join.
Name matching is fuzzy by nature (a Slack display name may not exactly match
a Jira display name) -- treat every suggested match as a suggestion to
verify, not a fact to blindly trust.

Needs SLACK_BOT_TOKEN with the `users:read` scope. If that scope isn't
granted, Slack returns a `missing_scope` error and this says so plainly --
it does NOT fall back to guessing.

Usage:
    uv run scripts/slack_user_lookup.py
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _jira_client import JiraConfigError, search_all  # noqa: E402


def _slack_users_list(token: str) -> list[dict]:
    members: list[dict] = []
    cursor = ""
    while True:
        url = "https://slack.com/api/users.list?limit=200"
        if cursor:
            url += f"&cursor={cursor}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read().decode("utf-8", errors="replace"))
        if not body.get("ok"):
            raise RuntimeError(f"Slack users.list failed: {body.get('error', 'unknown_error')}")
        members.extend(body.get("members", []))
        cursor = body.get("response_metadata", {}).get("next_cursor", "")
        if not cursor:
            break
    # Real humans only -- skip bots, deleted accounts, Slackbot itself.
    return [m for m in members if not m.get("is_bot") and not m.get("deleted") and m.get("id") != "USLACKBOT"]


def _jira_owner_names() -> set[str]:
    issues = search_all(
        'project = CHU AND resolution = Unresolved AND status NOT IN ("Resolved", "Canceled")',
        fields=["assignee"],
    )
    names = set()
    for i in issues:
        assignee = i["fields"].get("assignee")
        if assignee and assignee.get("displayName"):
            names.add(assignee["displayName"])
    return names


def main() -> None:
    token = os.environ.get("SLACK_BOT_TOKEN", "")
    if not token:
        sys.exit("SLACK_BOT_TOKEN is not set -- see app/.env.example")

    try:
        owner_names = _jira_owner_names()
    except JiraConfigError as exc:
        sys.exit(str(exc))
    print(f"Found {len(owner_names)} distinct active-ticket owners in Jira.\n")

    try:
        slack_members = _slack_users_list(token)
    except RuntimeError as exc:
        print(f"Could not fetch Slack members: {exc}")
        if "missing_scope" in str(exc):
            print(
                "This bot token doesn't have the users:read scope -- add it "
                "in Slack's app config (OAuth & Permissions > Scopes > Bot "
                "Token Scopes), reinstall the app to the workspace, then "
                "re-run this script. Manual entry in slack_user_map.json is "
                "the only other option."
            )
        sys.exit(1)
    print(f"Found {len(slack_members)} real (non-bot) Slack workspace members.\n")

    # Exact display-name / real-name match only -- no fuzzy matching, so
    # every suggestion here is either right or correctly absent, never a
    # confident-looking wrong guess.
    by_name: dict[str, str] = {}
    for m in slack_members:
        profile = m.get("profile", {})
        for candidate in (profile.get("real_name"), profile.get("display_name"), m.get("real_name")):
            if candidate:
                by_name.setdefault(candidate, m["id"])

    matched: dict[str, str] = {}
    unmatched: list[str] = []
    for owner in sorted(owner_names):
        slack_id = by_name.get(owner)
        if slack_id:
            matched[owner] = slack_id
        else:
            unmatched.append(owner)

    print(f"--- matched ({len(matched)}) ---")
    print(json.dumps(matched, indent=2, ensure_ascii=False))

    if unmatched:
        print(f"\n--- NOT matched by exact name ({len(unmatched)}) -- add manually if needed ---")
        for name in unmatched:
            print(f"  {name}")

    print(
        "\nCopy the entries you trust from the 'matched' block above into "
        "scripts/slack_user_map.json (merge, don't just overwrite -- keep "
        "the _comment key), then commit. This script never writes the file "
        "itself."
    )


if __name__ == "__main__":
    main()
