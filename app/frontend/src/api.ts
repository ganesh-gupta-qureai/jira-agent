// All API calls go through `apiUrl(path)` so they automatically pick up
// Vite's base prefix when we're embedded behind a reverse proxy
// (e.g. `/apps/sql-agent/api/chat`).
export function apiUrl(path: string): string {
  const base = import.meta.env.BASE_URL // ends with '/'
  const rel = path.startsWith('/') ? path.slice(1) : path
  return `${base}${rel}`
}

// When the Hive session/JWT expires mid-use, the qhive proxy answers our
// in-app fetches with 401. Mirror the qhive SPA's axios interceptor: send the
// user to the Hive login. Absolute '/login' targets the qhive root, not our
// '/apps/sql-agent/' prefix. Returns true if it bounced (caller should stop).
export function bounceIfUnauthorized(res: Response): boolean {
  if (res.status === 401) {
    window.location.href = '/login'
    return true
  }
  return false
}
