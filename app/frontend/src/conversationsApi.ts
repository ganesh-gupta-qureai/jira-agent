import { apiUrl, bounceIfUnauthorized } from './api'
import type { ChatState, TimelineItem } from './chat'

export type ConversationSummary = {
  session_id: string
  title: string
  updated_at: number // unix seconds
}

// Backend replay item shapes (see backend/conversations.py).
type ReplayItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant_text'; id: string; text: string }
  | { kind: 'tool_call'; id: string; name: string; args: string; result: string | null }

export async function fetchConversations(): Promise<ConversationSummary[]> {
  const res = await fetch(apiUrl('/api/conversations'))
  if (bounceIfUnauthorized(res)) throw new Error('unauthorized')
  if (!res.ok) throw new Error(`conversations failed: ${res.status}`)
  return res.json()
}

// Load one conversation and map its transcript into a renderable ChatState.
export async function fetchConversation(sessionId: string): Promise<ChatState> {
  const res = await fetch(apiUrl(`/api/conversations/${sessionId}`))
  if (bounceIfUnauthorized(res)) throw new Error('unauthorized')
  if (!res.ok) throw new Error(`conversation failed: ${res.status}`)
  const data = (await res.json()) as { items: ReplayItem[] }

  const items: TimelineItem[] = data.items.map((it) => {
    if (it.kind === 'user') return { kind: 'user', id: it.id, text: it.text }
    if (it.kind === 'assistant_text') {
      // Replayed text isn't streamed — one segment, already done.
      return { kind: 'assistant_text', id: it.id, segments: [it.text], done: true }
    }
    return {
      kind: 'tool_call',
      id: it.id,
      name: it.name,
      args: it.args,
      result: it.result ?? undefined,
      done: true,
    }
  })
  return { items, running: false, tokens: null, runStartedAt: null, error: null }
}
