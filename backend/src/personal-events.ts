import type { SessionUser } from './auth';
import { sha256 } from './auth';
import { personalReminderStatementsForOperation, validatePersonalReminderEvent } from './reminders';

type Row = {id:string; event_date:string; title:string; starts_at:string; ends_at:string; all_day:number; note:string; extra_json:string; version:number; deleted:number; created_at:string; updated_at:string};
const reply = (data:unknown,status=200) => new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const idValid = (value:unknown): value is string => typeof value==='string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value);
function record(row:Row) {
  return {id:row.id,date:row.event_date,title:row.title,start:row.starts_at,end:row.ends_at,allDay:Boolean(row.all_day),note:row.note,extra:JSON.parse(row.extra_json),version:row.version,deleted:Boolean(row.deleted),createdAt:row.created_at,updatedAt:row.updated_at};
}
function input(raw:any) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const {date,title,start,end,allDay,note}=raw;
  if (typeof date!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date) return null;
  if (typeof title!=='string' || !title.trim() || title.length>80 || typeof note!=='string' || note.length>160 || typeof allDay!=='boolean') return null;
  const time=(v:unknown)=>typeof v==='string' && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(v);
  if (!allDay && (!time(start) || !time(end) || end<=start)) return null;
  const extra=raw.extra ?? {};
  if (!extra || typeof extra!=='object' || Array.isArray(extra) || JSON.stringify(extra).length>8192) return null;
  // Stable ordering for legacy fingerprints, including nested unknown fields.
  const stable=(v:any):any=>Array.isArray(v) ? v.map(stable) : v && typeof v==='object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])) : v;
  const value={date,title,start:allDay?'':start as string,end:allDay?'':end as string,allDay,note,extra:stable(extra)};
  return validatePersonalReminderEvent(value)?value:null;
}
export async function handlePersonalEvents(request:Request,db:D1Database,path:string,user:SessionUser):Promise<Response> {
  try {
    const isActive=async()=>Boolean(await db.prepare('SELECT 1 FROM personal_sync_users WHERE user_id=?1').bind(user.id).first());
    if (request.method==='GET' && path==='/api/personal/events/status') {
      return reply({active:await isActive()});
    }
    if (request.method==='GET' && path==='/api/personal/events/sync') {
      if (!await isActive()) return reply({error:'新しいカレンダー同期はまだ開始されていません'},409);
      const cursor=Number(new URL(request.url).searchParams.get('cursor')||0);
      if (!Number.isSafeInteger(cursor)||cursor<0) return reply({error:'同期位置が正しくありません'},400);
      // Snapshot and delta query in one transaction. Cursor never uses client timestamps.
      const result=await db.batch([
        db.prepare('SELECT COALESCE(MAX(seq),0) AS high FROM personal_event_changes WHERE user_id=?1').bind(user.id),
        db.prepare('SELECT seq,event_json FROM personal_event_changes WHERE user_id=?1 AND seq>?2 ORDER BY seq LIMIT 501').bind(user.id,cursor),
      ]);
      const rows=result[1].results as {seq:number;event_json:string}[];
      const high=(result[0].results[0] as {high:number}).high;
      if (cursor>high) return reply({error:'同期履歴を再取得してください',resetCursor:true},409);
      const page=rows.slice(0,500);
      return reply({events:page.map(r=>JSON.parse(r.event_json)),cursor:rows.length>500?page.at(-1)!.seq:high,hasMore:rows.length>500});
    }
    if (request.method==='GET' && path==='/api/personal/events') {
      if (!await isActive()) return reply({error:'新しいカレンダー同期はまだ開始されていません'},409);
      const result=await db.prepare('SELECT * FROM personal_events WHERE user_id=?1 AND deleted=0 ORDER BY event_date,starts_at,id').bind(user.id).all<Row>();
      return reply({events:result.results.map(record)});
    }
    if (request.method!=='POST') return reply({error:'POSTメソッドを使用してください'},405);
    if (!request.headers.get('origin') || !request.headers.get('content-type')?.startsWith('application/json')) return reply({error:'DaySyncの画面から操作してください'},403);
    let body:any; try {body=await request.json();} catch{return reply({error:'入力内容を確認してください'},400);}
    if (!body || typeof body!=='object' || Array.isArray(body)) return reply({error:'入力内容を確認してください'},400);
    if (path==='/api/personal/events/activate') {
      if (body.freshStart!==true) return reply({error:'新しいカレンダーを開始するには、画面で明示的に同意してください'},400);
      await db.prepare('INSERT OR IGNORE INTO personal_sync_users VALUES (?1,?2)').bind(user.id,new Date().toISOString()).run();
      return reply({ok:true,active:true});
    }
    if (path==='/api/personal/events/import') {
      if (!await isActive() || body.restoreConfirmed!==true) return reply({error:'予定の復元には、同期開始後に画面で明示的に確認してください'},403);
      const event=input(body.event);
      if (!event || typeof body.sourceId!=='string' || !body.sourceId || body.sourceId.length>256) return reply({error:'移行予定の形式を確認してください。元データは保管されています。'},400);
      const fingerprint=await sha256(JSON.stringify(event));
      const id=`legacy-${await sha256(JSON.stringify([user.id,body.sourceId,fingerprint]))}`;
      const now=new Date().toISOString();
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO personal_events(user_id,id,event_date,title,starts_at,ends_at,all_day,note,extra_json,version,created_at,updated_at,last_operation,import_source,import_fingerprint)
          VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1,?10,?10,?2,?11,?12)`)
          .bind(user.id,id,event.date,event.title,event.start,event.end,Number(event.allDay),event.note,JSON.stringify(event.extra),now,body.sourceId,fingerprint),
        ...personalReminderStatementsForOperation(db,user.id,id,id,event,false),
      ]);
      const row=await db.prepare('SELECT * FROM personal_events WHERE user_id=?1 AND id=?2').bind(user.id,id).first<Row>();
      const variants=await db.prepare('SELECT COUNT(*) AS n FROM personal_events WHERE user_id=?1 AND import_source=?2').bind(user.id,body.sourceId).first<{n:number}>();
      return reply({event:record(row!),migrationConflict:(variants?.n||0)>1});
    }
    if (!['/api/personal/events/create','/api/personal/events/update','/api/personal/events/delete'].includes(path)) return reply({error:'APIが見つかりません'},404);
    if (!await isActive()) return reply({error:'新しいカレンダー同期はまだ開始されていません'},409);
    if (body.syncProtocol!==2) return reply({error:'旧形式の未送信予定は登録しません。復元する場合は画面で明示的に選択してください'},409);
    if (!idValid(body.id)||!idValid(body.operationId)) return reply({error:'予定IDを確認してください'},400);
    const existing=await db.prepare('SELECT result_json FROM personal_event_operations WHERE user_id=?1 AND operation_id=?2').bind(user.id,body.operationId).first<{result_json:string}>();
    if (existing) return reply({event:JSON.parse(existing.result_json)});
    const isCreate=path.endsWith('/create'),isDelete=path.endsWith('/delete');
    const event=isDelete ? null : input(body.event);
    if (!isDelete && !event) return reply({error:'タイトル・日付・時間・メモを確認してください'},400);
    if (!isCreate && (!Number.isSafeInteger(body.version)||body.version<1)) return reply({error:'予定バージョンを確認してください'},400);
    const now=new Date().toISOString();
    const mutation=isCreate ? db.prepare(`INSERT OR IGNORE INTO personal_events(user_id,id,event_date,title,starts_at,ends_at,all_day,note,extra_json,version,created_at,updated_at,last_operation)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1,?10,?10,?11)`).bind(user.id,body.id,event!.date,event!.title,event!.start,event!.end,Number(event!.allDay),event!.note,JSON.stringify(event!.extra),now,body.operationId)
      : isDelete ? db.prepare('UPDATE personal_events SET deleted=1,version=version+1,updated_at=?1,last_operation=?2 WHERE user_id=?3 AND id=?4 AND version=?5 AND deleted=0').bind(now,body.operationId,user.id,body.id,body.version)
      : db.prepare('UPDATE personal_events SET event_date=?1,title=?2,starts_at=?3,ends_at=?4,all_day=?5,note=?6,extra_json=?7,version=version+1,updated_at=?8,last_operation=?9 WHERE user_id=?10 AND id=?11 AND version=?12 AND deleted=0')
        .bind(event!.date,event!.title,event!.start,event!.end,Number(event!.allDay),event!.note,JSON.stringify(event!.extra),now,body.operationId,user.id,body.id,body.version);
    await db.batch([mutation,db.prepare(`INSERT OR IGNORE INTO personal_event_operations(user_id,operation_id,result_json)
      SELECT ?1,?2,event_json FROM personal_event_changes WHERE user_id=?1 AND seq=(SELECT MAX(seq) FROM personal_event_changes WHERE user_id=?1)
      AND EXISTS(SELECT 1 FROM personal_events WHERE user_id=?1 AND id=?3 AND last_operation=?2)`)
      .bind(user.id,body.operationId,body.id),
      ...personalReminderStatementsForOperation(db,user.id,body.id,body.operationId,event,isDelete)]);
    const applied=await db.prepare('SELECT result_json FROM personal_event_operations WHERE user_id=?1 AND operation_id=?2').bind(user.id,body.operationId).first<{result_json:string}>();
    if (applied) return reply({event:JSON.parse(applied.result_json)});
    const row=await db.prepare('SELECT * FROM personal_events WHERE user_id=?1 AND id=?2').bind(user.id,body.id).first<Row>();
    return row ? reply({error:'別の端末で更新または削除されています。変更は端末に保管されています。',event:record(row),conflict:true},409)
      : reply({error:'予定が見つかりません'},404);
  } catch {return reply({error:'予定を同期できませんでした。端末の予定は保管されています。'},500);}
}
