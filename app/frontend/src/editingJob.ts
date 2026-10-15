// Tracks which cron job (if any) a chat thread is "editing" -- set when the
// user clicks "Edit script" on a job in the Scheduled tab (see
// ScheduledJobs.tsx / App.tsx's editAutomationInChat), read by Markdown.tsx's
// Schedule button so clicking it there updates that job in place instead of
// creating a new one. Deliberately in localStorage keyed by thread id, not
// component state/context: the Scheduled tab and the chat's Schedule button
// live in different parts of the tree and a new chat tab/session shouldn't
// inherit another thread's in-progress edit.
const KEY_PREFIX = 'jira-agent:editingJob:'

// Carries the job's current schedule too (not just id/name) so Markdown.tsx's
// Schedule form can pre-fill cron/timezone/dates instead of resetting to
// defaults -- root-caused 2026-10-15: editing Automation 4 via chat reset its
// schedule to "every Monday 9am UTC" with no warning, because the form had
// nothing to pre-fill from.
export type EditingJob = {
  id: string
  name: string
  cronExpr: string
  timezone: string
  startDate: string | null
  endDate: string | null
}

export function setEditingJob(threadId: string, job: EditingJob) {
  try {
    localStorage.setItem(KEY_PREFIX + threadId, JSON.stringify(job))
  } catch {
    // Private browsing / storage disabled -- the feature just degrades to
    // "Schedule always creates a new job", never breaks.
  }
}

export function getEditingJob(threadId: string | null | undefined): EditingJob | null {
  if (!threadId) return null
  try {
    const raw = localStorage.getItem(KEY_PREFIX + threadId)
    return raw ? (JSON.parse(raw) as EditingJob) : null
  } catch {
    return null
  }
}

// Fired whenever a thread's editing marker is cleared, so App.tsx's banner
// (which mirrors this in React state, not read live from storage) can react
// even when the clear happens from a different component (Markdown.tsx's
// Schedule button) than the one that set it.
export const EDITING_JOB_CLEARED_EVENT = 'jira-agent:editingJobCleared'

export function clearEditingJob(threadId: string) {
  try {
    localStorage.removeItem(KEY_PREFIX + threadId)
  } catch {
    // ignore
  }
  window.dispatchEvent(new CustomEvent(EDITING_JOB_CLEARED_EVENT, { detail: threadId }))
}
