import type { SessionUser } from './auth';
import { PUBLIC_APP_ORIGIN } from './app-origin';
import { notificationPath, queueGroupInbox, queueGroupUserInbox } from './notifications';

export interface PushEnv {
	DB: D1Database;
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	VAPID_SUBJECT?: string;
}

type Subscription = { id:string; user_id:string; endpoint:string; p256dh:string; auth:string };
type Delivery = Subscription & { delivery_id:string; group_id:string; scope:'group' | 'personal'; recipient_user_id:string | null; target_path:string | null; reminder_id:string | null; kind:Notice['kind']; body:string; attempts:number };
type Notice = { body:string; groupId?:string; targetPath?:string; kind:'group_event_created' | 'group_event_updated' | 'group_joined' | 'wish_created' | 'wish_interested' | 'event_reminder' };
type DeliveryResult = { status:number; reason:string; provider:'apple' | 'other' };
const encoder = new TextEncoder();
const BATCH_SIZE = 8; // Keep each free-tier invocation small; a cron drains the remaining queue.

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' } });
}

function bytes(...parts: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
	let offset = 0;
	for (const part of parts) { result.set(part, offset); offset += part.length; }
	return result;
}

function decodeBase64Url(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url value');
	const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
	let binary = '';
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function validEndpoint(value: unknown): value is string {
	if (typeof value !== 'string' || value.length > 2048) return false;
	try {
		const url = new URL(value);
		const host = url.hostname.toLowerCase();
		return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && (
			host === 'fcm.googleapis.com' || host.endsWith('.fcm.googleapis.com') ||
			host.endsWith('.push.services.mozilla.com') || host.endsWith('.push.apple.com') ||
			host.endsWith('.notify.windows.com') || host === 'webpush.edge.microsoft.com'
		);
	} catch { return false; }
}

function validKeys(p256dh: unknown, auth: unknown): p256dh is string {
	try {
		return typeof p256dh === 'string' && typeof auth === 'string' &&
			decodeBase64Url(p256dh).length === 65 && decodeBase64Url(p256dh)[0] === 4 && decodeBase64Url(auth).length === 16;
	} catch { return false; }
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
	try {
		const value: unknown = await request.json();
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
	} catch { return null; }
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const imported = await crypto.subtle.importKey('raw', key, { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
	return new Uint8Array(await crypto.subtle.sign('HMAC', imported, data));
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, size: number): Promise<Uint8Array> {
	const prk = await hmac(salt, ikm);
	return (await hmac(prk, bytes(info, new Uint8Array([1])))).slice(0, size);
}

export async function encryptPushPayload(p256dh: string, auth: string, payload: string): Promise<Uint8Array> {
	const receiverRaw = decodeBase64Url(p256dh);
	const receiver = await crypto.subtle.importKey('raw', receiverRaw, { name:'ECDH', namedCurve:'P-256' }, false, []);
	const sender = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
	const senderRaw = new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey) as ArrayBuffer);
	const secret = new Uint8Array(await crypto.subtle.deriveBits({ name:'ECDH', public:receiver } as unknown as SubtleCryptoDeriveKeyAlgorithm, sender.privateKey, 256));
	const ikm = await hkdf(secret, decodeBase64Url(auth), bytes(encoder.encode('WebPush: info'), new Uint8Array([0]), receiverRaw, senderRaw), 32);
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const key = await hkdf(ikm, salt, bytes(encoder.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
	const nonce = await hkdf(ikm, salt, bytes(encoder.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);
	const plaintext = bytes(encoder.encode(payload), new Uint8Array([2]));
	if (plaintext.length + 16 >= 4096) throw new Error('Push payload is too long');
	const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv:nonce }, aes, plaintext));
	return bytes(salt, new Uint8Array([0, 0, 16, 0, senderRaw.length]), senderRaw, ciphertext);
}

async function vapidHeader(endpoint: string, env: PushEnv): Promise<string> {
	const raw = decodeBase64Url(env.VAPID_PUBLIC_KEY!);
	const privateBytes = decodeBase64Url(env.VAPID_PRIVATE_KEY!);
	if (raw.length !== 65 || raw[0] !== 4 || privateBytes.length !== 32) throw new Error('Invalid VAPID key pair');
	const key = await crypto.subtle.importKey('jwk', {
		kty:'EC', crv:'P-256', x:encodeBase64Url(raw.slice(1, 33)), y:encodeBase64Url(raw.slice(33)),
		d:env.VAPID_PRIVATE_KEY!, ext:false, key_ops:['sign'],
	}, { name:'ECDSA', namedCurve:'P-256' }, false, ['sign']);
	const header = encodeBase64Url(encoder.encode(JSON.stringify({ typ:'JWT', alg:'ES256' })));
	const claims = encodeBase64Url(encoder.encode(JSON.stringify({ aud:new URL(endpoint).origin, exp:Math.floor(Date.now() / 1000) + 3600, sub:env.VAPID_SUBJECT })));
	const input = `${header}.${claims}`;
	const signature = encodeBase64Url(new Uint8Array(await crypto.subtle.sign({ name:'ECDSA', hash:'SHA-256' }, key, encoder.encode(input))));
	return `vapid t=${input}.${signature}, k=${env.VAPID_PUBLIC_KEY}`;
}

function configured(env: PushEnv): boolean {
	return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT && /^(mailto:|https:\/\/)/.test(env.VAPID_SUBJECT));
}

const appleReasons = new Set([
	'BadJwtToken', 'BadVapidPublicKey', 'VapidPkHashMismatch', 'BadWebPushRequest',
	'BadMessageId', 'BadDeviceToken', 'DeviceTokenNotForTopic', 'ExpiredProviderToken',
	'InvalidProviderToken', 'MissingProviderToken', 'TooManyRequests', 'InternalServerError',
]);

async function deliver(env: PushEnv, subscription: Subscription, notice: Notice): Promise<DeliveryResult> {
	const url = new URL(notice.targetPath || '/', PUBLIC_APP_ORIGIN);
	if (notice.groupId) url.searchParams.set('group', notice.groupId);
	const payload = JSON.stringify({ title:'DaySync', body:notice.body, url:url.href, kind:notice.kind });
	const provider = new URL(subscription.endpoint).hostname.endsWith('.push.apple.com') ? 'apple' : 'other';
	try {
		const body = await encryptPushPayload(subscription.p256dh, subscription.auth, payload);
		const response = await fetch(subscription.endpoint, {
			method:'POST', redirect:'manual', headers:{
				'Content-Encoding':'aes128gcm', 'Content-Type':'application/octet-stream', TTL:'3600',
				Urgency:notice.kind === 'event_reminder' ? 'high' : 'normal',
				Authorization:await vapidHeader(subscription.endpoint, env),
			}, body,
		});
		let reason = '';
		if (provider === 'apple' && (response.status < 200 || response.status >= 300)) {
			try {
				const data:unknown = await response.json();
				const value = data && typeof data === 'object' ? (data as Record<string,unknown>).reason : null;
				if (typeof value === 'string' && appleReasons.has(value)) reason = value;
			} catch { /* Keep a valid HTTP status when a provider sends an unreadable body. */ }
		}
		return { status:response.status, reason, provider };
	} catch { return { status:0, reason:'request_error', provider }; }
}

export async function notifyGroup(env: PushEnv, groupId: string, actorUserId: string, notice: Omit<Notice, 'groupId'>): Promise<void> {
	await queueGroupNotice(env, groupId, actorUserId, notice);
	await drainPushQueue(env);
}

export async function queueGroupNotice(env: PushEnv, groupId: string, actorUserId: string, notice: Omit<Notice, 'groupId'>, dedupeKey?: string): Promise<void> {
	await queueGroupInbox(env.DB,groupId,actorUserId,notice.kind,
		notice.targetPath || notificationPath(groupId),dedupeKey || crypto.randomUUID());
	if (!configured(env)) return;
	const now = new Date().toISOString();
	await env.DB.prepare(
		`INSERT OR IGNORE INTO push_deliveries (id, subscription_id, group_id, kind, body, created_at, next_attempt_at, scope, dedupe_key)
		 SELECT lower(hex(randomblob(16))), s.id, ?1, ?2, ?3, ?4, ?4, 'group', CASE WHEN ?6 IS NULL THEN NULL ELSE ?6 || ':' || s.id END
		 FROM push_subscriptions s JOIN group_members m ON m.user_id = s.user_id
		 WHERE m.group_id = ?1 AND s.user_id != ?5`,
	).bind(groupId, notice.kind, notice.body, now, actorUserId, dedupeKey || null).run();
}

export async function queueGroupUserNotice(env: PushEnv, groupId: string, recipientUserId: string, actorUserId: string,
	notice: Omit<Notice, 'groupId'>, dedupeKey: string): Promise<void> {
	if (recipientUserId === actorUserId) return;
	await queueGroupUserInbox(env.DB,groupId,recipientUserId,actorUserId,notice.kind,
		notice.targetPath || notificationPath(groupId),dedupeKey);
	if (!configured(env)) return;
	const now = new Date().toISOString();
	await env.DB.prepare(
		`INSERT OR IGNORE INTO push_deliveries (id, subscription_id, group_id, kind, body, created_at, next_attempt_at, scope, recipient_user_id, dedupe_key)
		 SELECT lower(hex(randomblob(16))), s.id, ?1, ?2, ?3, ?4, ?4, 'group', ?5, ?6 || ':' || s.id
		 FROM push_subscriptions s JOIN group_members m ON m.user_id = s.user_id
		 WHERE m.group_id = ?1 AND s.user_id = ?5 AND s.user_id != ?7`,
	).bind(groupId, notice.kind, notice.body, now, recipientUserId, dedupeKey, actorUserId).run();
}

export async function drainPushQueue(env: PushEnv): Promise<void> {
	if (!configured(env)) return;
	await env.DB.prepare(
		`DELETE FROM push_deliveries WHERE
		 (scope = 'group' AND NOT EXISTS (
		   SELECT 1 FROM push_subscriptions s JOIN group_members m ON m.user_id = s.user_id
		   WHERE s.id = push_deliveries.subscription_id AND m.group_id = push_deliveries.group_id
		     AND (push_deliveries.recipient_user_id IS NULL OR m.user_id = push_deliveries.recipient_user_id)))
		 OR (scope = 'personal' AND NOT EXISTS (
		   SELECT 1 FROM push_subscriptions s WHERE s.id = push_deliveries.subscription_id
		     AND s.user_id = push_deliveries.recipient_user_id))`,
	).run();
	const now = new Date().toISOString();
	const rows = await env.DB.prepare(
		`SELECT d.id AS delivery_id, d.group_id, d.scope, d.recipient_user_id, d.target_path, d.reminder_id, d.kind, d.body, d.attempts,
		 s.id, s.user_id, s.endpoint, s.p256dh, s.auth
		 FROM push_deliveries d JOIN push_subscriptions s ON s.id = d.subscription_id
		 WHERE d.next_attempt_at <= ?1 ORDER BY d.created_at, d.id LIMIT ?2`,
	).bind(now, BATCH_SIZE).all<Delivery>();
	await Promise.all((rows.results || []).map(async (item) => {
		const claimed = await env.DB.prepare('UPDATE push_deliveries SET next_attempt_at = ?1 WHERE id = ?2 AND next_attempt_at <= ?3')
			.bind(new Date(Date.now() + 5 * 60_000).toISOString(), item.delivery_id, now).run();
		if (!claimed.meta.changes) return;
		const result = await deliver(env, item, { groupId:item.group_id, targetPath:item.target_path || undefined, kind:item.kind, body:item.body });
		const { status } = result;
		if (status < 200 || status >= 300) console.warn('Push delivery attempt failed', {
			provider:result.provider, status, reason:result.reason, attempt:item.attempts + 1,
		});
		if (status === 404 || status === 410) {
			await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?1').bind(item.id).run();
		} else if ((status >= 200 && status < 300) || item.attempts >= 4) {
			await env.DB.prepare('DELETE FROM push_deliveries WHERE id = ?1').bind(item.delivery_id).run();
		} else {
			const delay = Math.min(3600, 60 * 2 ** item.attempts);
			await env.DB.prepare('UPDATE push_deliveries SET attempts = attempts + 1, next_attempt_at = ?1 WHERE id = ?2')
				.bind(new Date(Date.now() + delay * 1000).toISOString(), item.delivery_id).run();
		}
	}));
}

export async function handlePushRequest(request: Request, env: PushEnv, pathname: string, user: SessionUser): Promise<Response> {
	if (pathname === '/api/push/config') {
		if (request.method !== 'GET') return json({ error:'GETメソッドを使用してください' }, 405);
		if (!configured(env)) return json({ error:'通知はまだ設定されていません' }, 503);
		return json({ publicKey:env.VAPID_PUBLIC_KEY });
	}
	if (request.method !== 'POST') return json({ error:'POSTメソッドを使用してください' }, 405);
	const body = await readBody(request);
	if (!body || !validEndpoint(body.endpoint)) return json({ error:'通知端末の情報を確認してください' }, 400);
	if (pathname === '/api/push/status') {
		const row = await env.DB.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?1').bind(body.endpoint).first<{ user_id:string }>();
		return json({ enabled:row?.user_id === user.id });
	}
	if (pathname === '/api/push/unsubscribe') {
		await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1 AND user_id = ?2').bind(body.endpoint, user.id).run();
		return json({ ok:true });
	}
	if (pathname !== '/api/push/subscribe') return json({ error:'APIが見つかりません' }, 404);
	if (!configured(env)) return json({ error:'通知はまだ設定されていません' }, 503);
	if (!validKeys(body.p256dh, body.auth)) return json({ error:'通知端末の鍵を確認してください' }, 400);
	const now = new Date().toISOString();
	try {
		await env.DB.prepare(
			`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
			 ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at
			 WHERE push_subscriptions.user_id = excluded.user_id`,
		).bind(crypto.randomUUID(), user.id, body.endpoint, body.p256dh, body.auth, now).run();
		const owner = await env.DB.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?1').bind(body.endpoint).first<{ user_id:string }>();
		if (owner?.user_id !== user.id) return json({ error:'この端末の通知は別のアカウントに登録されています' }, 409);
		return json({ ok:true });
	} catch {
		console.error('Push subscription registration failed');
		return json({ error:'通知の登録に失敗しました' }, 500);
	}
}
