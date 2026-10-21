import type { SessionUser } from './auth';
import { drainPushQueue, queueGroupNotice, queueGroupUserNotice, type PushEnv } from './push';
import { notificationPath } from './notifications';

type Body = Record<string, unknown>;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' },
	});
}

function text(value: unknown, limit: number): string | null {
	return typeof value === 'string' && [...value.trim()].length <= limit ? value.trim() : null;
}

function validDate(value: unknown): value is string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validTime(value: unknown): value is string {
	return typeof value === 'string' && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
}

function wishInput(body: Body) {
	const wishDate = body.wishDate;
	const isAllDay = body.isAllDay;
	const message = body.message === undefined ? '' : text(body.message, 80);
	if (!validDate(wishDate) || typeof isAllDay !== 'boolean' || message === null) return null;
	const start = isAllDay ? '' : body.start;
	const end = isAllDay ? '' : body.end ?? '';
	if (!isAllDay && (!validTime(start) || (end !== '' && (!validTime(end) || end <= start)))) return null;
	return { wishDate, isAllDay, start, end, message };
}

async function isMember(db: D1Database, groupId: string, userId: string): Promise<boolean> {
	return Boolean(await db.prepare('SELECT 1 FROM group_members WHERE group_id = ?1 AND user_id = ?2')
		.bind(groupId, userId).first());
}

async function list(db: D1Database, groupId: string, user: SessionUser): Promise<Response> {
	const rows = await db.prepare(`SELECT w.id, w.group_id, w.user_id, w.wish_date, w.start_time, w.end_time,
		w.is_all_day, w.message, w.created_at, w.updated_at, u.display_name, u.profile_icon,
		e.id AS event_id, e.status AS event_status,
		(SELECT COUNT(*) FROM group_availability_reactions r WHERE r.wish_id = w.id) AS reaction_count,
		EXISTS(SELECT 1 FROM group_availability_reactions r WHERE r.wish_id = w.id AND r.user_id = ?2) AS reacted
		FROM group_availability_wishes w JOIN users u ON u.id = w.user_id
		LEFT JOIN shared_events e ON e.wish_id = w.id
		WHERE w.group_id = ?1 ORDER BY w.wish_date, w.created_at, w.id`)
		.bind(groupId, user.id).all<{
			id:string; group_id:string; user_id:string; wish_date:string; start_time:string; end_time:string;
			is_all_day:number; message:string; created_at:string; updated_at:string; display_name:string;
			profile_icon:string; reaction_count:number; reacted:number; event_id:string | null; event_status:string | null;
		}>();
	const interested = await db.prepare(`SELECT r.wish_id, r.user_id, u.display_name, u.profile_icon
		FROM group_availability_reactions r JOIN group_availability_wishes w ON w.id = r.wish_id
		JOIN users u ON u.id = r.user_id WHERE w.group_id = ?1 ORDER BY r.created_at, r.user_id`)
		.bind(groupId).all<{ wish_id:string; user_id:string; display_name:string; profile_icon:string }>();
	const byWish = new Map<string, { userId:string; displayName:string; profileIcon:string }[]>();
	for (const person of interested.results || []) {
		const people = byWish.get(person.wish_id) || [];
		people.push({ userId:person.user_id, displayName:person.display_name, profileIcon:person.profile_icon || '🌿' });
		byWish.set(person.wish_id, people);
	}
	return json({ wishes:(rows.results || []).map((row) => ({
		id:row.id, groupId:row.group_id, userId:row.user_id, wishDate:row.wish_date,
		start:row.start_time, end:row.end_time, isAllDay:Boolean(row.is_all_day), message:row.message,
		ownerName:row.display_name, ownerIcon:row.profile_icon || '🌿', isOwn:row.user_id === user.id,
		reactionCount:Number(row.reaction_count), reacted:Boolean(row.reacted),
		interestedUsers:[{ userId:row.user_id, displayName:row.display_name, profileIcon:row.profile_icon || '🌿' }, ...(byWish.get(row.id) || [])],
		participantCount:Number(row.reaction_count) + 1, eventId:row.event_id, eventStatus:row.event_status,
		participantsInsufficient:row.event_status === 'tentative' && !Number(row.reaction_count),
		createdAt:row.created_at, updatedAt:row.updated_at,
	})) });
}

async function queueWishNotice(env: PushEnv, ctx: ExecutionContext, queue: () => Promise<void>): Promise<void> {
	try {
		await queue();
		ctx.waitUntil(drainPushQueue(env));
	} catch (error) { console.error('Wish notification could not be queued', error); }
}

async function create(env: PushEnv, ctx: ExecutionContext, groupId: string, body: Body, user: SessionUser): Promise<Response> {
	const db = env.DB;
	const input = wishInput(body);
	const requestId = body.clientRequestId === undefined ? null : text(body.clientRequestId, 64);
	if (!input || (body.clientRequestId !== undefined && !requestId)) return json({ error:'遊びたい日の入力内容を確認してください' }, 400);
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const result = await db.prepare(`INSERT OR IGNORE INTO group_availability_wishes
		(id, group_id, user_id, wish_date, start_time, end_time, is_all_day, message, created_at, updated_at, client_request_id)
		VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)`)
		.bind(id, groupId, user.id, input.wishDate, input.start, input.end, Number(input.isAllDay), input.message, now, requestId).run();
	if (result.meta.changes) {
		await queueWishNotice(env, ctx, () => queueGroupNotice(env, groupId, user.id, {
			kind:'wish_created', body:'グループに新しい「遊びたい日」の募集が追加されました',
			targetPath:notificationPath(groupId,input.wishDate,undefined,id),
		}, 'wish-created:' + id));
		return json({ id }, 201);
	}
	if (requestId) {
		const existing = await db.prepare('SELECT id FROM group_availability_wishes WHERE group_id = ?1 AND user_id = ?2 AND client_request_id = ?3')
			.bind(groupId, user.id, requestId).first<{ id:string }>();
		if (existing) return json({ id:existing.id }, 200);
	}
	return json({ error:'募集を保存できませんでした。もう一度お試しください' }, 409);
}
async function update(db: D1Database, groupId: string, body: Body, user: SessionUser): Promise<Response> {
	const id = text(body.wishId, 64);
	const input = wishInput(body);
	if (!id || !input) return json({ error:'遊びたい日の入力内容を確認してください' }, 400);
	const result = await db.prepare(`UPDATE group_availability_wishes SET wish_date = ?1, start_time = ?2,
		end_time = ?3, is_all_day = ?4, message = ?5, updated_at = ?6
		WHERE id = ?7 AND group_id = ?8 AND user_id = ?9`)
		.bind(input.wishDate, input.start, input.end, Number(input.isAllDay), input.message,
			new Date().toISOString(), id, groupId, user.id).run();
	if (!result.meta.changes) return json({ error:'この遊びたい日を編集する権限がありません' }, 403);
	await db.prepare(`UPDATE shared_events SET title = ?1, event_date = ?2, starts_at = ?3, ends_at = ?4,
		all_day = ?5, updated_at = ?6 WHERE wish_id = ?7 AND status = 'tentative'`)
		.bind(input.message || 'みんなで遊ぶ', input.wishDate, input.start, input.end, Number(input.isAllDay), new Date().toISOString(), id).run();
	return json({ ok:true });
}

async function remove(db: D1Database, groupId: string, body: Body, user: SessionUser): Promise<Response> {
	const id = text(body.wishId, 64);
	if (!id) return json({ error:'遊びたい日を指定してください' }, 400);
	const owned = await db.prepare('SELECT 1 FROM group_availability_wishes WHERE id = ?1 AND group_id = ?2 AND user_id = ?3')
		.bind(id, groupId, user.id).first();
	if (!owned) return json({ error:'この遊びたい日を削除する権限がありません' }, 403);
	await db.prepare("DELETE FROM shared_events WHERE wish_id = ?1 AND status = 'tentative'").bind(id).run();
	const result = await db.prepare('DELETE FROM group_availability_wishes WHERE id = ?1 AND group_id = ?2 AND user_id = ?3')
		.bind(id, groupId, user.id).run();
	return result.meta.changes ? json({ ok:true }) : json({ error:'この遊びたい日を削除する権限がありません' }, 403);
}

async function reaction(env: PushEnv, ctx: ExecutionContext, groupId: string, body: Body, user: SessionUser, removeReaction: boolean): Promise<Response> {
	const db = env.DB;
	const id = text(body.wishId, 64);
	if (!id) return json({ error:'遊びたい日を指定してください' }, 400);
	const wish = await db.prepare('SELECT user_id FROM group_availability_wishes WHERE id = ?1 AND group_id = ?2')
		.bind(id, groupId).first<{ user_id:string }>();
	if (!wish) return json({ error:'遊びたい日が見つかりません' }, 404);
	if (wish.user_id === user.id) return json({ error:'自分の遊びたい日には反応できません' }, 400);
	if (removeReaction) {
		await db.prepare('DELETE FROM group_availability_reactions WHERE wish_id = ?1 AND user_id = ?2').bind(id, user.id).run();
	} else {
		const inserted = await db.prepare('INSERT OR IGNORE INTO group_availability_reactions (wish_id, user_id, created_at) VALUES (?1, ?2, ?3)')
			.bind(id, user.id, new Date().toISOString()).run();
		const count = await db.prepare('SELECT COUNT(*) AS n FROM group_availability_reactions WHERE wish_id = ?1')
			.bind(id).first<{ n:number }>();
		if (Number(count?.n) >= 1) {
			await db.prepare(`INSERT OR IGNORE INTO shared_events
				(id, group_id, created_by_member_id, title, event_date, starts_at, ends_at, all_day, note, created_at, updated_at, status, wish_id)
				SELECT ?1, w.group_id, m.id, COALESCE(NULLIF(w.message, ''), 'みんなで遊ぶ'), w.wish_date,
				w.start_time, w.end_time, w.is_all_day, '', ?2, ?2, 'tentative', w.id
				FROM group_availability_wishes w JOIN group_members m ON m.group_id = w.group_id AND m.user_id = w.user_id
				WHERE w.id = ?3 AND w.group_id = ?4`)
				.bind(crypto.randomUUID(), new Date().toISOString(), id, groupId).run();
		}
		if (inserted.meta.changes) {
			const owner = await db.prepare(`SELECT w.user_id, w.wish_date, u.display_name FROM group_availability_wishes w
				JOIN users u ON u.id = w.user_id WHERE w.id = ?1 AND w.group_id = ?2`)
				.bind(id, groupId).first<{ user_id:string; wish_date:string; display_name:string }>();
			if (owner && owner.user_id !== user.id && await isMember(db, groupId, owner.user_id)) {
				await queueWishNotice(env, ctx, () => queueGroupUserNotice(env, groupId, owner.user_id, user.id, {
					kind:'wish_interested', body:(user.displayName || 'メンバー') + 'さんがあなたの募集に「行きたい」と伝えています',
					targetPath:notificationPath(groupId,owner.wish_date,undefined,id),
				}, 'wish-interest:' + id + ':' + user.id));
			}
		}
	}
	return json({ ok:true });
}
async function confirm(db: D1Database, groupId: string, body: Body, user: SessionUser): Promise<Response> {
	const wishId = text(body.wishId, 64);
	const title = text(body.title, 80);
	const eventDate = body.eventDate;
	const allDay = body.allDay === true;
	const start = allDay ? '' : body.start;
	const end = allDay ? '' : body.end;
	const participantIds = body.participantUserIds;
	if (!wishId || !title || !validDate(eventDate) || (!allDay && (!validTime(start) || !validTime(end) || end <= start)) ||
		!Array.isArray(participantIds) || participantIds.length < 2 || participantIds.length > 100 ||
		participantIds.some((id) => typeof id !== 'string' || id.length > 64) || new Set(participantIds).size !== participantIds.length)
		return json({ error:'共有予定の内容と参加者を確認してください' }, 400);
	const wish = await db.prepare(`SELECT w.user_id, e.id AS event_id, e.status FROM group_availability_wishes w
		JOIN shared_events e ON e.wish_id = w.id WHERE w.id = ?1 AND w.group_id = ?2`)
		.bind(wishId, groupId).first<{ user_id:string; event_id:string; status:string }>();
	if (!wish || wish.user_id !== user.id || wish.status !== 'tentative') return json({ error:'この仮予定を確定する権限がありません' }, 403);
	const reactions = await db.prepare('SELECT user_id FROM group_availability_reactions WHERE wish_id = ?1')
		.bind(wishId).all<{ user_id:string }>();
	const interestedIds = new Set([user.id, ...(reactions.results || []).map((row) => row.user_id)]);
	if (interestedIds.size < 2) return json({ error:'参加者が不足しているため確定できません' }, 409);
	if (!participantIds.includes(user.id)) return json({ error:'作成者を参加者に含めてください' }, 400);
	if (participantIds.some((id) => !interestedIds.has(id))) return json({ error:'参加表明していないユーザーを選択できません' }, 400);
	const members = await db.prepare(`SELECT user_id FROM group_members WHERE group_id = ?1 AND user_id IN (${participantIds.map(() => '?').join(',')})`)
		.bind(groupId, ...participantIds).all<{ user_id:string }>();
	if ((members.results || []).length !== participantIds.length) return json({ error:'参加者にグループ外のユーザーが含まれています' }, 400);
	const now = new Date().toISOString();
	await db.batch([
		db.prepare(`UPDATE shared_events SET title = ?1, event_date = ?2, starts_at = ?3, ends_at = ?4,
			all_day = ?5, status = 'confirmed', updated_at = ?6 WHERE id = ?7 AND status = 'tentative'`)
			.bind(title, eventDate, start, end, Number(allDay), now, wish.event_id),
		...participantIds.map((id) => db.prepare('INSERT INTO shared_event_participants (event_id, user_id) VALUES (?1, ?2)').bind(wish.event_id, id)),
	]);
	return json({ ok:true, eventId:wish.event_id });
}

export async function handleWishRequest(env: PushEnv, ctx: ExecutionContext, pathname: string, body: Body, user: SessionUser): Promise<Response> {
	const db = env.DB;
	const groupId = text(body.groupId, 64);
	if (!groupId || !await isMember(db, groupId, user.id)) return json({ error:'グループへの参加情報を確認できません' }, 401);
	switch (pathname) {
		case '/api/groups/wishes/list': return list(db, groupId, user);
		case '/api/groups/wishes/create': return create(env, ctx, groupId, body, user);
		case '/api/groups/wishes/update': return update(db, groupId, body, user);
		case '/api/groups/wishes/delete': return remove(db, groupId, body, user);
		case '/api/groups/wishes/react': return reaction(env, ctx, groupId, body, user, false);
		case '/api/groups/wishes/unreact': return reaction(env, ctx, groupId, body, user, true);
		case '/api/groups/wishes/confirm': return confirm(db, groupId, body, user);
		default: return json({ error:'APIが見つかりません' }, 404);
	}
}
