"""Fetch full detail for one JIRA ticket, including comments and custom fields.

Usage:
    uv run scripts/jira_get_issue.py CHU-461
    uv run scripts/jira_get_issue.py CHU-461 --expand names,renderedFields
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _jira_client import JiraConfigError, get_issue  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("key", help="issue key, e.g. CHU-461")
    parser.add_argument(
        "--expand",
        default="renderedFields,names",
        help="comma-separated expand params (default: renderedFields,names)",
    )
    args = parser.parse_args()

    try:
        result = get_issue(args.key, expand=args.expand)
    except JiraConfigError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
