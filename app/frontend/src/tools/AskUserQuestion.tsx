import { useState } from 'react'
import { safeParseArgs, type ToolViewProps } from './registry'

type Option = { label: string; description?: string }
type Question = {
  question: string
  header?: string
  multiSelect?: boolean
  options: Option[]
}
type Args = { questions: Question[] }

// AskUserQuestion is deferred by a PreToolUse hook (see askq_hook.py). When the
// turn pauses, the card becomes interactive: the user picks per question and we
// POST {question -> chosen label} to /api/answer, which resumes the session so
// the deferred tool resolves with the real answer.
export default function AskUserQuestionView({
  args,
  done,
  awaiting,
  questions,
  onAnswer,
}: ToolViewProps) {
  // Prefer the authoritative deferred questions; fall back to streamed args.
  const fromArgs = safeParseArgs<Args>(args)
  const qs = (questions as Question[] | undefined) ?? fromArgs?.questions

  const [picked, setPicked] = useState<Record<number, Set<string>>>({})
  const [submitted, setSubmitted] = useState<string[] | null>(null)

  if (!qs) {
    return done ? (
      <pre className="tool__pre">{args || '…'}</pre>
    ) : (
      <div className="tool__skeleton">parsing question…</div>
    )
  }

  const interactive = !!onAnswer && !!awaiting && submitted === null
  const allAnswered = qs.every((_, i) => (picked[i]?.size ?? 0) > 0)

  function choose(qi: number, label: string, multi: boolean) {
    if (!interactive) return
    setPicked((prev) => {
      const cur = new Set(multi ? (prev[qi] ?? []) : [])
      if (multi && cur.has(label)) cur.delete(label)
      else cur.add(label)
      return { ...prev, [qi]: cur }
    })
    // Snappy path: a single single-select question submits on click.
    if (!multi && qs!.length === 1) {
      submit({ [qs![0].question]: label })
    }
  }

  function submitAll() {
    const answers: Record<string, string> = {}
    qs!.forEach((q, i) => {
      answers[q.question] = [...(picked[i] ?? [])].join(', ')
    })
    submit(answers)
  }

  function submit(answers: Record<string, string>) {
    if (!onAnswer || submitted !== null) return
    setSubmitted(Object.values(answers))
    onAnswer(answers)
  }

  return (
    <div className="askq">
      {qs.map((q, i) => {
        const sel = picked[i] ?? new Set<string>()
        return (
          <div key={i} className="askq__block">
            <div className="askq__q">{q.question}</div>
            {q.header && <div className="askq__header">{q.header}</div>}
            <div className="askq__options">
              {q.options.map((opt, j) => {
                const isSel = sel.has(opt.label)
                const cls =
                  'askq__opt' +
                  (interactive ? ' askq__opt--clickable' : '') +
                  (isSel ? ' askq__opt--selected' : '')
                return (
                  <button
                    key={j}
                    type="button"
                    className={cls}
                    disabled={!interactive}
                    onClick={() => choose(i, opt.label, !!q.multiSelect)}
                  >
                    <div className="askq__opt-label">{opt.label}</div>
                    {opt.description && (
                      <div className="askq__opt-desc">{opt.description}</div>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}

      {interactive && !(qs.length === 1 && !qs[0].multiSelect) && (
        <button
          type="button"
          className="askq__submit"
          disabled={!allAnswered}
          onClick={submitAll}
        >
          Submit
        </button>
      )}

      {submitted !== null && (
        <div className="askq__answered">✓ You chose: {submitted.join(' · ')}</div>
      )}
    </div>
  )
}
