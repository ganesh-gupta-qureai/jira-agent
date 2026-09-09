import type { AGUIEvent } from './agui_sync'

// Renderable timeline items: user prompts, assistant text bubbles, tool calls.

export type UserItem = { kind: 'user'; id: string; text: string }

export type AssistantTextItem = {
  kind: 'assistant_text'
  id: string // message_id
  segments: string[]
  done: boolean
}

export type ToolCallItem = {
  kind: 'tool_call'
  id: string // tool_call_id
  name: string
  args: string // JSON-ish (may be partial while streaming)
  result?: string
  done: boolean
  awaiting?: boolean
  questions?: unknown[]
}

export type TimelineItem = UserItem | AssistantTextItem | ToolCallItem

export type ChatState = {
  items: TimelineItem[]
  running: boolean
  // authoritative run-state (from the SYNC frame) so a refresh keeps the true
  // elapsed time + live token count instead of resetting them.
  tokens: { output: number; input: number } | null
  runStartedAt: number | null // epoch ms
  // Last run's failure message (RUN_ERROR), surfaced to the user. Cleared when
  // the next run starts. Without this the turn would just silently vanish.
  error: string | null
}

export const initialChatState: ChatState = {
  items: [],
  running: false,
  tokens: null,
  runStartedAt: null,
  error: null,
}

// Apply one AG-UI event to the timeline. Returns a new state object.
export function applyEvent(state: ChatState, ev: AGUIEvent): ChatState {
  switch (ev.type) {
    case 'RUN_STARTED':
      // server-stamped start time (epoch s) so a refresh/replay keeps true elapsed
      return {
        ...state,
        running: true,
        tokens: null,
        runStartedAt: ev.started_at ? ev.started_at * 1000 : Date.now(),
        error: null, // clear any prior failure when a new run begins
      }

    case 'RUN_FINISHED':
      return { ...state, running: false }

    case 'RUN_ERROR':
      // Keep the message so the UI can show why the turn failed (e.g. an
      // invalid API key) instead of silently dropping it.
      return { ...state, running: false, error: ev.message }

    case 'RUN_TOKENS':
      return { ...state, tokens: { output: ev.output_tokens, input: ev.input_tokens } }

    case 'TEXT_MESSAGE_START':
      return {
        ...state,
        items: [...state.items, { kind: 'assistant_text', id: ev.message_id, segments: [], done: false }],
      }

    case 'TEXT_MESSAGE_CONTENT':
      if (!ev.delta) return state
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === 'assistant_text' && it.id === ev.message_id
            ? { ...it, segments: [...it.segments, ev.delta] }
            : it,
        ),
      }

    case 'TEXT_MESSAGE_END':
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === 'assistant_text' && it.id === ev.message_id ? { ...it, done: true } : it,
        ),
      }

    case 'TOOL_CALL_START':
      return {
        ...state,
        items: [
          ...state.items,
          { kind: 'tool_call', id: ev.tool_call_id, name: ev.tool_call_name, args: '', done: false },
        ],
      }

    case 'TOOL_CALL_ARGS':
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === 'tool_call' && it.id === ev.tool_call_id ? { ...it, args: it.args + ev.delta } : it,
        ),
      }

    case 'TOOL_CALL_END':
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === 'tool_call' && it.id === ev.tool_call_id ? { ...it, done: true } : it,
        ),
      }

    case 'TOOL_CALL_RESULT':
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === 'tool_call' && it.id === ev.tool_call_id ? { ...it, result: ev.content } : it,
        ),
      }

    case 'AWAIT_INPUT':
      return {
        ...state,
        items: state.items.map((it) =>
          it.kind === 'tool_call' && it.id === ev.tool_call_id
            ? { ...it, awaiting: true, questions: ev.questions }
            : it,
        ),
      }

    // server-authoritative sync: SYNC seeds prior history (only when non-empty,
    // so a reconnect with items:[] never wipes the timeline); USER_MESSAGE echoes
    // the user's own turn to every client. (Backend seeds in this item shape.)
    case 'SYNC':
      return {
        ...state,
        items: ev.items.length ? (ev.items as unknown as TimelineItem[]) : state.items,
        running: ev.running,
        runStartedAt: ev.running ? (ev.started_at ? ev.started_at * 1000 : state.runStartedAt) : state.runStartedAt,
        tokens: ev.running ? (ev.tokens ?? state.tokens) : state.tokens,
      }

    case 'USER_MESSAGE':
      return pushUser(state, ev.text)

    default:
      return state
  }
}

export function pushUser(state: ChatState, text: string): ChatState {
  return {
    ...state,
    items: [...state.items, { kind: 'user', id: crypto.randomUUID(), text }],
  }
}
