// Keep the frontend and Worker on the same hostname for SameSite=Lax cookies.
export const LOCAL_WORKER_PORT = 8787;
export const PUBLIC_APP_ORIGIN = 'https://daysync-app.vercel.app';

export function resolvePublicAppOrigin(location) {
  const origin = location?.origin;
  try {
    if (['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) return origin;
  } catch { /* Use the public app origin outside local development. */ }
  return PUBLIC_APP_ORIGIN;
}

export function createInviteUrl(inviteCode, location = globalThis.location) {
  const url = new URL('/', resolvePublicAppOrigin(location));
  url.searchParams.set('invite', inviteCode);
  return url;
}

export function resolveApiBase(location) {
  return ['localhost', '127.0.0.1'].includes(location.hostname)
    ? `http://${location.hostname}:${LOCAL_WORKER_PORT}`
    : ''; // Production: Vercel's existing /api rewrite forwards to the Worker.
}
export const API_BASE = resolveApiBase(globalThis.location || { hostname:'' });
