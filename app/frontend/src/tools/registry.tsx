import { type ReactNode } from 'react'
import AskUserQuestionView from './AskUserQuestion'
import BashView from './Bash'
import ReadView from './Read'

export type ToolViewProps = {
  args: string          // streamed JSON, may be incomplete
  result?: string
  done: boolean
  // True when this tool is a deferred AskUserQuestion awaiting the user.
  awaiting?: boolean
  // Authoritative deferred questions (from AWAIT_INPUT), preferred over `args`.
  questions?: unknown[]
  // Submits structured answers (question text -> chosen label) which resume the
  // claude session via /api/answer. Undefined while a turn is running.
  onAnswer?: (answers: Record<string, string>) => void
}

type Renderer = (props: ToolViewProps) => ReactNode

const REGISTRY: Record<string, Renderer> = {
  AskUserQuestion: AskUserQuestionView,
  Bash: BashView,
  Read: ReadView,
}

export function renderToolBody(name: string, props: ToolViewProps): ReactNode {
  return REGISTRY[name]?.(props) ?? null  // null → caller falls back to default JSON view
}

// Best-effort parse of streamed JSON args. Returns null while the chunk is
// still incomplete, so renderers can show a skeleton until parsing succeeds.
export function safeParseArgs<T = unknown>(raw: string): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
