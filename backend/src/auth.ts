import { isLocalDevelopment, type DevelopmentEnv } from './development';

export interface AuthEnv extends DevelopmentEnv { DB: D1Database }

export interface SessionUser { id: string; displayName: string; email: string }

const COOKIE_NAME = 'daysync_session';
const SESSION_DAYS = 365;
const RENEW_AFTER_DAYS = 30;
const DAY_MS = 86400_000;
const SESSION_SECONDS = SESSION_DAYS * 86400;
// Cloudflare Workers Web Crypto accepts at most 100,000 PBKDF2 iterations.
const PBKDF2_ITERATIONS = 100_000;
const encoder = new TextEncoder();

function json(data: unknown, status = 200, cookie?: string): Response {
	const headers = new Headers({ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });
	if (cookie) headers.set('set-cookie', cookie);
	return new Response(JSON.stringify(data), { status, headers });
}

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomHex(size: number): string {
	const bytes = new Uint8Array(size);
	crypto.getRandomValues(bytes);
	return hex(bytes);
}

export async function sha256(value: string): Promise<string> {
	return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

export async function passwordHash(password: string, salt: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits({ name:'PBKDF2', hash:'SHA-256', salt:encoder.encode(salt), iterations:PBKDF2_ITERATIONS }, key, 256);
	return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${hex(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, salt: string, stored: string): Promise<boolean> {
	const computed = await passwordHash(password, salt);
	if (computed.length !== stored.length) return false;
	let difference = 0;
	for (let index = 0; index < computed.length; index += 1) difference |= computed.charCodeAt(index) ^ stored.charCodeAt(index);
	return difference === 0;
}

function sessionToken(request: Request): string | null {
	const cookie = request.headers.get('cookie') || '';
	const value = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
	return value && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

export function cookieHeader(request: Request, env: AuthEnv, token: string, maxAge: number): string {
	const secure = isLocalDevelopment(request, env) ? '' : '; Secure';
	return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAge}`;
}

async function createSession(request: Request, env: AuthEnv, user: SessionUser, expectedHash?: string): Promise<Response> {
	const db = env.DB;
	const token = randomHex(32);
	const createdAt = new Date();
	const expiresAt = new Date(createdAt.getTime() + SESSION_DAYS * DAY_MS);
	const result = expectedHash
		? await db.prepare('INSERT INTO auth_sessions (id_hash, user_id, expires_at, created_at) SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?2 AND password_hash = ?5)')
			.bind(await sha256(token), user.id, expiresAt.toISOString(), createdAt.toISOString(), expectedHash).run()
		: await db.prepare('INSERT INTO auth_sessions (id_hash, user_id, expires_at, created_at) VALUES (?1, ?2, ?3, ?4)')
			.bind(await sha256(token), user.id, expiresAt.toISOString(), createdAt.toISOString()).run();
	if (!result.meta.changes) return json({ error:'パスワードが変更されました。再度ログインしてください' }, 401);
	return json({ user }, 200, cookieHeader(request, env, token, SESSION_SECONDS));
}

async function findSession(request: Request, db: D1Database): Promise<{ user:SessionUser; token:string; expiresAt:string } | null> {
	const token = sessionToken(request);
	if (!token) return null;
	const row = await db.prepare(
		`SELECT u.id, u.display_name, u.email, s.expires_at FROM auth_sessions s
		 JOIN users u ON u.id = s.user_id
		 WHERE s.id_hash = ?1 AND s.expires_at > ?2`,
	).bind(await sha256(token), new Date().toISOString()).first<{ id:string; display_name:string; email:string; expires_at:string }>();
	return row ? { user:{ id:row.id, displayName:row.display_name, email:row.email }, token, expiresAt:row.expires_at } : null;
}

export async function getSessionUser(request: Request, db: D1Database): Promise<SessionUser | null> {
	return (await findSession(request, db))?.user || null;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
	try {
		const value: unknown = await request.json();
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
	} catch { return null; }
}

export function passwordValidation(password: string, confirmation: unknown): string | null {
	if (password.length < 8 || password.length > 128) return 'パスワードは8〜128文字で入力してください';
	return confirmation !== password ? '確認用パスワードが一致しません' : null;
}

export async function handleAuthRequest(request: Request, env: AuthEnv, pathname: string): Promise<Response> {
	try {
		if (pathname === '/api/auth/me') {
			if (request.method !== 'GET') return json({ error:'GETメソッドを使用してください' }, 405);
			const session = await findSession(request, env.DB);
			if (!session) return json({ error:'ログインが必要です' }, 401);
			const now = new Date();
			if (Date.parse(session.expiresAt) - now.getTime() <= (SESSION_DAYS - RENEW_AFTER_DAYS) * DAY_MS) {
				const expiresAt = new Date(now.getTime() + SESSION_DAYS * DAY_MS).toISOString();
				const result = await env.DB.prepare('UPDATE auth_sessions SET expires_at = ?1 WHERE id_hash = ?2 AND expires_at > ?3')
					.bind(expiresAt, await sha256(session.token), now.toISOString()).run();
				if (!result.meta.changes) return json({ error:'ログインが必要です' }, 401);
				return json({ user:session.user }, 200, cookieHeader(request, env, session.token, SESSION_SECONDS));
			}
			return json({ user:session.user });
		}
		if (request.method !== 'POST') return json({ error:'POSTメソッドを使用してください' }, 405);
		if (pathname === '/api/auth/logout') {
			const token = sessionToken(request);
			if (token) {
				const idHash = await sha256(token);
				const body = await readBody(request);
				const endpoint = typeof body?.endpoint === 'string' && body.endpoint.length <= 2048 ? body.endpoint : null;
				if (endpoint) {
					try {
						await env.DB.prepare(
							'DELETE FROM push_subscriptions WHERE endpoint = ?1 AND user_id IN (SELECT user_id FROM auth_sessions WHERE id_hash = ?2)',
						).bind(endpoint, idHash).run();
					} catch (error) { console.warn('Could not remove this device subscription on logout', error); }
				}
				await env.DB.prepare('DELETE FROM auth_sessions WHERE id_hash = ?1').bind(idHash).run();
			}
			return json({ ok:true }, 200, cookieHeader(request, env, '', 0));
		}
		const body = await readBody(request);
		if (!body) return json({ error:'入力内容を確認してください' }, 400);
		const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
		const password = typeof body.password === 'string' ? body.password : '';
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json({ error:'メールアドレスの形式を確認してください' }, 400);
		if (pathname === '/api/auth/register') {
			const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
			if (!displayName || displayName.length > 40) return json({ error:'表示名を入力してください' }, 400);
			const invalid = passwordValidation(password, body.passwordConfirm);
			if (invalid) return json({ error:invalid }, 400);
			const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first();
			if (existing) return json({ error:'このメールアドレスは登録済みです' }, 409);
			const user = { id:crypto.randomUUID(), displayName, email };
			const salt = randomHex(16);
			const hash = await passwordHash(password, salt);
			try {
				await env.DB.prepare('INSERT INTO users (id, display_name, email, password_hash, password_salt, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
					.bind(user.id, displayName, email, hash, salt, new Date().toISOString()).run();
			} catch (error) {
				if (String(error).includes('UNIQUE constraint failed')) return json({ error:'このメールアドレスは登録済みです' }, 409);
				throw error;
			}
			return createSession(request, env, user);
		}
		if (pathname === '/api/auth/login') {
			if (!password) return json({ error:'パスワードを入力してください' }, 400);
			const row = await env.DB.prepare('SELECT id, display_name, email, password_hash, password_salt FROM users WHERE email = ?1')
				.bind(email).first<{ id:string; display_name:string; email:string; password_hash:string; password_salt:string }>();
			if (!row || !await verifyPassword(password, row.password_salt, row.password_hash)) return json({ error:'メールアドレスまたはパスワードが正しくありません' }, 401);
			return createSession(request, env, { id:row.id, displayName:row.display_name, email:row.email }, row.password_hash);
		}
		return json({ error:'APIが見つかりません' }, 404);
	} catch (error) {
		console.error(error);
		return json({ error:'サーバーで処理できませんでした' }, 500);
	}
}
