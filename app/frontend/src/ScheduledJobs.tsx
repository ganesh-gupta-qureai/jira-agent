import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  archiveCronJob,
  executeCronJob,
  fetchArchivedCronJobs,
  fetchCronJobs,
  promoteCronJob,
  setCronJobEnabled,
  unarchiveCronJob,
  updateCronJob,
  type CronJob,
  type CronJobRun,
  type ExecuteResult,
} from './cronJobsApi'
import { highlightPython } from './Markdown'
import { ScheduleForm, type ScheduleValues } from './ScheduleForm'
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
        {run.manual && 'manual · '}
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

function ExecuteResultBox({ result }: { result: ExecuteResult }) {
  return (
    <div
      className={`md-codeblock__result ${result.timed_out || !result.ok ? 'md-codeblock__result--error' : 'md-codeblock__result--ok'}`}
    >
      <div className="md-codeblock__result-head">
        {result.timed_out ? 'Timed out' : result.ok ? 'Exit 0' : `Exit ${result.exit_code ?? '?'}`}
      </div>
      {result.stdout && <pre className="md-pre">{result.stdout}</pre>}
      {result.stderr && <pre className="md-pre">{result.stderr}</pre>}
      {!result.stdout && !result.stderr && !result.timed_out && (
        <div className="md-codeblock__result-empty">(no output)</div>
      )}
      {result.ok && (
        <div className="md-codeblock__slack-status">
          {result.posted_to_slack ? '✓ Posted to Slack' : `⚠ Not posted to Slack: ${result.slack_error}`}
        </div>
      )}
    </div>
  )
}

function JobRow({
  job,
  onChanged,
  onEditInChat,
  archivedView,
}: {
  job: CronJob
  onChanged: (job: CronJob | null, id: string) => void
  onEditInChat: (job: CronJob) => void
  archivedView: boolean
}) {
  const [open, setOpen] = useState(false)
  const [rescheduling, setRescheduling] = useState(false)
  const [reschedError, setReschedError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [execBusy, setExecBusy] = useState(false)
  const [execResult, setExecResult] = useState<ExecuteResult | null>(null)
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

  async function handleArchive(e: React.MouseEvent) {
    e.stopPropagation()
    if (busy) return
    if (!window.confirm(`Archive "${job.name}"? It'll stop running and move to the Archived list — you can restore it later.`))
      return
    setBusy(true)
    try {
      await archiveCronJob(job.id)
      onChanged(null, job.id)
    } catch (err) {
      console.error(err)
      setBusy(false)
    }
  }

  async function handleUnarchive(e: React.MouseEvent) {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      await unarchiveCronJob(job.id)
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

  async function handleExecute(e: React.MouseEvent) {
    e.stopPropagation()
    if (execBusy) return
    setExecBusy(true)
    setExecResult(null)
    try {
      const result = await executeCronJob(job.id)
      setExecResult(result)
    } catch (err) {
      setExecResult({
        ok: false,
        timed_out: false,
        exit_code: null,
        stdout: '',
        stderr: err instanceof Error ? err.message : 'Execute failed',
        posted_to_slack: false,
        slack_error: null,
      })
    } finally {
      setExecBusy(false)
    }
  }

  async function quickField(patch: Partial<Pick<CronJob, 'channel' | 'send'>>) {
    if (busy) return
    const nextChannel = patch.channel ?? job.channel
    const nextSend = patch.send ?? job.send
    if (nextSend && nextChannel === PRODUCTION_SLACK_CHANNEL_ID && !(job.send && job.channel === PRODUCTION_SLACK_CHANNEL_ID)) {
      if (
        !window.confirm(
          'This will send REAL messages to #us-operations (production) every time it runs, not a test channel. Continue?',
        )
      )
        return
    }
    setBusy(true)
    try {
      const updated = await updateCronJob(
        job.id,
        job.name,
        job.cron_expr,
        job.start_date,
        job.end_date,
        nextChannel,
        nextSend,
        true, // already confirmed just above when moving to production
      )
      onChanged(updated, job.id)
    } catch (err) {
      console.error(err)
    } finally {
      setBusy(false)
    }
  }

  async function submitReschedule(values: ScheduleValues) {
    setBusy(true)
    setReschedError(null)
    try {
      const updated = await updateCronJob(
        job.id,
        values.name,
        values.cronExpr,
        values.startDate,
        values.endDate,
        job.channel,
        job.send,
        true, // channel/send unchanged here, already-confirmed values
      )
      onChanged(updated, job.id)
      setRescheduling(false)
    } catch (err) {
      setReschedError(err instanceof Error ? err.message : 'Could not save changes')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="history__row">
      <button type="button" className="history__head" onClick={() => setOpen((o) => !o)}>
        <span className={`history__status ${job.enabled ? '' : 'sched__status--paused'}`}>
          {job.archived ? 'Archived' : job.enabled ? job.cron_expr : 'Paused'}
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
      {open && !rescheduling && (
        <div className="history__body">
          <div className="history__label">cron expression</div>
          <pre className="md-pre">{job.cron_expr}</pre>
          <div className="history__label">channel</div>
          {archivedView ? (
            <pre className="md-pre">{channelLabel(job.channel)}</pre>
          ) : (
            <select
              className="sched-form__select"
              value={job.channel ?? SLACK_CHANNELS[0].id}
              onChange={(e) => quickField({ channel: e.target.value })}
              onClick={(e) => e.stopPropagation()}
              disabled={busy}
            >
              {SLACK_CHANNELS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          <div className="history__label">send mode</div>
          {archivedView ? (
            <pre className="md-pre">{job.send ? 'Actually sends to Slack' : 'Preview only (never posts)'}</pre>
          ) : (
            <label className="sched-form__checkbox" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={job.send}
                onChange={(e) => quickField({ send: e.target.checked })}
                disabled={busy}
              />
              Actually sends to Slack
            </label>
          )}
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
          {execResult && <ExecuteResultBox result={execResult} />}
          <div className="history__actions">
            {archivedView ? (
              <button className="btn btn--ghost" onClick={handleUnarchive} disabled={busy}>
                Unarchive
              </button>
            ) : (
              <>
                <button className="btn btn--ghost" onClick={toggleEnabled} disabled={busy}>
                  {job.enabled ? 'Pause' : 'Resume'}
                </button>
                <button
                  className="btn btn--ghost"
                  onClick={(e) => {
                    e.stopPropagation()
                    setRescheduling(true)
                  }}
                  disabled={busy}
                  title="Rename, and change the interval/dates with date & time pickers"
                >
                  Re-schedule
                </button>
                <button className="btn btn--ghost" onClick={handleExecute} disabled={execBusy}>
                  {execBusy ? 'Running…' : 'Execute'}
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
                  Edit Automation
                </button>
                {job.channel !== PRODUCTION_SLACK_CHANNEL_ID && (
                  <button className="btn btn--solid" onClick={handlePromote} disabled={busy}>
                    Promote to production
                  </button>
                )}
                <button className="btn btn--ghost history__delete" onClick={handleArchive} disabled={busy}>
                  Archive
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {open && rescheduling && (
        <div className="history__body">
          <ScheduleForm
            initial={{
              name: job.name,
              cronExpr: job.cron_expr,
              startDate: job.start_date,
              endDate: job.end_date,
            }}
            onCancel={() => setRescheduling(false)}
            onSubmit={submitReschedule}
            busy={busy}
            error={reschedError}
            submitLabel="Save changes"
            busyLabel="Saving…"
          />
        </div>
      )}
    </div>
  )
}

export default function ScheduledJobs({ onEditInChat }: { onEditInChat: (job: CronJob) => void }) {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'active' | 'archived'>('active')
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['cron-jobs'],
    queryFn: fetchCronJobs,
  })
  const { data: archivedJobs = [], isLoading: archivedLoading } = useQuery({
    queryKey: ['cron-jobs-archived'],
    queryFn: fetchArchivedCronJobs,
    enabled: tab === 'archived',
  })

  function applyChange(updated: CronJob | null, id: string) {
    // An archive/unarchive moves a job between the two lists rather than
    // just updating it in place, so invalidate both instead of only patching
    // the list the click happened in.
    queryClient.invalidateQueries({ queryKey: ['cron-jobs'] })
    queryClient.invalidateQueries({ queryKey: ['cron-jobs-archived'] })
    if (updated) {
      queryClient.setQueryData<CronJob[]>(['cron-jobs'], (prev) =>
        (prev ?? []).map((j) => (j.id === id ? updated : j)),
      )
    }
  }

  const list = tab === 'active' ? jobs : archivedJobs
  const loading = tab === 'active' ? isLoading : archivedLoading

  return (
    <div className="history">
      <div className="history__toolbar">
        <div className="sched-form__seg">
          <button
            type="button"
            className={`sched-form__seg-btn ${tab === 'active' ? 'sched-form__seg-btn--active' : ''}`}
            onClick={() => setTab('active')}
          >
            Active
          </button>
          <button
            type="button"
            className={`sched-form__seg-btn ${tab === 'archived' ? 'sched-form__seg-btn--active' : ''}`}
            onClick={() => setTab('archived')}
          >
            Archived
          </button>
        </div>
        <div className="history__count">
          {list.length} schedule{list.length === 1 ? '' : 's'}
        </div>
      </div>
      {loading && <div className="history__empty">Loading…</div>}
      {!loading && list.length === 0 && (
        <div className="history__empty">
          {tab === 'active'
            ? 'No schedules yet. Click "Schedule" under a generated script in chat to create one.'
            : 'No archived schedules.'}
        </div>
      )}
      {list.map((job) => (
        <JobRow
          key={job.id}
          job={job}
          onChanged={applyChange}
          onEditInChat={onEditInChat}
          archivedView={tab === 'archived'}
        />
      ))}
    </div>
  )
}
