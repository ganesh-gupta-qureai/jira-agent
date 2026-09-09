# JIRA Custom Fields Reference (CHU project)

Use these field IDs when building JQL or requesting specific `fields` from
`scripts/jira_search.py` / `scripts/jira_get_issue.py`.

## Ticket Category (in-scope filter)
- Field id: `customfield_13817`, name "Ticket Category"
- In-scope value: `"Issues & Incidents"` (customFieldOption id `16659`)
- Example JQL: `project = CHU AND cf[13817] = "Issues & Incidents" ORDER BY created DESC`
- Everything under `"Product Feedback"` or other category values is a
  different bucket — don't fold it into "issues/incidents" reporting unless
  the user explicitly asks for it.

## Other useful CHU custom fields
| Field id | Name | Shape / notes |
|---|---|---|
| `customfield_13769` | Site / Hospital / Project | plain string, e.g. "Wellstar" |
| `customfield_13683` | qure products | `{value: "qER"}` |
| `customfield_10332` | Product Name | alternate product field, also `{value: ...}` — some tickets use this instead of 13683 |
| `customfield_13684` | Date/Time of Occurrence | ISO datetime |
| `customfield_13686` | Number of Users Affected | string |
| `customfield_13722` | QPartner Portal Creator | email string |
| `customfield_12355` | Issue Priority | `{value: "P3 - MEDIUM"}` |
| `customfield_13770` | Issue Complexity | `{value: "C1 - Simple"}` |
| `customfield_10033` | Root Cause Analysis - RCA | ADF (Atlassian Document Format) rich text |
| `customfield_10926` | Correction/Fix Done | ADF rich text |

## API notes
- The base endpoint for search is `/rest/api/3/search/jql` (POST, JQL in
  body) — the older `/rest/api/3/search` is deprecated (410 Gone).
- Product/hospital tickets aren't always on the same field: check both
  `customfield_13683` and `customfield_10332` for product, since different
  tickets populate different ones.
