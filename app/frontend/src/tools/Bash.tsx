import { safeParseArgs, type ToolViewProps } from './registry'

type Args = { command: string; description?: string }

export default function BashView({ args, result, done }: ToolViewProps) {
  const parsed = safeParseArgs<Args>(args)
  const cmd = parsed?.command ?? args
  const desc = parsed?.description

  return (
    <>
      {desc && <div className="tool__desc">{desc}</div>}
      <div className="tool__label">$ shell</div>
      <pre className="tool__pre tool__pre--code">{cmd || (done ? '' : '…')}</pre>
      {result !== undefined && (
        <>
          <div className="tool__label">output</div>
          <pre className="tool__pre">{result}</pre>
        </>
      )}
    </>
  )
}
