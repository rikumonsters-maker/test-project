import {env,createExecutionContext} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {applySQL} from './migration-helper';
import {handleSharedRequest} from '../src/shared';
import type {SessionUser} from '../src/auth';

const migrations=import.meta.glob('../migrations/*.sql',{query:'?raw',import:'default',eager:true}) as Record<string,string>;
const db=env.DB;
const migration=(name:string)=>migrations[Object.keys(migrations).find(key=>key.includes(name))!];
const count=async(table:string,groupId:string)=>(await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE group_id=?1`)
  .bind(groupId).first<{n:number}>())!.n;

it('rehearses 0015 data through 0016, 0017 and 0018 with old Worker writes blocked',async()=>{
  for(const key of Object.keys(migrations).sort().filter(key=>
    !key.includes('0011_')&&!key.includes('0016_')&&!key.includes('0017_')&&!key.includes('0018_')))
    await applySQL(db,migrations[key]);
  const now=new Date().toISOString(),uid=crypto.randomUUID(),groupId=crypto.randomUUID();
  const memberId=crypto.randomUUID(),eventId=crypto.randomUUID(),wishId=crypto.randomUUID();
  const personalId=crypto.randomUUID(),subscriptionId=crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO users(id,email,display_name,password_hash,password_salt,created_at)
      VALUES(?1,?2,'Rehearsal','test-only','test-only',?3)`).bind(uid,uid+'@example.test',now),
    db.prepare(`INSERT INTO groups(id,name,invite_code,created_at)
      VALUES(?1,'Existing group',?2,?3)`).bind(groupId,'local-'+groupId,now),
    db.prepare(`INSERT INTO group_members(id,group_id,user_id,display_name,access_token,created_at)
      VALUES(?1,?2,?3,'Rehearsal',?4,?5)`).bind(memberId,groupId,uid,crypto.randomUUID(),now),
  ]);
  await db.batch([
    db.prepare(`INSERT INTO shared_events(id,group_id,created_by_member_id,title,event_date,created_at,updated_at)
      VALUES(?1,?2,?3,'Existing shared event','2030-01-01',?4,?4)`)
      .bind(eventId,groupId,memberId,now),
    db.prepare(`INSERT INTO group_availability_wishes(id,group_id,user_id,wish_date,start_time,end_time,
      is_all_day,message,created_at,updated_at)
      VALUES(?1,?2,?3,'2030-01-02','','',1,'Existing wish',?4,?4)`)
      .bind(wishId,groupId,uid,now),
    db.prepare(`INSERT INTO personal_events(user_id,id,event_date,title,starts_at,ends_at,all_day,note,
      version,created_at,updated_at,last_operation)
      VALUES(?1,?2,'2030-01-01','Private title','12:00','13:00',0,'Private note',1,?3,?3,'test')`)
      .bind(uid,personalId,now),
  ]);
  expect(await count('shared_events',groupId)).toBe(1);
  expect(await count('group_availability_wishes',groupId)).toBe(1);
  await applySQL(db,migration('0016_'));
  expect(await count('shared_events',groupId)).toBe(1);
  expect((await db.prepare('SELECT COUNT(*) AS n FROM group_calendar_sync_coverage')
    .first<{n:number}>())?.n).toBe(0);
  await applySQL(db,migration('0017_'));
  expect((await db.prepare('SELECT manager_member_id FROM group_availability_wishes WHERE id=?1')
    .bind(wishId).first<{manager_member_id:string}>())?.manager_member_id).toBe(memberId);
  expect(await count('shared_events',groupId)).toBe(1);
  await applySQL(db,migration('0018_'));
  expect((await db.prepare('SELECT COUNT(*) AS n FROM active_group_members WHERE group_id=?1')
    .bind(groupId).first<{n:number}>())?.n).toBe(1);
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  const guards=await db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN
    ('group_members_preserve_history','orphan_event_delete_guard','group_push_old_worker_claim',
     'scheduled_event_old_worker_update')`).all();
  expect(guards.results).toHaveLength(4);

  const planId=crypto.randomUUID();
  await db.prepare(`INSERT INTO group_schedules(id,group_id,created_by_user_id,created_by_member_id,
    manager_member_id,source_wish_id,title,response_deadline,minimum_participants,
    client_request_id,created_at,updated_at)
    VALUES(?1,?2,?3,?4,?4,?5,'New schedule','2030-01-01T00:00:00.000Z',1,?6,?7,?7)`)
    .bind(planId,groupId,uid,memberId,wishId,crypto.randomUUID(),now).run();
  await db.prepare('UPDATE shared_events SET schedule_plan_id=?1 WHERE id=?2').bind(planId,eventId).run();
  // The deployed 0015 Worker increments management_version on a normal edit.
  await expect(db.prepare(`UPDATE shared_events SET title='Stale old Worker',
    management_version=management_version+1 WHERE id=?1`)
    .bind(eventId).run()).rejects.toThrow();
  await expect(db.prepare(`UPDATE group_availability_wishes SET message='Stale old Worker' WHERE id=?1`)
    .bind(wishId).run()).rejects.toThrow();
  await db.prepare(`UPDATE shared_events SET title='Current Worker',management_version=management_version+1,
    scheduling_write_version=scheduling_write_version+1
    WHERE id=?1`).bind(eventId).run();
  await db.prepare(`UPDATE group_availability_wishes SET message='Current Worker',
    management_version=management_version+1 WHERE id=?1`).bind(wishId).run();
  const deliveryId=crypto.randomUUID();
  await db.prepare(`INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,created_at,updated_at)
    VALUES(?1,?2,?3,'test','test',?4,?4)`)
    .bind(subscriptionId,uid,'https://example.test/'+subscriptionId,now).run();
  await db.prepare(`INSERT INTO push_deliveries(id,subscription_id,group_id,kind,body,created_at,next_attempt_at)
    VALUES(?1,?2,?3,'group_event_created','generic',?4,?4)`)
    .bind(deliveryId,subscriptionId,groupId,now).run();
  const later=new Date(Date.now()+60_000).toISOString();
  await expect(db.prepare('UPDATE push_deliveries SET next_attempt_at=?1 WHERE id=?2')
    .bind(later,deliveryId).run()).rejects.toThrow();
  await db.prepare(`UPDATE push_deliveries SET next_attempt_at=?1,
    delivery_guard_version=delivery_guard_version+1 WHERE id=?2`).bind(later,deliveryId).run();

  const user:SessionUser={id:uid,email:uid+'@example.test',displayName:'Rehearsal'};
  const response=await handleSharedRequest(new Request('https://example.test/api/groups/delete',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groupId}),
  }),{DB:db},createExecutionContext(),'/api/groups/delete',user);
  expect(response.status).toBe(200);
  expect(await count('shared_events',groupId)).toBe(1);
  expect(await count('group_availability_wishes',groupId)).toBe(1);
  expect(await count('group_schedules',groupId)).toBe(1);
  expect(await count('push_deliveries',groupId)).toBe(0);
  expect((await db.prepare('SELECT title,note FROM personal_events WHERE user_id=?1 AND id=?2')
    .bind(uid,personalId).first())).toEqual({title:'Private title',note:'Private note'});
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
});
