import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addProjectDoc,
  createProject,
  deleteProject,
  deleteProjectDoc,
  fetchProjectDocs,
  fetchProjects,
  type Project,
} from './projectsApi'

// Codex/Claude-style "Projects": named spaces bundling custom instructions,
// a small text-note knowledge base, and a set of chats (chats are assigned
// via the per-conversation "Move to project" menu in App.tsx's sidebar list,
// not from here).
export default function ProjectsPanel({
  selectedProjectId,
  onSelectProject,
}: {
  selectedProjectId: string | null
  onSelectProject: (id: string | null) => void
}) {
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [instructions, setInstructions] = useState('')
  const [docTitle, setDocTitle] = useState('')
  const [docContent, setDocContent] = useState('')

  const { data: projectList = [] } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects })
  const selected = projectList.find((p) => p.id === selectedProjectId) ?? null

  const { data: docs = [] } = useQuery({
    queryKey: ['project-docs', selectedProjectId],
    queryFn: () => fetchProjectDocs(selectedProjectId as string),
    enabled: !!selectedProjectId,
  })

  async function submitCreate() {
    if (!name.trim()) return
    await createProject(name, instructions)
    setName('')
    setInstructions('')
    setCreating(false)
    queryClient.invalidateQueries({ queryKey: ['projects'] })
  }

  async function remove(p: Project) {
    if (!window.confirm(`Delete project "${p.name}"? Its chats are kept, just unassigned.`)) return
    await deleteProject(p.id)
    if (selectedProjectId === p.id) onSelectProject(null)
    queryClient.invalidateQueries({ queryKey: ['projects'] })
  }

  async function submitDoc() {
    if (!selectedProjectId || !docTitle.trim() || !docContent.trim()) return
    await addProjectDoc(selectedProjectId, docTitle, docContent)
    setDocTitle('')
    setDocContent('')
    queryClient.invalidateQueries({ queryKey: ['project-docs', selectedProjectId] })
    queryClient.invalidateQueries({ queryKey: ['projects'] })
  }

  async function removeDoc(docId: string) {
    if (!selectedProjectId) return
    await deleteProjectDoc(selectedProjectId, docId)
    queryClient.invalidateQueries({ queryKey: ['project-docs', selectedProjectId] })
    queryClient.invalidateQueries({ queryKey: ['projects'] })
  }

  return (
    <div className="projects">
      <div className="sidebar__label projects__label">
        <span>Projects</span>
        <button className="projects__add" onClick={() => setCreating((c) => !c)} title="New project">
          +
        </button>
      </div>

      {creating && (
        <div className="projects__new">
          <input
            className="sidebar__search"
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <textarea
            className="projects__instructions"
            placeholder="Custom instructions (optional) — applied to every chat in this project"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={3}
          />
          <button className="btn btn--solid projects__new-save" onClick={submitCreate} disabled={!name.trim()}>
            Create project
          </button>
        </div>
      )}

      <nav className="projects__list">
        {projectList.map((p) => (
          <button
            key={p.id}
            className={`project-row ${selectedProjectId === p.id ? 'project-row--active' : ''}`}
            onClick={() => onSelectProject(selectedProjectId === p.id ? null : p.id)}
            title={p.instructions || p.name}
          >
            <span className="project-row__icon">📁</span>
            <span className="project-row__name">{p.name}</span>
            <span className="project-row__count">{p.chat_count}</span>
            <span
              className="project-row__remove"
              onClick={(e) => {
                e.stopPropagation()
                remove(p)
              }}
              title="Delete project"
            >
              ×
            </span>
          </button>
        ))}
      </nav>

      {selected && (
        <div className="projects__detail">
          <div className="projects__detail-head">{selected.name}</div>
          {selected.instructions && <p className="projects__detail-instructions">{selected.instructions}</p>}
          <div className="sidebar__label">Docs ({docs.length})</div>
          {docs.map((d) => (
            <div key={d.id} className="project-doc">
              <span className="project-doc__title" title={d.content}>
                {d.title}
              </span>
              <span className="project-doc__remove" onClick={() => removeDoc(d.id)} title="Delete">
                ×
              </span>
            </div>
          ))}
          <input
            className="sidebar__search"
            placeholder="Doc title"
            value={docTitle}
            onChange={(e) => setDocTitle(e.target.value)}
          />
          <textarea
            className="projects__instructions"
            placeholder="Doc content"
            value={docContent}
            onChange={(e) => setDocContent(e.target.value)}
            rows={3}
          />
          <button
            className="btn btn--ghost projects__new-save"
            onClick={submitDoc}
            disabled={!docTitle.trim() || !docContent.trim()}
          >
            Add doc
          </button>
        </div>
      )}
    </div>
  )
}
