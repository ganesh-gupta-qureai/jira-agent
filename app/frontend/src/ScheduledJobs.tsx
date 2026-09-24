import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteCronJob,
  fetchCronJobs,
  setCronJobEnabled,
  type CronJob,
} from './cronJobsApi'
import { highlightPython } from './Markdown'
import { formatAgo, formatLocalDateTime } from './formatAgo'

function lastRunLabel(job: CronJob): { label: string; className: string } {
  if (job.last_run_at === null) return { label: 'Never run yet', className: '' }
  return job.last_run_ok
    ? { label: `Last run ok — ${formatAgo(job.last_run_at * 1000)}`, className: 'sched__status--ok' }
    : { label: `Last run failed — ${formatAgo(job.last_run_at * 1000)}`, className: 'sched__status--error' }
}

function JobRow({ job, onChanged }: { job: CronJob; onChanged: (job: CronJob | null, id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const status = lastRunLabel(job)

  async function toggleEnabled(e: React.MouseEvent) {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      const updated = await setCronJobEnabled(job.id, !job.enabled)
      onChanged(updated, job.id)
    } catch (err) {
      console.error(err)
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
    if (busy) return
    if (!window.confirm(`Delete the schedule "${job.name}"? This can't be undone.`)) return
    setBusy(true)
    try {
      await deleteCronJob(job.id)
      onChanged(null, job.id)
    } catch (err) {
      console.error(err)
      setBusy(false)
    }
  }

  return (
    <div className="history__row">
      <button type="button" className="history__head" onClick={() => setOpen((o) => !o)}>
        <span className={`history__status ${job.enabled ? '' : 'sched__status--paused'}`}>
          {job.enabled ? job.cron_expr : 'Paused'}
        </span>
        <span className="history__when" title={status.label}>
          {job.name}
        </span>
        <span className={`history__slack ${status.className}`}>{status.label}</span>
        <span className="history__chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="history__body">
          <div className="history__label">cron expression</div>
          <pre className="md-pre">{job.cron_expr}</pre>
          {(job.start_date || job.end_date) && (
            <>
              <div className="history__label">date range</div>
              <pre className="md-pre">
                {job.start_date ?? 'starts immediately'} → {job.end_date ?? 'no end date'}
              </pre>
            </>
          )}
          <div className="history__label">created</div>
          <pre className="md-pre">{formatLocalDateTime(job.created_at * 1000)}</pre>
          <div className="history__label">script</div>
          <pre className="md-pre">
            <code>{highlightPython(job.code)}</code>
          </pre>
          <div className="history__actions">
            <button className="btn btn--ghost" onClick={toggleEnabled} disabled={busy}>
              {job.enabled ? 'Pause' : 'Resume'}
            </button>
            <button className="btn btn--ghost history__delete" onClick={handleDelete} disabled={busy}>
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function ScheduledJobs() {
  const queryClient = useQueryClient()
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['cron-jobs'],
    queryFn: fetchCronJobs,
  })

  function applyChange(updated: CronJob | null, id: string) {
    queryClient.setQueryData<CronJob[]>(['cron-jobs'], (prev) =>
      (prev ?? []).flatMap((j) => (j.id !== id ? [j] : updated ? [updated] : [])),
    )
  }

  return (
    <div className="history">
      <div className="history__toolbar">
        <div className="history__count">
          {jobs.length} schedule{jobs.length === 1 ? '' : 's'}
        </div>
      </div>
      {isLoading && <div className="history__empty">Loading…</div>}
      {!isLoading && jobs.length === 0 && (
        <div className="history__empty">
          No schedules yet. Click "Schedule" under a generated script in chat to create one.
        </div>
      )}
      {jobs.map((job) => (
        <JobRow key={job.id} job={job} onChanged={applyChange} />
      ))}
    </div>
  )
}
