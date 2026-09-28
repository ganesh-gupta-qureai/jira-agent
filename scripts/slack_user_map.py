"""Load the persistent Jira-display-name -> Slack-member-ID mapping (see
slack_user_map.json) used to @mention ticket owners in Slack replies. A
missing file or a name with no entry is never an error -- callers fall back
to the plain display name, since incomplete mapping data shouldn't break the
report."""
import json
from pathlib import Path

_MAP_PATH = Path(__file__).resolve().parent / "slack_user_map.json"


def load_user_map() -> dict[str, str]:
    if not _MAP_PATH.exists():
        return {}
    try:
        data = json.loads(_MAP_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return {k: v for k, v in data.items() if not k.startswith("_")}


def mention(name: str) -> str:
    """Slack `<@USERID>` mention markup if a mapping exists for `name`,
    else the plain name unchanged."""
    slack_id = load_user_map().get(name)
    return f"<@{slack_id}>" if slack_id else name
