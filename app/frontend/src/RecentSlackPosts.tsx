import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteSlackMessage, fetchSlackMessages, undoLastSlackPost, type SlackMessage } from './slackMessagesApi'
import { formatAgo, formatLocalDateTime } from './formatAgo'

// Browse + delete this bot's own recent Slack messages in a channel -- added
// 2026-10-15 after a test Execute click posted for real to #us-operations
// with no way to undo it from the UI. Shared between the Scheduled tab (per
// job's channel) and chat's CodeBlock (per the channel currently selected
// there), since both just need "this bot's recent posts in channel X."

export function RecentSlackPosts({ channel }: { channel: string }) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const { data: messages = [], isLoading } = useQuery({
    queryKey: ['slack-messages', channel],
    queryFn: () => fetchSlackMessages(channel, 10),
    enabled: open,
  })

  async function handleDelete(msg: SlackMessage) {
    if (!window.confirm(`Delete this message from Slack?\n\n"${msg.text || '(no text)'}"\n\nThis can't be undone.`))
      return
    setError(null)
    try {
      await deleteSlackMessage(channel, msg.ts)
      queryClient.invalidateQueries({ queryKey: ['slack-messages', channel] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete message')
    }
  }

  return (
    <div className="slack-posts">
      <button type="button" className="btn btn--ghost" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide' : 'Show'} recent posts in this channel
      </button>
      {open && (
        <div className="slack-posts__list">
          {isLoading && <div className="sched__run-empty">Loading…</div>}
          {!isLoading && messages.length === 0 && (
            <div className="sched__run-empty">No recent messages from this bot in this channel.</div>
          )}
          {messages.map((m) => (
            <div key={m.ts} className="slack-posts__row">
              <span className="slack-posts__when" title={formatLocalDateTime(m.posted_at * 1000)}>
                {formatAgo(m.posted_at * 1000)}
              </span>
              <span className="slack-posts__text">{m.text || '(no text)'}</span>
              <button type="button" className="btn btn--ghost history__delete" onClick={() => handleDelete(m)}>
                Delete
              </button>
            </div>
          ))}
          {error && <div className="sched-form__error">{error}</div>}
        </div>
      )}
    </div>
  )
}

export function UndoLastPostButton({ channel }: { channel: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  async function handleUndo() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const preview = await fetchSlackMessages(channel, 1)
      if (preview.length === 0) {
        setError('No recent message from this bot in this channel.')
        return
      }
      if (
        !window.confirm(
          `Delete the last message this bot posted to this channel?\n\n"${preview[0].text || '(no text)'}"\n\nThis can't be undone.`,
        )
      )
        return
      await undoLastSlackPost(channel)
      queryClient.invalidateQueries({ queryKey: ['slack-messages', channel] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not undo last post')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" className="btn btn--ghost" onClick={handleUndo} disabled={busy}>
        {busy ? 'Undoing…' : 'Undo last post'}
      </button>
      {error && <div className="sched-form__error">{error}</div>}
    </>
  )
}
