import { useState } from 'react'
import { apiUrl, bounceIfUnauthorized } from './api'

// Generic "post this answer to Slack" affordance for ANY agent reply, not
// just a generated script. Reuses the exact same /api/execute-script path a
// Mode 2 script's own Execute button uses (script_runner.py's uv-run +
// auto-post-on-success pipeline) -- it just builds the trivial script itself
// instead of showing one. base64 avoids any quoting/escaping issue with the
// answer text (backticks, quotes, triple-quotes) ending up inside Python source.
function toBase64Utf8(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  bytes.forEach((b) => {
    binary += String.fromCharCode(b)
  })
  return btoa(binary)
}

type PostResult = {
  ok: boolean
  timed_out: boolean
  posted_to_slack: boolean
  slack_error: string | null
}

function SlackIcon() {
  return (
    <svg className="slack-post__icon" viewBox="0 0 122.8 122.8" width="14" height="14" aria-hidden="true">
      <path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9z" fill="#E01E5A" />
      <path d="M32.3 77.6c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A" />
      <path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2z" fill="#36C5F0" />
      <path d="M45.2 32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0" />
      <path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2z" fill="#2EB67D" />
      <path d="M90.5 45.2c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D" />
      <path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9z" fill="#ECB22E" />
      <path d="M77.6 90.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ECB22E" />
    </svg>
  )
}

export function PostToSlackButton({ text }: { text: string }) {
  const [status, setStatus] = useState<'idle' | 'posting' | 'ok' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  async function post() {
    if (status === 'posting') return
    setStatus('posting')
    setMessage(null)
    try {
      const code = `import base64\nprint(base64.b64decode("${toBase64Utf8(text)}").decode("utf-8"))\n`
      const res = await fetch(apiUrl('/api/execute-script'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
      if (bounceIfUnauthorized(res)) return
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(typeof body?.detail === 'string' ? body.detail : `post failed: ${res.status}`)
      }
      const result: PostResult = await res.json()
      if (result.ok && result.posted_to_slack) {
        setStatus('ok')
      } else {
        setStatus('error')
        setMessage(result.slack_error ?? (result.timed_out ? 'timed out' : 'the script did not exit cleanly'))
      }
    } catch (err) {
      setStatus('error')
      setMessage(err instanceof Error ? err.message : 'Post failed')
    }
  }

  return (
    <div className="slack-post">
      <button
        className={`slack-post__btn slack-post__btn--${status}`}
        onClick={post}
        disabled={status === 'posting'}
        title="Post this answer to the CHU Slack channel now"
      >
        <SlackIcon />
        {status === 'posting' ? 'Posting…' : status === 'ok' ? '✓ Posted to Slack' : 'Post to Slack'}
      </button>
      {status === 'error' && <span className="slack-post__error">{message}</span>}
    </div>
  )
}
