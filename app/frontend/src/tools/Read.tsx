import { safeParseArgs, type ToolViewProps } from './registry'

type Args = { file_path: string; offset?: number; limit?: number }

export default function ReadView({ args, result, done }: ToolViewProps) {
  const parsed = safeParseArgs<Args>(args)
  const path = parsed?.file_path ?? args
  const range =
    parsed?.offset != null || parsed?.limit != null
      ? `lines ${parsed?.offset ?? 1}${parsed?.limit ? `–${(parsed.offset ?? 1) + parsed.limit - 1}` : '+'}`
      : null

  return (
    <>
      <div className="tool__desc">
        <span className="tool__file">{path || (done ? '' : '…')}</span>
        {range && <span className="tool__range"> · {range}</span>}
      </div>
      {result !== undefined && (
        <>
          <div className="tool__label">contents</div>
          <pre className="tool__pre">{result}</pre>
        </>
      )}
    </>
  )
}
