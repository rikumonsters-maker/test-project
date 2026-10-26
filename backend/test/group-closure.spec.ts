import {env,createExecutionContext} from 'cloudflare:test';
import {beforeAll,describe,expect,it} from 'vitest';
import {applySQL} from './migration-helper';
import {handleSharedRequest} from '../src/shared';
import {drainScheduleNotices} from '../src/schedule-cron';
import type {SessionUser} from '../src/auth';

const migrations=import.meta.glob('../migrations/*.sql',{query:'?raw',import:'default',eager:true}) as Record<string,string>;
const db=env.DB;
async function user():Promise<SessionUser>{
  const id=crypto.randomUUID(),email=`${id}@example.test`;
  await db.prepare(`INSERT INTO users(id,email,display_name,password_hash,password_salt,created_at)
    VALUES(?1,?2,'Member','test-only','test-only',?3)`).bind(id,email,new Date().toISOString()).run();
  return {id,email,displayName:'Member'};
}
async function api(who:SessionUser,path:string,body:Record<string,unknown>={}){
  const response=await handleSharedRequest(new Request('https://example.test'+path,{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{DB:db},createExecutionContext(),path,who);
  return {status:response.status,data:await response.json() as any};
}
async function fixture(){
  const owner=await user(),other=await user();
  const created=await api(owner,'/api/groups/create',{name:'Closure test'});
  expect(created.status).toBe(201);
  return {owner,other,group:created.data.membership as {groupId:string;memberId:string;inviteCode:string}};
}
async function count(table:string,groupId:string){
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE group_id=?1`).bind(groupId).first<{n:number}>())!.n;
}
beforeAll(async()=>{for(const key of Object.keys(migrations).sort())await applySQL(db,migrations[key]);});

describe('last member closes a group without deleting history',()=>{
  it('retains events, wishes, schedules and member history while revoking access and notices',async()=>{
    const f=await fixture(),g=f.group.groupId,m=f.group.memberId,now=new Date().toISOString();
    const eventId=crypto.randomUUID(),tentativeId=crypto.randomUUID(),wishId=crypto.randomUUID();
    const scheduleId=crypto.randomUUID(),confirmedPlanId=crypto.randomUUID(),optionId=crypto.randomUUID();
    const deadline=new Date(Date.now()+30*60_000).toISOString();
    await db.prepare(`INSERT INTO shared_events(id,group_id,created_by_member_id,title,event_date,created_at,updated_at)
      VALUES(?1,?2,?3,'Kept event','2030-01-01',?4,?4)`).bind(eventId,g,m,now).run();
    await db.prepare(`INSERT INTO shared_events(id,group_id,created_by_member_id,title,event_date,status,created_at,updated_at)
      VALUES(?1,?2,?3,'Kept tentative','2030-01-02','tentative',?4,?4)`)
      .bind(tentativeId,g,m,now).run();
    await db.prepare(`INSERT INTO group_availability_wishes
      (id,group_id,user_id,wish_date,start_time,end_time,is_all_day,message,created_at,updated_at)
      VALUES(?1,?2,?3,'2030-01-02','','',1,'Kept wish',?4,?4)`).bind(wishId,g,f.owner.id,now).run();
    await db.prepare(`INSERT INTO group_schedules(id,group_id,created_by_user_id,created_by_member_id,
      manager_member_id,title,response_deadline,minimum_participants,client_request_id,created_at,updated_at)
      VALUES(?1,?2,?3,?4,?4,'Kept schedule',?5,1,?6,?7,?7)`)
      .bind(scheduleId,g,f.owner.id,m,deadline,crypto.randomUUID(),now).run();
    await db.batch([
      db.prepare(`INSERT INTO group_schedule_participants(schedule_id,member_id,added_at)
        VALUES(?1,?2,?3)`).bind(scheduleId,m,now),
      db.prepare(`INSERT INTO group_schedule_options(id,schedule_id,event_date,starts_at,ends_at,client_request_id,created_at)
        VALUES(?1,?2,'2030-01-02','12:00','13:00',?3,?4)`)
        .bind(optionId,scheduleId,crypto.randomUUID(),now),
    ]);
    await db.prepare(`INSERT INTO group_schedule_votes(option_id,member_id,response,updated_at)
      VALUES(?1,?2,'yes',?3)`).bind(optionId,m,now).run();
    await db.prepare(`INSERT INTO group_schedules(id,group_id,created_by_user_id,created_by_member_id,
      manager_member_id,title,response_deadline,minimum_participants,client_request_id,state,
      confirmed_event_id,created_at,updated_at)
      VALUES(?1,?2,?3,?4,?4,'Confirmed schedule',?5,1,?6,'confirmed',?7,?8,?8)`)
      .bind(confirmedPlanId,g,f.owner.id,m,deadline,crypto.randomUUID(),eventId,now).run();
    await db.prepare('UPDATE shared_events SET schedule_plan_id=?1 WHERE id=?2')
      .bind(confirmedPlanId,eventId).run();
    const personalId=crypto.randomUUID(),subscriptionId=crypto.randomUUID();
    await db.batch([
      db.prepare(`INSERT INTO personal_events(user_id,id,event_date,title,starts_at,ends_at,all_day,note,
        version,created_at,updated_at,last_operation) VALUES(?1,?2,'2030-01-01','Private event','12:00',
        '13:00',0,'Private note',1,?3,?3,'test')`).bind(f.owner.id,personalId,now),
      db.prepare(`INSERT INTO member_calendar_entries(group_id,member_id,source_type,source_id,event_date,title)
        VALUES(?1,?2,'shift',?3,'2030-01-01','Shift')`).bind(g,m,crypto.randomUUID()),
      db.prepare(`INSERT INTO in_app_notifications(id,user_id,group_id,kind,target_path,dedupe_key,created_at)
        VALUES(?1,?2,?3,'group_joined','/',?4,?5)`)
        .bind(crypto.randomUUID(),f.owner.id,g,crypto.randomUUID(),now),
      db.prepare(`INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,created_at,updated_at)
        VALUES(?1,?2,?3,'test','test',?4,?4)`)
        .bind(subscriptionId,f.owner.id,`https://example.test/${subscriptionId}`,now),
      db.prepare(`INSERT INTO event_reminders(id,scope,user_id,group_id,shared_event_id,offset_minutes,
        time_zone,event_start_at,due_at,created_at)
        VALUES(?1,'shared',?2,?3,?4,60,'Asia/Tokyo','2030-01-01T12:00:00.000Z',
          '2030-01-01T11:00:00.000Z',?5)`)
        .bind(crypto.randomUUID(),f.owner.id,g,eventId,now),
    ]);
    await db.prepare(`INSERT INTO push_deliveries(id,subscription_id,group_id,kind,body,created_at,next_attempt_at)
      VALUES(?1,?2,?3,'group_event_created','generic',?4,?4)`)
      .bind(crypto.randomUUID(),subscriptionId,g,now).run();
    const options=await api(f.owner,'/api/groups/leave/options',{groupId:g});
    expect(options.data).toMatchObject({lastMember:true,groupName:'Closure test'});
    const closed=await api(f.owner,'/api/groups/delete',{groupId:g});
    expect(closed.status).toBe(200);
    expect((await api(f.owner,'/api/groups/delete',{groupId:g})).data).toMatchObject({alreadyClosed:true});
    expect((await api(f.other,'/api/groups/delete',{groupId:g})).status).toBe(403);
    expect((await api(f.owner,'/api/groups/mine')).data.groups).toEqual([]);
    expect((await api(f.owner,'/api/groups/members/list',{groupId:g})).status).toBe(401);
    expect((await api(f.owner,'/api/shared/events/list',{groupId:g,month:'2030-01'})).status).toBe(401);
    expect((await api(f.owner,'/api/groups/schedules/list',{groupId:g})).status).toBe(401);
    for(const [path,body] of [
      ['/api/groups/wishes/list',{groupId:g}],
      ['/api/shared/availability/search',{groupId:g,userIds:[f.owner.id],startDate:'2030-01-01',endDate:'2030-01-01',durationMinutes:60}],
      ['/api/shared/calendar/sync',{groupId:g,month:'2030-01',entries:[]}],
      ['/api/groups/schedules/create',{groupId:g,title:'Denied',participantUserIds:[f.owner.id],options:[]}],
    ] as const)expect((await api(f.owner,path,body)).status).not.toBe(200);
    expect((await api(f.other,'/api/groups/join',{inviteCode:f.group.inviteCode})).status).toBe(404);
    for(const table of ['group_availability_wishes','group_members','member_calendar_entries','in_app_notifications','event_reminders'])
      expect(await count(table,g)).toBe(1);
    expect(await count('shared_events',g)).toBe(2);
    expect(await count('group_schedules',g)).toBe(2);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM group_schedule_votes WHERE option_id=?1')
      .bind(optionId).first<{n:number}>())?.n).toBe(1);
    expect(await count('push_deliveries',g)).toBe(0);
    expect((await db.prepare('SELECT revoked_at FROM in_app_notifications WHERE group_id=?1').bind(g)
      .first<{revoked_at:string|null}>())?.revoked_at).not.toBeNull();
    expect((await db.prepare('SELECT title FROM personal_events WHERE user_id=?1 AND id=?2')
      .bind(f.owner.id,personalId).first<{title:string}>())?.title).toBe('Private event');
    const membership=await db.prepare('SELECT user_id,departed_user_id,left_at FROM group_members WHERE id=?1')
      .bind(m).first<{user_id:string|null;departed_user_id:string;left_at:string|null}>();
    expect(membership).toMatchObject({user_id:null,departed_user_id:f.owner.id});
    expect(membership?.left_at).not.toBeNull();
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    const triggers=await db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
      AND name IN ('group_members_preserve_history','closed_group_event_delete','closed_group_member_insert')`).all<{name:string}>();
    expect(triggers.results).toHaveLength(3);
    await expect(db.prepare('DELETE FROM shared_events WHERE id=?1').bind(eventId).run()).rejects.toThrow();
    await expect(db.prepare(`INSERT INTO group_members(id,group_id,user_id,display_name,access_token,created_at)
      VALUES(?1,?2,?3,'Member',?4,?5)`).bind(crypto.randomUUID(),g,f.other.id,crypto.randomUUID(),now).run()).rejects.toThrow();
    await expect(db.prepare(`INSERT INTO push_deliveries(id,subscription_id,group_id,kind,body,created_at,next_attempt_at)
      VALUES(?1,?2,?3,'group_event_created','generic',?4,?4)`)
      .bind(crypto.randomUUID(),subscriptionId,g,now).run()).rejects.toThrow();
    await expect(db.prepare(`INSERT INTO in_app_notifications(id,user_id,group_id,kind,target_path,dedupe_key,created_at)
      VALUES(?1,?2,?3,'group_joined','/',?4,?5)`)
      .bind(crypto.randomUUID(),f.owner.id,g,crypto.randomUUID(),now).run()).rejects.toThrow();
    await drainScheduleNotices({DB:db} as Parameters<typeof drainScheduleNotices>[0]);
    expect((await db.prepare('SELECT deadline_notified_at FROM group_schedules WHERE id=?1').bind(scheduleId)
      .first<{deadline_notified_at:string|null}>())?.deadline_notified_at).toBeNull();
  });

  it('rejects non-final closure and preserves normal departure',async()=>{
    const f=await fixture();
    expect((await api(f.other,'/api/groups/join',{inviteCode:f.group.inviteCode})).status).toBe(201);
    const closed=await api(f.owner,'/api/groups/delete',{groupId:f.group.groupId});
    expect(closed.status).toBe(409);
    expect(closed.data.code).toBe('GROUP_MEMBER_COUNT_CHANGED');
    expect((await db.prepare('SELECT closed_at FROM groups WHERE id=?1').bind(f.group.groupId)
      .first<{closed_at:string|null}>())?.closed_at).toBeNull();
    expect((await api(f.owner,'/api/groups/leave/options',{groupId:f.group.groupId})).data.lastMember).toBe(false);
    expect((await api(f.other,'/api/groups/leave',{groupId:f.group.groupId})).status).toBe(200);
    expect((await api(f.owner,'/api/groups/members/list',{groupId:f.group.groupId})).status).toBe(200);
  });

  it('blocks a stale join after closure and never partially closes on a racing join',async()=>{
    const f=await fixture(),g=f.group.groupId;
    const [join,close]=await Promise.all([
      api(f.other,'/api/groups/join',{inviteCode:f.group.inviteCode}),
      api(f.owner,'/api/groups/delete',{groupId:g}),
    ]);
    const state=await db.prepare('SELECT closed_at FROM groups WHERE id=?1').bind(g)
      .first<{closed_at:string|null}>();
    const active=await db.prepare('SELECT COUNT(*) AS n FROM active_group_members WHERE group_id=?1')
      .bind(g).first<{n:number}>();
    if(state?.closed_at){expect(close.status).toBe(200);expect(active?.n).toBe(0);expect(join.status).not.toBe(201);}
    else {expect(join.status).toBe(201);expect(close.status).toBe(409);expect(active?.n).toBe(2);}
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('rolls back closure if revoking a membership fails midway',async()=>{
    const f=await fixture(),g=f.group.groupId;
    await db.prepare(`CREATE TRIGGER closure_test_failure BEFORE UPDATE OF left_at ON group_members
      WHEN NEW.group_id='${g}' BEGIN SELECT RAISE(ABORT,'simulated failure'); END`).run();
    try {
      expect((await api(f.owner,'/api/groups/delete',{groupId:g})).status).toBe(409);
      const group=await db.prepare('SELECT closed_at FROM groups WHERE id=?1').bind(g)
        .first<{closed_at:string|null}>();
      expect(group?.closed_at).toBeNull();
      expect((await db.prepare('SELECT COUNT(*) AS n FROM active_group_members WHERE group_id=?1')
        .bind(g).first<{n:number}>())?.n).toBe(1);
      expect((await db.prepare('SELECT COUNT(*) AS n FROM group_closure_assertions')
        .first<{n:number}>())?.n).toBe(0);
    }finally{await db.prepare('DROP TRIGGER closure_test_failure').run();}
  });
});
