import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  clearExecutions,
  deleteExecution,
  fetchExecutions,
  reExecute,
  type ExecutionRecord,
} from './executionsApi'
import { highlightPython } from './Markdown'
import { formatAgo } from './formatAgo'

function statusOf(rec: ExecutionRecord): { label: string; className: string } {
  if (rec.timed_out) return { label: 'Timed out', className: 'history__status--error' }
  if (!rec.ok) return { label: `Failed (exit ${rec.exit_code ?? '?'})`, className: 'history__status--error' }
  return { label: 'Success', className: 'history__status--ok' }
}

function HistoryRow({ rec, onDeleted }: { rec: ExecutionRecord; onDeleted: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [rerunning, setRerunning] = useState(false)
  const [rerunError, setRerunError] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const status = statusOf(rec)

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
    if (deleting) return
    if (!window.confirm('Delete this run from history? This can\'t be undone.')) return
    setDeleting(true)
    try {
      await deleteExecution(rec.id)
      onDeleted(rec.id)
    } catch (err) {
      console.error(err)
      setDeleting(false)
    }
  }

  async function handleRerun(e: React.MouseEvent) {
    e.stopPropagation()
    if (rerunning) return
    setRerunning(true)
    setRerunError(null)
    try {
      await reExecute(rec.code)
      await queryClient.invalidateQueries({ queryKey: ['executions'] })
    } catch (err) {
      setRerunError(err instanceof Error ? err.message : 'Re-run failed')
    } finally {
      setRerunning(false)
    }
  }

  return (
    <div className="history__row">
      <button type="button" className="history__head" onClick={() => setOpen((o) => !o)}>
        <span className={`history__status ${status.className}`}>{status.label}</span>
        <span className="history__when">{formatAgo(rec.timestamp * 1000)}</span>
        <span className="history__slack">
          {rec.ok ? (rec.posted_to_slack ? '✓ Slack' : '⚠ Slack') : ''}
        </span>
        <span className="history__chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="history__body">
          <div className="history__label">script</div>
          <pre className="md-pre">
            <code>{highlightPython(rec.code)}</code>
          </pre>
          {rec.stdout && (
            <>
              <div className="history__label">stdout</div>
              <pre className="md-pre">{rec.stdout}</pre>
            </>
          )}
          {rec.stderr && (
            <>
              <div className="history__label">stderr</div>
              <pre className="md-pre">{rec.stderr}</pre>
            </>
          )}
          {!rec.ok && rec.slack_error === null && (
            <div className="history__note">Not posted to Slack -- only successful runs are broadcast.</div>
          )}
          {rec.ok && !rec.posted_to_slack && rec.slack_error && (
            <div className="history__note">Not posted to Slack: {rec.slack_error}</div>
          )}
          <div className="history__actions">
            <button className="btn btn--ghost" onClick={handleRerun} disabled={rerunning}>
              {rerunning ? 'Running…' : '▶ Re-run'}
            </button>
            <button className="btn btn--ghost history__delete" onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
          {rerunError && <div className="history__error">{rerunError}</div>}
        </div>
      )}
    </div>
  )
}

export default function ExecutionHistory() {
  const queryClient = useQueryClient()
  const [clearing, setClearing] = useState(false)
  const { data: executions = [], isLoading } = useQuery({
    queryKey: ['executions'],
    queryFn: fetchExecutions,
  })

  function removeFromCache(id: string) {
    queryClient.setQueryData<ExecutionRecord[]>(['executions'], (prev) =>
      (prev ?? []).filter((r) => r.id !== id),
    )
  }

  async function handleClearAll() {
    if (clearing || executions.length === 0) return
    if (!window.confirm(`Delete all ${executions.length} run(s) from history? This can't be undone.`)) return
    setClearing(true)
    try {
      await clearExecutions()
      queryClient.setQueryData<ExecutionRecord[]>(['executions'], [])
    } catch (err) {
      console.error(err)
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="history">
      <div className="history__toolbar">
        <div className="history__count">
          {executions.length} run{executions.length === 1 ? '' : 's'}
        </div>
        <button
          className="btn btn--ghost"
          onClick={handleClearAll}
          disabled={clearing || executions.length === 0}
        >
          {clearing ? 'Clearing…' : 'Clear all'}
        </button>
      </div>
      {isLoading && <div className="history__empty">Loading…</div>}
      {!isLoading && executions.length === 0 && (
        <div className="history__empty">No scripts have been run yet.</div>
      )}
      {executions.map((rec) => (
        <HistoryRow key={rec.id} rec={rec} onDeleted={removeFromCache} />
      ))}
    </div>
  )
}
