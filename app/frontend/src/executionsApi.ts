import { apiUrl, bounceIfUnauthorized } from './api'

// Mirrors backend/execution_history.py's record shape.
export type ExecutionRecord = {
  id: string
  timestamp: number // unix seconds (float)
  code: string
  ok: boolean
  timed_out: boolean
  exit_code: number | null
  stdout: string
  stderr: string
  posted_to_slack: boolean
  slack_error: string | null
}

export async function fetchExecutions(): Promise<ExecutionRecord[]> {
  const res = await fetch(apiUrl('/api/executions'))
  if (bounceIfUnauthorized(res)) throw new Error('unauthorized')
  if (!res.ok) throw new Error(`executions failed: ${res.status}`)
  return res.json()
}

export async function deleteExecution(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/executions/${id}`), { method: 'DELETE' })
  if (bounceIfUnauthorized(res)) throw new Error('unauthorized')
  if (!res.ok && res.status !== 404) throw new Error(`delete failed: ${res.status}`)
}

export async function clearExecutions(): Promise<void> {
  const res = await fetch(apiUrl('/api/executions'), { method: 'DELETE' })
  if (bounceIfUnauthorized(res)) throw new Error('unauthorized')
  if (!res.ok) throw new Error(`clear failed: ${res.status}`)
}

// Re-run a past script exactly as it ran before -- same endpoint the Execute
// button already uses, just called from the History tab instead of chat.
export async function reExecute(code: string): Promise<ExecutionRecord> {
  const res = await fetch(apiUrl('/api/execute-script'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (bounceIfUnauthorized(res)) throw new Error('unauthorized')
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(typeof body?.detail === 'string' ? body.detail : `execute failed: ${res.status}`)
  }
  return res.json()
}
