import type { SessionUser } from './auth';
import { reminderInboxStatement, validReminderSql } from './notifications';
import type { PushEnv } from './push';

type ReminderScope = 'personal' | 'shared';
type ReminderPreference = { offsetMinutes:number[]; timeZone:string };
type EventTime = { date:string; start:string; allDay:boolean };
type PersonalEvent = EventTime & { extra:Record<string, unknown> };
type SharedEvent = EventTime & { id:string; group_id:string; status:string; wish_id:string | null };
type ReminderRow = {
	id:string; scope:ReminderScope; user_id:string; group_id:string | null; personal_event_id:string | null;
	shared_event_id:string | null; offset_minutes:number; time_zone:string; event_start_at:string; due_at:string;
	queued_at:string | null; generation:number; event_date:string;
};

const MAX_OFFSET_MINUTES = 7 * 24 * 60;
const MAX_REMINDERS = 8;
const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const reply = (data:unknown, status=200) => new Response(JSON.stringify(data), { status, headers:{ 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' } });

function validDate(value:string): boolean {
	if (!SAFE_DATE.test(value)) return false;
	const date = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTimeZone(value:unknown): value is string {
	if (typeof value !== 'string' || !value.trim() || value.length > 64) return false;
	try { new Intl.DateTimeFormat('en', { timeZone:value }).format(0); return true; }
	catch { return false; }
}

export function normalizeReminderPreference(offsets:unknown, timeZone:unknown): ReminderPreference | null {
	if (!Array.isArray(offsets) || offsets.length > MAX_REMINDERS || !validTimeZone(timeZone)) return null;
	const values = offsets;
	if (values.some((value) => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_OFFSET_MINUTES)) return null;
	return { offsetMinutes:[...new Set(values)].sort((a, b) => a - b), timeZone };
}

export function personalReminderPreference(extra:unknown): ReminderPreference | null {
	if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return null;
	const raw = (extra as Record<string, unknown>).daySyncReminders;
	if (raw === undefined) return { offsetMinutes:[], timeZone:'UTC' };
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const value = raw as Record<string, unknown>;
	return normalizeReminderPreference(value.offsetMinutes, value.timeZone);
}

function localParts(epochMs:number, timeZone:string): Record<string, number> {
	const fields = new Intl.DateTimeFormat('en-GB', {
		timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23',
	}).formatToParts(epochMs);
	return Object.fromEntries(fields.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function matchingLocalTime(epochMs:number, expected:Record<string, number>, timeZone:string): boolean {
	const actual = localParts(epochMs, timeZone);
	return ['year','month','day','hour','minute'].every((key) => actual[key] === expected[key]);
}

export function localDateTimeToInstant(date:string, time:string, timeZone:string): string | null {
	if (!validDate(date) || !SAFE_TIME.test(time) || !validTimeZone(timeZone)) return null;
	const [year, month, day] = date.split('-').map(Number);
	const [hour, minute] = time.split(':').map(Number);
	const wallClockMs = Date.UTC(year, month - 1, day, hour, minute);
	const expected = { year, month, day, hour, minute };
	const offsets = new Set<number>();
	try {
		for (let hours = -36; hours <= 36; hours += 6) {
			const sample = wallClockMs + hours * 60 * 60_000;
			const local = localParts(sample, timeZone);
			const represented = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
			offsets.add(represented - sample);
		}
	} catch { return null; }
	const candidates = [...offsets].map((offset) => wallClockMs - offset)
		.filter((candidate) => matchingLocalTime(candidate, expected, timeZone)).sort((a, b) => a - b);
	// Ambiguous times during a fall-back transition choose the earlier instant.
	return candidates.length ? new Date(candidates[0]).toISOString() : null;
}

function eventStart(event:EventTime, timeZone:string): string | null {
	return localDateTimeToInstant(event.date, event.allDay ? '09:00' : event.start, timeZone);
}

function dueAt(startAt:string, offsetMinutes:number): string {
	return new Date(Date.parse(startAt) - offsetMinutes * 60_000).toISOString();
}

function validEventReminderSetting(extra:unknown): boolean {
	return personalReminderPreference(extra) !== null;
}

function personalReminderStatements(db:D1Database, userId:string, eventId:string, operationId:string,
	event:PersonalEvent | null, deleted:boolean): D1PreparedStatement[] {
	const statements:D1PreparedStatement[] = [];
	const preference = event ? personalReminderPreference(event.extra) : { offsetMinutes:[], timeZone:'UTC' };
	if (!preference) throw new Error('予定のリマインド設定を確認してください');
	const startAt = event && preference.offsetMinutes.length ? eventStart(event, preference.timeZone) : null;
	if (event && preference.offsetMinutes.length && !startAt) throw new Error('予定のタイムゾーンまたは開始時刻を確認してください');
	const applied = `EXISTS(SELECT 1 FROM personal_events e WHERE e.user_id=?1 AND e.id=?2 AND e.last_operation=?3 AND e.deleted=?4)`;
	const obsoletePredicate = preference.offsetMinutes.length ? 'r.offset_minutes NOT IN (' + preference.offsetMinutes.map((_,index) => `?${index+5}`).join(',') + ')' : '1=1';
	const binds = [userId, eventId, operationId, Number(deleted), ...preference.offsetMinutes];
	statements.push(db.prepare(`DELETE FROM push_deliveries WHERE reminder_id IN (
		SELECT r.id FROM event_reminders r WHERE r.scope='personal' AND r.user_id=?1 AND r.personal_event_id=?2
		AND (${obsoletePredicate}) AND ${applied})`).bind(...binds));
	if (event && !deleted && startAt) {
		for (const offset of preference.offsetMinutes) {
			const nextDueAt=dueAt(startAt,offset);
			statements.push(db.prepare(`DELETE FROM push_deliveries WHERE reminder_id IN (
				SELECT id FROM event_reminders WHERE scope='personal' AND user_id=?1 AND personal_event_id=?2 AND offset_minutes=?4
				AND (time_zone!=?5 OR event_start_at!=?6 OR due_at!=?7))
				AND EXISTS(SELECT 1 FROM personal_events e WHERE e.user_id=?1 AND e.id=?2 AND e.last_operation=?3 AND e.deleted=0)`)
				.bind(userId,eventId,operationId,offset,preference.timeZone,startAt,nextDueAt));
		}
	}
	statements.push(db.prepare(`DELETE FROM event_reminders WHERE scope='personal' AND user_id=?1 AND personal_event_id=?2
		AND ${applied} AND (${obsoletePredicate.replaceAll('r.', '')})`).bind(...binds));
	if (event && !deleted && startAt) {
		for (const offset of preference.offsetMinutes) {
			statements.push(db.prepare(`INSERT INTO event_reminders
				(id,scope,user_id,group_id,personal_event_id,shared_event_id,offset_minutes,time_zone,event_start_at,due_at,created_at)
				SELECT lower(hex(randomblob(16))),'personal',?1,NULL,?2,NULL,?4,?5,?6,?7,?8
				WHERE EXISTS(SELECT 1 FROM personal_events e WHERE e.user_id=?1 AND e.id=?2 AND e.last_operation=?3 AND e.deleted=0)
				ON CONFLICT(user_id,personal_event_id,offset_minutes) WHERE scope='personal' DO UPDATE SET
				 time_zone=excluded.time_zone,event_start_at=excluded.event_start_at,due_at=excluded.due_at,
				 queued_at=NULL,generation=event_reminders.generation+1
				WHERE event_reminders.time_zone!=excluded.time_zone OR event_reminders.event_start_at!=excluded.event_start_at OR event_reminders.due_at!=excluded.due_at`)
				.bind(userId, eventId, operationId, offset, preference.timeZone, startAt, dueAt(startAt, offset), new Date().toISOString()));
		}
	}
	return statements;
}

export function validatePersonalReminderSetting(extra:unknown): boolean {
	return validEventReminderSetting(extra);
}

export function validatePersonalReminderEvent(event:PersonalEvent):boolean {
	const preference=personalReminderPreference(event.extra);
	if(!preference) return false;
	return !preference.offsetMinutes.length || Boolean(eventStart(event,preference.timeZone));
}

async function sharedEventForUser(db:D1Database, groupId:string, eventId:string, userId:string):Promise<SharedEvent | null> {
	return db.prepare(`SELECT e.id,e.group_id,e.event_date AS date,e.starts_at AS start,e.all_day AS allDay,
		e.status,e.wish_id FROM shared_events e JOIN group_members gm ON gm.group_id=e.group_id
		WHERE e.id=?1 AND e.group_id=?2 AND gm.user_id=?3 AND e.status='confirmed'
		AND (e.wish_id IS NULL OR EXISTS(SELECT 1 FROM shared_event_participants p WHERE p.event_id=e.id AND p.user_id=?3))`)
		.bind(eventId,groupId,userId).first<SharedEvent>();
}

function sharedReminderStatements(db:D1Database, userId:string, event:SharedEvent, preference:ReminderPreference):D1PreparedStatement[] {
	const startAt = preference.offsetMinutes.length ? eventStart(event, preference.timeZone) : null;
	if (preference.offsetMinutes.length && !startAt) throw new Error('予定のタイムゾーンまたは開始時刻を確認してください');
	const obsolete = preference.offsetMinutes.length ? 'offset_minutes NOT IN (' + preference.offsetMinutes.map(() => '?').join(',') + ')' : '1=1';
	const baseBinds = [userId,event.id,...preference.offsetMinutes];
	const statements:D1PreparedStatement[] = [];
	statements.push(db.prepare(`DELETE FROM push_deliveries WHERE reminder_id IN (
		SELECT id FROM event_reminders WHERE scope='shared' AND user_id=?1 AND shared_event_id=?2 AND (${obsolete}))`).bind(...baseBinds));
	statements.push(db.prepare(`DELETE FROM push_deliveries WHERE reminder_id IN (
		SELECT id FROM event_reminders WHERE scope='shared' AND user_id=?1 AND shared_event_id=?2
		AND (time_zone!=?3 OR event_start_at!=?4))`)
		.bind(userId,event.id,preference.timeZone,startAt||''));
	statements.push(db.prepare(`DELETE FROM event_reminders WHERE scope='shared' AND user_id=?1 AND shared_event_id=?2 AND (${obsolete})`).bind(...baseBinds));
	if (startAt) for (const offset of preference.offsetMinutes) {
		statements.push(db.prepare(`INSERT INTO event_reminders
			(id,scope,user_id,group_id,personal_event_id,shared_event_id,offset_minutes,time_zone,event_start_at,due_at,created_at)
			SELECT lower(hex(randomblob(16))),'shared',?1,?2,NULL,?3,?4,?5,?6,?7,?8
			WHERE EXISTS(SELECT 1 FROM shared_events e JOIN group_members gm ON gm.group_id=e.group_id
			 WHERE e.id=?3 AND e.group_id=?2 AND gm.user_id=?1 AND e.status='confirmed'
			 AND (e.wish_id IS NULL OR EXISTS(SELECT 1 FROM shared_event_participants p WHERE p.event_id=e.id AND p.user_id=?1)))
			ON CONFLICT(user_id,shared_event_id,offset_minutes) WHERE scope='shared' DO UPDATE SET
			 time_zone=excluded.time_zone,event_start_at=excluded.event_start_at,due_at=excluded.due_at,
			 queued_at=NULL,generation=event_reminders.generation+1
			WHERE event_reminders.time_zone!=excluded.time_zone OR event_reminders.event_start_at!=excluded.event_start_at OR event_reminders.due_at!=excluded.due_at`)
			.bind(userId,event.group_id,event.id,offset,preference.timeZone,startAt,dueAt(startAt,offset),new Date().toISOString()));
	}
	return statements;
}

export function sharedReminderRefreshStatements(db:D1Database, groupId:string, eventId:string,
	event:EventTime & { allDay:boolean }, userReminders:Array<{ user_id:string; offset_minutes:number; time_zone:string }>):D1PreparedStatement[] {
	const statements:D1PreparedStatement[]=[];
	for (const reminder of userReminders) {
		const startAt=eventStart(event,reminder.time_zone);
		if (!startAt) throw new Error('予定のタイムゾーンまたは開始時刻を確認してください');
		statements.push(db.prepare(`DELETE FROM push_deliveries WHERE reminder_id IN (
			SELECT id FROM event_reminders WHERE scope='shared' AND user_id=?1 AND shared_event_id=?2 AND offset_minutes=?3
			AND (time_zone!=?4 OR event_start_at!=?5 OR due_at!=?6))`)
			.bind(reminder.user_id,eventId,reminder.offset_minutes,reminder.time_zone,startAt,dueAt(startAt,reminder.offset_minutes)));
		statements.push(db.prepare(`UPDATE event_reminders SET event_start_at=?1,due_at=?2,queued_at=NULL,generation=generation+1
			WHERE scope='shared' AND user_id=?3 AND shared_event_id=?4 AND offset_minutes=?5
			AND (event_start_at!=?1 OR due_at!=?2)
			AND EXISTS(SELECT 1 FROM shared_events e WHERE e.id=?4 AND e.group_id=?6 AND e.status='confirmed')`)
			.bind(startAt,dueAt(startAt,reminder.offset_minutes),reminder.user_id,eventId,reminder.offset_minutes,groupId));
	}
	return statements;
}

export async function handleReminderRequest(request:Request, db:D1Database, path:string, user:SessionUser):Promise<Response> {
	if (request.method!=='POST') return reply({ error:'POSTメソッドを使用してください' },405);
	if (!request.headers.get('origin') || !request.headers.get('content-type')?.startsWith('application/json')) return reply({ error:'DaySyncの画面から操作してください' },403);
	let body:Record<string,unknown>;
	try { const parsed=await request.json(); if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)) return reply({error:'入力内容を確認してください'},400); body=parsed as Record<string,unknown>; }
	catch { return reply({error:'入力内容を確認してください'},400); }
	const groupId=typeof body.groupId==='string'&&body.groupId.length<=64?body.groupId:'';
	const eventId=typeof body.eventId==='string'&&body.eventId.length<=80?body.eventId:'';
	if (!groupId||!eventId) return reply({error:'予定を指定してください'},400);
	try {
		const event=await sharedEventForUser(db,groupId,eventId,user.id);
		if (!event) return reply({error:'この予定にはリマインドを設定できません'},404);
		if (path==='/api/reminders/shared/get') {
			const rows=await db.prepare(`SELECT offset_minutes,time_zone FROM event_reminders
				WHERE scope='shared' AND user_id=?1 AND group_id=?2 AND shared_event_id=?3 ORDER BY offset_minutes`)
				.bind(user.id,groupId,eventId).all<{offset_minutes:number;time_zone:string}>();
			return reply({offsetMinutes:rows.results.map((row)=>row.offset_minutes),timeZone:rows.results[0]?.time_zone||'Asia/Tokyo'});
		}
		if (path!=='/api/reminders/shared/set') return reply({error:'APIが見つかりません'},404);
		const preference=normalizeReminderPreference(body.offsetMinutes,body.timeZone);
		if (!preference) return reply({error:'通知タイミングとタイムゾーンを確認してください'},400);
		let statements:D1PreparedStatement[];
		try { statements=sharedReminderStatements(db,user.id,event,preference); }
		catch { return reply({error:'予定の開始時刻が設定タイムゾーン上で無効なため、リマインドを設定できません'},400); }
		await db.batch(statements);
		return reply({ok:true,offsetMinutes:preference.offsetMinutes,timeZone:preference.timeZone});
	} catch(error) {
		console.error('Reminder preference could not be saved',error);
		return reply({error:'リマインド設定を保存できませんでした'},500);
	}
}

function reminderTargetPath(row:ReminderRow):string {
	const query=new URLSearchParams();
	if(row.scope==='personal') {
		query.set('reminder','personal');
		query.set('eventId',row.personal_event_id||'');
	} else {
		query.set('reminder','shared');
		query.set('group',row.group_id||'');
		query.set('eventId',row.shared_event_id||'');
	}
	query.set('date',row.event_date);
	return '/?'+query.toString();
}

export async function drainReminderQueue(env:PushEnv):Promise<void> {
	const db=env.DB;
	const now=new Date().toISOString();
	await db.prepare(`DELETE FROM push_deliveries WHERE reminder_id IS NOT NULL AND NOT EXISTS(
		SELECT 1 FROM event_reminders r WHERE r.id=push_deliveries.reminder_id AND r.event_start_at>?1)`)
		.bind(now).run();
	const due=await db.prepare(`SELECT r.*,CASE WHEN r.scope='personal' THEN p.event_date ELSE e.event_date END AS event_date
		FROM event_reminders r
		LEFT JOIN personal_events p ON r.scope='personal' AND p.user_id=r.user_id AND p.id=r.personal_event_id
		LEFT JOIN shared_events e ON r.scope='shared' AND e.id=r.shared_event_id
		WHERE r.queued_at IS NULL AND r.due_at<=?1 AND r.event_start_at>?1
		AND (${validReminderSql()})
		ORDER BY r.due_at,r.id LIMIT 50`).bind(now).all<ReminderRow>();
	for (const reminder of due.results) {
		const token=crypto.randomUUID();
		const targetPath=reminderTargetPath(reminder);
		const valid=validReminderSql();
		const statements:D1PreparedStatement[]=[
			reminderInboxStatement(db,reminder.id,targetPath,now),
			db.prepare(`UPDATE event_reminders AS r SET queued_at=?1 WHERE r.id=?2 AND r.queued_at IS NULL AND r.due_at<=?3 AND r.event_start_at>?3
				AND (${valid})`).bind(token,reminder.id,now),
		];
		if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT) statements.push(
			db.prepare(`INSERT OR IGNORE INTO push_deliveries
				(id,subscription_id,group_id,kind,body,created_at,next_attempt_at,scope,recipient_user_id,target_path,reminder_id,dedupe_key)
				SELECT lower(hex(randomblob(16))),s.id,COALESCE(r.group_id,''),'event_reminder','予定の開始時刻が近づいています',?3,?3,
				 CASE WHEN r.scope='shared' THEN 'group' ELSE 'personal' END,r.user_id,?2,r.id,
				 'reminder:'||r.id||':'||r.generation||':'||s.id
				FROM event_reminders r JOIN push_subscriptions s ON s.user_id=r.user_id
				WHERE r.id=?1 AND r.queued_at=?4 AND r.event_start_at>?3 AND (${valid})`)
				.bind(reminder.id,targetPath,now,token));
		await db.batch(statements);
	}
	await db.prepare(`DELETE FROM event_reminders WHERE event_start_at<?1 AND created_at<?2`)
		.bind(now,new Date(Date.now()-30*24*60*60_000).toISOString()).run();
}

export function personalReminderStatementsForOperation(db:D1Database,userId:string,eventId:string,operationId:string,
	event:PersonalEvent|null,deleted:boolean):D1PreparedStatement[] {
	return personalReminderStatements(db,userId,eventId,operationId,event,deleted);
}
