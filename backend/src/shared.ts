import { canManageSharedEventSql } from './group-permissions';
import type { SessionUser } from './auth';
import { drainPushQueue, queueGroupNotice, type PushEnv } from './push';
import { handleWishRequest } from './wishes';
import { handleScheduleRequest } from './schedules';
import { queueScheduleNotice } from './schedule-notices';
import { sharedReminderRefreshStatements } from './reminders';
import { notificationPath } from './notifications';
import { candidateSlots, combineBusyDays, formatMinute, freeIntervals, loadAvailabilityDays, loadBusyDays, nextDate, rankAvailability, unconfirmedByMonth } from './availability';

type SharedEnv = PushEnv;

async function scheduleNotice(env: SharedEnv, ctx: ExecutionContext, groupId: string, userId: string,
	kind: 'group_event_created' | 'group_event_updated' | 'group_joined', body: string,
	dedupeKey = crypto.randomUUID(), targetPath = notificationPath(groupId)) {
	try {
		await queueGroupNotice(env, groupId, userId, { kind, body, targetPath }, dedupeKey);
		ctx.waitUntil(drainPushQueue(env));
	} catch (error) { console.warn('Could not queue group notification', error); }
}

type JsonRecord = Record<string, unknown>;

const GROUP_ICON_IDS = new Set(['friends', 'university', 'work', 'club', 'game', 'food', 'karaoke', 'bowling', 'travel', 'sports', 'study', 'other']);
const GROUP_ICON_COLOR_IDS = new Set(['green', 'blue', 'lightblue', 'purple', 'pink', 'orange', 'gray']);

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control':'no-store' },
	});
}

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, maxLength: number): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function validDate(value: unknown): value is string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTime(value: unknown): value is string {
	return typeof value === 'string' && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
}

function token(prefix = ''): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return `${prefix}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function readBody(request: Request): Promise<JsonRecord | null> {
	try {
		const body: unknown = await request.json();
		return isRecord(body) ? body : null;
	} catch {
		return null;
	}
}

type MemberRow = {
	member_id: string;
	group_id: string;
	group_name: string;
	display_name: string;
};

async function requireMembership(db: D1Database, body: JsonRecord, user: SessionUser): Promise<MemberRow | null> {
	const groupId = stringValue(body.groupId, 64);
	if (!groupId) return null;
	return db.prepare(
		`SELECT m.id AS member_id, m.group_id, g.name AS group_name, m.display_name
		 FROM active_group_members m JOIN groups g ON g.id = m.group_id
		 WHERE m.group_id = ?1 AND m.user_id = ?2`,
	).bind(groupId, user.id).first<MemberRow>();
}

function membershipResponse(groupId: string, groupName: string, inviteCode: string, memberId: string, memberName: string,
	groupIcon = 'friends', groupIconColor = 'green') {
	return { membership: { groupId, groupName, inviteCode, memberId, memberName, groupIcon, groupIconColor } };
}

async function createGroup(db: D1Database, body: JsonRecord, user: SessionUser): Promise<Response> {
	const name = stringValue(body.name, 60);
	const memberName = stringValue(body.memberName, 40) || user.displayName;
	if (!name || !memberName) return jsonResponse({ error: 'グループ名と表示名を入力してください' }, 400);
	const groupId = crypto.randomUUID();
	const memberId = crypto.randomUUID();
	const inviteCode = token('MP-').toUpperCase();
	const memberToken = token();
	const createdAt = new Date().toISOString();
	await db.batch([
		db.prepare('INSERT INTO groups (id, name, invite_code, created_at, group_icon, group_icon_color) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(groupId, name, inviteCode, createdAt, 'friends', 'green'),
		db.prepare('INSERT INTO group_members (id, group_id, display_name, access_token, created_at, user_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(memberId, groupId, memberName, memberToken, createdAt, user.id),
	]);
	return jsonResponse(membershipResponse(groupId, name, inviteCode, memberId, memberName), 201);
}

async function renameGroup(db: D1Database, body: JsonRecord, user: SessionUser): Promise<Response> {
	const member = await requireMembership(db, body, user);
	if (!member) return jsonResponse({ error:'グループが見つからないか、変更する権限がありません' }, 404);
	const name = stringValue(body.name, 60);
	if (!name) return jsonResponse({ error:'グループ名は1〜60文字で入力してください' }, 400);
	await db.prepare('UPDATE groups SET name = ?1, management_version=management_version+1 WHERE id = ?2 AND EXISTS(SELECT 1 FROM active_group_members WHERE id=?3 AND group_id=?2)').bind(name, member.group_id, member.member_id).run();
	return jsonResponse({ ok:true, groupName:name });
}

async function updateGroupIcon(db: D1Database, body: JsonRecord, user: SessionUser): Promise<Response> {
	const member = await requireMembership(db, body, user);
	if (!member) return jsonResponse({ error:'\u30b0\u30eb\u30fc\u30d7\u304c\u898b\u3064\u304b\u3089\u306a\u3044\u304b\u3001\u5909\u66f4\u3059\u308b\u6a29\u9650\u304c\u3042\u308a\u307e\u305b\u3093' }, 404);
	const groupIcon = stringValue(body.groupIcon, 32);
	const groupIconColor = stringValue(body.groupIconColor, 32);
	if (!groupIcon || !GROUP_ICON_IDS.has(groupIcon) || !groupIconColor || !GROUP_ICON_COLOR_IDS.has(groupIconColor)) {
		return jsonResponse({ error:'\u30b0\u30eb\u30fc\u30d7\u30a2\u30a4\u30b3\u30f3\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044' }, 400);
	}
	await db.prepare('UPDATE groups SET group_icon = ?1, group_icon_color = ?2, management_version=management_version+1 WHERE id = ?3 AND EXISTS(SELECT 1 FROM active_group_members WHERE id=?4 AND group_id=?3)')
		.bind(groupIcon, groupIconColor, member.group_id, member.member_id).run();
	return jsonResponse({ ok:true, groupIcon, groupIconColor });
}

async function joinGroup(env: SharedEnv, ctx: ExecutionContext, body: JsonRecord, user: SessionUser): Promise<Response> {
	const db = env.DB;
	const inviteCode = stringValue(body.inviteCode, 40)?.toUpperCase();
	const memberName = stringValue(body.memberName, 40) || user.displayName;
	if (!inviteCode || !memberName) return jsonResponse({ error: '招待コードと表示名を入力してください' }, 400);
	const group = await db.prepare('SELECT id, name, invite_code, group_icon, group_icon_color FROM groups WHERE invite_code = ?1').bind(inviteCode)
		.first<{ id: string; name: string; invite_code: string; group_icon:string; group_icon_color:string }>();
	if (!group) return jsonResponse({ error: '招待コードが見つかりません' }, 404);
	const existing = await db.prepare('SELECT id, display_name FROM active_group_members WHERE group_id = ?1 AND user_id = ?2').bind(group.id, user.id).first<{ id:string; display_name:string }>();
	if (existing) return jsonResponse(membershipResponse(group.id, group.name, group.invite_code, existing.id, existing.display_name, group.group_icon || 'friends', group.group_icon_color || 'green'));
	const memberId = crypto.randomUUID();
	const memberToken = token();
	await db.prepare('INSERT INTO group_members (id, group_id, display_name, access_token, created_at, user_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)').bind(memberId, group.id, memberName, memberToken, new Date().toISOString(), user.id).run();
	await scheduleNotice(env, ctx, group.id, user.id, 'group_joined', `「${group.name}」に${memberName}さんが参加しました`,
		'group-joined:'+memberId);
	return jsonResponse(membershipResponse(group.id, group.name, group.invite_code, memberId, memberName, group.group_icon || 'friends', group.group_icon_color || 'green'), 201);
}

async function mine(db: D1Database, user: SessionUser): Promise<Response> {
	const rows = await db.prepare(`SELECT m.id AS member_id, m.display_name, g.id AS group_id, g.name, g.invite_code, g.group_icon, g.group_icon_color
		FROM active_group_members m JOIN groups g ON g.id = m.group_id WHERE m.user_id = ?1 ORDER BY m.created_at, m.id`)
		.bind(user.id).all<{ member_id:string; display_name:string; group_id:string; name:string; invite_code:string; group_icon:string; group_icon_color:string }>();
	return jsonResponse({ groups:(rows.results || []).map((row) => ({ groupId:row.group_id, groupName:row.name, inviteCode:row.invite_code, memberId:row.member_id, memberName:row.display_name,
		groupIcon:row.group_icon || 'friends', groupIconColor:row.group_icon_color || 'green' })) });
}

async function claimLegacyMembership(db: D1Database, body: JsonRecord, user: SessionUser): Promise<Response> {
	const groupId = stringValue(body.groupId, 64);
	const memberId = stringValue(body.memberId, 64);
	const memberToken = stringValue(body.memberToken, 80);
	if (!groupId || !memberId || !memberToken) return jsonResponse({ error:'参加情報を確認してください' }, 400);
	const current = await db.prepare('SELECT user_id FROM active_group_members WHERE id = ?1 AND group_id = ?2 AND access_token = ?3')
		.bind(memberId, groupId, memberToken).first<{ user_id:string | null }>();
	if (!current || (current.user_id && current.user_id !== user.id)) return jsonResponse({ error:'このグループの参加情報を引き継げませんでした' }, 403);
	if (current.user_id === user.id) return mine(db, user);
	const result = await db.prepare('UPDATE group_members SET user_id = ?1 WHERE id = ?2 AND group_id = ?3 AND access_token = ?4 AND user_id IS NULL AND left_at IS NULL')
		.bind(user.id, memberId, groupId, memberToken).run();
	if (!result.meta.changes) return jsonResponse({ error:'このグループの参加情報を引き継げませんでした' }, 403);
	return mine(db, user);
}

async function listGroupMembers(db: D1Database, body: JsonRecord, user: SessionUser): Promise<Response> {
	const member = await requireMembership(db, body, user);
	if (!member) return jsonResponse({ error: 'グループへの参加情報を確認できません' }, 401);
	const result = await db.prepare(
		`SELECT m.id AS member_id, COALESCE(u.display_name, m.display_name) AS display_name,
		 m.user_id, COALESCE(u.profile_icon, '🌿') AS profile_icon,
		 CASE WHEN u.status_expires_at > ?2 THEN u.status_message ELSE '' END AS status_message,
		 CASE WHEN u.status_expires_at > ?2 THEN u.status_expires_at ELSE NULL END AS status_expires_at
		 FROM active_group_members m LEFT JOIN users u ON u.id = m.user_id
		 WHERE m.group_id = ?1
		 ORDER BY m.created_at, m.id`,
	).bind(member.group_id, new Date().toISOString()).all<{ member_id: string; display_name: string; user_id:string | null; profile_icon:string; status_message:string; status_expires_at:string | null }>();
	return jsonResponse({ members:(result.results || []).map((item) => ({ memberId:item.member_id, memberName:item.display_name,
		userId:item.user_id, profileIcon:item.profile_icon, statusMessage:item.status_message || '', statusExpiresAt:item.status_expires_at })) });
}

async function leaveGroup(env:SharedEnv,ctx:ExecutionContext, body: JsonRecord, user: SessionUser): Promise<Response> {
	const db=env.DB;
	const member = await requireMembership(db, body, user);
	if (!member) return jsonResponse({ error:'グループへの参加情報を確認できません' }, 401);
	const choice = body.exitChoice === 'close' || body.exitChoice === 'transfer' ? body.exitChoice : '';
	const successor = choice === 'transfer' && typeof body.successorUserId === 'string' ? body.successorUserId : '';
	if (choice === 'transfer' && (!successor || successor === user.id))
		return jsonResponse({ error:'引き継ぎ先のメンバーを選んでください' }, 400);
	const memberCount = await db.prepare(`SELECT COUNT(*) AS count FROM active_group_members
		WHERE group_id=?1 AND user_id IS NOT NULL`).bind(member.group_id).first<{count:number}>();
	if (Number(memberCount?.count) <= 1)
		return jsonResponse({ error:'最後のメンバーは現在退出できません。グループの扱いが決まるまでお待ちください。',code:'LEAVE_REQUIRES_REVIEW' },409);
	const unrelatedTentative=await db.prepare(`SELECT 1 FROM shared_events WHERE group_id=?1 AND created_by_member_id=?2
		AND status='tentative' AND wish_id IS NULL AND cancelled_at IS NULL LIMIT 1`)
		.bind(member.group_id,member.member_id).first();
	if(unrelatedTentative) return jsonResponse({error:'あなたが作成した仮予定があるため退出できません。仮予定は削除されていません。',code:'LEAVE_REQUIRES_REVIEW'},409);
	const open = await db.prepare(`SELECT
		(SELECT COUNT(*) FROM group_availability_wishes WHERE group_id=?1 AND manager_member_id=?2 AND management_state='open') AS wishes,
		(SELECT COUNT(*) FROM group_schedules WHERE group_id=?1 AND manager_member_id=?2 AND state='open') AS schedules`)
		.bind(member.group_id,member.member_id).first<{wishes:number;schedules:number}>();
	if (!choice && (Number(open?.wishes) || Number(open?.schedules)))
		return jsonResponse({ error:Number(open?.wishes)>0
			? '募集があるため退出には終了か他のメンバーへの引き継ぎを選んでください。'
			: '進行中の日程調整があります。終了か他のメンバーへの引き継ぎを選んでください。',
			code:'LEAVE_REQUIRES_CHOICE',wishes:Number(open?.wishes),schedules:Number(open?.schedules) },409);
	const managedPlans=choice ? await db.prepare(`SELECT id FROM group_schedules
		WHERE group_id=?1 AND manager_member_id=?2 AND state='open'`)
		.bind(member.group_id,member.member_id).all<{id:string}>() : null;
	const timestamp = new Date().toISOString();
	const nonce = crypto.randomUUID();
	// The eligibility check and revocation run in one D1 batch transaction.
	// In particular, two simultaneous departures cannot remove the last member.
	const departed = 'EXISTS (SELECT 1 FROM group_members WHERE id=?3 AND group_id=?2 AND departed_user_id=?1 AND user_id IS NULL AND left_at=?4)';
	const binds = [user.id, member.group_id, member.member_id, timestamp, choice, successor];
	let results: D1Result[];
	try { results = await db.batch([
		db.prepare(`UPDATE group_members SET departed_user_id=user_id, user_id=NULL, left_at=?4, access_token=lower(hex(randomblob(32)))
			WHERE user_id=?1 AND group_id=?2 AND id=?3 AND left_at IS NULL
			AND EXISTS (SELECT 1 FROM active_group_members other WHERE other.group_id=?2 AND other.id<>?3 AND other.user_id IS NOT NULL)
			AND NOT EXISTS (SELECT 1 FROM shared_events WHERE group_id=?2 AND created_by_member_id=?3 AND status='tentative'
			  AND cancelled_at IS NULL AND wish_id IS NULL)
			AND (?5 IN ('close','transfer') OR (NOT EXISTS
			  (SELECT 1 FROM group_availability_wishes WHERE group_id=?2 AND manager_member_id=?3 AND management_state='open')
			  AND NOT EXISTS (SELECT 1 FROM group_schedules WHERE group_id=?2 AND manager_member_id=?3 AND state='open')))
			AND (?5!='transfer' OR EXISTS (SELECT 1 FROM active_group_members other
			  WHERE other.group_id=?2 AND other.user_id=?6 AND other.id<>?3))`).bind(...binds),
		db.prepare(`UPDATE group_availability_wishes SET manager_member_id=(SELECT id FROM active_group_members
			WHERE group_id=?2 AND user_id=?6), management_version=management_version+1, updated_at=?4
			WHERE group_id=?2 AND manager_member_id=?3 AND management_state='open' AND ?5='transfer' AND ${departed}`)
			.bind(...binds),
		db.prepare(`UPDATE group_schedules SET manager_member_id=(SELECT id FROM active_group_members
			WHERE group_id=?2 AND user_id=?6), version=version+1,updated_at=?4
			WHERE group_id=?2 AND manager_member_id=?3 AND state='open' AND ?5='transfer' AND ${departed}`)
			.bind(...binds),
		db.prepare(`UPDATE group_availability_wishes SET management_state='closed',management_version=management_version+1,
			updated_at=?4 WHERE group_id=?2 AND manager_member_id=?3 AND management_state='open' AND ?5='close' AND ${departed}`)
			.bind(...binds.slice(0,5)),
		db.prepare(`UPDATE group_schedules SET state='cancelled',version=version+1,updated_at=?4
			WHERE group_id=?2 AND manager_member_id=?3 AND state='open' AND ?5='close' AND ${departed}`)
			.bind(...binds.slice(0,5)),
		db.prepare(`UPDATE shared_events SET cancelled_at=?4,management_version=management_version+1,updated_at=?4
			WHERE group_id=?2 AND status='tentative' AND cancelled_at IS NULL AND wish_id IN
			(SELECT id FROM group_availability_wishes WHERE group_id=?2 AND manager_member_id=?3
			AND management_state='closed') AND ?5='close' AND ${departed}`).bind(...binds.slice(0,5)),
		db.prepare(`UPDATE group_availability_reactions SET revoked_at=?4 WHERE user_id=?1 AND revoked_at IS NULL
			AND wish_id IN (SELECT id FROM group_availability_wishes WHERE group_id=?2) AND ${departed}`).bind(...binds.slice(0,4)),
		db.prepare(`UPDATE shared_event_participants SET revoked_at=?4 WHERE user_id=?1 AND revoked_at IS NULL
			AND event_id IN (SELECT id FROM shared_events WHERE group_id=?2) AND ${departed}`).bind(...binds.slice(0,4)),
		db.prepare(`UPDATE in_app_notifications SET revoked_at=?4 WHERE user_id=?1 AND group_id=?2 AND revoked_at IS NULL
			AND ${departed}`).bind(...binds.slice(0,4)),
		db.prepare(`DELETE FROM push_deliveries WHERE scope='group' AND group_id=?2
			AND (recipient_user_id=?1 OR subscription_id IN (SELECT id FROM push_subscriptions WHERE user_id=?1))
			AND ${departed}`).bind(...binds.slice(0,4)),
		db.prepare(`DELETE FROM event_reminders WHERE scope='shared' AND user_id=?1 AND group_id=?2 AND ${departed}`).bind(...binds.slice(0,4)),
		db.prepare(`INSERT INTO group_departure_assertions(nonce,valid) VALUES(?7, CASE WHEN ${departed}
			AND NOT EXISTS (SELECT 1 FROM group_availability_wishes WHERE group_id=?2 AND manager_member_id=?3 AND management_state='open')
			AND NOT EXISTS (SELECT 1 FROM group_schedules WHERE group_id=?2 AND manager_member_id=?3 AND state='open')
			THEN 1 ELSE 0 END)`).bind(...binds,nonce),
		db.prepare('DELETE FROM group_departure_assertions WHERE nonce=?1').bind(nonce),
	]); } catch {
		const active=await db.prepare(`SELECT COUNT(*) AS count FROM active_group_members
			WHERE group_id=?1 AND user_id IS NOT NULL`).bind(member.group_id).first<{count:number}>();
		if(Number(active?.count)<=1) return jsonResponse({error:'最後のメンバーは現在退出できません。',code:'LEAVE_REQUIRES_REVIEW'},409);
		return jsonResponse({error:'退出条件が変わりました。グループ情報を更新してから再試行してください。',code:'LEAVE_REQUIRES_REVIEW'},409);
	}
	if (!results[0].meta.changes) {
		const reason = await db.prepare(`SELECT
			(SELECT COUNT(*) FROM active_group_members WHERE group_id=?1 AND user_id IS NOT NULL) AS members,
			(SELECT COUNT(*) FROM group_availability_wishes WHERE group_id=?1 AND user_id=?2) AS wishes,
			(SELECT COUNT(*) FROM shared_events WHERE group_id=?1 AND created_by_member_id=?3 AND status='tentative') AS tentative`)
			.bind(member.group_id, user.id, member.member_id).first<{members:number;wishes:number;tentative:number}>();
		const error = !reason || reason.members <= 1
			? '最後のメンバーは現在退出できません。グループの扱いが決まるまでお待ちください。'
			: reason.wishes > 0
				? 'あなたが作成した募集があるため退出できません。募集は削除されていません。'
				: reason.tentative > 0
					? 'あなたが作成した仮予定があるため退出できません。仮予定は削除されていません。'
					: '退出条件を確認できませんでした。グループ情報を更新してください。';
		return jsonResponse({ error, code:'LEAVE_REQUIRES_REVIEW' }, 409);
	}
	for(const plan of managedPlans?.results||[]) try {
		const recipients=choice==='transfer' ? [successor] :
			(await db.prepare(`SELECT m.user_id FROM group_schedule_participants p JOIN active_group_members m
			ON m.id=p.member_id AND m.group_id=?2 WHERE p.schedule_id=?1`)
			.bind(plan.id,member.group_id).all<{user_id:string}>()).results.map(row=>row.user_id);
		await queueScheduleNotice(env,member.group_id,plan.id,recipients,
			choice==='transfer'?'schedule_changed':'schedule_cancelled',`schedule-leave:${choice}:${plan.id}:${member.member_id}`);
		ctx.waitUntil(drainPushQueue(env));
	} catch { console.warn('Group departure notice could not be queued'); }
	return jsonResponse({ ok:true });
}

async function leaveOptions(db:D1Database,body:JsonRecord,user:SessionUser):Promise<Response> {
	const member=await requireMembership(db,body,user);
	if(!member) return jsonResponse({error:'グループへの参加情報を確認できません'},401);
	const work=await db.prepare(`SELECT
		(SELECT COUNT(*) FROM group_availability_wishes WHERE group_id=?1 AND manager_member_id=?2 AND management_state='open') AS wishes,
		(SELECT COUNT(*) FROM group_schedules WHERE group_id=?1 AND manager_member_id=?2 AND state='open') AS schedules,
		(SELECT COUNT(*) FROM shared_events WHERE group_id=?1 AND created_by_member_id=?2
		  AND status='tentative' AND cancelled_at IS NULL AND wish_id IS NULL) AS other_tentative`)
		.bind(member.group_id,member.member_id).first<{wishes:number;schedules:number;other_tentative:number}>();
	const others=await db.prepare(`SELECT m.user_id,COALESCE(u.display_name,m.display_name) AS display_name
		FROM active_group_members m LEFT JOIN users u ON u.id=m.user_id
		WHERE m.group_id=?1 AND m.user_id IS NOT NULL AND m.id<>?2 ORDER BY m.created_at,m.id`)
		.bind(member.group_id,member.member_id).all<{user_id:string;display_name:string}>();
	return jsonResponse({wishes:Number(work?.wishes||0),schedules:Number(work?.schedules||0),
		otherTentative:Number(work?.other_tentative||0),
		successors:others.results.map(row=>({userId:row.user_id,name:row.display_name}))});
}

async function listEvents(db: D1Database, body: JsonRecord, user: SessionUser): Promise<Response> {
	const member = await requireMembership(db, body, user);
	const month = stringValue(body.month, 7);
	if (!member) return jsonResponse({ error: 'グループへの参加情報を確認できません' }, 401);
	if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return jsonResponse({ error: '対象月を指定してください' }, 400);
	const rows = await db.prepare(
		`SELECT e.id, e.title, e.event_date, e.starts_at, e.ends_at, e.all_day, e.note, e.status, e.wish_id,
		        e.created_by_member_id, m.user_id AS created_by_user_id, m.left_at AS creator_left_at,
		        CASE WHEN m.left_at IS NOT NULL THEN m.display_name ELSE COALESCE(u.display_name, m.display_name) END AS created_by_name
		 FROM shared_events e JOIN group_members m ON m.id = e.created_by_member_id
		 LEFT JOIN users u ON u.id = m.user_id
		 WHERE e.group_id = ?1 AND e.event_date >= ?2 AND e.event_date < ?3 AND e.cancelled_at IS NULL
		 ORDER BY e.event_date, e.all_day DESC, e.starts_at, e.created_at`,
	).bind(member.group_id, `${month}-01`, `${month}-32`).all<{
		id: string; title: string; event_date: string; starts_at: string; ends_at: string; all_day: number; note: string; status:string; wish_id:string | null; created_by_member_id: string; created_by_user_id:string | null; created_by_name: string; creator_left_at: string | null;
	}>();
	const otherBusy = await db.prepare(`SELECT DISTINCT e.id, e.event_date, e.starts_at, e.ends_at, e.all_day
		 FROM shared_events e JOIN group_members creator ON creator.id = e.created_by_member_id
		WHERE e.group_id <> ?1 AND e.event_date >= ?2 AND e.event_date < ?3 AND e.cancelled_at IS NULL
		AND EXISTS (SELECT 1 FROM active_group_members viewer_member
			WHERE viewer_member.group_id = ?1 AND viewer_member.user_id IS NOT NULL AND
			((creator.left_at IS NULL AND viewer_member.user_id = creator.user_id) OR EXISTS
				(SELECT 1 FROM shared_event_participants p WHERE p.event_id = e.id AND p.user_id = viewer_member.user_id AND p.revoked_at IS NULL)))
		ORDER BY e.event_date, e.starts_at`)
		.bind(member.group_id, `${month}-01`, `${month}-32`).all<{
			id:string; event_date:string; starts_at:string; ends_at:string; all_day:number;
		}>();
	const automatic = await db.prepare(
		`SELECT e.source_type, e.source_id, e.title, e.event_date, e.starts_at, e.ends_at, e.all_day, e.note,
		        e.member_id, m.user_id, COALESCE(u.display_name, m.display_name) AS member_name
		 FROM member_calendar_entries e JOIN active_group_members m ON m.id = e.member_id
		 LEFT JOIN users u ON u.id = m.user_id
		 WHERE e.group_id = ?1 AND e.event_date >= ?2 AND e.event_date < ?3
		 AND (e.source_type <> 'personal' OR NOT EXISTS (SELECT 1 FROM personal_sync_users s WHERE s.user_id = m.user_id))
		 ORDER BY e.event_date, e.all_day DESC, e.starts_at`,
	).bind(member.group_id, `${month}-01`, `${month}-32`).all<{
		source_type: string; source_id: string; title: string; event_date: string; starts_at: string; ends_at: string; all_day: number; note: string; member_id: string; user_id:string | null; member_name: string;
	}>();
	const legacyEvents = (rows.results || []).map((event) => ({
		id:event.id, title:event.title, eventDate:event.event_date, start:event.starts_at, end:event.ends_at,
		allDay:Boolean(event.all_day), note:event.note, createdByMemberId:event.created_by_member_id,
		createdByUserId:event.created_by_user_id, createdByName:event.created_by_name, sourceType:'shared',
		status:event.status, wishId:event.wish_id,
		creatorLeft:Boolean(event.creator_left_at),
		canManage:event.created_by_member_id === member.member_id || (Boolean(event.creator_left_at) && event.status === 'confirmed'),
	}));
	const automaticEvents = (automatic.results || []).map((event) => {
		if (event.user_id !== user.id) return {
			id:`busy:${crypto.randomUUID()}`, title:'\u4e88\u5b9a\u3042\u308a', eventDate:event.event_date,
			start:event.starts_at, end:event.ends_at, allDay:Boolean(event.all_day), sourceType:'busy',
		};
		return {
			id:`${event.member_id}:${event.source_type}:${event.source_id}`, title:event.title, eventDate:event.event_date,
			start:event.starts_at, end:event.ends_at, allDay:Boolean(event.all_day), note:event.note,
			createdByMemberId:event.member_id, createdByUserId:event.user_id,
			createdByName:event.member_name, sourceType:event.source_type,
		};
	});
	const redacted = (otherBusy.results || []).map((event) => ({
		id:`busy:${crypto.randomUUID()}`, title:'予定あり', eventDate:event.event_date, start:event.starts_at,
		end:event.ends_at, allDay:Boolean(event.all_day), sourceType:'busy',
	}));
	const personal = await db.prepare(`SELECT e.event_date,e.starts_at,e.ends_at,e.all_day,
		CASE WHEN e.user_id=?4 THEN 1 ELSE 0 END AS owned,
		CASE WHEN e.user_id=?4 THEN e.id ELSE NULL END AS id,
		CASE WHEN e.user_id=?4 THEN e.title ELSE NULL END AS title,
		CASE WHEN e.user_id=?4 THEN e.note ELSE NULL END AS note,
		CASE WHEN e.user_id=?4 THEN m.id ELSE NULL END AS member_id,
		CASE WHEN e.user_id=?4 THEN u.display_name ELSE NULL END AS display_name
		FROM personal_events e
		JOIN personal_sync_users s ON s.user_id=e.user_id JOIN active_group_members m ON m.user_id=e.user_id
		JOIN users u ON u.id=e.user_id WHERE m.group_id=?1 AND e.deleted=0 AND e.event_date>=?2 AND e.event_date<?3`)
		.bind(member.group_id, `${month}-01`, `${month}-32`, user.id).all<{
			id:string | null; owned:number; event_date:string; title:string | null; starts_at:string; ends_at:string; all_day:number; note:string | null; member_id:string | null; display_name:string | null;
		}>();
	const personalEvents = personal.results.map(event => event.owned ? {
		id:`personal:${event.id}`,title:event.title,eventDate:event.event_date,start:event.starts_at,end:event.ends_at,
		allDay:Boolean(event.all_day),note:event.note,createdByMemberId:event.member_id,createdByUserId:user.id,createdByName:event.display_name,sourceType:'personal',
	} : {id:`busy:${crypto.randomUUID()}`,title:'予定あり',eventDate:event.event_date,start:event.starts_at,end:event.ends_at,allDay:Boolean(event.all_day),sourceType:'busy'});
	return jsonResponse({ events:[...legacyEvents, ...automaticEvents, ...personalEvents, ...redacted].sort((a, b) =>
		a.eventDate.localeCompare(b.eventDate) || Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start),
	) });
}

async function availability(db: D1Database, body: JsonRecord, user: SessionUser): Promise<Response> {
	const member = await requireMembership(db, body, user);
	const targetUserId = stringValue(body.userId, 64);
	const date = body.date;
	if (!member) return jsonResponse({ error:'グループへの参加情報を確認できません' }, 401);
	if (!targetUserId || !validDate(date)) return jsonResponse({ error:'日付とメンバーを指定してください' }, 400);
	const target = await db.prepare('SELECT 1 FROM active_group_members WHERE group_id = ?1 AND user_id = ?2')
		.bind(member.group_id, targetUserId).first();
	if (!target) return jsonResponse({ error:'グループ外のメンバーは確認できません' }, 403);
	const busy=(await loadBusyDays(db,member.group_id,[targetUserId],date,date)).get(targetUserId)?.get(date) || [];
	return jsonResponse({ date, busy:busy.map(([start,end])=>({start:formatMinute(start),end:formatMinute(end),label:'予定あり'})),
		free:freeIntervals(busy).map(([start,end])=>({start:formatMinute(start),end:formatMinute(end)})) });
}

async function searchAvailability(db:D1Database, body:JsonRecord, user:SessionUser):Promise<Response> {
	const member=await requireMembership(db,body,user);
	if (!member) return jsonResponse({error:'グループへの参加情報を確認できません'},401);
	const rawIds=body.userIds;
	const first=body.startDate, last=body.endDate, duration=body.durationMinutes;
	const minimum=body.minimumParticipants===undefined ? rawIds instanceof Array ? rawIds.length : 0 : body.minimumParticipants;
	if (!Array.isArray(rawIds) || rawIds.length<2 || rawIds.length>20 ||
		rawIds.some(id=>!stringValue(id,64)) || new Set(rawIds).size!==rawIds.length ||
		!validDate(first) || !validDate(last) || first>last ||
		(Date.parse(last+'T00:00:00Z')-Date.parse(first+'T00:00:00Z'))/86400000>13 ||
		!Number.isInteger(duration) || (duration as number)<60 || (duration as number)>360 || (duration as number)%30!==0 ||
		!Number.isInteger(minimum) || (minimum as number)<1 || (minimum as number)>rawIds.length)
		return jsonResponse({error:'2人以上のメンバー、14日以内の期間、1〜6時間を30分単位で指定してください'},400);
	const userIds=rawIds as string[];
	const selected=await db.prepare(`SELECT user_id,id FROM active_group_members WHERE group_id=? AND user_id IN (${userIds.map(()=>'?').join(',')})`)
		.bind(member.group_id,...userIds).all<{user_id:string;id:string}>();
	if (selected.results.length!==userIds.length) return jsonResponse({error:'グループ外または退出済みのメンバーは選択できません'},403);
	const memberIds=new Map(selected.results.map(row=>[row.user_id,row.id]));
	const months=[...new Set(Array.from({length:14},(_,i)=>nextDate(first,i)).filter(date=>date<=last)
		.flatMap(date=>[date.slice(0,7),nextDate(date,-1).slice(0,7)]))];
	const [availability,unconfirmed]=await Promise.all([
		loadAvailabilityDays(db,member.group_id,userIds,first,last),
		unconfirmedByMonth(db,member.group_id,memberIds,months),
	]);
	const busy=combineBusyDays(availability);
	// A selected member can leave while the range queries run. Never turn the
	// missing rows into an apparently free slot, or answer a departed requester.
	const current=await db.prepare(`SELECT user_id,id FROM active_group_members WHERE group_id=? AND user_id IN (${userIds.map(()=>'?').join(',')})`)
		.bind(member.group_id,...userIds).all<{user_id:string;id:string}>();
	if (current.results.length!==userIds.length || current.results.some(row=>memberIds.get(row.user_id)!==row.id) ||
		!(await db.prepare('SELECT 1 FROM active_group_members WHERE id=? AND group_id=? AND user_id=?')
			.bind(member.member_id,member.group_id,user.id).first()))
		return jsonResponse({error:'検索中にメンバー構成が変わりました。もう一度お試しください'},409);
	const days=[];
	const unknownByDate=new Map<string,Set<string>>();
	for (let date=first;date<=last;date=nextDate(date)) {
		const unknown=userIds.filter(id=>unconfirmed.get(date.slice(0,7))?.has(id) ||
			unconfirmed.get(nextDate(date,-1).slice(0,7))?.has(id));
		unknownByDate.set(date,new Set(unknown));
		days.push({date,unconfirmedUserIds:unknown,
			slots:candidateSlots(busy,userIds,date,duration as number).map(([start,end])=>
				({start:formatMinute(start),end:formatMinute(end),needsConfirmation:unknown.length>0}))});
	}
	return jsonResponse({startDate:first,endDate:last,durationMinutes:duration,minimumParticipants:minimum,days,
		recommendations:rankAvailability(availability.hard,availability.tentative,userIds,days.map(day=>day.date),
			duration as number,minimum as number,unknownByDate)});
}

async function syncCalendar(env: SharedEnv, ctx: ExecutionContext, body: JsonRecord, user: SessionUser): Promise<Response> {
	const db = env.DB;
	const member = await requireMembership(db, body, user);
	const month = stringValue(body.month, 7);
	if (!member) return jsonResponse({ error: 'グループへの参加情報を確認できません' }, 401);
	if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return jsonResponse({ error: '対象月を指定してください' }, 400);
	if (!Array.isArray(body.entries) || body.entries.length > 250) return jsonResponse({ error: '同期できる予定は1か月250件までです' }, 400);
	const hasPersonalEntry = body.entries.some((raw) => isRecord(raw) && raw.sourceType === 'personal');
	const hasShiftEntry = body.entries.some((raw) => isRecord(raw) && raw.sourceType === 'shift');
	const optedIn = Boolean(await db.prepare('SELECT 1 FROM personal_sync_users WHERE user_id=?1').bind(user.id).first());
	// This endpoint is a group-shift mirror only. Never persist or diff personal entries,
	// regardless of consent or legacy flags. A legacy unflagged request is a shift snapshot
	// only when it actually contains a shift; personal-only payloads must not erase shifts.
	// Explicit empty snapshots still let the current client clear deleted shifts, but a
	// personal-only payload cannot be reinterpreted as such a snapshot.
	const syncShifts = (body.syncShifts === true && !(hasPersonalEntry && !hasShiftEntry))
		|| (body.syncShifts === undefined && !optedIn && hasShiftEntry);
	const entries = [];
	const seen = new Set<string>();
	for (const raw of body.entries) {
		if (!isRecord(raw)) return jsonResponse({ error: '予定の形式が正しくありません' }, 400);
		const sourceType = raw.sourceType;
		if (sourceType === 'personal') continue;
		if (sourceType !== 'shift') return jsonResponse({ error: '予定の内容を確認してください' }, 400);
		if (!syncShifts) continue;
		const sourceId = stringValue(raw.sourceId, 80);
		const eventDate = raw.eventDate;
		const title = stringValue(raw.title, 80);
		const allDay = raw.allDay === true;
		const start = allDay ? '' : raw.start;
		const end = allDay ? '' : raw.end;
		const note = typeof raw.note === 'string' && raw.note.length <= 160 ? raw.note : null;
		const identity = `${sourceType}:${sourceId}`;
		if (!sourceId || !validDate(eventDate) || !eventDate.startsWith(`${month}-`) || !title || note === null || (!allDay && (!validTime(start) || !validTime(end))) || seen.has(identity)) {
			return jsonResponse({ error: '予定の内容を確認してください' }, 400);
		}
		seen.add(identity);
		entries.push({ sourceType, sourceId, eventDate, title, start, end, allDay, note });
	}
	if (!syncShifts) return jsonResponse({ ok:true, count:0 });
	const old = await db.prepare(
		`SELECT source_type, source_id, event_date, title, starts_at, ends_at, all_day, note
		 FROM member_calendar_entries WHERE group_id = ?1 AND member_id = ?2 AND event_date >= ?3 AND event_date < ?4
		 AND source_type='shift' AND EXISTS(SELECT 1 FROM active_group_members WHERE id=?2 AND group_id=?1)`,
	).bind(member.group_id, member.member_id, `${month}-01`, `${month}-32`).all<{
		source_type:string; source_id:string; event_date:string; title:string; starts_at:string; ends_at:string; all_day:number; note:string;
	}>();
	const previous = new Map((old.results || []).map((entry) => [`${entry.source_type}:${entry.source_id}`, JSON.stringify([
		entry.event_date, entry.title, entry.starts_at, entry.ends_at, Boolean(entry.all_day), entry.note,
	])]));
	let added = false;
	let changed = false;
	for (const entry of entries) {
		const key = `${entry.sourceType}:${entry.sourceId}`;
		const value = JSON.stringify([entry.eventDate, entry.title, entry.start, entry.end, entry.allDay, entry.note]);
		if (!previous.has(key)) added = true;
		else if (previous.get(key) !== value) changed = true;
		previous.delete(key);
	}
	if (previous.size) changed = true;
	const coverage=db.prepare(`INSERT INTO group_calendar_sync_coverage(group_id,member_id,month,synced_at)
		VALUES(?1,?2,?3,?4) ON CONFLICT(group_id,member_id,month) DO UPDATE SET synced_at=excluded.synced_at`)
		.bind(member.group_id,member.member_id,month,new Date().toISOString());
	if (!added && !changed) {
		await coverage.run();
		return jsonResponse({ ok:true, count:entries.length });
	}
	const statements = [db.prepare(
		`DELETE FROM member_calendar_entries WHERE group_id = ?1 AND member_id = ?2 AND event_date >= ?3 AND event_date < ?4
		 AND source_type='shift' AND EXISTS(SELECT 1 FROM active_group_members WHERE id=?2 AND group_id=?1)`,
	).bind(member.group_id, member.member_id, `${month}-01`, `${month}-32`)];
	for (const entry of entries) {
		statements.push(db.prepare(
			`INSERT OR REPLACE INTO member_calendar_entries (group_id, member_id, source_type, source_id, event_date, title, starts_at, ends_at, all_day, note)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
		).bind(member.group_id, member.member_id, entry.sourceType, entry.sourceId, entry.eventDate, entry.title, entry.start, entry.end, Number(entry.allDay), entry.note));
	}
	statements.push(coverage);
	await db.batch(statements);
	if (added || changed) await scheduleNotice(env, ctx, member.group_id, user.id,
		added ? 'group_event_created' : 'group_event_updated', `「${member.group_name}」の共有予定が${added ? '追加' : '変更'}されました`,
		crypto.randomUUID(), notificationPath(member.group_id,month+'-01'));
	return jsonResponse({ ok:true, count:entries.length });
}

function eventInput(body: JsonRecord) {
	const title = stringValue(body.title, 80);
	const eventDate = body.eventDate;
	const allDay = body.allDay === true;
	const note = typeof body.note === 'string' && body.note.trim().length <= 160 ? body.note.trim() : null;
	const start = allDay ? '' : body.start;
	const end = allDay ? '' : body.end;
	if (!title || !validDate(eventDate) || note === null || (!allDay && (!validTime(start) || !validTime(end) || end <= start))) return null;
	return { title, eventDate, allDay, start, end, note };
}

async function createEvent(env: SharedEnv, ctx: ExecutionContext, body: JsonRecord, user: SessionUser): Promise<Response> {
	const db = env.DB;
	const member = await requireMembership(db, body, user);
	const event = eventInput(body);
	if (!member) return jsonResponse({ error: 'グループへの参加情報を確認できません' }, 401);
	if (!event) return jsonResponse({ error: '共有予定の入力内容を確認してください' }, 400);
	const id = crypto.randomUUID();
	const timestamp = new Date().toISOString();
	await db.prepare(
		`INSERT INTO shared_events (id, group_id, created_by_member_id, title, event_date, starts_at, ends_at, all_day, note, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
	).bind(id, member.group_id, member.member_id, event.title, event.eventDate, event.start, event.end, Number(event.allDay), event.note, timestamp).run();
	await scheduleNotice(env, ctx, member.group_id, user.id, 'group_event_created', `「${member.group_name}」に新しい予定が追加されました`,
		'shared-created:'+id,notificationPath(member.group_id,event.eventDate,id));
	return jsonResponse({ id }, 201);
}

async function updateEvent(env: SharedEnv, ctx: ExecutionContext, body: JsonRecord, user: SessionUser): Promise<Response> {
	const db = env.DB;
	const member = await requireMembership(db, body, user);
	const id = stringValue(body.id, 64);
	const event = eventInput(body);
	if (!member) return jsonResponse({ error: 'グループへの参加情報を確認できません' }, 401);
	if (!id || !event) return jsonResponse({ error: '共有予定の入力内容を確認してください' }, 400);
	const existingReminders = await db.prepare(`SELECT r.user_id,r.offset_minutes,r.time_zone FROM event_reminders r
		JOIN shared_events e ON e.id=r.shared_event_id
		WHERE r.scope='shared' AND r.group_id=?1 AND r.shared_event_id=?2 AND ${canManageSharedEventSql('e', '?3')} AND e.status='confirmed' AND e.cancelled_at IS NULL`)
		.bind(member.group_id,id,member.member_id).all<{user_id:string;offset_minutes:number;time_zone:string}>();
	let reminderStatements:D1PreparedStatement[];
	try {
		reminderStatements=sharedReminderRefreshStatements(db,member.group_id,id,
			{date:event.eventDate as string,start:event.start as string,allDay:event.allDay as boolean},existingReminders.results,member.member_id);
	} catch {
		return jsonResponse({error:'予定の開始時刻が設定タイムゾーン上で無効なため、通知時刻を更新できませんでした。'},400);
	}
	const timestamp = new Date().toISOString();
	const result = await db.batch([
		db.prepare(
		`UPDATE shared_events AS e SET title = ?1, event_date = ?2, starts_at = ?3, ends_at = ?4, all_day = ?5, note = ?6, updated_at = ?7,
		 management_version=management_version+1
		 WHERE id = ?8 AND group_id = ?9 AND e.cancelled_at IS NULL AND ${canManageSharedEventSql('e', '?10')}`,
		).bind(event.title, event.eventDate, event.start, event.end, Number(event.allDay), event.note, timestamp, id, member.group_id, member.member_id),
		...reminderStatements,
	]);
	if (!result[0].meta.changes) return jsonResponse({ error: 'この予定を編集する権限がありません' }, 403);
	await scheduleNotice(env, ctx, member.group_id, user.id, 'group_event_updated', `「${member.group_name}」の予定が変更されました`,
		'shared-updated:'+id+':'+timestamp,notificationPath(member.group_id,event.eventDate,id));
	return jsonResponse({ ok:true });
}

async function deleteEvent(env:SharedEnv,ctx:ExecutionContext, body: JsonRecord, user: SessionUser): Promise<Response> {
	const db=env.DB;
	const member = await requireMembership(db, body, user);
	const id = stringValue(body.id, 64);
	if (!member) return jsonResponse({ error: 'グループへの参加情報を確認できません' }, 401);
	if (!id) return jsonResponse({ error: '予定を指定してください' }, 400);
	const scheduled=await db.prepare(`SELECT e.schedule_plan_id FROM shared_events e
		WHERE e.id=?1 AND e.group_id=?2 AND e.cancelled_at IS NULL AND ${canManageSharedEventSql('e','?3')}`)
		.bind(id,member.group_id,member.member_id).first<{schedule_plan_id:string|null}>();
	if(scheduled?.schedule_plan_id) return handleScheduleRequest(env,ctx,'/api/groups/schedules/cancel',
		{groupId:member.group_id,scheduleId:scheduled.schedule_plan_id},user);
	const result = await db.batch([
		db.prepare(`INSERT INTO shared_event_delete_grants(event_id,actor_member_id)
			SELECT e.id,?3 FROM shared_events e WHERE e.id=?1 AND e.group_id=?2 AND e.cancelled_at IS NULL AND ${canManageSharedEventSql('e', '?3')}`)
			.bind(id,member.group_id,member.member_id),
		db.prepare(`DELETE FROM push_deliveries WHERE reminder_id IN (
			SELECT r.id FROM event_reminders r JOIN shared_events e ON e.id=r.shared_event_id
			WHERE r.scope='shared' AND r.group_id=?1 AND r.shared_event_id=?2 AND e.cancelled_at IS NULL AND ${canManageSharedEventSql('e', '?3')})`)
			.bind(member.group_id,id,member.member_id),
		db.prepare(`DELETE FROM shared_events AS e WHERE id = ?1 AND group_id = ?2 AND e.cancelled_at IS NULL AND ${canManageSharedEventSql('e', '?3')}`)
			.bind(id, member.group_id, member.member_id),
	]);
	if (!result[2].meta.changes) return jsonResponse({ error: 'この予定を削除する権限がありません' }, 403);
	return jsonResponse({ ok:true });
}

export async function handleSharedRequest(request: Request, env: SharedEnv, ctx: ExecutionContext, pathname: string, user: SessionUser): Promise<Response> {
	if (request.method !== 'POST') return jsonResponse({ error: 'POSTメソッドを使用してください' }, 405);
	const body = await readBody(request);
	if (!body) return jsonResponse({ error: 'リクエスト本文は有効なJSONオブジェクトである必要があります' }, 400);
	try {
		if (pathname.startsWith('/api/groups/schedules/')) return await handleScheduleRequest(env,ctx,pathname,body,user);
		if (pathname.startsWith('/api/groups/wishes/')) return await handleWishRequest(env, ctx, pathname, body, user);
		if (pathname === '/api/groups/create') return await createGroup(env.DB, body, user);
		if (pathname === '/api/groups/rename') return await renameGroup(env.DB, body, user);
		if (pathname === '/api/groups/icon') return await updateGroupIcon(env.DB, body, user);
		if (pathname === '/api/groups/join') return await joinGroup(env, ctx, body, user);
		if (pathname === '/api/groups/mine') return await mine(env.DB, user);
		if (pathname === '/api/groups/claim') return await claimLegacyMembership(env.DB, body, user);
		if (pathname === '/api/groups/members/list') return await listGroupMembers(env.DB, body, user);
		if (pathname === '/api/groups/leave/options') return await leaveOptions(env.DB,body,user);
		if (pathname === '/api/groups/leave') return await leaveGroup(env,ctx, body, user);
		if (pathname === '/api/shared/events/list') return await listEvents(env.DB, body, user);
		if (pathname === '/api/shared/availability') return await availability(env.DB, body, user);
		if (pathname === '/api/shared/availability/search') return await searchAvailability(env.DB, body, user);
		if (pathname === '/api/shared/calendar/sync') return await syncCalendar(env, ctx, body, user);
		if (pathname === '/api/shared/events/create') return await createEvent(env, ctx, body, user);
		if (pathname === '/api/shared/events/update') return await updateEvent(env, ctx, body, user);
		if (pathname === '/api/shared/events/delete') return await deleteEvent(env,ctx, body, user);
		return jsonResponse({ error: 'APIが見つかりません' }, 404);
	} catch (error) {
		if (String(error).includes('inactive group membership')) return jsonResponse({error:'参加状態が変更されました。グループ情報を更新してください。'},409);
		console.error(error);
		return jsonResponse({ error: 'サーバーで処理できませんでした' }, 500);
	}
}
