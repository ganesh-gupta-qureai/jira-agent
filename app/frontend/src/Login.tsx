import { useState } from 'react'
import { apiUrl } from './api'

type Props = { onLoggedIn: () => void }

// Accept either a raw OAuth code or the full callback URL the user copied from
// their browser bar (e.g. `localhost:52530/callback?code=...`).
function extractCode(input: string): string {
  const trimmed = input.trim()
  try {
    const u = new URL(trimmed.startsWith('http') ? trimmed : `http://${trimmed}`)
    const code = u.searchParams.get('code')
    if (code) return code
  } catch {
    /* fall through */
  }
  return trimmed
}

export default function Login({ onLoggedIn }: Props) {
  const [phase, setPhase] = useState<'idle' | 'awaiting' | 'submitting'>('idle')
  const [session, setSession] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function start() {
    setError(null)
    try {
      const res = await fetch(apiUrl('/api/auth/start'), { method: 'POST' })
      if (!res.ok) throw new Error(`start failed: ${res.status}`)
      const data = await res.json()
      setSession(data.session_id)
      setUrl(data.url)
      setPhase('awaiting')
      window.open(data.url, '_blank', 'noopener,noreferrer')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to start login')
    }
  }

  async function submit() {
    if (!session) return
    setPhase('submitting')
    setError(null)
    try {
      const res = await fetch(apiUrl('/api/auth/complete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session, code: extractCode(code) }),
      })
      const data = await res.json()
      if (!data.ok) {
        throw new Error(data.message || 'login failed')
      }
      onLoggedIn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'login failed')
      setPhase('awaiting')
    }
  }

  return (
    <div className="login">
      <div className="login__card">
        <h2>Sign in to Claude</h2>

        {phase === 'idle' && (
          <>
            <p className="login__muted">
              The container can't open a browser, so you'll do this in two clicks.
            </p>
            <button className="login__btn" onClick={start}>
              Start login
            </button>
          </>
        )}

        {phase !== 'idle' && url && (
          <ol className="login__steps">
            <li>
              <a href={url} target="_blank" rel="noreferrer">
                Open the Claude sign-in page
              </a>{' '}
              and authorize.
            </li>
            <li>
              The browser will try to redirect to <code>localhost:NNNN/callback?code=…</code>{' '}
              and show a "connection refused" page. <strong>That's expected.</strong>
            </li>
            <li>Copy the URL from the address bar (or just the <code>code</code> part) and paste it below.</li>
          </ol>
        )}

        {phase !== 'idle' && (
          <>
            <textarea
              className="login__input"
              placeholder="paste code or full callback URL"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              rows={3}
              autoFocus
            />
            <button
              className="login__btn"
              onClick={submit}
              disabled={!code.trim() || phase === 'submitting'}
            >
              {phase === 'submitting' ? 'Verifying…' : 'Sign in'}
            </button>
          </>
        )}

        {error && <div className="login__error">{error}</div>}
      </div>
    </div>
  )
}
