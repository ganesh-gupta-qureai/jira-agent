import { useMemo, useState } from 'react'

// Friendly schedule picker -- builds a 5-field cron expression from
// structured selections (frequency/time/days) instead of asking the user to
// hand-write cron syntax. Start/end date are separate fields passed straight
// through to the backend (APScheduler's CronTrigger supports them natively).

type Frequency = 'daily' | 'weekly' | 'monthly'

const WEEKDAYS: { label: string; value: number }[] = [
  { label: 'Sun', value: 0 },
  { label: 'Mon', value: 1 },
  { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 },
  { label: 'Thu', value: 4 },
  { label: 'Fri', value: 5 },
  { label: 'Sat', value: 6 },
]

function buildCronExpr(freq: Frequency, time: string, weekdays: number[], dayOfMonth: number): string {
  const [hh, mm] = time.split(':').map((n) => parseInt(n, 10) || 0)
  if (freq === 'daily') return `${mm} ${hh} * * *`
  if (freq === 'monthly') return `${mm} ${hh} ${dayOfMonth} * *`
  const days = weekdays.length ? [...weekdays].sort().join(',') : '1' // default Monday if none picked
  return `${mm} ${hh} * * ${days}`
}

function summarize(freq: Frequency, time: string, weekdays: number[], dayOfMonth: number): string {
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
}: {
  onSubmit: (values: ScheduleValues) => void
  onCancel: () => void
  busy: boolean
  error: string | null
}) {
  const [name, setName] = useState('')
  const [freq, setFreq] = useState<Frequency>('weekly')
  const [time, setTime] = useState('09:00')
  const [weekdays, setWeekdays] = useState<number[]>([1]) // Monday
  const [dayOfMonth, setDayOfMonth] = useState(1)
  const [useStart, setUseStart] = useState(false)
  const [startDate, setStartDate] = useState('')
  const [useEnd, setUseEnd] = useState(false)
  const [endDate, setEndDate] = useState('')

  const cronExpr = useMemo(() => buildCronExpr(freq, time, weekdays, dayOfMonth), [freq, time, weekdays, dayOfMonth])
  const summary = useMemo(() => summarize(freq, time, weekdays, dayOfMonth), [freq, time, weekdays, dayOfMonth])

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
          {(['daily', 'weekly', 'monthly'] as Frequency[]).map((f) => (
            <button
              key={f}
              type="button"
              className={`sched-form__seg-btn ${freq === f ? 'sched-form__seg-btn--active' : ''}`}
              onClick={() => setFreq(f)}
            >
              {f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

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

      <div className="sched-form__row">
        <span className="sched-form__label">Time</span>
        <input
          type="time"
          className="sched-form__input sched-form__input--time"
          value={time}
          onChange={(e) => setTime(e.target.value || '09:00')}
        />
      </div>

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
          End date
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
          {busy ? 'Creating…' : 'Create schedule'}
        </button>
        <button className="md-codeblock__download" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <div className="sched-form__error">{error}</div>}
    </div>
  )
}
