// Keep the frontend and Worker on the same hostname for SameSite=Lax cookies.
export const LOCAL_WORKER_PORT = 8787;
export function resolveApiBase(location) {
  return ['localhost', '127.0.0.1'].includes(location.hostname)
    ? `http://${location.hostname}:${LOCAL_WORKER_PORT}`
    : ''; // Production: Vercel's existing /api rewrite forwards to the Worker.
}
export const API_BASE = resolveApiBase(globalThis.location || { hostname:'' });
