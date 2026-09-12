import { useState, type ReactNode } from 'react'
import { apiUrl, bounceIfUnauthorized } from './api'

// Minimal, dependency-free markdown renderer for assistant chat output.
// Handles the subset the agent actually emits: headings, fenced code blocks,
// unordered/ordered lists, blockquotes, and inline spans (bold, italic,
// inline code, links). Not a spec-complete parser — just enough to read well.

type Props = { children: string }

export function Markdown({ children }: Props) {
  return <>{renderBlocks(children ?? '')}</>
}

// --- block level ----------------------------------------------------------

function renderBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    // fenced code block ```lang ... ```
    const fence = line.match(/^\s*```(\w*)\s*$/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // skip closing fence
      out.push(<CodeBlock key={key++} lang={fence[1]} code={body.join('\n')} />)
      continue
    }

    // blank line
    if (/^\s*$/.test(line)) {
      i++
      continue
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      out.push(heading(h[1].length, renderInline(h[2]), key++))
      i++
      continue
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      out.push(
        <blockquote key={key++} className="md-quote">
          {renderBlocks(quote.join('\n'))}
        </blockquote>,
      )
      continue
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      out.push(
        <ul key={key++} className="md-ul">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ul>,
      )
      continue
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      out.push(
        <ol key={key++} className="md-ol">
          {items.map((it, j) => (
            <li key={j}>{renderInline(it)}</li>
          ))}
        </ol>,
      )
      continue
    }

    // paragraph: gather consecutive non-blank, non-block lines
    const para: string[] = []
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i])
      i++
    }
    out.push(<p key={key++}>{renderInline(para.join('\n'))}</p>)
  }

  return out
}

// Language → file extension, for the generated download's filename. A
// fenced block with no language tag (bare ``` ... ```, e.g. raw JSON dumps
// in tool output) gets no download button — only fences the agent actually
// tagged with a language are treated as "a script."
const EXT_BY_LANG: Record<string, string> = {
  python: 'py', py: 'py',
  bash: 'sh', sh: 'sh', shell: 'sh',
  javascript: 'js', js: 'js',
  typescript: 'ts', ts: 'ts',
  json: 'json',
  yaml: 'yaml', yml: 'yaml',
  sql: 'sql',
}

type ExecuteResult = {
  ok: boolean
  timed_out: boolean
  exit_code: number | null
  stdout: string
  stderr: string
}

// Only a real Python block is a "script" the human might want to run in
// place -- other fenced languages (bash snippets, raw JSON dumps, SQL) still
// get the Download button but never Execute, since this backend only knows
// how to `uv run` a .py file (see script_runner.py).
const EXECUTABLE_LANGS = new Set(['python', 'py'])

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const hasLang = lang.trim().length > 0
  const langLower = lang.toLowerCase()
  const ext = EXT_BY_LANG[langLower] ?? 'txt'
  const executable = EXECUTABLE_LANGS.has(langLower)

  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ExecuteResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  function download() {
    const blob = new Blob([code], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `script.${ext}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  async function execute() {
    if (running) return
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch(apiUrl('/api/execute-script'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      if (bounceIfUnauthorized(res)) return
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(typeof body?.detail === 'string' ? body.detail : `execute failed: ${res.status}`)
      }
      setResult(await res.json())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Execute failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="md-codeblock">
      {hasLang && (
        <div className="md-codeblock__head">
          <span className="md-codeblock__lang">{lang}</span>
          <div className="md-codeblock__actions">
            {executable && (
              <button
                className="md-codeblock__execute"
                onClick={execute}
                disabled={running}
                title="Run this script now, in this workspace"
              >
                {running ? '⏳ Running…' : '▶ Execute'}
              </button>
            )}
            <button className="md-codeblock__download" onClick={download} title="Download as a file">
              ↓ Download
            </button>
          </div>
        </div>
      )}
      <pre className="md-pre">
        <code>{code}</code>
      </pre>
      {error && <div className="md-codeblock__result md-codeblock__result--error">{error}</div>}
      {result && (
        <div
          className={`md-codeblock__result ${
            result.timed_out || !result.ok ? 'md-codeblock__result--error' : 'md-codeblock__result--ok'
          }`}
        >
          <div className="md-codeblock__result-head">
            {result.timed_out
              ? 'Timed out'
              : result.ok
                ? `Exit 0`
                : `Exit ${result.exit_code ?? '?'}`}
          </div>
          {result.stdout && <pre className="md-pre">{result.stdout}</pre>}
          {result.stderr && <pre className="md-pre">{result.stderr}</pre>}
          {!result.stdout && !result.stderr && !result.timed_out && (
            <div className="md-codeblock__result-empty">(no output)</div>
          )}
        </div>
      )}
    </div>
  )
}

function heading(level: number, kids: ReactNode, key: number): ReactNode {
  switch (level) {
    case 1: return <h1 key={key}>{kids}</h1>
    case 2: return <h2 key={key}>{kids}</h2>
    case 3: return <h3 key={key}>{kids}</h3>
    case 4: return <h4 key={key}>{kids}</h4>
    case 5: return <h5 key={key}>{kids}</h5>
    default: return <h6 key={key}>{kids}</h6>
  }
}

// --- inline level ----------------------------------------------------------

// Tokenize inline spans. Order matters: code first (so its contents aren't
// re-parsed), then links, bold, italic.
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let key = 0
  let rest = text

  // Combined matcher for the next inline token.
  const re =
    /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]+\]\([^)]+\))/

  while (rest.length) {
    const m = rest.match(re)
    if (!m || m.index === undefined) {
      nodes.push(...withBreaks(rest, key))
      key += 100
      break
    }

    if (m.index > 0) {
      nodes.push(...withBreaks(rest.slice(0, m.index), key))
      key += 100
    }

    const tok = m[0]
    if (m[1]) {
      nodes.push(<code key={key++} className="md-code">{tok.slice(1, -1)}</code>)
    } else if (m[2]) {
      nodes.push(<strong key={key++}>{tok.slice(2, -2)}</strong>)
    } else if (m[3]) {
      nodes.push(<em key={key++}>{tok.slice(1, -1)}</em>)
    } else if (m[4]) {
      const link = tok.match(/\[([^\]]+)\]\(([^)]+)\)/)!
      nodes.push(
        <a key={key++} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>,
      )
    }

    rest = rest.slice(m.index + tok.length)
  }

  return nodes
}

// Turn literal newlines inside a paragraph into <br/>.
function withBreaks(text: string, baseKey: number): ReactNode[] {
  const parts = text.split('\n')
  const out: ReactNode[] = []
  parts.forEach((p, j) => {
    if (j > 0) out.push(<br key={`${baseKey}-br-${j}`} />)
    if (p) out.push(p)
  })
  return out
}

export default Markdown
