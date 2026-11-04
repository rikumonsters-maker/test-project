import { env, createExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applySQL } from './migration-helper';
import { handleSharedRequest } from '../src/shared';
import { isTokyoCleanupTick, removeUnreferencedExpiredWishes, tokyoToday } from '../src/wish-expiry';
import type { SessionUser } from '../src/auth';

const migrations = import.meta.glob('../migrations/*.sql', { query:'?raw', import:'default', eager:true }) as Record<string,string>;
const db = env.DB;
const today = tokyoToday();
const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0,10);
async function user(): Promise<SessionUser> {
  const id=crypto.randomUUID(),email=`${id}@example.test`;
  await db.prepare(`INSERT INTO users(id,email,display_name,password_hash,password_salt,created_at)
    VALUES(?1,?2,'Test user','test','test',?3)`).bind(id,email,new Date().toISOString()).run();
  return {id,email,displayName:'Test user'};
}
async function api(who:SessionUser,path:string,body:Record<string,unknown>) {
  const response=await handleSharedRequest(new Request(`https://example.test${path}`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
  }),{DB:db},createExecutionContext(),path,who);
  return {status:response.status,data:await response.json() as any};
}
beforeAll(async()=>{
  for(const key of Object.keys(migrations).sort().filter(key=>!key.includes('0011_'))) await applySQL(db,migrations[key]);
});

describe('Tokyo wish expiry and retained history',()=>{
  it('uses the Tokyo date at midnight, including month and year changes',()=>{
    expect(tokyoToday(new Date('2026-10-31T14:59:59Z'))).toBe('2026-10-31');
    expect(tokyoToday(new Date('2026-10-31T15:00:00Z'))).toBe('2026-11-01');
    expect(tokyoToday(new Date('2026-12-31T15:00:00Z'))).toBe('2027-01-01');
    expect(isTokyoCleanupTick(Date.parse('2026-10-31T15:05:00Z'))).toBe(true);
    expect(isTokyoCleanupTick(Date.parse('2026-10-31T15:06:00Z'))).toBe(false);
  });
  it('hides expired proposals, rejects stale writes and cleans only unreferenced rows twice safely',async()=>{
    const owner=await user(),other=await user();
    const created=await api(owner,'/api/groups/create',{name:'Expiry test'});
    expect(created.status).toBe(201);
    const groupId=created.data.membership.groupId as string;
    const memberId=created.data.membership.memberId as string;
    const now=new Date().toISOString();
    const bare=crypto.randomUUID(),reacted=crypto.randomUUID(),linked=crypto.randomUUID(),scheduled=crypto.randomUUID(),notified=crypto.randomUUID(),current=crypto.randomUUID();
    for(const [id,date] of [[bare,yesterday],[reacted,yesterday],[linked,yesterday],[scheduled,yesterday],[notified,yesterday],[current,today]]) {
      await db.prepare(`INSERT INTO group_availability_wishes
        (id,group_id,user_id,wish_date,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)`)
        .bind(id,groupId,owner.id,date,now).run();
    }
    await db.prepare(`INSERT INTO group_availability_reactions(wish_id,user_id,created_at)
      VALUES(?1,?2,?3)`).bind(reacted,owner.id,now).run();
    await db.prepare(`INSERT INTO in_app_notifications(id,user_id,group_id,kind,target_path,dedupe_key,created_at)
      VALUES(?1,?2,?3,'wish_created',?4,?5,?6)`)
      .bind(crypto.randomUUID(),owner.id,groupId,`/?wish=${notified}`,crypto.randomUUID(),now).run();
    const eventId=crypto.randomUUID();
    await db.prepare(`INSERT INTO shared_events(id,group_id,created_by_member_id,title,event_date,
      status,created_at,updated_at,wish_id) VALUES(?1,?2,?3,'History',?6,
      'confirmed',?4,?4,?5)`).bind(eventId,groupId,memberId,now,linked,yesterday).run();
    const scheduleId=crypto.randomUUID();
    await db.prepare(`INSERT INTO group_schedules(id,group_id,created_by_user_id,created_by_member_id,
      manager_member_id,source_wish_id,title,response_deadline,minimum_participants,
      client_request_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?4,?5,'History',?6,1,?7,?8,?8)`)
      .bind(scheduleId,groupId,owner.id,memberId,scheduled,new Date(Date.now()+86400000).toISOString(),crypto.randomUUID(),now).run();
    const before=await api(owner,'/api/groups/wishes/list',{groupId});
    expect(before.data.wishes.map((w:any)=>w.id)).toEqual([current]);
    expect((await api(owner,'/api/groups/wishes/create',{groupId,wishDate:yesterday,isAllDay:true})).status).toBe(400);
    expect((await api(owner,'/api/groups/wishes/update',{groupId,wishId:current,wishDate:yesterday,isAllDay:true})).status).toBe(400);
    expect((await api(owner,'/api/groups/wishes/react',{groupId,wishId:reacted})).status).toBe(404);
    expect((await api(other,'/api/groups/wishes/list',{groupId})).status).toBe(401);
    await removeUnreferencedExpiredWishes(db,today);
    await removeUnreferencedExpiredWishes(db,today);
    const remaining=await db.prepare('SELECT id FROM group_availability_wishes WHERE group_id=?1 ORDER BY id').bind(groupId).all<{id:string}>();
    expect(remaining.results.map(r=>r.id).sort()).toEqual([reacted,linked,scheduled,notified,current].sort());
    expect((await db.prepare('SELECT source_wish_id FROM group_schedules WHERE id=?1').bind(scheduleId)
      .first<{source_wish_id:string}>())?.source_wish_id).toBe(scheduled);
    expect((await db.prepare('SELECT status FROM shared_events WHERE id=?1').bind(eventId).first<{status:string}>())?.status).toBe('confirmed');
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
});
