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

import difflib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _jira_client import JiraConfigError, search_all  # noqa: E402

# Common English first-name <-> nickname pairs -- lets "Ron Wider" (Slack)
# match "Ronald Wider" (Jira) even though neither exact nor normalized
# string matching can, since the two names aren't the same string in any
# casing/spacing. Deliberately a small, well-known table rather than a
# general nickname-guessing algorithm -- every pair here is unambiguous, so
# this never invents a nickname relationship that isn't actually common.
_NICKNAMES: dict[str, set[str]] = {}
for _a, _b in [
    ("ron", "ronald"), ("rob", "robert"), ("bob", "robert"), ("bill", "william"),
    ("will", "william"), ("mike", "michael"), ("dave", "david"), ("dan", "daniel"),
    ("dan", "danielle"), ("steve", "steven"), ("steve", "stephen"), ("chris", "christopher"),
    ("chris", "christine"), ("liz", "elizabeth"), ("beth", "elizabeth"), ("jim", "james"),
    ("joe", "joseph"), ("tom", "thomas"), ("tony", "anthony"), ("alex", "alexander"),
    ("alex", "alexandra"), ("sam", "samuel"), ("sam", "samantha"), ("nick", "nicholas"),
    ("matt", "matthew"), ("andy", "andrew"), ("ken", "kenneth"), ("ted", "theodore"),
    ("greg", "gregory"), ("jen", "jennifer"), ("jenny", "jennifer"), ("kate", "katherine"),
    ("katie", "katherine"), ("pat", "patricia"), ("patty", "patricia"),
]:
    _NICKNAMES.setdefault(_a, set()).add(_b)
    _NICKNAMES.setdefault(_b, set()).add(_a)


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

    # Two passes, both deterministic (no edit-distance/fuzzy matching that
    # could produce a confident-looking wrong guess):
    #   1. Exact string match.
    #   2. Normalized match -- lowercase, and "." or "_" treated as a space,
    #      so a Jira dotted-username style ("Sai.Vinayak") can still match a
    #      Slack real name written as "Sai Vinayak". Every normalized match
    #      is labeled as such in the output so a human can sanity-check it
    #      before trusting it the same as an exact match.
    def _normalize(s: str) -> str:
        return " ".join(s.replace(".", " ").replace("_", " ").split()).lower()

    def _similarity(jira_name: str, slack_name: str) -> float:
        """0..1 confidence that these are the same person: last name must
        match exactly (this is the real signal -- two different people
        sharing a first name is common, sharing a last name in the same
        small org is not), then first name gets a nickname-table check or a
        plain string-similarity score."""
        j_parts = _normalize(jira_name).split()
        s_parts = _normalize(slack_name).split()
        if not j_parts or not s_parts or j_parts[-1] != s_parts[-1]:
            return 0.0
        j_first, s_first = j_parts[0], s_parts[0]
        if j_first == s_first:
            return 1.0
        if s_first in _NICKNAMES.get(j_first, set()) or j_first in _NICKNAMES.get(s_first, set()):
            return 0.95
        return 0.5 * difflib.SequenceMatcher(None, j_first, s_first).ratio()

    by_name: dict[str, str] = {}
    by_normalized: dict[str, str] = {}
    for m in slack_members:
        profile = m.get("profile", {})
        for candidate in (profile.get("real_name"), profile.get("display_name"), m.get("real_name")):
            if candidate:
                by_name.setdefault(candidate, m["id"])
                by_normalized.setdefault(_normalize(candidate), m["id"])

    matched: dict[str, str] = {}
    matched_normalized: dict[str, str] = {}
    unmatched: list[str] = []
    for owner in sorted(owner_names):
        slack_id = by_name.get(owner)
        if slack_id:
            matched[owner] = slack_id
            continue
        slack_id = by_normalized.get(_normalize(owner))
        if slack_id:
            matched_normalized[owner] = slack_id
        else:
            unmatched.append(owner)

    # Third pass: triangulate the leftovers. Only Slack members not already
    # claimed by an exact/normalized match are candidates (elimination --
    # once a Slack ID is used, it's removed from the pool so two Jira
    # owners can't both get attributed to the same person). Scored pairs are
    # resolved highest-confidence-first, and only a score >= 0.7 (last name
    # exact + either identical or nicknamed first name) is proposed; a low
    # first-name-similarity score alone is never enough on its own.
    used_ids = set(matched.values()) | set(matched_normalized.values())
    remaining_slack = [
        (name, m["id"])
        for m in slack_members
        if m["id"] not in used_ids
        for name in {m.get("profile", {}).get("real_name"), m.get("profile", {}).get("display_name")}
        if name
    ]
    candidates: list[tuple[float, str, str, str]] = []  # (score, jira_owner, slack_name, slack_id)
    for owner in unmatched:
        for slack_name, slack_id in remaining_slack:
            score = _similarity(owner, slack_name)
            if score >= 0.7:
                candidates.append((score, owner, slack_name, slack_id))
    candidates.sort(key=lambda c: -c[0])

    matched_fuzzy: dict[str, dict[str, str]] = {}
    claimed_owners: set[str] = set()
    claimed_ids: set[str] = set()
    for score, owner, slack_name, slack_id in candidates:
        if owner in claimed_owners or slack_id in claimed_ids:
            continue
        matched_fuzzy[owner] = {"slack_id": slack_id, "slack_name": slack_name, "confidence": round(score, 2)}
        claimed_owners.add(owner)
        claimed_ids.add(slack_id)
    unmatched = [o for o in unmatched if o not in claimed_owners]

    print(f"--- matched by exact name ({len(matched)}) ---")
    print(json.dumps(matched, indent=2, ensure_ascii=False))

    if matched_normalized:
        print(
            f"\n--- matched by normalized name only ({len(matched_normalized)}) -- "
            "spot-check these, formatting differed (case/dots/underscores) ---"
        )
        print(json.dumps(matched_normalized, indent=2, ensure_ascii=False))

    if matched_fuzzy:
        print(
            f"\n--- triangulated by last name + nickname/similarity ({len(matched_fuzzy)}) -- "
            "VERIFY these carefully before trusting, especially confidence < 0.9 ---"
        )
        for owner, info in matched_fuzzy.items():
            print(f'  "{owner}": "{info["slack_id"]}"   # matched to Slack real name "{info["slack_name"]}", confidence {info["confidence"]}')

    if unmatched:
        print(f"\n--- NOT matched at all ({len(unmatched)}) -- add manually if needed ---")
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
