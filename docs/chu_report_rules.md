# CHU weekly Slack report -- confirmed rules

Reference for generating/adapting `scripts/chu_weekly_report.py` or any similar
Jira-to-Slack report script for Complaint Handling US (project `CHU`). These
rules come from an already-running instance of this exact report (the "CHU
Jira Report Bot" posting to `#complaint-handling-us`) -- follow them rather
than inventing a different report shape.

## Scope and freshness

- Always a fresh Jira API pull. Never reuse a saved/cached count.
- Inactive for reporting purposes: `Done`, `Closed`, `Resolved`, `Canceled`,
  or any issue with a populated Jira `resolution`. Never tag people on an
  inactive ticket.

## Required sections (parent message)

- Active open/unresolved count.
- To Do / not acknowledged count.
- Tickets 7-30 days old / older than 30 days (age buckets).
- Current active first-response and resolution SLA breach counts.
- Unassigned active ticket count.
- Category split: `Feedback` / `Issue/Complaint` / `Incident/Alerts` (no
  people tags in this section -- plain counts/list only).
- Person-wise follow-ups go in **thread replies**, not the parent message.

## SLA breach rules (important, easy to get wrong)

- A ticket counts as breaching **only** when its SLA custom field's
  `ongoingCycle.breached` is `true`. A `completedCycles` entry with
  `breached: true` is historical -- it does NOT mean the ticket is
  *currently* breaching (it may have since moved to a status where the SLA
  clock stopped, or been resolved). Never count `completedCycles` breaches.
- JQL cannot reliably express `ongoingCycle.breached = true` on an SLA custom
  field -- don't link the SLA breach count to a JQL search; it would open a
  different (larger, wrong) set. Report it as a plain count instead.
- SLA fields for CHU: `customfield_10087` (Time to first response),
  `customfield_10086` (Time to resolution).

## Who never gets tagged or auto-assigned

- `Qpartner_integration` -- a system/integration account, not a person. Never
  tag it, never group tickets under it in person-wise replies, never
  auto-assign to it.
- External/client-email reporters (even when Jira shows the email as the
  reporter *display name* rather than the reporter email field).
- Missing or system-only reporter accounts.
- Anyone whose only tickets are inactive (resolved/closed/canceled/done).

## Person-wise thread reply rules

- Group by assignee (owner). If unassigned, do not invent an owner --
  "Unassigned" is its own bucket.
- **Suppress zero-count lines.** If someone has 1 active ticket and nothing
  else, show only the active-open line for them, not five zero lines.
- Don't repeat a raw ticket-key list when a linked count already opens the
  same Jira list -- e.g. show `To Do / not acknowledged: <count>`, not also a
  separate `To Do tickets: CHU-1, CHU-4, ...` line.

## Formatting / tone

- No ChatGPT/Codex/automation/local-script attribution anywhere in the Slack
  text. No internal file paths.
- Ticket links: Slack's `<url|text>` format, e.g.
  `<https://aiinovation.atlassian.net/browse/CHU-123|CHU-123>`.
- Category section: no tags. SLA / To-Do / Unassigned sections: tag the
  responsible person where a Slack mapping exists.

## Slack posting method

- Use the Slack Web API `chat.postMessage` with a **bot token**
  (`SLACK_BOT_TOKEN`, `chat:write` scope, bot invited to the channel) for the
  parent-message-plus-thread-replies format.
- An incoming webhook cannot return the parent message's `ts`, so it can't
  support threaded replies -- webhooks are fine for a single test message,
  not for this report's real format.
- Confirmed channel for the CHU weekly report: `#complaint-handling-us`
  (`C055ZJ1JTV1`) -- see `CHU_SLACK_CHANNEL_ID` in `app/.env.example`.

## What this agent's version deliberately does NOT do

Some earlier, non-agent versions of this report also auto-assigned
unresolved unassigned tickets to their reporter before sending. This agent
is read-only against Jira by design (`system_prompt.md`'s Hard Rule #1) --
a generated/executed script inherits that same boundary even though it *can*
now be executed via the UI's Execute button. If a Jira-mutating version of
this report is ever wanted, that's a deliberate, separate decision to make
explicitly -- not something to add by copying an older script wholesale.
