"""Wires cron_jobs.py's persisted job definitions to APScheduler, running
each job through the exact same execute_script() path the Execute button
uses -- same throwaway-file-in-workspace execution, same successful-run-only
Slack post, same execution-history logging (script_runner.py). A scheduled
run is indistinguishable from a human clicking Execute at that moment,
except nobody had to click it.

start() is called once at FastAPI startup to re-register every persisted
job (across all users) so schedules survive a redeploy or restart --
JIRA_agent's container has no other durable process, so the schedule
registration itself only lives as long as this one process does; the JSON
files in cron_jobs.py are the actual durable state.
"""
from __future__ import annotations

import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

import cron_jobs
from script_runner import execute_script

logger = logging.getLogger("cron_scheduler")

scheduler = AsyncIOScheduler()


def _aps_id(user_id: str, job_id: str) -> str:
    return f"{user_id}:{job_id}"


async def _run_job(user_id: str, job_id: str) -> None:
    job = cron_jobs.get_job(user_id, job_id)
    if job is None or not job.get("enabled", True):
        return
    try:
        result = await execute_script(user_id, job["code"])
        cron_jobs.record_run(user_id, job_id, ok=bool(result.get("ok")))
    except Exception:
        logger.exception("cron job %s (user %s) failed", job_id, user_id)
        cron_jobs.record_run(user_id, job_id, ok=False)


def validate_cron(cron_expr: str) -> str | None:
    """Returns an error string if `cron_expr` isn't a valid 5-field crontab
    expression, else None. Used to reject a bad expression at creation time
    with a 400 instead of it silently never firing."""
    try:
        CronTrigger.from_crontab(cron_expr)
    except ValueError as exc:
        return str(exc)
    return None


def _build_trigger(job: dict) -> CronTrigger:
    """Build the actual trigger from a job's stored fields. Split the
    5-field crontab string into CronTrigger's own minute/hour/day/month/
    day_of_week kwargs (same field syntax, so this is a direct pass-through)
    instead of using from_crontab(), which has no start_date/end_date
    parameters -- those only exist on the full constructor."""
    minute, hour, day, month, day_of_week = job["cron_expr"].split()
    kwargs: dict = dict(minute=minute, hour=hour, day=day, month=month, day_of_week=day_of_week)
    if job.get("start_date"):
        kwargs["start_date"] = job["start_date"]
    if job.get("end_date"):
        # A date-only end_date means "through the end of that day" to a user,
        # not "at 00:00 on that day" (which would make the job never fire on
        # its own end date) -- push to the last instant of that day.
        kwargs["end_date"] = f"{job['end_date']} 23:59:59"
    return CronTrigger(**kwargs)


def schedule_job(user_id: str, job: dict) -> None:
    """(Re)register one job with the live scheduler -- called on create and
    once per persisted job at startup. An invalid cron expression here (only
    possible for a job that predates a stricter validate_cron check) is
    logged and skipped, not raised, so one bad job can't block every other
    job or the app itself from starting."""
    aps_id = _aps_id(user_id, job["id"])
    if scheduler.get_job(aps_id):
        scheduler.remove_job(aps_id)
    if not job.get("enabled", True):
        return
    try:
        trigger = _build_trigger(job)
    except (ValueError, KeyError):
        logger.error("invalid schedule fields for job %s: %r", job["id"], job)
        return
    scheduler.add_job(
        _run_job,
        trigger=trigger,
        args=[user_id, job["id"]],
        id=aps_id,
        replace_existing=True,
        misfire_grace_time=3600,
    )


def unschedule_job(user_id: str, job_id: str) -> None:
    aps_id = _aps_id(user_id, job_id)
    if scheduler.get_job(aps_id):
        scheduler.remove_job(aps_id)


def start() -> None:
    for user_id in cron_jobs.all_user_ids():
        for job in cron_jobs.list_jobs(user_id):
            schedule_job(user_id, job)
    scheduler.start()
