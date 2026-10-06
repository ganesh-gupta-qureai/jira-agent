import { apiUrl, bounceIfUnauthorized } from './api'

export type SavedScript = {
  id: string
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
