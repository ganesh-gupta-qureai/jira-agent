import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  deleteCronJob,
  fetchCronJobs,
  promoteCronJob,
  setCronJobEnabled,
  updateCronJob,
  type CronJob,
  type CronJobRun,
} from './cronJobsApi'
import { highlightPython } from './Markdown'
import { formatAgo, formatLocalDateTime } from './formatAgo'
import { PRODUCTION_SLACK_CHANNEL_ID, SLACK_CHANNELS } from './slackChannels'

function channelLabel(id: string | null): string {
  return SLACK_CHANNELS.find((c) => c.id === id)?.label ?? id ?? 'default (CHU_SLACK_CHANNEL_ID)'
}

function lastRunLabel(job: CronJob): { label: string; className: string } {
  if (job.last_run_at === null) return { label: 'Never run yet', className: '' }
  return job.last_run_ok
    ? { label: `Last run ok — ${formatAgo(job.last_run_at * 1000)}`, className: 'sched__status--ok' }
    : { label: `Last run failed — ${formatAgo(job.last_run_at * 1000)}`, className: 'sched__status--error' }
}

function RunLogRow({ run }: { run: CronJobRun }) {
  return (
    <div className={`sched__run ${run.ok ? 'sched__run--ok' : 'sched__run--error'}`}>
      <span className="sched__run-icon">{run.ok ? '✓' : '✗'}</span>
      <span className="sched__run-when">{formatLocalDateTime(run.at * 1000)}</span>
      <span className="sched__run-detail">
        {run.timed_out
          ? 'timed out'
          : run.exit_code !== null
            ? `exit ${run.exit_code}`
            : run.ok
              ? 'ok'
              : 'failed'}
        {run.ok && (run.posted_to_slack ? ' · posted to Slack' : ' · not posted')}
      </span>
      {run.error && <span className="sched__run-error">{run.error}</span>}
    </div>
  )
}

function EditJobForm({
  job,
  onSaved,
  onCancel,
}: {
  job: CronJob
  onSaved: (job: CronJob) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(job.name)
  const [cronExpr, setCronExpr] = useState(job.cron_expr)
  const [channel, setChannel] = useState(job.channel ?? SLACK_CHANNELS[0].id)
  const [send, setSend] = useState(job.send)
  const [startDate, setStartDate] = useState(job.start_date ?? '')
  const [endDate, setEndDate] = useState(job.end_date ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    if (busy || !name.trim() || !cronExpr.trim()) return
    let confirmedProduction = false
    if (send && channel === PRODUCTION_SLACK_CHANNEL_ID) {
      const ok = window.confirm(
        'This edit will send REAL messages to #us-operations (production) every time it runs, not a test channel. Continue?',
      )
      if (!ok) return
      confirmedProduction = true
    }
    setBusy(true)
    setError(null)
    try {
      const updated = await updateCronJob(
        job.id,
        name.trim(),
        cronExpr.trim(),
        startDate || null,
        endDate || null,
        channel,
        send,
        confirmedProduction,
      )
      onSaved(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save changes')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sched-form">
      <input className="sched-form__input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      <div className="sched-form__row">
        <span className="sched-form__label">Cron</span>
        <input
          className="sched-form__input"
          value={cronExpr}
          onChange={(e) => setCronExpr(e.target.value)}
          placeholder="e.g. */10 * * * * (every 10 minutes)"
        />
      </div>
      <div className="sched-form__hint">5-field cron, UTC. Step syntax works, e.g. `*/10 * * * *` = every 10 minutes.</div>
      <div className="sched-form__row">
        <span className="sched-form__label">Channel</span>
        <select className="sched-form__select" value={channel} onChange={(e) => setChannel(e.target.value)}>
          {SLACK_CHANNELS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <div className="sched-form__row">
        <label className="sched-form__checkbox">
          <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} />
          Actually send
        </label>
      </div>
      <div className="sched-form__row">
        <span className="sched-form__label">Start date</span>
        <input
          type="date"
          className="sched-form__input sched-form__input--date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
        />
      </div>
      <div className="sched-form__row">
        <span className="sched-form__label">End date (optional)</span>
        <input
          type="date"
          className="sched-form__input sched-form__input--date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
        />
      </div>
      <div className="sched-form__actions">
        <button className="md-codeblock__execute" onClick={save} disabled={busy || !name.trim() || !cronExpr.trim()}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button className="md-codeblock__download" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <div className="sched-form__error">{error}</div>}
    </div>
  )
}

function JobRow({
  job,
  onChanged,
  onEditInChat,
}: {
  job: CronJob
  onChanged: (job: CronJob | null, id: string) => void
  onEditInChat: (job: CronJob) => void
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
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

  async function handlePromote(e: React.MouseEvent) {
    e.stopPropagation()
    if (busy) return
    if (
      !window.confirm(
        `Promote "${job.name}" to PRODUCTION (#us-operations)? It will start posting for real on its ` +
          `existing schedule (${job.cron_expr}) instead of the test channel. This can't be undone from here.`,
      )
    )
      return
    setBusy(true)
    try {
      const updated = await promoteCronJob(job.id, true)
      onChanged(updated, job.id)
    } catch (err) {
      console.error(err)
    } finally {
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
        <span className="sched__owner" title={`Created by ${job.owner}`}>
          {job.owner.split('@')[0]}
        </span>
        <span className={`history__slack ${status.className}`}>{status.label}</span>
        <span className="history__chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && !editing && (
        <div className="history__body">
          <div className="history__label">cron expression</div>
          <pre className="md-pre">{job.cron_expr}</pre>
          <div className="history__label">channel</div>
          <pre className="md-pre">{channelLabel(job.channel)}</pre>
          <div className="history__label">send mode</div>
          <pre className="md-pre">{job.send ? 'Actually sends to Slack' : 'Preview only (never posts)'}</pre>
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
          <div className="history__label">run history ({job.runs.length})</div>
          {job.runs.length === 0 ? (
            <div className="sched__run-empty">No runs logged yet.</div>
          ) : (
            <div className="sched__runs">
              {job.runs.map((run, i) => (
                <RunLogRow key={`${run.at}-${i}`} run={run} />
              ))}
            </div>
          )}
          <div className="history__label">script</div>
          <pre className="md-pre">
            <code>{highlightPython(job.code)}</code>
          </pre>
          <div className="history__actions">
            <button className="btn btn--ghost" onClick={toggleEnabled} disabled={busy}>
              {job.enabled ? 'Pause' : 'Resume'}
            </button>
            <button
              className="btn btn--ghost"
              onClick={(e) => {
                e.stopPropagation()
                setEditing(true)
              }}
              disabled={busy}
              title="Change the name, cron schedule, channel, send mode, or dates"
            >
              Edit schedule
            </button>
            <button
              className="btn btn--ghost"
              onClick={(e) => {
                e.stopPropagation()
                onEditInChat(job)
              }}
              disabled={busy}
              title="Open a new chat with this automation's script to revise the logic itself"
            >
              Edit script
            </button>
            {job.channel !== PRODUCTION_SLACK_CHANNEL_ID && (
              <button className="btn btn--solid" onClick={handlePromote} disabled={busy}>
                Promote to production
              </button>
            )}
            <button className="btn btn--ghost history__delete" onClick={handleDelete} disabled={busy}>
              Delete
            </button>
          </div>
        </div>
      )}
      {open && editing && (
        <div className="history__body">
          <EditJobForm
            job={job}
            onCancel={() => setEditing(false)}
            onSaved={(updated) => {
              onChanged(updated, job.id)
              setEditing(false)
            }}
          />
        </div>
      )}
    </div>
  )
}

export default function ScheduledJobs({ onEditInChat }: { onEditInChat: (job: CronJob) => void }) {
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
        <JobRow key={job.id} job={job} onChanged={applyChange} onEditInChat={onEditInChat} />
      ))}
    </div>
  )
}
