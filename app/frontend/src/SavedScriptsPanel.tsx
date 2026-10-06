import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { deleteSavedScript, fetchSavedScripts } from './savedScriptsApi'

// Top-right "Saved scripts" affordance for the current chat only -- a place
// to keep a script for later reference. Deliberately view/copy/delete only:
// no Execute button anywhere in here, saving a script is not a way to run it.
export default function SavedScriptsPanel({ threadId }: { threadId: string | null }) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data: saved = [] } = useQuery({
    queryKey: ['saved-scripts', threadId],
    queryFn: () => fetchSavedScripts(threadId as string),
    enabled: !!threadId && open,
  })

  if (!threadId) return null

  async function remove(id: string) {
    await deleteSavedScript(id)
    queryClient.invalidateQueries({ queryKey: ['saved-scripts', threadId] })
  }

  return (
    <div className="saved-scripts">
      <button
        className="icon-btn"
        title="Saved scripts for this chat"
        onClick={() => setOpen((o) => !o)}
      >
        📑{saved.length > 0 ? ` ${saved.length}` : ''}
      </button>
      {open && (
        <div className="saved-scripts__panel">
          <div className="saved-scripts__head">Saved scripts (this chat)</div>
          {saved.length === 0 && <div className="saved-scripts__empty">Nothing saved yet.</div>}
          {saved.map((s) => (
            <div key={s.id} className="saved-scripts__item">
              <div
                className="saved-scripts__title"
                onClick={() => setExpanded((e) => (e === s.id ? null : s.id))}
                title="View code"
              >
                {s.title}
              </div>
              <button
                className="saved-scripts__remove"
                onClick={() => remove(s.id)}
                title="Delete"
              >
                ×
              </button>
              {expanded === s.id && (
                <pre className="saved-scripts__code">
                  <code>{s.code}</code>
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
