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

## What counts as a "linked product ticket"

**A non-empty `issuelinks` list does NOT mean a CHU ticket has a product
ticket linked.** Confirmed live (2026-10-05, CHU-474): a CHU ticket can have
a "Relates" link to ANOTHER CHU-board ticket (e.g. a duplicate/related
Product Feedback ticket on the same board) — that is not a product ticket,
and checking `issuelinks is not empty` alone will wrongly treat the CHU
ticket as already linked.

**The real rule: a genuine product ticket link is to an issue in a
DIFFERENT project than CHU.** Parse the linked issue's key prefix (the part
before the `-`, e.g. `RET` in `RET-4653`) from `issuelinks[].outwardIssue.key`
/ `inwardIssue.key`, and only count it as a product ticket link if that
prefix is not `CHU`. A same-project (`CHU-...`) link should never satisfy a
"has a product ticket linked" condition.

**Links are mutable and get reassigned during ticket cleanup — don't trust
the first link you see as permanent.** Real case: CHU-475 was linked to
`RET-4653` (a genuine product ticket), then that link was removed and
replaced with a "Relates to CHU-474" link sixteen seconds later, when
CHU-475 was folded into CHU-474 as a duplicate (see the comment: "have
linked the original ticket as this is a duplicate, lets close this"). The
product-ticket reference (`RET-4653`) was lost in that merge — it was never
re-added to CHU-474. A script checking "does this ticket have a product
link" needs to re-derive the answer from the CURRENT `issuelinks` state
every run, not assume a link seen once stays valid, and should treat a
same-project-only link as still "missing a product ticket," not skip it.

## API notes
- The base endpoint for search is `/rest/api/3/search/jql` (POST, JQL in
  body) — the older `/rest/api/3/search` is deprecated (410 Gone).
- Product/hospital tickets aren't always on the same field: check both
  `customfield_13683` and `customfield_10332` for product, since different
  tickets populate different ones.
- **A `{value: ...}`-shaped custom field can come back as a bare list
  instead** (`[{value: ...}, ...]`) for at least some CHU tickets -- confirmed
  live: a generated report script's naive `isinstance(field, dict)` check
  passed the raw list through unchanged, and `Counter(...)`-ing it crashed
  with `TypeError: unhashable type: 'list'`. Any script that groups/counts by
  one of these fields should handle a list value explicitly (e.g. join
  multiple values, or take the first) instead of assuming dict-or-scalar.
