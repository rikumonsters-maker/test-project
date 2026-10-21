import type { SessionUser } from './auth';

const ICONS = new Set(['🌿', '🌸', '☀️', '🌙', '⭐', '🐱', '🐶', '📅']);
const STATUS_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
}

async function profile(db: D1Database, userId: string): Promise<Response> {
	const row = await db.prepare('SELECT id, display_name, email, profile_icon, bio, status_message, status_updated_at, status_expires_at FROM users WHERE id = ?1')
		.bind(userId).first<{ id:string; display_name:string; email:string; profile_icon:string; bio:string; status_message:string; status_updated_at:string | null; status_expires_at:string | null }>();
	if (!row) return json({ error:'ユーザーが見つかりません' }, 404);
	const active = Boolean(row.status_message && row.status_expires_at && row.status_expires_at > new Date().toISOString());
	return json({ profile:{ id:row.id, displayName:row.display_name, email:row.email, profileIcon:row.profile_icon, bio:row.bio,
		statusMessage:active ? row.status_message : '', statusUpdatedAt:active ? row.status_updated_at : null,
		statusExpiresAt:active ? row.status_expires_at : null } });
}

export async function handleProfileRequest(request: Request, db: D1Database, pathname: string, user: SessionUser): Promise<Response> {
	try {
		if (pathname === '/api/profile' && request.method === 'GET') return profile(db, user.id);
		if ((pathname !== '/api/profile/update' && pathname !== '/api/profile/status') || request.method !== 'POST') return json({ error:'APIが見つかりません' }, 404);
		let body: Record<string, unknown>;
		try {
			const value: unknown = await request.json();
			if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid body');
			body = value as Record<string, unknown>;
		} catch { return json({ error:'入力内容を確認してください' }, 400); }
		if (pathname === '/api/profile/status') {
			if (typeof body.statusMessage !== 'string') return json({ error:'今やりたいことを確認してください' }, 400);
			const message = body.statusMessage.trim();
			if ([...message].length > 50) return json({ error:'今やりたいことは50文字以内で入力してください' }, 400);
			const updatedAt = message ? new Date().toISOString() : null;
			const expiresAt = updatedAt ? new Date(Date.parse(updatedAt) + STATUS_LIFETIME_MS).toISOString() : null;
			await db.prepare('UPDATE users SET status_message = ?1, status_updated_at = ?2, status_expires_at = ?3 WHERE id = ?4')
				.bind(message, updatedAt, expiresAt, user.id).run();
			return profile(db, user.id);
		}
		const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
		const bio = typeof body.bio === 'string' ? body.bio.trim() : null;
		const icon = body.profileIcon;
		if (!displayName || [...displayName].length > 40) return json({ error:'名前は1〜40文字で入力してください' }, 400);
		if (bio !== null && [...bio].length > 50) return json({ error:'プロフィール文は50文字以内で入力してください' }, 400);
		if (typeof icon !== 'string' || !ICONS.has(icon)) return json({ error:'アイコンを選択してください' }, 400);
		await db.prepare('UPDATE users SET display_name = ?1, profile_icon = ?2, bio = COALESCE(?3, bio) WHERE id = ?4')
			.bind(displayName, icon, bio, user.id).run();
		return profile(db, user.id);
	} catch (error) {
		console.error(error);
		return json({ error:'プロフィールを更新できませんでした' }, 500);
	}
}
