import { apiUrl, bounceIfUnauthorized } from './api'

// Mirrors backend/cron_jobs.py's per-run log entry (record_run).
export type CronJobRun = {
  at: number // unix seconds (float)
  ok: boolean
  exit_code: number | null
  timed_out: boolean
  posted_to_slack: boolean
  error: string | null
}

// Mirrors backend/cron_jobs.py's record shape.
export type CronJob = {
  id: string
  owner: string // email of whoever created it -- the tab shows every user's jobs, not just the viewer's
  name: string
  code: string
  cron_expr: string
  start_date: string | null // ISO date (YYYY-MM-DD)
  end_date: string | null // ISO date (YYYY-MM-DD)
  channel: string | null // Slack channel ID override
  send: boolean // whether each run sets CHU_REPORT_SEND=1
  created_at: number // unix seconds (float)
  enabled: boolean
  last_run_at: number | null
  last_run_ok: boolean | null
  runs: CronJobRun[] // newest first, capped at 50 -- see cron_jobs._MAX_RUN_LOG
}

async function throwIfBad(res: Response): Promise<void> {
  if (bounceIfUnauthorized(res)) throw new Error('unauthorized')
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(typeof body?.detail === 'string' ? body.detail : `request failed: ${res.status}`)
  }
}

export async function fetchCronJobs(): Promise<CronJob[]> {
  const res = await fetch(apiUrl('/api/cron-jobs'))
  await throwIfBad(res)
  return res.json()
}

export async function createCronJob(
  name: string,
  code: string,
  cron_expr: string,
  start_date: string | null,
  end_date: string | null,
  channel: string | null,
  send: boolean,
  confirmedProduction: boolean,
): Promise<CronJob> {
  const res = await fetch(apiUrl('/api/cron-jobs'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      code,
      cron_expr,
      start_date,
      end_date,
      channel,
      send,
      confirmed_production: confirmedProduction,
    }),
  })
  await throwIfBad(res)
  return res.json()
}

export async function setCronJobEnabled(id: string, enabled: boolean): Promise<CronJob> {
  const res = await fetch(apiUrl(`/api/cron-jobs/${id}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  await throwIfBad(res)
  return res.json()
}

export async function updateCronJob(
  id: string,
  name: string,
  cron_expr: string,
  start_date: string | null,
  end_date: string | null,
  channel: string | null,
  send: boolean,
  confirmedProduction: boolean,
): Promise<CronJob> {
  const res = await fetch(apiUrl(`/api/cron-jobs/${id}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      cron_expr,
      start_date,
      end_date,
      channel,
      send,
      confirmed_production: confirmedProduction,
    }),
  })
  await throwIfBad(res)
  return res.json()
}

export async function deleteCronJob(id: string): Promise<void> {
  const res = await fetch(apiUrl(`/api/cron-jobs/${id}`), { method: 'DELETE' })
  await throwIfBad(res)
}

export async function promoteCronJob(id: string, confirmedProduction: boolean): Promise<CronJob> {
  const res = await fetch(apiUrl(`/api/cron-jobs/${id}/promote`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed_production: confirmedProduction }),
  })
  await throwIfBad(res)
  return res.json()
}
