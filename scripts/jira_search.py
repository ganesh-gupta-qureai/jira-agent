"""Run a read-only JQL search against JIRA and print matching issues as JSON.

Usage:
    uv run scripts/jira_search.py "project = CHU AND status != Done ORDER BY created DESC"
    uv run scripts/jira_search.py "<JQL>" --fields summary,status,assignee,priority --max 25

See docs/jira_fields.md for custom field IDs to filter/select on (hospital,
product, ticket category, priority, etc.).
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _jira_client import JiraConfigError, search  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("jql", help="JQL query string")
    parser.add_argument("--fields", help="comma-separated field list", default=None)
    parser.add_argument("--max", type=int, default=50, help="max results (default 50)")
    args = parser.parse_args()

    fields = args.fields.split(",") if args.fields else None

    try:
        result = search(args.jql, fields=fields, max_results=args.max)
    except JiraConfigError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
