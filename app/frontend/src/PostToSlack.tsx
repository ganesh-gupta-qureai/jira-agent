import { useState } from 'react'
import { apiUrl, bounceIfUnauthorized } from './api'
import { DEFAULT_SLACK_CHANNEL, PRODUCTION_SLACK_CHANNEL_ID, SLACK_CHANNELS } from './slackChannels'

// Generic "post this answer to Slack" affordance for ANY agent reply, not
// just a generated script. Reuses the exact same /api/execute-script path a
// Mode 2 script's own Execute button uses (script_runner.py's uv-run +
// auto-post-on-success pipeline) -- it just builds the trivial script itself
// instead of showing one. JSON.stringify produces a valid Python double-quoted
// string literal too (both share \", \\, \n, \r, \t, \uXXXX escaping), so the
// Scripts log shows real, readable Python -- not a base64 blob -- while still
// being immune to quote/backtick/triple-quote characters in the answer text.
//
// Root-caused 2026-10-06 (Shamil): this button silently did nothing on click
// -- it never sent `channel` or `send`, so script_runner.py's execute_script
// skipped the post entirely (send=False) while still reporting ok=true,
// which read as success. He had to fall back to typing "send it" in chat
// (Mode 0's post_to_slack.py -- no channel picker, no confirmation at all)
// to get anything posted. Fix: give this button the SAME channel picker +
// confirmed_production flow CodeBlock's Execute button already has, and
// always set send=true -- unlike Execute, there's no "preview" concept for
// a plain chat answer, clicking this button always means "actually post it."
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
  const [channel, setChannel] = useState<string>(DEFAULT_SLACK_CHANNEL)

  async function post() {
    if (status === 'posting') return
    if (channel === PRODUCTION_SLACK_CHANNEL_ID) {
      const ok = window.confirm(
        'This will send a REAL message to #complaint-handling-us (production), not a test channel. Continue?',
      )
      if (!ok) return
    }
    setStatus('posting')
    setMessage(null)
    try {
      const code = `print(${JSON.stringify(text)})\n`
      const res = await fetch(apiUrl('/api/execute-script'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          channel,
          send: true,
          confirmed_production: channel === PRODUCTION_SLACK_CHANNEL_ID,
        }),
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
      <select
        className="slack-post__channel"
        value={channel}
        onChange={(e) => setChannel(e.target.value)}
        disabled={status === 'posting'}
        title="Slack channel to post this answer to"
      >
        {SLACK_CHANNELS.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      <button
        className={`slack-post__btn slack-post__btn--${status}`}
        onClick={post}
        disabled={status === 'posting'}
        title="Post this answer to the selected Slack channel now"
      >
        <SlackIcon />
        {status === 'posting' ? 'Posting…' : status === 'ok' ? '✓ Posted to Slack' : 'Post to Slack'}
      </button>
      {status === 'error' && <span className="slack-post__error">{message}</span>}
    </div>
  )
}
