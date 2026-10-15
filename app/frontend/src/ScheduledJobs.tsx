import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  archiveCronJob,
  createCronJob,
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
import { RecentSlackPosts, UndoLastPostButton } from './RecentSlackPosts'
import { ScheduleForm, type ScheduleValues } from './ScheduleForm'
import { formatAgo, formatLocalDateTime } from './formatAgo'
import { PRODUCTION_SLACK_CHANNEL_ID, SLACK_CHANNELS } from './slackChannels'
import {
  deleteSavedScript,
  executeSavedScript,
  fetchAllSavedScripts,
  type SavedScript,
} from './savedScriptsApi'

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
  // The job's own permanent channel/send -- only edited via Re-schedule,
  // re-seeded from the job each time that form opens so it can't go stale.
  const [channel, setChannel] = useState<string>(job.channel ?? SLACK_CHANNELS[0].id)
  const [send, setSend] = useState(job.send)
  const [busy, setBusy] = useState(false)
  const [execBusy, setExecBusy] = useState(false)
  const [execResult, setExecResult] = useState<ExecuteResult | null>(null)
  // Execute's own fresh channel/send for just this one run -- always starts
  // at the safe test default, same as the chat composer, independent of
  // whatever the job's own permanent channel/send are set to. Root-caused
  // 2026-10-15: an earlier version reused the job's own (already-production)
  // channel/send here with no override and no confirmation, and a test click
  // on the already-promoted Automation 4 posted for real to #us-operations.
  const [execChannel, setExecChannel] = useState<string>(SLACK_CHANNELS[0].id)
  const [execSend, setExecSend] = useState(false)
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
    // A repeat click is worth a pause -- same reasoning as the chat
    // composer's own Execute button. Only asks from the second run onward.
    if (execResult && !window.confirm('This has already been executed. Execute it again?')) return
    let confirmedProduction = false
    if (execSend && execChannel === PRODUCTION_SLACK_CHANNEL_ID) {
      if (
        !window.confirm(
          `This will send a REAL message to #us-operations (production) right now, not a test channel. Continue?`,
        )
      )
        return
      confirmedProduction = true
    }
    setExecBusy(true)
    setExecResult(null)
    try {
      const result = await executeCronJob(job.id, execChannel, execSend, confirmedProduction)
      setExecResult(result)
      // Run history changed server-side -- refetch so it shows up without a
      // stale optimistic overwrite (passing null skips that, only invalidates).
      onChanged(null, job.id)
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

  async function submitReschedule(values: ScheduleValues) {
    let confirmedProduction = true
    if (send && channel === PRODUCTION_SLACK_CHANNEL_ID && !(job.send && job.channel === PRODUCTION_SLACK_CHANNEL_ID)) {
      confirmedProduction = window.confirm(
        'This will send REAL messages to #us-operations (production) every time it runs, not a test channel. Continue?',
      )
      if (!confirmedProduction) return
    }
    setBusy(true)
    setReschedError(null)
    try {
      const updated = await updateCronJob(
        job.id,
        values.name,
        values.cronExpr,
        values.timezone,
        values.startDate,
        values.endDate,
        channel,
        send,
        confirmedProduction,
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
          <pre className="md-pre">
            {job.cron_expr} ({job.timezone})
          </pre>
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
          <div className="history__label">slack posts in this channel</div>
          <div className="slack-posts__actions">
            <RecentSlackPosts channel={job.channel ?? SLACK_CHANNELS[0].id} />
            {!archivedView && <UndoLastPostButton channel={job.channel ?? SLACK_CHANNELS[0].id} />}
          </div>
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
                    setChannel(job.channel ?? SLACK_CHANNELS[0].id)
                    setSend(job.send)
                    setRescheduling(true)
                  }}
                  disabled={busy}
                  title="Rename, and change the interval/timezone/dates/channel with pickers"
                >
                  Re-schedule
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
                {/* Execute's own channel/send + the button itself, grouped together
                    at the end like every other code block's action row (chat's
                    Markdown.tsx CodeBlock) -- always defaults to the test channel,
                    send off, independent of the job's own permanent settings above. */}
                <select
                  className="sched-form__select"
                  value={execChannel}
                  onChange={(e) => setExecChannel(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  title="Channel this one-off Execute run will use"
                >
                  {SLACK_CHANNELS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <label className="sched-form__checkbox" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={execSend}
                    onChange={(e) => setExecSend(e.target.checked)}
                  />
                  Actually send
                </label>
                <button className="btn btn--ghost" onClick={handleExecute} disabled={execBusy}>
                  {execBusy ? 'Running…' : 'Execute'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {open && rescheduling && (
        <div className="history__body">
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
              Actually sends to Slack (its real, recurring runs)
            </label>
          </div>
          <ScheduleForm
            initial={{
              name: job.name,
              cronExpr: job.cron_expr,
              timezone: job.timezone,
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

// A script someone saved from chat but never turned into a real cron job --
// "all automations" per Ganesh/Shamil/Anish's 2026-10-15 request means these
// should be visible and actionable (Execute once, or Schedule for real) from
// the same shared Scheduled tab the cron jobs live in, not just buried in the
// 📑 panel of whichever chat they were saved from.
function SavedScriptRow({ script, onChanged }: { script: SavedScript; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [schedError, setSchedError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [execChannel, setExecChannel] = useState<string>(SLACK_CHANNELS[0].id)
  const [execSend, setExecSend] = useState(false)
  const [execBusy, setExecBusy] = useState(false)
  const [execResult, setExecResult] = useState<ExecuteResult | null>(null)

  async function handleExecute(e: React.MouseEvent) {
    e.stopPropagation()
    if (execBusy) return
    if (execResult && !window.confirm('This has already been executed. Execute it again?')) return
    let confirmedProduction = false
    if (execSend && execChannel === PRODUCTION_SLACK_CHANNEL_ID) {
      if (
        !window.confirm(
          'This will send a REAL message to #us-operations (production) right now, not a test channel. Continue?',
        )
      )
        return
      confirmedProduction = true
    }
    setExecBusy(true)
    setExecResult(null)
    try {
      const result = await executeSavedScript(script.code, execChannel, execSend, confirmedProduction)
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

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
    if (busy) return
    if (!window.confirm(`Delete the saved script "${script.title}"? This can't be undone.`)) return
    setBusy(true)
    try {
      await deleteSavedScript(script.id)
      onChanged()
    } catch (err) {
      console.error(err)
      setBusy(false)
    }
  }

  async function submitSchedule(values: ScheduleValues, channel: string, send: boolean) {
    let confirmedProduction = true
    if (send && channel === PRODUCTION_SLACK_CHANNEL_ID) {
      confirmedProduction = window.confirm(
        'This will send REAL messages to #us-operations (production) every time it runs, not a test channel. Continue?',
      )
      if (!confirmedProduction) return
    }
    setBusy(true)
    setSchedError(null)
    try {
      await createCronJob(
        values.name,
        script.code,
        values.cronExpr,
        values.timezone,
        values.startDate,
        values.endDate,
        channel,
        send,
        confirmedProduction,
      )
      setScheduling(false)
      onChanged()
    } catch (err) {
      setSchedError(err instanceof Error ? err.message : 'Could not create schedule')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="history__row">
      <button type="button" className="history__head" onClick={() => setOpen((o) => !o)}>
        <span className="history__status">Saved</span>
        <span className="history__when">{script.title}</span>
        <span className="sched__owner" title={`Saved by ${script.owner}`}>
          {script.owner.split('@')[0]}
        </span>
        <span className="history__slack">{formatAgo(script.created_at * 1000)}</span>
        <span className="history__chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && !scheduling && (
        <div className="history__body">
          <div className="history__label">script</div>
          <pre className="md-pre">
            <code>{highlightPython(script.code)}</code>
          </pre>
          {execResult && <ExecuteResultBox result={execResult} />}
          <div className="history__actions">
            <button
              className="btn btn--solid"
              onClick={(e) => {
                e.stopPropagation()
                setScheduling(true)
              }}
              disabled={busy}
              title="Turn this into a real recurring cron job"
            >
              Schedule
            </button>
            <button className="btn btn--ghost history__delete" onClick={handleDelete} disabled={busy}>
              Delete
            </button>
            <select
              className="sched-form__select"
              value={execChannel}
              onChange={(e) => setExecChannel(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              title="Channel this one-off Execute run will use"
            >
              {SLACK_CHANNELS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <label className="sched-form__checkbox" onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={execSend} onChange={(e) => setExecSend(e.target.checked)} />
              Actually send
            </label>
            <button className="btn btn--ghost" onClick={handleExecute} disabled={execBusy}>
              {execBusy ? 'Running…' : 'Execute'}
            </button>
          </div>
        </div>
      )}
      {open && scheduling && (
        <SavedScriptScheduleForm
          onCancel={() => setScheduling(false)}
          onSubmit={submitSchedule}
          busy={busy}
          error={schedError}
        />
      )}
    </div>
  )
}

// ScheduleForm itself only collects name/cron/timezone/dates -- channel/send
// are gathered here, same split JobRow's own Re-schedule form uses, since a
// brand new job needs them too and ScheduleForm has no channel concept.
function SavedScriptScheduleForm({
  onCancel,
  onSubmit,
  busy,
  error,
}: {
  onCancel: () => void
  onSubmit: (values: ScheduleValues, channel: string, send: boolean) => void
  busy: boolean
  error: string | null
}) {
  const [channel, setChannel] = useState<string>(SLACK_CHANNELS[0].id)
  const [send, setSend] = useState(false)
  return (
    <div className="history__body">
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
          Actually sends to Slack (its real, recurring runs)
        </label>
      </div>
      <ScheduleForm
        onCancel={onCancel}
        onSubmit={(values) => onSubmit(values, channel, send)}
        busy={busy}
        error={error}
        submitLabel="Create schedule"
        busyLabel="Creating…"
      />
    </div>
  )
}

export default function ScheduledJobs({ onEditInChat }: { onEditInChat: (job: CronJob) => void }) {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'active' | 'archived' | 'saved'>('active')
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['cron-jobs'],
    queryFn: fetchCronJobs,
  })
  const { data: archivedJobs = [], isLoading: archivedLoading } = useQuery({
    queryKey: ['cron-jobs-archived'],
    queryFn: fetchArchivedCronJobs,
    enabled: tab === 'archived',
  })
  const { data: savedScripts = [], isLoading: savedLoading } = useQuery({
    queryKey: ['saved-scripts-all'],
    queryFn: fetchAllSavedScripts,
    enabled: tab === 'saved',
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

  const list = tab === 'active' ? jobs : tab === 'archived' ? archivedJobs : savedScripts
  const loading = tab === 'active' ? isLoading : tab === 'archived' ? archivedLoading : savedLoading
  const noun = tab === 'saved' ? 'saved script' : 'schedule'

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
            className={`sched-form__seg-btn ${tab === 'saved' ? 'sched-form__seg-btn--active' : ''}`}
            onClick={() => setTab('saved')}
          >
            Saved
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
          {list.length} {noun}
          {list.length === 1 ? '' : 's'}
        </div>
      </div>
      {loading && <div className="history__empty">Loading…</div>}
      {!loading && list.length === 0 && (
        <div className="history__empty">
          {tab === 'active' &&
            'No schedules yet. Click "Schedule" under a generated script in chat to create one.'}
          {tab === 'archived' && 'No archived schedules.'}
          {tab === 'saved' &&
            'No saved scripts yet. Click "Save" under a generated script in chat to park it here for anyone to Execute or Schedule later.'}
        </div>
      )}
      {tab === 'saved'
        ? savedScripts.map((script) => (
            <SavedScriptRow
              key={script.id}
              script={script}
              onChanged={() => {
                // Covers both outcomes: Delete (only saved-scripts-all
                // changes) and Schedule (a new cron job also appears, so the
                // Active tab needs to pick it up too).
                queryClient.invalidateQueries({ queryKey: ['saved-scripts-all'] })
                queryClient.invalidateQueries({ queryKey: ['cron-jobs'] })
              }}
            />
          ))
        : (tab === 'active' ? jobs : archivedJobs).map((job) => (
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
