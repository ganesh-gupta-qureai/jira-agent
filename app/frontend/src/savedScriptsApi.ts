import { apiUrl, bounceIfUnauthorized } from './api'
import type { ExecuteResult } from './cronJobsApi'

export type SavedScript = {
  id: string
  owner: string
  thread_id: string
  title: string
  code: string
  created_at: number
}

async function unwrap<T>(res: Response): Promise<T> {
  if (bounceIfUnauthorized(res)) throw new Error('unauthorized')
  if (!res.ok) throw new Error(`request failed: ${res.status}`)
  return res.json()
}

export async function fetchSavedScripts(threadId: string): Promise<SavedScript[]> {
  return unwrap(await fetch(apiUrl(`/api/saved-scripts?thread_id=${encodeURIComponent(threadId)}`)))
}

// Every saved script across all 3 users -- backs the Scheduled tab's shared
// "Saved" list (see saved_scripts.py's list_all_saved).
export async function fetchAllSavedScripts(): Promise<SavedScript[]> {
  return unwrap(await fetch(apiUrl('/api/saved-scripts/all')))
}

export async function saveScript(threadId: string, code: string, title: string): Promise<SavedScript> {
  return unwrap(
    await fetch(apiUrl('/api/saved-scripts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_id: threadId, code, title }),
    }),
  )
}

export async function deleteSavedScript(id: string): Promise<void> {
  await unwrap(await fetch(apiUrl(`/api/saved-scripts/${id}`), { method: 'DELETE' }))
}

// One-off run of a saved-but-not-scheduled script -- same /api/execute-script
// path every other Execute button uses (CodeBlock, JobRow, PostToSlack), just
// called from the Scheduled tab's "Saved" list instead of chat/a cron job.
export async function executeSavedScript(
  code: string,
  channel: string,
  send: boolean,
  confirmedProduction: boolean,
): Promise<ExecuteResult> {
  return unwrap(
    await fetch(apiUrl('/api/execute-script'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, channel, send, confirmed_production: confirmedProduction }),
    }),
  )
}
