import { env, createExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { applySQL } from './migration-helper';
import { handleSharedRequest } from '../src/shared';
import { handleReminderRequest, drainReminderQueue } from '../src/reminders';
import { handleNotificationRequest } from '../src/notifications';
import { queueGroupNotice, drainPushQueue } from '../src/push';
import type { SessionUser } from '../src/auth';
import { PUBLIC_APP_ORIGIN } from '../src/app-origin';

const migrations = import.meta.glob('../migrations/*.sql', {query:'?raw', import:'default', eager:true}) as Record<string,string>;
const db = env.DB;
const event = { title:'共有予定', eventDate:'2030-10-21', start:'13:00', end:'14:00', allDay:false, note:'共有メモ' };
const request = (path:string, body?:unknown) => new Request('https://example.test'+path, {
  method:body === undefined ? 'GET' : 'POST',
  headers:{ Origin:PUBLIC_APP_ORIGIN, 'Content-Type':'application/json' },
  body:body === undefined ? undefined : JSON.stringify(body),
});
async function api(user:SessionUser, path:string, body:Record<string,unknown>={}) {
  const r = await handleSharedRequest(request(path,body), {DB:db}, createExecutionContext(), path, user);
  return {status:r.status, data:await r.json() as any};
}
async function user():Promise<SessionUser> {
  const id=crypto.randomUUID(), email=id+'@example.test';
  await db.prepare(`INSERT INTO users(id,email,display_name,password_hash,password_salt,created_at)
    VALUES(?1,?2,'Test','test-only','test-only',?3)`).bind(id,email,new Date().toISOString()).run();
  return {id,email,displayName:'Test'};
}
async function fixture() {
  const owner=await user(), member=await user(), outsider=await user();
  const group=(await api(owner,'/api/groups/create',{name:'退会テスト'})).data.membership;
  const joined=(await api(member,'/api/groups/join',{inviteCode:group.inviteCode})).data.membership;
  const id=(await api(owner,'/api/shared/events/create',{...event,groupId:group.groupId})).data.id;
  return {owner,member,outsider,group,joined,id};
}
async function inbox(u:SessionUser) {
  return await (await handleNotificationRequest(request('/api/notifications'),db,'/api/notifications',u)).json() as any;
}
async function reminder(u:SessionUser, groupId:string, eventId:string, get=false) {
  return handleReminderRequest(request('/api/reminders/shared/'+(get?'get':'set'),
    {groupId,eventId,offsetMinutes:[10],timeZone:'Asia/Tokyo'}),db,'/api/reminders/shared/'+(get?'get':'set'),u);
}
let legacy:{owner:SessionUser;groupId:string;memberId:string;eventId:string};
beforeAll(async()=>{
  for(const key of Object.keys(migrations).sort().filter(k=>!k.includes('0015_'))) await applySQL(db,migrations[key]);
  const owner=await user(), groupId=crypto.randomUUID(), memberId=crypto.randomUUID(), eventId=crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO groups(id,name,invite_code,created_at) VALUES(?1,'既存','legacy-migration-test','2026-01-01')").bind(groupId),
    db.prepare("INSERT INTO group_members(id,group_id,user_id,display_name,access_token,created_at) VALUES(?1,?2,?3,'既存','legacy-test-token','2026-01-01')").bind(memberId,groupId,owner.id),
    db.prepare("INSERT INTO shared_events(id,group_id,created_by_member_id,title,event_date,created_at,updated_at) VALUES(?1,?2,?3,'既存共有予定','2030-10-21','2026-01-01','2026-01-01')").bind(eventId,groupId,memberId),
  ]);
  legacy={owner,groupId,memberId,eventId};
  await applySQL(db,migrations[Object.keys(migrations).find(k=>k.includes('0015_'))!]);
});

describe('group departure retention and authorization',()=>{
  it('migrates existing memberships/events without losing data or breaking foreign keys',async()=>{
    expect(await db.prepare('SELECT left_at FROM group_members WHERE id=?1').bind(legacy.memberId).first()).toEqual({left_at:null});
    const listed=await api(legacy.owner,'/api/shared/events/list',{groupId:legacy.groupId,month:'2030-10'});
    expect(listed.data.events[0]).toMatchObject({id:legacy.eventId,title:'既存共有予定',canManage:true,creatorLeft:false});
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('retains events and lets remaining members edit/delete only after the creator leaves',async()=>{
    const f=await fixture();
    const body={...event,groupId:f.group.groupId,id:f.id};
    expect((await api(f.member,'/api/shared/events/update',body)).status).toBe(403);
    expect((await reminder(f.member,f.group.groupId,f.id)).status).toBe(200);
    expect((await api(f.owner,'/api/groups/leave',{groupId:f.group.groupId})).status).toBe(200);
    const listed=await api(f.member,'/api/shared/events/list',{groupId:f.group.groupId,month:'2030-10'});
    expect(listed.data.events.find((e:any)=>e.id===f.id)).toMatchObject({title:event.title,note:event.note,canManage:true,creatorLeft:true});
    expect((await api(f.member,'/api/shared/events/update',{...body,title:'引き継いで編集',start:'15:00',end:'16:00'})).status).toBe(200);
    expect(await db.prepare('SELECT event_start_at FROM event_reminders WHERE shared_event_id=?1').bind(f.id).first()).toEqual({event_start_at:'2030-10-21T06:00:00.000Z'});
    expect((await api(f.outsider,'/api/shared/events/delete',body)).status).toBe(401);
    expect((await api(f.member,'/api/shared/events/delete',body)).status).toBe(200);
    expect(await db.prepare('SELECT id FROM event_reminders WHERE shared_event_id=?1').bind(f.id).first()).toBeNull();
    expect(await db.prepare('SELECT id FROM group_members WHERE id=?1').bind(f.group.memberId).first()).not.toBeNull();
  });

  it('denies every group API and old legacy claim to the departed user',async()=>{
    const f=await fixture();
    const old=await db.prepare('SELECT access_token FROM group_members WHERE id=?1').bind(f.group.memberId).first<{access_token:string}>();
    await api(f.owner,'/api/groups/leave',{groupId:f.group.groupId});
    for(const path of ['members/list','rename','icon','leave','wishes/list','wishes/create','wishes/update','wishes/delete','wishes/react','wishes/unreact','wishes/confirm']) {
      expect((await api(f.owner,'/api/groups/'+path,{groupId:f.group.groupId})).status).toBeGreaterThanOrEqual(400);
    }
    for(const path of ['events/list','events/create','events/update','events/delete','calendar/sync','availability']) {
      expect((await api(f.owner,'/api/shared/'+path,{...event,groupId:f.group.groupId,id:f.id,month:'2030-10',entries:[],userId:f.member.id,date:event.eventDate})).status).toBe(401);
    }
    expect((await api(f.owner,'/api/groups/mine')).data.groups).toEqual([]);
    expect((await api(f.owner,'/api/groups/claim',{groupId:f.group.groupId,memberId:f.group.memberId,memberToken:old!.access_token})).status).toBe(403);
    expect((await reminder(f.owner,f.group.groupId,f.id,true)).status).toBe(404);
    expect((await reminder(f.owner,f.group.groupId,f.id)).status).toBe(404);
    const members=(await api(f.member,'/api/groups/members/list',{groupId:f.group.groupId})).data.members;
    expect(members.map((m:any)=>m.userId)).toEqual([f.member.id]);
    expect((await api(f.member,'/api/shared/availability',{groupId:f.group.groupId,userId:f.owner.id,date:event.eventDate})).status).toBe(403);
  });

  it('rejects the last departure and concurrent attempts without leaving an empty group',async()=>{
    const f=await fixture();
    const result=await Promise.all([f.owner,f.member].map(u=>api(u,'/api/groups/leave',{groupId:f.group.groupId})));
    expect(result.map(r=>r.status).sort()).toEqual([200,409]);
    expect(result.find(r=>r.status===409)?.data.error).toContain('最後のメンバー');
    expect((await db.prepare('SELECT id FROM active_group_members WHERE group_id=?1').bind(f.group.groupId).all()).results).toHaveLength(1);
    expect(await db.prepare('SELECT id FROM shared_events WHERE id=?1').bind(f.id).first()).not.toBeNull();
  });

  it('does not count an unclaimed legacy member as another active account',async()=>{
    const sole=await user();
    const group=(await api(sole,'/api/groups/create',{name:'未引継ぎメンバー'})).data.membership;
    await db.prepare(`INSERT INTO group_members(id,group_id,display_name,access_token,created_at)
      VALUES(?1,?2,'旧端末','legacy-unclaimed-token','2026-01-01')`).bind(crypto.randomUUID(),group.groupId).run();
    const result=await api(sole,'/api/groups/leave',{groupId:group.groupId});
    expect(result.status).toBe(409);
    expect(result.data.error).toContain('最後のメンバー');
  });

  it('rejects departures with an owned wish or tentative event and preserves all records',async()=>{
    const f=await fixture();
    const w=await api(f.owner,'/api/groups/wishes/create',{groupId:f.group.groupId,wishDate:event.eventDate,isAllDay:true});
    const blockedWish=await api(f.owner,'/api/groups/leave',{groupId:f.group.groupId});
    expect(blockedWish.status).toBe(409);
    expect(blockedWish.data.error).toContain('募集があるため');
    await api(f.member,'/api/groups/wishes/react',{groupId:f.group.groupId,wishId:w.data.id});
    expect((await api(f.owner,'/api/groups/leave',{groupId:f.group.groupId})).status).toBe(409);
    expect((await api(f.member,'/api/groups/wishes/list',{groupId:f.group.groupId})).data.wishes[0]).toMatchObject({id:w.data.id,eventStatus:'tentative',reactionCount:1});
    expect(await db.prepare('SELECT left_at FROM group_members WHERE id=?1').bind(f.group.memberId).first()).toEqual({left_at:null});
    await db.prepare("UPDATE shared_events SET status='tentative' WHERE id=?1").bind(f.id).run();
    // Test an independent tentative record without altering or deleting a wish.
    const other=await fixture();
    await db.prepare("UPDATE shared_events SET status='tentative' WHERE id=?1").bind(other.id).run();
    const blockedTentative=await api(other.owner,'/api/groups/leave',{groupId:other.group.groupId});
    expect(blockedTentative.status).toBe(409);
    expect(blockedTentative.data.error).toContain('仮予定があるため');
  });

  it('revokes old reactions, participation, reminders and inbox on rejoin without restoring old membership',async()=>{
    const f=await fixture();
    const w=await api(f.owner,'/api/groups/wishes/create',{groupId:f.group.groupId,wishDate:event.eventDate,isAllDay:true});
    await api(f.member,'/api/groups/wishes/react',{groupId:f.group.groupId,wishId:w.data.id});
    const confirmed=await api(f.owner,'/api/groups/wishes/confirm',{groupId:f.group.groupId,wishId:w.data.id,...event,participantUserIds:[f.owner.id,f.member.id]});
    expect(confirmed.status).toBe(200);
    expect((await reminder(f.member,f.group.groupId,confirmed.data.eventId)).status).toBe(200);
    const oldNotices=(await inbox(f.member)).notifications.map((n:any)=>n.id);
    expect(oldNotices.length).toBeGreaterThan(0);
    expect((await api(f.member,'/api/groups/leave',{groupId:f.group.groupId})).status).toBe(200);
    expect((await inbox(f.member)).notifications).toEqual([]);
    const rejoined=(await api(f.member,'/api/groups/join',{inviteCode:f.group.inviteCode})).data.membership;
    expect(rejoined.memberId).not.toBe(f.joined.memberId);
    expect((await inbox(f.member)).notifications.some((n:any)=>oldNotices.includes(n.id))).toBe(false);
    expect((await api(f.member,'/api/groups/wishes/list',{groupId:f.group.groupId})).data.wishes[0]).toMatchObject({reactionCount:0,reacted:false});
    expect((await reminder(f.member,f.group.groupId,confirmed.data.eventId)).status).toBe(404);
    expect((await db.prepare('SELECT * FROM event_reminders WHERE user_id=?1 AND group_id=?2').bind(f.member.id,f.group.groupId).all()).results).toEqual([]);
    expect((await api(f.member,'/api/shared/events/update',{...event,groupId:f.group.groupId,id:confirmed.data.eventId})).status).toBe(403);
    // Explicit new reaction is allowed, but is not an automatic participant restore.
    expect((await api(f.member,'/api/groups/wishes/react',{groupId:f.group.groupId,wishId:w.data.id})).status).toBe(200);
    expect((await reminder(f.member,f.group.groupId,confirmed.data.eventId)).status).toBe(404);
  });

  it('retains personal/shift data but hides departed users from group calendars and future queueing',async()=>{
    const f=await fixture();
    await db.prepare(`INSERT INTO member_calendar_entries(group_id,member_id,source_type,source_id,event_date,title,starts_at,ends_at,note)
      VALUES(?1,?2,'shift','shift-test',?3,'PRIVATE_WORK','10:00','12:00','PRIVATE_SALARY')`).bind(f.group.groupId,f.group.memberId,event.eventDate).run();
    await db.prepare('INSERT INTO personal_sync_users(user_id,activated_at) VALUES(?1,?2)').bind(f.owner.id,new Date().toISOString()).run();
    await db.prepare(`INSERT INTO personal_events(user_id,id,event_date,title,starts_at,ends_at,all_day,note,extra_json,version,deleted,created_at,updated_at,last_operation)
      VALUES(?1,'private',?2,'PRIVATE_TITLE','16:00','17:00',0,'PRIVATE_NOTE','{}',1,0,?3,?3,'test-only')`)
      .bind(f.owner.id,event.eventDate,new Date().toISOString()).run();
    const before=await api(f.member,'/api/shared/events/list',{groupId:f.group.groupId,month:'2030-10'});
    expect(JSON.stringify(before.data)).not.toMatch(/PRIVATE_/);
    await api(f.owner,'/api/groups/leave',{groupId:f.group.groupId});
    const after=await api(f.member,'/api/shared/events/list',{groupId:f.group.groupId,month:'2030-10'});
    expect(after.data.events).toHaveLength(1);
    expect(await db.prepare('SELECT id FROM personal_events WHERE user_id=?1').bind(f.owner.id).first()).not.toBeNull();
    expect(await db.prepare('SELECT source_id FROM member_calendar_entries WHERE member_id=?1').bind(f.group.memberId).first()).not.toBeNull();
    await queueGroupNotice({DB:db},f.group.groupId,f.member.id,{kind:'group_event_created',body:'test'},'after-leave:'+f.id);
    expect((await inbox(f.owner)).notifications).toEqual([]);
    await api(f.owner,'/api/groups/join',{inviteCode:f.group.inviteCode});
    const rejoined=await api(f.member,'/api/shared/events/list',{groupId:f.group.groupId,month:'2030-10'});
    expect(JSON.stringify(rejoined.data)).not.toMatch(/PRIVATE_/);
    expect(rejoined.data.events.filter((e:any)=>e.sourceType==='busy')).toHaveLength(1); // personal busy only; old shift mirror stays inactive
  });

  it('blocks stale inserts after departure and leaves foreign keys valid',async()=>{
    const f=await fixture();
    await api(f.owner,'/api/groups/leave',{groupId:f.group.groupId});
    await expect(db.prepare(`INSERT INTO shared_events(id,group_id,created_by_member_id,title,event_date,created_at,updated_at)
      VALUES(?1,?2,?3,'late','2030-10-21','now','now')`).bind(crypto.randomUUID(),f.group.groupId,f.group.memberId).run()).rejects.toThrow('inactive group membership');
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('removes queued group Push and shared reminders but preserves personal reminder settings',async()=>{
    const f=await fixture();
    const personalId=crypto.randomUUID(), personalReminder=crypto.randomUUID();
    await db.prepare(`INSERT INTO personal_events(user_id,id,event_date,title,starts_at,ends_at,all_day,note,version,created_at,updated_at,last_operation)
      VALUES(?1,?2,'2030-10-21','Private','13:00','14:00',0,'Private',1,'now','now','local-test')`).bind(f.member.id,personalId).run();
    await db.prepare(`INSERT INTO event_reminders(id,scope,user_id,personal_event_id,offset_minutes,time_zone,event_start_at,due_at,created_at)
      VALUES(?1,'personal',?2,?3,10,'Asia/Tokyo','2030-10-21T04:00:00.000Z','2030-10-21T03:50:00.000Z','now')`)
      .bind(personalReminder,f.member.id,personalId).run();
    expect((await reminder(f.member,f.group.groupId,f.id)).status).toBe(200);
    const rid=(await db.prepare('SELECT id FROM event_reminders WHERE user_id=?1 AND shared_event_id=?2').bind(f.member.id,f.id).first<{id:string}>())!.id;
    const sid=crypto.randomUUID();
    await db.prepare("INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,created_at,updated_at) VALUES(?1,?2,?3,'test','test','now','now')").bind(sid,f.member.id,'https://example.test/'+sid).run();
    await db.prepare(`INSERT INTO push_deliveries(id,subscription_id,group_id,kind,body,created_at,next_attempt_at,scope,reminder_id)
      VALUES(?1,?2,?3,'event_reminder','generic','2000-01-01','2000-01-01','group',?4)`).bind(crypto.randomUUID(),sid,f.group.groupId,rid).run();
    await api(f.member,'/api/groups/leave',{groupId:f.group.groupId});
    expect((await db.prepare('SELECT id FROM push_deliveries WHERE subscription_id=?1').bind(sid).all()).results).toEqual([]);
    expect(await db.prepare('SELECT id FROM event_reminders WHERE id=?1').bind(rid).first()).toBeNull();
    expect(await db.prepare('SELECT id FROM event_reminders WHERE id=?1').bind(personalReminder).first()).not.toBeNull();
    expect(await db.prepare('SELECT id FROM push_subscriptions WHERE id=?1').bind(sid).first()).not.toBeNull();
    const fetchMock=vi.fn(()=>Promise.resolve(new Response(null,{status:201})));
    vi.stubGlobal('fetch',fetchMock);
    try {
      await drainReminderQueue({DB:db});
      await drainPushQueue({DB:db,VAPID_PUBLIC_KEY:'test',VAPID_PRIVATE_KEY:'test',VAPID_SUBJECT:'mailto:test@example.test'});
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('Cron refuses a stale shared reminder for a departed user even if a row reappears',async()=>{
    const f=await fixture();
    await api(f.member,'/api/groups/leave',{groupId:f.group.groupId});
    const id=crypto.randomUUID();
    await db.prepare(`INSERT INTO event_reminders(id,scope,user_id,group_id,shared_event_id,offset_minutes,time_zone,event_start_at,due_at,created_at)
      VALUES(?1,'shared',?2,?3,?4,10,'Asia/Tokyo','2030-10-21T04:00:00.000Z','2000-01-01T00:00:00.000Z',?5)`)
      .bind(id,f.member.id,f.group.groupId,f.id,new Date().toISOString()).run();
    await drainReminderQueue({DB:db});
    expect(await db.prepare('SELECT queued_at FROM event_reminders WHERE id=?1').bind(id).first()).toEqual({queued_at:null});
    expect((await inbox(f.member)).notifications).toEqual([]);
  });

  it('rejoin never reclaims the historical creator member ID',async()=>{
    const f=await fixture();
    await api(f.owner,'/api/groups/leave',{groupId:f.group.groupId});
    const rejoined=(await api(f.owner,'/api/groups/join',{inviteCode:f.group.inviteCode})).data.membership;
    expect(rejoined.memberId).not.toBe(f.group.memberId);
    expect((await db.prepare('SELECT id FROM active_group_members WHERE group_id=?1 AND user_id=?2').bind(f.group.groupId,f.owner.id).all()).results).toHaveLength(1);
    const listed=await api(f.owner,'/api/shared/events/list',{groupId:f.group.groupId,month:'2030-10'});
    expect(listed.data.events[0]).toMatchObject({createdByMemberId:f.group.memberId,creatorLeft:true,canManage:true});
    // The rejoined user has only the same confirmed-orphan permission as everyone else.
    await db.prepare("UPDATE shared_events SET status='tentative' WHERE id=?1").bind(f.id).run();
    expect((await api(f.owner,'/api/shared/events/update',{...event,groupId:f.group.groupId,id:f.id})).status).toBe(403);
  });
});
