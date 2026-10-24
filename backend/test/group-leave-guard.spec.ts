import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applySQL } from './migration-helper';

const migrations = import.meta.glob('../migrations/*.sql', {query:'?raw', import:'default', eager:true}) as Record<string,string>;
const db = env.DB;
const id = () => crypto.randomUUID();
const groupId=id(), ownerId=id(), otherId=id(), ownerMemberId=id(), otherMemberId=id();
const eventId=id(), wishId=id(), otherWishId=id(), subscriptionId=id(), pushId=id(), reminderId=id();

// Exact five-statement DELETE order from the pre-0015 Worker at main 0fcafe6c.
// Its membership read may happen before the guard migration is installed.
function oldLeaveBatch() {
  return db.batch([
    db.prepare(`DELETE FROM group_availability_reactions WHERE user_id = ?1 AND wish_id IN
      (SELECT id FROM group_availability_wishes WHERE group_id = ?2)`).bind(ownerId,groupId),
    db.prepare('DELETE FROM group_availability_wishes WHERE group_id = ?1 AND user_id = ?2').bind(groupId,ownerId),
    db.prepare('DELETE FROM member_calendar_entries WHERE group_id = ?1 AND member_id = ?2').bind(groupId,ownerMemberId),
    db.prepare('DELETE FROM shared_events WHERE group_id = ?1 AND created_by_member_id = ?2').bind(groupId,ownerMemberId),
    db.prepare('DELETE FROM group_members WHERE group_id = ?1 AND id = ?2').bind(groupId,ownerMemberId),
  ]);
}

async function row(table:string, key:string, value:string) {
  return db.prepare(`SELECT 1 FROM ${table} WHERE ${key}=?1`).bind(value).first();
}

beforeAll(async()=>{
  for (const key of Object.keys(migrations).sort().filter(k=>!k.includes('0014a_')&&!k.includes('0015_')))
    await applySQL(db,migrations[key]);
  await db.batch([
    db.prepare("INSERT INTO users(id,email,display_name,password_hash,password_salt,created_at) VALUES(?1,?2,'Owner','test-only','test-only','now')").bind(ownerId,ownerId+'@example.test'),
    db.prepare("INSERT INTO users(id,email,display_name,password_hash,password_salt,created_at) VALUES(?1,?2,'Other','test-only','test-only','now')").bind(otherId,otherId+'@example.test'),
    db.prepare("INSERT INTO groups(id,name,invite_code,created_at) VALUES(?1,'Group',?2,'now')").bind(groupId,id()),
    db.prepare("INSERT INTO group_members(id,group_id,display_name,access_token,created_at,user_id) VALUES(?1,?2,'Owner',?3,'now',?4)").bind(ownerMemberId,groupId,id(),ownerId),
    db.prepare("INSERT INTO group_members(id,group_id,display_name,access_token,created_at,user_id) VALUES(?1,?2,'Other',?3,'now',?4)").bind(otherMemberId,groupId,id(),otherId),
    db.prepare("INSERT INTO group_availability_wishes(id,group_id,user_id,wish_date,created_at,updated_at) VALUES(?1,?2,?3,'2030-10-21','now','now')").bind(wishId,groupId,ownerId),
    db.prepare("INSERT INTO group_availability_wishes(id,group_id,user_id,wish_date,created_at,updated_at) VALUES(?1,?2,?3,'2030-10-22','now','now')").bind(otherWishId,groupId,otherId),
    db.prepare("INSERT INTO group_availability_reactions(wish_id,user_id,created_at) VALUES(?1,?2,'now')").bind(wishId,otherId),
    db.prepare("INSERT INTO group_availability_reactions(wish_id,user_id,created_at) VALUES(?1,?2,'now')").bind(otherWishId,ownerId),
    db.prepare("INSERT INTO member_calendar_entries(group_id,member_id,source_type,source_id,event_date,title) VALUES(?1,?2,'shift','shift-1','2030-10-21','work')").bind(groupId,ownerMemberId),
    db.prepare("INSERT INTO shared_events(id,group_id,created_by_member_id,title,event_date,created_at,updated_at) VALUES(?1,?2,?3,'Keep me','2030-10-21','now','now')").bind(eventId,groupId,ownerMemberId),
    db.prepare("INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,created_at,updated_at) VALUES(?1,?2,?3,'test','test','now','now')").bind(subscriptionId,ownerId,'https://example.test/'+subscriptionId),
    db.prepare("INSERT INTO push_deliveries(id,subscription_id,group_id,kind,body,created_at,next_attempt_at) VALUES(?1,?2,?3,'group_event_created','generic','now','now')").bind(pushId,subscriptionId,groupId),
    db.prepare(`INSERT INTO event_reminders(id,scope,user_id,group_id,shared_event_id,offset_minutes,time_zone,event_start_at,due_at,created_at)
      VALUES(?1,'shared',?2,?3,?4,10,'Asia/Tokyo','2030-10-21T04:00:00.000Z','2030-10-21T03:50:00.000Z','now')`).bind(reminderId,ownerId,groupId,eventId),
  ]);
});

describe('pre-0015 D1 guard against an in-flight old Worker',()=>{
  it('rolls back every old-leave DELETE after its membership read predates the guard',async()=>{
    expect(await db.prepare('SELECT id FROM group_members WHERE group_id=?1 AND user_id=?2')
      .bind(groupId,ownerId).first()).not.toBeNull();
    await applySQL(db,migrations[Object.keys(migrations).find(k=>k.includes('0014a_'))!]);
    await expect(oldLeaveBatch()).rejects.toThrow('group membership must be retained');
    for (const [table,key,value] of [
      ['group_members','id',ownerMemberId],['shared_events','id',eventId],
      ['group_availability_wishes','id',wishId],['member_calendar_entries','source_id','shift-1'],
      ['event_reminders','id',reminderId],['push_deliveries','id',pushId],
    ]) expect(await row(table,key,value)).not.toBeNull();
    expect(await db.prepare('SELECT 1 FROM group_availability_reactions WHERE wish_id=?1 AND user_id=?2')
      .bind(otherWishId,ownerId).first()).not.toBeNull();
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('retains the guard if the next migration fails partway through',async()=>{
    await expect(db.batch([
      db.prepare('ALTER TABLE group_members ADD COLUMN left_at TEXT'),
      db.prepare('SELECT * FROM intentionally_missing_table'),
    ])).rejects.toThrow();
    expect(await db.prepare("SELECT 1 FROM pragma_table_info('group_members') WHERE name='left_at'").first()).toBeNull();
    expect(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='group_members_preserve_history'").first()).not.toBeNull();
    await expect(oldLeaveBatch()).rejects.toThrow('group membership must be retained');
    expect(await row('shared_events','id',eventId)).not.toBeNull();
  });

  it('allows an ordinary event edit and author delete while retaining the member',async()=>{
    const edited=await db.prepare('UPDATE shared_events SET title=?1 WHERE id=?2 AND group_id=?3 AND created_by_member_id=?4')
      .bind('Edited',eventId,groupId,ownerMemberId).run();
    expect(edited.meta.changes).toBe(1);
    const removed=await db.prepare('DELETE FROM shared_events WHERE id=?1 AND group_id=?2 AND created_by_member_id=?3')
      .bind(eventId,groupId,ownerMemberId).run();
    expect(removed.meta.changes).toBeGreaterThanOrEqual(1);
    expect(await row('shared_events','id',eventId)).toBeNull();
    expect(await row('event_reminders','id',reminderId)).toBeNull();
    expect(await row('group_members','id',ownerMemberId)).not.toBeNull();
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
});
