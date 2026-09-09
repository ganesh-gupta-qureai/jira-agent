"""One-shot check that JIRA credentials in app/.env work.

Usage:
    uv run scripts/test_connection.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _jira_client import JiraConfigError, whoami  # noqa: E402


def main() -> None:
    try:
        me = whoami()
    except JiraConfigError as e:
        print(f"Config error: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Connection failed: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"Connected as: {me.get('displayName')} ({me.get('emailAddress')})")


if __name__ == "__main__":
    main()
