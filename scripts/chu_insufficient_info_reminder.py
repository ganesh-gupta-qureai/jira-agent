"""Automation 4 - Insufficient Information reminder (CHU) -> one consolidated Slack message.

Reminds CHU owners to add requested details to tickets stuck in the Jira status
"Insufficient Information". A ticket qualifies when ALL hold:
  * project CHU, status "Insufficient Information" (a status, not a label/field),
    unresolved
  * it has waited MORE than 2 working days in that status (>= 3)

Rules (confirmed, same waiting-time logic as chu_missing_product_ticket.py):
  * Working days = weekdays (Mon-Fri) strictly AFTER the date of the latest
    transition INTO the status (changelog, Asia/Kolkata), up to and including
    today. The entry date itself and Sat/Sun are excluded; holidays are NOT.
    Re-entering the status resets the clock (latest entry wins).
  * No status history -> skipped and reported on stderr, never guessed.
  * Nothing qualifies -> nothing is printed to stdout and nothing is sent.
  * Same-day dedup: on --send, if this reminder was already posted to the same
    channel today (IST), an unattended cron fire skips (protects against a
    redeploy mid-day re-registering and double-firing the same schedule); a
    human running it manually (Execute/Post) gets a warning instead and still
    posts -- a deliberate manual re-run is never blocked. Checked against
    Slack channel history first, then a marker file under /data (USERS_ROOT's
    parent) as a fallback; both survive redeploys.

Read-only against Jira (GET / search only). Exactly ONE Slack message is sent
(split only if it would exceed Slack's size limit).

Env vars: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, SLACK_BOT_TOKEN,
          CHU_SLACK_CHANNEL_ID (defaults to the test channel C0B86EU1Y03;
          production #us-operations is C055ZJ1JTV1 via --channel).

Usage:
    uv run scripts/chu_insufficient_info_reminder.py             # dry run, prints only
    uv run scripts/chu_insufficient_info_reminder.py --send      # posts to Slack
    uv run scripts/chu_insufficient_info_reminder.py --send --channel C055ZJ1JTV1

CHU_REPORT_SEND=1 in the environment is equivalent to --send (Execute/Schedule
run scripts with no CLI args).

Schedule: daily 9:00 AM IST -> cron `0 9 * * *` (scheduler in IST) or
`30 3 * * *` (scheduler in UTC).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _jira_client import JiraConfigError, _request, search_all  # noqa: E402
from slack_user_map import mention  # noqa: E402

IST = ZoneInfo("Asia/Kolkata")
STATUS = "Insufficient Information"
MIN_WORKING_DAYS = 3  # "more than 2 working days"
SLACK_CHUNK_LIMIT = 3500
HEADER_MARKER = "Action needed · Missing information"  # also the dedup marker
INTRO = (
    "These tickets have been in Insufficient Information for over 2 working days. "
    "Owners: please add the requested details to each ticket and update ticket "
    "status and assignee."
)
# Under the USERS_ROOT volume's parent (/data), same as agent_memory.py: /shared is
# rebuilt from git on every redeploy, /data is not.
STATE_FILE = Path(os.environ.get("USERS_ROOT", "/data/users")).parent / "chu_insufficient_info_reminder.state.json"

_FIELDS = ["summary", "status", "assignee"]


def _base_url() -> str:
    return os.environ.get("JIRA_BASE_URL", "").rstrip("/")


def entered_status_on(key: str) -> date | None:
    """Date (IST) of the latest transition INTO STATUS, from the full changelog."""
    latest: datetime | None = None
    start = 0
    while True:
        page = _request("GET", f"/rest/api/3/issue/{key}/changelog?startAt={start}&maxResults=100")
        for h in page.get("values", []):
            for item in h.get("items", []):
                if item.get("field") == "status" and item.get("toString") == STATUS:
                    ts = datetime.strptime(h["created"], "%Y-%m-%dT%H:%M:%S.%f%z")
                    if latest is None or ts > latest:
                        latest = ts
        start += len(page.get("values", []))
        if page.get("isLast", True) or not page.get("values"):
            break
    return latest.astimezone(IST).date() if latest else None


def working_days_since(entered: date, today: date) -> int:
    """Weekdays after `entered` up to and including `today`."""
    days, d = 0, entered + timedelta(days=1)
    while d <= today:
        if d.weekday() < 5:
            days += 1
        d += timedelta(days=1)
    return days


def collect() -> tuple[list[dict], list[str]]:
    # Currently IN the status and unresolved. The extra NOT IN is a guard for
    # tickets moved to Resolved/Canceled without a resolution being set; only
    # status names confirmed to exist in CHU are listed (Jira errors on unknown ones).
    jql = (
        f'project = CHU AND status = "{STATUS}" AND resolution = Unresolved '
        'AND status NOT IN ("Resolved", "Canceled") ORDER BY created ASC'
    )
    today = datetime.now(IST).date()
    eligible, problems = [], []
    for issue in search_all(jql, fields=_FIELDS):
        key, f = issue["key"], issue["fields"]
        entered = entered_status_on(key)
        if entered is None:
            problems.append(f"{key}: no status history for '{STATUS}'; skipped")
            continue
        waited = working_days_since(entered, today)
        if waited < MIN_WORKING_DAYS:
            continue
        eligible.append({
            "key": key,
            "owner": (f.get("assignee") or {}).get("displayName") or "Unassigned",
            "waited": waited,
        })
    eligible.sort(key=lambda t: -t["waited"])
    return eligible, problems


def build_messages(tickets: list[dict]) -> list[str]:
    n = len(tickets)
    header = f"*{HEADER_MARKER} · {n} ticket{'s' if n != 1 else ''}*\n{INTRO}\n"
    lines = []
    for t in tickets:
        owner = mention(t["owner"]) if t["owner"] != "Unassigned" else "Unassigned"
        lines.append(f"• <{_base_url()}/browse/{t['key']}|{t['key']}> · {owner} · {t['waited']} days")
    messages, current = [], header
    for line in lines:
        if len(current) + len(line) + 1 > SLACK_CHUNK_LIMIT and current != header:
            messages.append(current)
            current = ""
        current = f"{current}\n{line}" if current else line
    messages.append(current)
    return messages


# ---- same-day dedup -------------------------------------------------------

def _today_start_ts() -> float:
    return datetime.now(IST).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()


def _posted_today_slack(token: str, channel: str) -> bool | None:
    """True/False from channel history since IST midnight; None if history is unreadable."""
    qs = urllib.parse.urlencode({"channel": channel, "oldest": f"{_today_start_ts():.6f}", "limit": 200})
    req = urllib.request.Request(
        f"https://slack.com/api/conversations.history?{qs}",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8", errors="replace"))
    except OSError:
        return None
    if not body.get("ok"):
        return None  # e.g. missing_scope / not_in_channel -> fall back to the local marker
    return any(HEADER_MARKER in (m.get("text") or "") for m in body.get("messages", []))


def _load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def already_posted_today(token: str, channel: str) -> bool:
    via_slack = _posted_today_slack(token, channel)
    if via_slack is not None:
        return via_slack
    return _load_state().get(channel) == datetime.now(IST).date().isoformat()


def record_posted(channel: str) -> None:
    state = _load_state()
    state[channel] = datetime.now(IST).date().isoformat()
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(state), encoding="utf-8")
    except OSError as exc:
        print(f"WARNING: could not write dedup marker: {exc}", file=sys.stderr)


def post(token: str, channel: str, text: str) -> None:
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage",
        data=json.dumps({"channel": channel, "text": text, "mrkdwn": True}).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode("utf-8", errors="replace"))
    if not body.get("ok"):
        raise RuntimeError(f"Slack API error: {body.get('error', 'unknown_error')}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--send", action="store_true", help="post to Slack (default: dry run)")
    parser.add_argument("--channel", default=os.environ.get("CHU_SLACK_CHANNEL_ID", "C0B86EU1Y03"))
    args = parser.parse_args()
    send = args.send or os.environ.get("CHU_REPORT_SEND") == "1"

    token = os.environ.get("SLACK_BOT_TOKEN", "")
    if send:
        if not token:
            sys.exit("SLACK_BOT_TOKEN is not set -- see app/.env.example")
        if already_posted_today(token, args.channel):
            # JIRA_AGENT_SCHEDULED_RUN is set only for an unattended cron fire
            # (see script_runner.py's execute_script) -- that's the one case
            # this guard should actually block, e.g. a redeploy mid-day
            # re-registering the same cron minute and firing twice. A human
            # clicking Execute or Post to Slack is a deliberate, explicit
            # request and must always be allowed to post, as many times as
            # they want (root-caused 2026-10-15: this used to hard-skip a
            # manual re-run too) -- so a manual run only gets a warning here,
            # never a skip.
            if os.environ.get("JIRA_AGENT_SCHEDULED_RUN") == "1":
                print(f"Already posted to {args.channel} today; skipping.", file=sys.stderr)
                return
            print(f"WARNING: already posted to {args.channel} today -- posting again anyway.", file=sys.stderr)

    try:
        tickets, problems = collect()
    except JiraConfigError as exc:
        sys.exit(str(exc))

    for p in problems:  # exceptions go to stderr only, never into the Slack message
        print(f"WARNING: {p}", file=sys.stderr)
    if not tickets:
        print("No eligible tickets; nothing to send.", file=sys.stderr)
        return

    messages = build_messages(tickets)
    if not send:
        print("\n\n".join(messages))
        return

    for m in messages:
        post(token, args.channel, m)
    record_posted(args.channel)
    print("SLACK_POSTED=1")  # tells Execute not to double-post stdout
    print(f"channel={args.channel} tickets={len(tickets)} messages={len(messages)}")


if __name__ == "__main__":
    main()
