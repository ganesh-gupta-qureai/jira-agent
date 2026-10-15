import { apiUrl, bounceIfUnauthorized } from './api'

// Mirrors backend/slack_messages.py's list_bot_messages() entries.
export type SlackMessage = {
  ts: string
  text: string
  posted_at: number // unix seconds (float)
}

async function throwIfBad(res: Response): Promise<void> {
  if (bounceIfUnauthorized(res)) throw new Error('unauthorized')
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(typeof body?.detail === 'string' ? body.detail : `request failed: ${res.status}`)
  }
}

export async function fetchSlackMessages(channel: string, limit = 20): Promise<SlackMessage[]> {
  const res = await fetch(apiUrl(`/api/slack-messages?channel=${encodeURIComponent(channel)}&limit=${limit}`))
  await throwIfBad(res)
  return res.json()
}

export async function deleteSlackMessage(channel: string, ts: string): Promise<void> {
  const res = await fetch(apiUrl('/api/slack-messages/delete'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, ts }),
  })
  await throwIfBad(res)
}

export async function undoLastSlackPost(channel: string): Promise<{ ok: boolean; deleted: SlackMessage }> {
  const res = await fetch(apiUrl('/api/slack-messages/undo-last'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel }),
  })
  await throwIfBad(res)
  return res.json()
}
