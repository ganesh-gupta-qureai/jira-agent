"""Example tool — replace with your agent's real tool(s).

Usage:
    uv run scripts/example.py "some text"
    echo "some text" | uv run scripts/example.py -

Tools are just small programs the agent runs via Bash. Read input from argv (or
stdin), do one job, and print the result to stdout — that's what the agent reads.
Real tools live here too: a SQL runner, an API client, a file transformer, etc.
"""

import sys


def main() -> None:
    arg = " ".join(sys.argv[1:]).strip()
    text = sys.stdin.read() if arg in ("", "-") else arg
    print(f"words:      {len(text.split())}")
    print(f"characters: {len(text)}")
    print(f"uppercase:  {text.upper()}")


if __name__ == "__main__":
    main()
