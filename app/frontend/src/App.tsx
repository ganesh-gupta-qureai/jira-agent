import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiUrl } from './api'
import { subscribeAGUI } from './agui_sync'
import type { AGUIEvent } from './agui_sync'
import { applyEvent, initialChatState, type TimelineItem } from './chat'
import { fetchConversations } from './conversationsApi'
import Honeycomb from './Honeycomb'
import LoadingDots from './LoadingDots'
import Login from './Login'
import { Markdown } from './Markdown'
import { renderToolBody } from './tools/registry'
import './App.css'

type AuthStatus = { loggedIn: boolean; email?: string; orgName?: string }

// thread (stable conversation key) + claude session live in the URL so a page
// refresh re-attaches to the same — possibly in-progress — run.
function readUrl(): { thread: string | null; session: string | null } {
  const p = new URLSearchParams(window.location.search)
  return { thread: p.get('t'), session: p.get('s') }
}
function writeUrl(thread: string | null, session: string | null) {
  const u = new URL(window.location.href)
  if (thread) u.searchParams.set('t', thread)
  else u.searchParams.delete('t')
  if (session) u.searchParams.set('s', session)
  else u.searchParams.delete('s')
  window.history.replaceState(null, '', u)
}

export default function App() {
  const [threadId, setThreadId] = useState<string | null>(() => readUrl().thread)
  const [sessionId, setSessionId] = useState<string | null>(() => readUrl().session)
  const [state, setState] = useState(initialChatState)
  const [draft, setDraft] = useState('')
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const scrollRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()

  // The inbox: the user's past conversations, read from claude's transcripts.
  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
    enabled: !!auth?.loggedIn,
  })

  const refreshAuth = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/auth/status'))
      const data = await res.json()
      setAuth({ loggedIn: !!data.loggedIn, email: data.email, orgName: data.orgName })
    } catch {
      setAuth({ loggedIn: false })
    }
  }, [])

  useEffect(() => {
    refreshAuth()
  }, [refreshAuth])

  // A new visitor with no thread in the URL gets a fresh one.
  useEffect(() => {
    if (auth?.loggedIn && !threadId) {
      const t = crypto.randomUUID()
      setThreadId(t)
      writeUrl(t, null)
    }
  }, [auth?.loggedIn, threadId])

  // Subscribe to the active thread's resumable SSE. Re-runs when the THREAD
  // changes (not on session adoption); on refresh this re-attaches to an
  // in-progress run and the SYNC frame restores running-state, elapsed + tokens.
  useEffect(() => {
    if (!auth?.loggedIn || !threadId) return
    setState(initialChatState)
    const qs = `thread_id=${encodeURIComponent(threadId)}${sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ''}`
    const sub = subscribeAGUI(apiUrl(`/api/events?${qs}`), (ev: AGUIEvent) => {
      if (ev.type === 'SESSION') {
        // adopt claude's session id (resume + URL persistence) without resubscribing
        setSessionId(ev.session_id)
        writeUrl(threadId, ev.session_id)
        queryClient.invalidateQueries({ queryKey: ['conversations'] })
        return
      }
      if (ev.type === 'AUTH_REQUIRED') {
        setAuth({ loggedIn: false })
        return
      }
      setState((s) => applyEvent(s, ev))
    })
    return () => sub.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth?.loggedIn, threadId])

  // tick the elapsed timer while a run is in flight
  useEffect(() => {
    if (!state.running) return
    const iv = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(iv)
  }, [state.running])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [state.items])

  function newChat() {
    const t = crypto.randomUUID()
    setThreadId(t)
    setSessionId(null)
    writeUrl(t, null)
    setState(initialChatState)
    setDraft('')
  }

  // Open a past conversation: thread_id == its session_id; the backend seeds the
  // log from claude's transcript and the SYNC frame restores it.
  function openConversation(id: string) {
    if (id === threadId || state.running) return
    setThreadId(id)
    setSessionId(id)
    writeUrl(id, id)
  }

  // Fire-and-forget a turn trigger; the live SSE subscription drives the UI.
  async function trigger(path: string, body: Record<string, unknown>) {
    try {
      await fetch(apiUrl(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, thread_id: threadId, session_id: sessionId }),
      })
    } catch (err) {
      console.error(err)
      setState((s) => ({ ...s, running: false }))
    }
  }

  function sendMessage(raw: string) {
    const text = raw.trim()
    if (!text || state.running || !threadId) return
    setState((s) => ({ ...s, running: true, error: null })) // optimistic; the SSE confirms
    trigger('/api/chat', { message: text })
  }

  function send() {
    if (!draft.trim() || state.running) return
    const text = draft
    setDraft('')
    sendMessage(text)
  }

  // Resume a deferred AskUserQuestion with the user's structured choices.
  function answerQuestions(answers: Record<string, string>) {
    if (state.running || !threadId) return
    setState((s) => ({ ...s, running: true, error: null }))
    trigger('/api/answer', { answers })
  }

  if (auth === null) return <div className="shell"><div className="loading">loading…</div></div>
  if (!auth.loggedIn) return <Login onLoggedIn={refreshAuth} />

  const initials = (auth.email ?? '?').slice(0, 2).toUpperCase()
  const elapsed = state.runStartedAt ? Math.max(0, (now - state.runStartedAt) / 1000) : 0

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="sidebar__head sidebar__back" href="/myapps" title="Back to Hive">
          <span className="back-arrow">←</span>
          <span className="logo">⬢</span>
          <span className="logo-text">All apps</span>
        </a>

        <div className="sidebar__actions">
          <button className="btn btn--solid" onClick={newChat}>
            <span className="btn__plus">+</span> New Chat
          </button>
        </div>

        <div className="sidebar__section">
          <div className="sidebar__label">Recent chats</div>
          <input className="sidebar__search" placeholder="Search…" />
        </div>

        <nav className="sidebar__list">
          {conversations.length === 0 && (
            <div className="sidebar__empty">No conversations yet</div>
          )}
          {conversations.map((c) => (
            <button
              key={c.session_id}
              className={`recent ${c.session_id === sessionId ? 'recent--active' : ''}`}
              onClick={() => openConversation(c.session_id)}
              title={c.title}
            >
              <div className="recent__title">{c.title}</div>
              <div className="recent__when">{formatAgo(c.updated_at * 1000)}</div>
            </button>
          ))}
        </nav>

        <div className="sidebar__foot">
          <div className="avatar">{initials}</div>
          <div className="who">
            <div className="who__name">{auth.email ?? 'signed in'}</div>
            <div className="who__role">{auth.orgName ?? 'Claude'}</div>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar__title">Agent</div>
          <div className="topbar__icons">
            <button className="icon-btn" title="Settings">⚙</button>
            <button className="icon-btn" title="Theme">☀</button>
            <div className="avatar avatar--sm">{initials}</div>
          </div>
        </header>

        <div className="chat" ref={scrollRef}>
          {state.items.length === 0 && !state.running && (
            <div className="empty">
              <div className="empty__title">How can I help?</div>
              <div className="empty__sub">
                Start with a question about scans, forms, patients, or risk groups.
              </div>
            </div>
          )}
          <AnimatePresence initial={false}>
            {state.items.map((item) => (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, ease: 'easeOut' }}
              >
                <Item item={item} onAnswer={state.running ? undefined : answerQuestions} />
              </motion.div>
            ))}
          </AnimatePresence>
          {state.running && (
            <div className="run-status" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 2px' }}>
              {!hasLiveAssistantText(state.items) && <LoadingDots />}
              <span style={{ fontSize: 12, opacity: 0.55 }}>
                working {elapsed.toFixed(1)}s
                {state.tokens ? ` · ↓ ${state.tokens.output.toLocaleString()} tok` : ''}
              </span>
            </div>
          )}
          {state.error && !state.running && (
            <div
              className="run-error"
              role="alert"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                margin: '8px 2px',
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid rgba(220, 80, 80, 0.4)',
                background: 'rgba(220, 80, 80, 0.08)',
                color: '#f3b1b1',
                fontSize: 13,
              }}
            >
              <span aria-hidden>⚠</span>
              <span>{state.error}</span>
            </div>
          )}
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <div className="composer__wrap">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder="Message the agent…"
              rows={1}
            />
            <button
              className="composer__send"
              type="submit"
              disabled={state.running || !draft.trim()}
              title="Send"
            >
              ↑
            </button>
          </div>
        </form>

        <footer className="statusbar">
          <span className="statusbar__dot" />
          <span>Connected</span>
          <span className="statusbar__fact">
            Your agent, running in your workspace.
          </span>
          <span className="statusbar__ver">Agent v0.1</span>
        </footer>
      </div>

      <Honeycomb />
    </div>
  )
}

function AssistantText({ item }: { item: Extract<TimelineItem, { kind: 'assistant_text' }> }) {
  const fullText = item.segments.join('')
  return (
    <div className="msg msg--agent">
      <div className="msg__avatar">⬢</div>
      <div className="msg__body">
        <div className="msg__label">Agent</div>
        <div className="msg__prose">
          <Markdown>{fullText}</Markdown>
          {!item.done && <span className="cursor">▍</span>}
        </div>
      </div>
    </div>
  )
}

type AnswerFn = (answers: Record<string, string>) => void

function Item({ item, onAnswer }: { item: TimelineItem; onAnswer?: AnswerFn }) {
  if (item.kind === 'user') {
    return (
      <div className="msg msg--user">
        <p className="msg__text">{item.text}</p>
      </div>
    )
  }
  if (item.kind === 'assistant_text') {
    return <AssistantText item={item} />
  }
  return <ToolCard item={item} onAnswer={onAnswer} />
}

function ToolCard({
  item,
  onAnswer,
}: {
  item: Extract<TimelineItem, { kind: 'tool_call' }>
  onAnswer?: AnswerFn
}) {
  const [open, setOpen] = useState(true)
  const status = item.result ? 'done' : item.done ? 'running' : 'streaming'
  const glyph = item.result ? '✓' : item.done ? '…' : '●'

  const customBody = renderToolBody(item.name, {
    args: item.args,
    result: item.result,
    done: item.done,
    awaiting: item.awaiting,
    questions: item.questions,
    onAnswer,
  })

  return (
    <div className="tool">
      <button type="button" className="tool__head" onClick={() => setOpen((o) => !o)}>
        <span className="tool__icon">⌘</span>
        <span className="tool__name">{item.name}</span>
        <span className={`tool__status tool__status--${status}`}>{glyph}</span>
        <span className="tool__chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool__body">
          {customBody ?? (
            <>
              <div className="tool__label">args</div>
              <pre className="tool__pre">{item.args || '…'}</pre>
              {item.result !== undefined && (
                <>
                  <div className="tool__label">result</div>
                  <pre className="tool__pre">{item.result}</pre>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function hasLiveAssistantText(items: TimelineItem[]): boolean {
  return items.some((i) => i.kind === 'assistant_text' && i.segments.length > 0)
}

function formatAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
