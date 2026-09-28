"""CHU (Complaint Handling US) weekly Jira snapshot -> Slack.

A worked, runnable example of the "Create Script" / "Schedule Task" output
described in system_prompt.md -- read-only against Jira (only ever GET/search,
same as _jira_client.py), and posts a summary to Slack via `chat.postMessage`
with a bot token (not an incoming webhook -- a webhook can't return the parent
message's `ts`, which threaded replies need). Confirmed report shape and rules
against a real, already-running instance of this report (the "CHU Jira Report
Bot" posting to #complaint-handling-us).

Deliberately does NOT auto-assign unassigned tickets to their reporter (a
mutation some earlier, non-agent versions of this report performed) -- this
agent is read-only against Jira by design (system_prompt.md's Hard Rule #1);
a generated script inherits that same boundary even when it's executed.

Owner mentions: threaded replies @mention the ticket owner when their Jira
display name has an entry in slack_user_map.json (see that file), else they
fall back to a plain name -- never an error either way.

Env vars used (see app/.env.example):
    JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN  -- see _jira_client.py
    SLACK_BOT_TOKEN       -- xoxb-... bot token, chat:write scope, invited to
                             the target channel
    CHU_SLACK_CHANNEL_ID  -- defaults to C055ZJ1JTV1 (#complaint-handling-us)

Usage:
    uv run scripts/chu_weekly_report.py              # dry run, prints only
    uv run scripts/chu_weekly_report.py --send        # posts to Slack
    uv run scripts/chu_weekly_report.py --send --channel C0XXXXXXX  # override channel

Send mode can also come from CHU_REPORT_SEND=1 in the environment, not just
--send -- the app's Execute/Schedule buttons run this script with no CLI
args at all (see app/backend/script_runner.py's execute_script), so the
UI's "actually send" toggle has to reach this some other way. A real
terminal invocation with --send still works exactly the same.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _jira_client import JiraConfigError, search_all  # noqa: E402
from slack_user_map import mention  # noqa: E402

CATEGORY_FIELD = "customfield_13817"
FIRST_RESPONSE_SLA_FIELD = "customfield_10087"
RESOLUTION_SLA_FIELD = "customfield_10086"
# Confirmed live against the field's own editmeta.allowedValues (2026-09-24):
# exactly these two options today, ids 16659/16660. An older external
# reference for this project described a 3-way Feedback/Issue-Complaint/
# Incident-Alerts split -- that's stale; the field was reconfigured to this
# 2-way split at some point after that reference was last updated. Using the
# old 3-way names here would silently bucket 0 tickets into every category.
CATEGORIES = ("Issues & Incidents", "Product Feedback")

# Reporters this report never assigns/tags -- system/integration accounts, not people.
_UNTAGGABLE_REPORTERS = {"Qpartner_integration"}

_FIELDS = [
    "summary", "status", "assignee", "reporter", "priority", "created",
    CATEGORY_FIELD, FIRST_RESPONSE_SLA_FIELD, RESOLUTION_SLA_FIELD,
]


def _jira_base_url() -> str:
    return os.environ.get("JIRA_BASE_URL", "").rstrip("/")


def _issue_url(key: str) -> str:
    return f"{_jira_base_url()}/browse/{key}"


def _jql_link(jql: str) -> str:
    return f"{_jira_base_url()}/issues/?jql=" + urllib.parse.quote(jql)


def _category_value(issue_fields: dict) -> str | None:
    v = issue_fields.get(CATEGORY_FIELD)
    if isinstance(v, dict):
        return v.get("value")
    return v


def _sla_breached(issue_fields: dict, field: str) -> bool:
    """Only an ongoingCycle counts -- a completed/historical cycle's breach
    doesn't mean the ticket is CURRENTLY breaching (it may have since moved
    to a status where the SLA clock stopped, or been resolved)."""
    sla = issue_fields.get(field)
    if not isinstance(sla, dict):
        return False
    cycle = sla.get("ongoingCycle")
    return bool(cycle and cycle.get("breached"))


def _age_days(created: str) -> int:
    created_dt = datetime.strptime(created[:19], "%Y-%m-%dT%H:%M:%S")
    return (datetime.now(timezone.utc).replace(tzinfo=None) - created_dt).days


def _owner_name(person: dict | None) -> str:
    if not person:
        return "Unassigned"
    return person.get("displayName") or person.get("emailAddress") or "Unassigned"


def fetch_active_issues() -> list[dict]:
    # "Active" per docs/chu_report_rules.md: excludes a populated resolution
    # AND excludes Resolved/Canceled status -- a ticket can be moved to one
    # of those statuses without the resolution field ever being set (a real
    # data-entry inconsistency in this project), so checking resolution alone
    # isn't enough. Status names confirmed live against
    # /rest/api/3/project/CHU/statuses (2026-09-28) -- CHU has no "Done" or
    # "Closed" status, so those aren't included here even though the docs
    # mention them as generic examples.
    jql = (
        'project = CHU AND resolution = Unresolved '
        'AND status NOT IN ("Resolved", "Canceled") '
        'ORDER BY created DESC'
    )
    return search_all(jql, fields=_FIELDS)


def build_report(issues: list[dict]) -> dict:
    active = issues
    todo = [i for i in active if i["fields"].get("status", {}).get("name") == "To Do"]
    age_7_30, age_30_plus = [], []
    for i in active:
        created = i["fields"].get("created")
        if not created:
            continue
        days = _age_days(created)
        if 7 <= days <= 30:
            age_7_30.append(i)
        elif days > 30:
            age_30_plus.append(i)
    unassigned = [i for i in active if not i["fields"].get("assignee")]
    first_resp_breach = [i for i in active if _sla_breached(i["fields"], FIRST_RESPONSE_SLA_FIELD)]
    resolution_breach = [i for i in active if _sla_breached(i["fields"], RESOLUTION_SLA_FIELD)]
    by_category: dict[str, list[dict]] = {c: [] for c in CATEGORIES}
    for i in active:
        cat = _category_value(i["fields"])
        if cat in by_category:
            by_category[cat].append(i)

    # Single pass per issue, one bucket-membership check per issue, so an
    # untaggable reporter (e.g. Qpartner_integration) is excluded from EVERY
    # bucket consistently -- a per-bucket loop each re-deriving "is this
    # issue in bucket X" independently is exactly how a system account could
    # leak into by_person through a bucket whose loop forgot the skip.
    by_person: dict[str, dict] = {}
    todo_keys = {i["key"] for i in todo}
    first_resp_keys = {i["key"] for i in first_resp_breach}
    resolution_keys = {i["key"] for i in resolution_breach}
    age_7_30_keys = {i["key"] for i in age_7_30}
    age_30_plus_keys = {i["key"] for i in age_30_plus}
    for i in active:
        owner = _owner_name(i["fields"].get("assignee"))
        if owner in _UNTAGGABLE_REPORTERS:
            continue
        b = by_person.setdefault(owner, {"active": [], "todo": [], "first_resp": [], "resolution": [], "age_7_30": [], "age_30_plus": []})
        b["active"].append(i)
        if i["key"] in todo_keys:
            b["todo"].append(i)
        if i["key"] in first_resp_keys:
            b["first_resp"].append(i)
        if i["key"] in resolution_keys:
            b["resolution"].append(i)
        if i["key"] in age_7_30_keys:
            b["age_7_30"].append(i)
        if i["key"] in age_30_plus_keys:
            b["age_30_plus"].append(i)

    return {
        "active": active, "todo": todo, "age_7_30": age_7_30, "age_30_plus": age_30_plus,
        "unassigned": unassigned, "first_resp_breach": first_resp_breach,
        "resolution_breach": resolution_breach, "by_category": by_category, "by_person": by_person,
    }


def _linked_count(label: str, count: int, jql: str) -> str:
    return f"- {label}: <{_jql_link(jql)}|{count}>"


def _plain_count(label: str, count: int) -> str:
    return f"- {label}: {count}"


def build_parent_message(r: dict) -> str:
    lines = [
        "*Complaint Handling US - Jira snapshot*",
        "Hey everyone, this is to highlight the current status of tickets on the "
        "Complaint Handling US Jira board and create better visibility for the team.",
        "",
        _linked_count("Active open tickets", len(r["active"]), "project = CHU AND resolution = Unresolved ORDER BY created ASC"),
        _linked_count("To Do / not acknowledged", len(r["todo"]), 'project = CHU AND resolution = Unresolved AND status = "To Do" ORDER BY created ASC'),
        _linked_count("Tickets 7-30 days old", len(r["age_7_30"]), "project = CHU AND resolution = Unresolved AND created <= -7d AND created > -30d ORDER BY created ASC"),
        _linked_count("Tickets older than 30 days", len(r["age_30_plus"]), "project = CHU AND resolution = Unresolved AND created <= -30d ORDER BY created ASC"),
        # Not linked: JQL can't express "ongoingCycle.breached = true" on an SLA
        # custom field, so any JQL link here would open a different (larger,
        # wrong) set than what this count actually reports -- see _sla_breached.
        # Plain count only, until a confirmed-correct JQL/saved-filter exists.
        _plain_count("Current active first response SLA breach tickets", len(r["first_resp_breach"])),
        _plain_count("Current active resolution SLA breach tickets", len(r["resolution_breach"])),
        _linked_count("Unassigned active tickets", len(r["unassigned"]), "project = CHU AND resolution = Unresolved AND assignee is EMPTY ORDER BY created ASC"),
        "",
        "*Category split*",
    ]
    for cat in CATEGORIES:
        lines.append(f"- {cat}: {len(r['by_category'][cat])}")
    lines.append("")
    lines.append(
        "Person-wise follow-ups are in the thread. Linked counts open Jira lists "
        "sorted oldest first; the SLA breach counts aren't linked (see script "
        "comments) but are still the accurate current-active-cycle count."
    )
    return "\n".join(lines)


def build_person_replies(r: dict) -> list[tuple[str, str]]:
    """Returns (owner, reply_text) pairs -- the owner name travels alongside
    the text so send_to_slack() can report per-owner thread results as
    execution evidence, not just an opaque list of strings."""
    replies = []
    for owner, buckets in sorted(r["by_person"].items(), key=lambda kv: -len(kv[1]["active"])):
        if not any(buckets.values()):
            continue
        # Unassigned isn't a person -- @mentioning it would be meaningless
        # (and there's no Slack ID for "nobody" to look up anyway).
        header = mention(owner) if owner != "Unassigned" else owner
        lines = [f"*{header}*"]
        if buckets["active"]:
            lines.append(f"- Active open: {len(buckets['active'])}")
        if buckets["todo"]:
            lines.append(f"- To Do / not acknowledged: {len(buckets['todo'])}")
        if buckets["first_resp"]:
            lines.append(f"- Current active first response SLA breaches: {len(buckets['first_resp'])}")
        if buckets["resolution"]:
            lines.append(f"- Current active resolution SLA breaches: {len(buckets['resolution'])}")
        if buckets["age_7_30"]:
            lines.append(f"- Tickets 7-30 days old: {len(buckets['age_7_30'])}")
        if buckets["age_30_plus"]:
            lines.append(f"- Tickets older than 30 days: {len(buckets['age_30_plus'])}")
        replies.append((owner, "\n".join(lines)))
    return replies


# --- Slack (Web API, bot token -- needed for thread_ts on the parent message) ---

def _slack_post(token: str, channel: str, text: str, thread_ts: str | None = None) -> dict:
    payload: dict = {"channel": channel, "text": text, "mrkdwn": True}
    if thread_ts:
        payload["thread_ts"] = thread_ts
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode("utf-8", errors="replace"))
    if not body.get("ok"):
        raise RuntimeError(f"Slack API error: {body.get('error', 'unknown_error')}")
    return body


def _slack_permalink(token: str, channel: str, ts: str) -> str | None:
    """Best-effort -- a report that posted fine but couldn't fetch a
    permalink still succeeded, so this returns None rather than raising."""
    url = "https://slack.com/api/chat.getPermalink?" + urllib.parse.urlencode(
        {"channel": channel, "message_ts": ts}
    )
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read().decode("utf-8", errors="replace"))
    except (urllib.error.HTTPError, urllib.error.URLError):
        return None
    return body.get("permalink") if body.get("ok") else None


def send_to_slack(channel: str, parent_text: str, thread_replies: list[tuple[str, str]]) -> dict:
    """`channel` is used for EVERY Slack API call this function makes (the
    parent post, the permalink lookup, and every threaded reply) -- there is
    no separate env-default fallback in here, so a human-chosen channel
    override from the caller always wins for the whole send, not just part
    of it.

    Returns a plain dict (not just the parent ts) so main() can print full
    execution evidence: the parent ts/permalink and each reply's own ts."""
    token = os.environ.get("SLACK_BOT_TOKEN", "")
    if not token:
        sys.exit("SLACK_BOT_TOKEN is not set -- see app/.env.example")
    parent = _slack_post(token, channel, parent_text)
    thread_ts = str(parent.get("ts") or "")
    permalink = _slack_permalink(token, channel, thread_ts)
    reply_results = []
    for owner, reply in thread_replies:
        result = _slack_post(token, channel, reply, thread_ts=thread_ts)
        reply_results.append({"owner": owner, "ts": str(result.get("ts") or "")})
        time.sleep(1.0)  # avoid Slack's per-channel rate limit
    return {"channel": channel, "parent_ts": thread_ts, "parent_permalink": permalink, "replies": reply_results}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--send", action="store_true", help="actually post to Slack (default: dry run, print only)")
    parser.add_argument("--channel", default=os.environ.get("CHU_SLACK_CHANNEL_ID", "C055ZJ1JTV1"))
    args = parser.parse_args()
    # See the module docstring -- the Execute/Schedule buttons can't pass
    # --send as a CLI arg, so CHU_REPORT_SEND=1 is the equivalent trigger.
    args.send = args.send or os.environ.get("CHU_REPORT_SEND") == "1"

    try:
        issues = fetch_active_issues()
    except JiraConfigError as exc:
        sys.exit(str(exc))

    report = build_report(issues)
    parent = build_parent_message(report)
    replies = build_person_replies(report)

    print("--- parent message ---")
    print(parent)
    print(f"\n--- {len(replies)} thread repl(y/ies) ---")
    for _owner, text in replies:
        print(text)
        print()

    if args.send:
        # This structured block is deliberately grep-able: script_runner.py's
        # Execute button auto-posts a successful run's stdout to Slack too,
        # which would double-post this report (it already sent itself,
        # above) -- SLACK_POSTED=1 is the signal that tells it to suppress
        # that generic post for this run. See script_runner.py's
        # _SLACK_ALREADY_POSTED_RE.
        evidence = send_to_slack(args.channel, parent, replies)
        print("\n--- slack send result ---")
        print("SLACK_POSTED=1")
        print(f"channel={evidence['channel']}")
        print(f"parent_ts={evidence['parent_ts']}")
        print(f"parent_permalink={evidence['parent_permalink'] or '(unavailable)'}")
        for i, reply in enumerate(evidence["replies"], 1):
            print(f"reply_{i}_owner={reply['owner']}")
            print(f"reply_{i}_ts={reply['ts']}")
    else:
        print("\n(dry run -- nothing sent. Re-run with --send to post to Slack.)")


if __name__ == "__main__":
    main()
