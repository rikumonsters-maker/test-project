import type { SessionUser } from './auth';

export type NotificationKind = 'group_event_created' | 'group_event_updated' | 'group_joined'
  | 'wish_created' | 'wish_interested' | 'event_reminder';

const messages: Record<NotificationKind, string> = {
  group_event_created:'共有予定が追加されました',
  group_event_updated:'共有予定が変更されました',
  group_joined:'グループに新しいメンバーが参加しました',
  wish_created:'新しい「遊びたい日」の募集があります',
  wish_interested:'あなたの募集に「行きたい」が届きました',
  event_reminder:'予定の開始時刻が近づいています',
};

type Row = { id:string; kind:NotificationKind; target_path:string; created_at:string; read_at:string | null };
const visible = `n.revoked_at IS NULL AND (n.group_id IS NULL OR EXISTS (
  SELECT 1 FROM active_group_members gm WHERE gm.group_id=n.group_id AND gm.user_id=n.user_id))`;

function json(data:unknown, status=200):Response {
  return new Response(JSON.stringify(data), { status, headers:{
    'content-type':'application/json; charset=utf-8', 'cache-control':'no-store',
  } });
}

export function notificationPath(groupId:string, date?:string, eventId?:string, wishId?:string):string {
  const query=new URLSearchParams({group:groupId});
  if (date) query.set('date',date);
  if (eventId) { query.set('reminder','shared'); query.set('eventId',eventId); }
  if (wishId) query.set('wishId',wishId);
  return '/?'+query.toString();
}

export async function queueGroupInbox(db:D1Database, groupId:string, actorUserId:string,
  kind:NotificationKind, targetPath:string, dedupeKey:string):Promise<void> {
  const now=new Date().toISOString();
  await db.prepare(`INSERT OR IGNORE INTO in_app_notifications
    (id,user_id,group_id,kind,target_path,dedupe_key,created_at)
    SELECT lower(hex(randomblob(16))),gm.user_id,?1,?2,?3,?4,?5
    FROM active_group_members gm WHERE gm.group_id=?1 AND gm.user_id IS NOT NULL AND gm.user_id!=?6`)
    .bind(groupId,kind,targetPath,dedupeKey,now,actorUserId).run();
}

export async function queueGroupUserInbox(db:D1Database, groupId:string, recipientUserId:string,
  actorUserId:string, kind:NotificationKind, targetPath:string, dedupeKey:string):Promise<void> {
  if (recipientUserId===actorUserId) return;
  const now=new Date().toISOString();
  await db.prepare(`INSERT OR IGNORE INTO in_app_notifications
    (id,user_id,group_id,kind,target_path,dedupe_key,created_at)
    SELECT lower(hex(randomblob(16))),gm.user_id,?1,?2,?3,?4,?5
    FROM active_group_members gm WHERE gm.group_id=?1 AND gm.user_id=?6`)
    .bind(groupId,kind,targetPath,dedupeKey,now,recipientUserId).run();
}

// The same predicate protects both the inbox and the existing Push queue at cron time.
export function validReminderSql():string {
  return `(r.scope='personal' AND EXISTS(SELECT 1 FROM personal_events p
    WHERE p.user_id=r.user_id AND p.id=r.personal_event_id AND p.deleted=0))
    OR (r.scope='shared' AND EXISTS(SELECT 1 FROM shared_events e
      JOIN active_group_members gm ON gm.group_id=e.group_id AND gm.user_id=r.user_id
      WHERE e.id=r.shared_event_id AND e.group_id=r.group_id AND e.status='confirmed'
      AND (e.wish_id IS NULL OR EXISTS(SELECT 1 FROM shared_event_participants sp
        WHERE sp.event_id=e.id AND sp.user_id=r.user_id AND sp.revoked_at IS NULL))))`;
}

export function reminderInboxStatement(db:D1Database, reminderId:string, targetPath:string,
  now:string):D1PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO in_app_notifications
    (id,user_id,group_id,kind,target_path,dedupe_key,created_at)
    SELECT lower(hex(randomblob(16))),r.user_id,r.group_id,'event_reminder',?2,
      'reminder:'||r.id||':'||r.generation,?3
    FROM event_reminders r WHERE r.id=?1 AND r.queued_at IS NULL
      AND r.due_at<=?3 AND r.event_start_at>?3 AND (${validReminderSql()})`)
    .bind(reminderId,targetPath,now);
}

async function unreadCount(db:D1Database,userId:string):Promise<number> {
  const row=await db.prepare(`SELECT COUNT(*) AS count FROM in_app_notifications n
    WHERE n.user_id=?1 AND n.read_at IS NULL AND ${visible}`)
    .bind(userId).first<{count:number}>();
  return Number(row?.count||0);
}

export async function handleNotificationRequest(request:Request, db:D1Database,
  pathname:string, user:SessionUser):Promise<Response> {
  if (pathname==='/api/notifications/count') {
    if (request.method!=='GET') return json({error:'GETメソッドを使用してください'},405);
    return json({unreadCount:await unreadCount(db,user.id)});
  }
  if (pathname==='/api/notifications') {
    if (request.method!=='GET') return json({error:'GETメソッドを使用してください'},405);
    const search=new URL(request.url).searchParams;
    const beforeAt=search.get('beforeAt');
    const beforeId=search.get('beforeId');
    if ((beforeAt||beforeId) && (!beforeAt || !beforeId ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(beforeAt) ||
      !/^[0-9a-f]{32}$/.test(beforeId))) return json({error:'一覧の位置を確認してください'},400);
    const rows=await db.prepare(`SELECT n.id,n.kind,n.target_path,n.created_at,n.read_at
      FROM in_app_notifications n WHERE n.user_id=?1 AND ${visible}
      AND (?2 IS NULL OR n.created_at<?2 OR (n.created_at=?2 AND n.id<?3))
      ORDER BY n.created_at DESC,n.id DESC LIMIT 31`)
      .bind(user.id,beforeAt,beforeId).all<Row>();
    const page=rows.results.slice(0,30);
    const last=page.at(-1);
    return json({notifications:page.map(row=>({
      id:row.id,kind:row.kind,message:messages[row.kind],targetPath:row.target_path,
      createdAt:row.created_at,readAt:row.read_at,
    })), unreadCount:await unreadCount(db,user.id),
      nextCursor:rows.results.length>30 && last ? {beforeAt:last.created_at,beforeId:last.id} : null});
  }
  if (pathname!=='/api/notifications/read' && pathname!=='/api/notifications/read-all')
    return json({error:'APIが見つかりません'},404);
  if (request.method!=='POST') return json({error:'POSTメソッドを使用してください'},405);
  if (!request.headers.get('origin') || !request.headers.get('content-type')?.startsWith('application/json'))
    return json({error:'DaySyncの画面から操作してください'},403);
  if (pathname==='/api/notifications/read-all') {
    await db.prepare(`UPDATE in_app_notifications SET read_at=?1 WHERE user_id=?2 AND read_at IS NULL`)
      .bind(new Date().toISOString(),user.id).run();
    return json({ok:true,unreadCount:0});
  }
  let body:unknown;
  try { body=await request.json(); } catch { return json({error:'通知を指定してください'},400); }
  const id=body && typeof body==='object' && !Array.isArray(body)
    ? (body as Record<string,unknown>).id : null;
  if (typeof id!=='string' || !/^[0-9a-f]{32}$/.test(id)) return json({error:'通知を指定してください'},400);
  await db.prepare(`UPDATE in_app_notifications SET read_at=?1 WHERE user_id=?2 AND id=?3 AND read_at IS NULL`)
    .bind(new Date().toISOString(),user.id,id).run();
  return json({ok:true,unreadCount:await unreadCount(db,user.id)});
}
