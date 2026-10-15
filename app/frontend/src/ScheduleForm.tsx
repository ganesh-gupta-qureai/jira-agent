import { useMemo, useState } from 'react'

// Friendly schedule picker -- builds a 5-field cron expression from
// structured selections (frequency/time/days) instead of asking the user to
// hand-write cron syntax. Start/end date are separate fields passed straight
// through to the backend (APScheduler's CronTrigger supports them natively).

type Frequency = 'minutes' | 'daily' | 'weekly' | 'monthly'

const WEEKDAYS: { label: string; value: number }[] = [
  { label: 'Sun', value: 0 },
  { label: 'Mon', value: 1 },
  { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 },
  { label: 'Thu', value: 4 },
  { label: 'Fri', value: 5 },
  { label: 'Sat', value: 6 },
]

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: 'minutes', label: 'Minutes' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
]

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

function buildCronExpr(
  freq: Frequency,
  time: string,
  weekdays: number[],
  dayOfMonth: number,
  minuteInterval: number,
): string {
  if (freq === 'minutes') return `*/${minuteInterval} * * * *`
  const [hh, mm] = time.split(':').map((n) => parseInt(n, 10) || 0)
  if (freq === 'daily') return `${mm} ${hh} * * *`
  if (freq === 'monthly') return `${mm} ${hh} ${dayOfMonth} * *`
  const days = weekdays.length ? [...weekdays].sort().join(',') : '1' // default Monday if none picked
  return `${mm} ${hh} * * ${days}`
}

function summarize(
  freq: Frequency,
  time: string,
  weekdays: number[],
  dayOfMonth: number,
  minuteInterval: number,
): string {
  if (freq === 'minutes') return `Every ${minuteInterval} minute${minuteInterval === 1 ? '' : 's'}`
  if (freq === 'daily') return `Every day at ${time}`
  if (freq === 'monthly') return `Day ${dayOfMonth} of every month at ${time}`
  const names = weekdays.length
    ? [...weekdays].sort().map((d) => WEEKDAYS[d].label).join(', ')
    : WEEKDAYS[1].label
  return `Every ${names} at ${time}`
}

export type ScheduleValues = {
  name: string
  cronExpr: string
  startDate: string | null
  endDate: string | null
}

export function ScheduleForm({
  onSubmit,
  onCancel,
  busy,
  error,
  submitLabel = 'Create schedule',
  busyLabel = 'Creating…',
}: {
  onSubmit: (values: ScheduleValues) => void
  onCancel: () => void
  busy: boolean
  error: string | null
  submitLabel?: string
  busyLabel?: string
}) {
  const [name, setName] = useState('')
  const [freq, setFreq] = useState<Frequency>('weekly')
  const [time, setTime] = useState('09:00')
  const [weekdays, setWeekdays] = useState<number[]>([1]) // Monday
  const [dayOfMonth, setDayOfMonth] = useState(1)
  const [minuteInterval, setMinuteInterval] = useState(5)
  // Start date defaults ON with today prefilled -- a new schedule should
  // start firing immediately unless the user deliberately pushes it out.
  const [useStart, setUseStart] = useState(true)
  const [startDate, setStartDate] = useState(todayIso)
  const [useEnd, setUseEnd] = useState(false)
  const [endDate, setEndDate] = useState('')

  const cronExpr = useMemo(
    () => buildCronExpr(freq, time, weekdays, dayOfMonth, minuteInterval),
    [freq, time, weekdays, dayOfMonth, minuteInterval],
  )
  const summary = useMemo(
    () => summarize(freq, time, weekdays, dayOfMonth, minuteInterval),
    [freq, time, weekdays, dayOfMonth, minuteInterval],
  )

  function toggleWeekday(v: number) {
    setWeekdays((ws) => (ws.includes(v) ? ws.filter((d) => d !== v) : [...ws, v]))
  }

  function submit() {
    if (busy || !name.trim()) return
    if (useEnd && useStart && startDate && endDate && endDate < startDate) return
    onSubmit({
      name: name.trim(),
      cronExpr,
      startDate: useStart && startDate ? startDate : null,
      endDate: useEnd && endDate ? endDate : null,
    })
  }

  return (
    <div className="sched-form">
      <input
        className="sched-form__input"
        placeholder="Name this schedule, e.g. Weekly CHU report"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      <div className="sched-form__row">
        <span className="sched-form__label">Repeat</span>
        <div className="sched-form__seg">
          {FREQUENCIES.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`sched-form__seg-btn ${freq === f.value ? 'sched-form__seg-btn--active' : ''}`}
              onClick={() => setFreq(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {freq === 'minutes' && (
        <div className="sched-form__row">
          <span className="sched-form__label">Every</span>
          <select
            className="sched-form__select"
            value={minuteInterval}
            onChange={(e) => setMinuteInterval(parseInt(e.target.value, 10))}
          >
            {[1, 2, 5, 10, 15, 20, 30, 45].map((n) => (
              <option key={n} value={n}>
                {n} minute{n === 1 ? '' : 's'}
              </option>
            ))}
          </select>
        </div>
      )}

      {freq === 'weekly' && (
        <div className="sched-form__row">
          <span className="sched-form__label">On</span>
          <div className="sched-form__days">
            {WEEKDAYS.map((d) => (
              <button
                key={d.value}
                type="button"
                className={`sched-form__day ${weekdays.includes(d.value) ? 'sched-form__day--active' : ''}`}
                onClick={() => toggleWeekday(d.value)}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {freq === 'monthly' && (
        <div className="sched-form__row">
          <span className="sched-form__label">Day of month</span>
          <select
            className="sched-form__select"
            value={dayOfMonth}
            onChange={(e) => setDayOfMonth(parseInt(e.target.value, 10))}
          >
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
      )}

      {freq !== 'minutes' && (
        <>
          <div className="sched-form__row">
            <span className="sched-form__label">Time (UTC)</span>
            <input
              type="time"
              className="sched-form__input sched-form__input--time"
              value={time}
              onChange={(e) => setTime(e.target.value || '09:00')}
            />
          </div>
          {/* The backend scheduler (APScheduler) runs on the container's system
              clock, which is UTC -- confirmed live 2026-10-14. buildCronExpr
              below passes this value straight through with no conversion, so a
              user entering their own local time (e.g. 9am IST) here would
              silently schedule it for 9am UTC instead, 5.5 hours off. Root-caused
              after nearly shipping exactly that mistake for Automation 4. */}
          <div className="sched-form__hint">
            Enter the time in UTC, not your local time — e.g. 9:00 AM IST is 03:30 UTC.
          </div>
        </>
      )}

      <div className="sched-form__row">
        <label className="sched-form__checkbox">
          <input type="checkbox" checked={useStart} onChange={(e) => setUseStart(e.target.checked)} />
          Start date
        </label>
        {useStart && (
          <input
            type="date"
            className="sched-form__input sched-form__input--date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        )}
      </div>

      <div className="sched-form__row">
        <label className="sched-form__checkbox">
          <input type="checkbox" checked={useEnd} onChange={(e) => setUseEnd(e.target.checked)} />
          End date (optional)
        </label>
        {useEnd && (
          <input
            type="date"
            className="sched-form__input sched-form__input--date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        )}
      </div>

      <div className="sched-form__preview">
        {summary}
        {useStart && startDate ? ` — starting ${startDate}` : ''}
        {useEnd && endDate ? ` — through ${endDate}` : ''}
      </div>
      {useStart && useEnd && startDate && endDate && endDate < startDate && (
        <div className="sched-form__error">End date can't be before start date.</div>
      )}

      <div className="sched-form__actions">
        <button className="md-codeblock__execute" onClick={submit} disabled={busy || !name.trim()}>
          {busy ? busyLabel : submitLabel}
        </button>
        <button className="md-codeblock__download" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <div className="sched-form__error">{error}</div>}
    </div>
  )
}
