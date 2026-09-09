// AG-UI event types we consume from the backend.
import { bounceIfUnauthorized } from './api'

export type AGUIEvent =
  | { type: 'RUN_STARTED'; thread_id: string; run_id: string }
  | { type: 'RUN_FINISHED'; thread_id: string; run_id: string }
  | { type: 'RUN_ERROR'; message: string }
  | { type: 'TEXT_MESSAGE_START'; message_id: string; role: 'assistant' }
  | { type: 'TEXT_MESSAGE_CONTENT'; message_id: string; delta: string }
  | { type: 'TEXT_MESSAGE_END'; message_id: string }
  | { type: 'TOOL_CALL_START'; tool_call_id: string; tool_call_name: string; parent_message_id: string | null }
  | { type: 'TOOL_CALL_ARGS'; tool_call_id: string; delta: string }
  | { type: 'TOOL_CALL_END'; tool_call_id: string }
  | { type: 'TOOL_CALL_RESULT'; message_id: string; tool_call_id: string; content: string }
  // Emitted when an AskUserQuestion was deferred — the turn paused awaiting the
  // user's answer. `questions` is the authoritative deferred input.
  | { type: 'AWAIT_INPUT'; tool_call_id: string; questions: unknown[] }
  // Carries claude's session_id (from system/init). The client adopts it as the
  // canonical conversation id for resume + the inbox.
  | { type: 'SESSION'; session_id: string }
  // The Claude login expired (401). The client should bounce to the login flow.
  | { type: 'AUTH_REQUIRED' }

// Parse an SSE stream from `fetch` and yield AG-UI events.
export async function* streamAGUI(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<AGUIEvent> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  // Hive session expired mid-stream — the proxy 401s. Bounce to login.
  if (bounceIfUnauthorized(res)) throw new Error('unauthorized')
  if (!res.ok || !res.body) {
    throw new Error(`stream failed: ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    // SSE frames are separated by a blank line.
    let sep
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, sep)
      buf = buf.slice(sep + 2)

      // A frame can have multiple lines; we only care about `data:` lines.
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) {
          const json = line.slice(5).trim()
          if (!json) continue
          try {
            yield JSON.parse(json) as AGUIEvent
          } catch {
            // ignore malformed frames
          }
        }
      }
    }
  }
}
