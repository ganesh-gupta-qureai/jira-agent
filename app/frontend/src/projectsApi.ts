import { apiUrl, bounceIfUnauthorized } from './api'

export type Project = {
  id: string
  name: string
  instructions: string
  created_at: number
  chat_count: number
  doc_count: number
}

export type ProjectDoc = {
  id: string
  title: string
  content: string
  created_at: number
}

async function unwrap<T>(res: Response): Promise<T> {
  if (bounceIfUnauthorized(res)) throw new Error('unauthorized')
  if (!res.ok) throw new Error(`request failed: ${res.status}`)
  return res.json()
}

export async function fetchProjects(): Promise<Project[]> {
  return unwrap(await fetch(apiUrl('/api/projects')))
}

export async function createProject(name: string, instructions: string): Promise<Project> {
  return unwrap(
    await fetch(apiUrl('/api/projects'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, instructions }),
    }),
  )
}

export async function updateProject(id: string, patch: { name?: string; instructions?: string }): Promise<Project> {
  return unwrap(
    await fetch(apiUrl(`/api/projects/${id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  )
}

export async function deleteProject(id: string): Promise<void> {
  await unwrap(await fetch(apiUrl(`/api/projects/${id}`), { method: 'DELETE' }))
}

export async function fetchProjectDocs(projectId: string): Promise<ProjectDoc[]> {
  return unwrap(await fetch(apiUrl(`/api/projects/${projectId}/docs`)))
}

export async function addProjectDoc(projectId: string, title: string, content: string): Promise<ProjectDoc> {
  return unwrap(
    await fetch(apiUrl(`/api/projects/${projectId}/docs`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content }),
    }),
  )
}

export async function deleteProjectDoc(projectId: string, docId: string): Promise<void> {
  await unwrap(await fetch(apiUrl(`/api/projects/${projectId}/docs/${docId}`), { method: 'DELETE' }))
}
