"""Shared read-only JIRA Cloud REST client used by the other scripts/ tools.

Auth and base URL come from environment variables (set in app/.env):
  JIRA_BASE_URL   e.g. https://aiinovation.atlassian.net
  JIRA_EMAIL      account email for basic auth
  JIRA_API_TOKEN  API token for basic auth

This module only issues GET requests and the read-only POST search endpoint
(/rest/api/3/search/jql, which is a query — not a mutation). It exposes no
function that can create, update, transition, or delete a ticket.
"""

import base64
import json
import os
import sys
import urllib.error
import urllib.request


class JiraConfigError(RuntimeError):
    pass


def _config() -> tuple[str, str, str]:
    base_url = os.environ.get("JIRA_BASE_URL", "").rstrip("/")
    email = os.environ.get("JIRA_EMAIL", "")
    token = os.environ.get("JIRA_API_TOKEN", "")
    if not base_url or not email or not token:
        raise JiraConfigError(
            "Missing JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN. "
            "Set them in app/.env (see app/.env.example)."
        )
    return base_url, email, token


def _headers() -> dict:
    _, email, token = _config()
    basic = base64.b64encode(f"{email}:{token}".encode()).decode()
    return {
        "Authorization": f"Basic {basic}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def _request(method: str, path: str, body: dict | None = None) -> dict:
    base_url, _, _ = _config()
    url = f"{base_url}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=_headers(), method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        print(f"JIRA API error {e.code}: {detail}", file=sys.stderr)
        raise


def search(
    jql: str,
    fields: list[str] | None = None,
    max_results: int = 50,
    page_token: str | None = None,
) -> dict:
    """Read-only JQL search. Uses /search/jql — the old /search POST endpoint is 410 Gone.

    A single call returns at most `max_results` issues (the API caps this
    regardless of how high it's set) plus `isLast`/`nextPageToken` — use
    `search_all` to walk every page for an exhaustive/aggregate query.
    """
    body = {
        "jql": jql,
        "maxResults": max_results,
        "fields": fields or ["summary", "status", "assignee", "created", "updated", "priority"],
    }
    if page_token:
        body["nextPageToken"] = page_token
    return _request("POST", "/rest/api/3/search/jql", body)


def search_all(jql: str, fields: list[str] | None = None, page_size: int = 100) -> list[dict]:
    """Walk every page of a JQL search and return the combined issue list.

    Use for aggregate/"across all tickets" questions (counts, group-bys) where
    a single 50-100 result page would silently undercount.
    """
    issues: list[dict] = []
    token: str | None = None
    while True:
        resp = search(jql, fields=fields, max_results=page_size, page_token=token)
        issues.extend(resp.get("issues", []))
        if resp.get("isLast", True) or not resp.get("nextPageToken"):
            break
        token = resp["nextPageToken"]
    return issues


def get_issue(key: str, expand: str | None = None) -> dict:
    path = f"/rest/api/3/issue/{key}"
    if expand:
        path += f"?expand={expand}"
    return _request("GET", path)


def whoami() -> dict:
    return _request("GET", "/rest/api/3/myself")
