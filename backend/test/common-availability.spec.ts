import { env, createExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applySQL } from './migration-helper';
import { handleSharedRequest } from '../src/shared';
import type { SessionUser } from '../src/auth';

const migrations=import.meta.glob('../migrations/*.sql',{query:'?raw',import:'default',eager:true}) as Record<string,string>;
const db=env.DB;
const day='2030-10-02';
let groupId:string;
let owner:SessionUser,member:SessionUser,outsider:SessionUser;
let memberId:string;

async function account(name:string):Promise<SessionUser> {
  const id=crypto.randomUUID(),email=id+'@example.test';
  await db.prepare(`INSERT INTO users(id,email,display_name,password_hash,password_salt,created_at)
    VALUES(?1,?2,?3,'test-only','test-only','2030-01-01')`).bind(id,email,name).run();
  return {id,email,displayName:name};
}
async function api(user:SessionUser,path:string,body:Record<string,unknown>) {
  const request=new Request('https://example.test'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const response=await handleSharedRequest(request,{DB:db},createExecutionContext(),path,user);
  return {status:response.status,data:await response.json() as any};
}
const search=(user:SessionUser,ids:string[],extra:Record<string,unknown>={})=>api(user,'/api/shared/availability/search',
  {groupId,userIds:ids,startDate:day,endDate:day,durationMinutes:60,...extra});

beforeAll(async()=>{
  for (const key of Object.keys(migrations).sort()) await applySQL(db,migrations[key]);
  owner=await account('Owner'); member=await account('Member'); outsider=await account('Outsider');
  groupId=crypto.randomUUID(); memberId=crypto.randomUUID();
  const ownerMemberId=crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO groups(id,name,invite_code,created_at) VALUES(?1,'Test','availability-test','2030-01-01')").bind(groupId),
    db.prepare("INSERT INTO group_members(id,group_id,user_id,display_name,access_token,created_at) VALUES(?1,?2,?3,'Owner',?4,'2030-01-01')")
      .bind(ownerMemberId,groupId,owner.id,crypto.randomUUID()),
    db.prepare("INSERT INTO group_members(id,group_id,user_id,display_name,access_token,created_at) VALUES(?1,?2,?3,'Member',?4,'2030-01-01')")
      .bind(memberId,groupId,member.id,crypto.randomUUID()),
    db.prepare(`INSERT INTO shared_events(id,group_id,created_by_member_id,title,event_date,starts_at,ends_at,note,created_at,updated_at)
      VALUES(?1,?2,?3,'PRIVATE_SHARED_TITLE',?4,'13:00','14:00','PRIVATE_SHARED_NOTE','2030-01-01','2030-01-01')`)
      .bind(crypto.randomUUID(),groupId,ownerMemberId,day),
  ]);
});

describe('common availability Phase 1',()=>{
  it('rejects invalid ranges, durations, outsiders and departed members',async()=>{
    const ids=[owner.id,member.id];
    expect((await search(owner,ids,{endDate:'2030-10-16'})).status).toBe(400);
    expect((await search(owner,ids,{durationMinutes:390})).status).toBe(400);
    expect((await search(owner,ids,{durationMinutes:75})).status).toBe(400);
    expect((await search(owner,[owner.id,outsider.id])).status).toBe(403);
    expect((await search(outsider,ids)).status).toBe(401);
  });

  it('marks missing calendar coverage as unconfirmed, including an empty shift month',async()=>{
    const ids=[owner.id,member.id];
    const unknown=await search(owner,ids);
    expect(unknown.status).toBe(200);
    expect(unknown.data.days[0].unconfirmedUserIds).toEqual(ids);
    expect(unknown.data.days[0].slots[0]).toMatchObject({needsConfirmation:true});
    for (const user of [owner,member]) {
      await db.prepare('INSERT INTO personal_sync_users(user_id,activated_at) VALUES(?1,?2)')
        .bind(user.id,'2030-01-01').run();
      expect((await api(user,'/api/shared/calendar/sync',
        {groupId,month:'2030-10',entries:[],syncShifts:true})).status).toBe(200);
    }
    const known=await search(owner,ids);
    expect(known.data.days[0].unconfirmedUserIds).toEqual([]);
    expect(known.data.days[0].slots[0].needsConfirmation).toBe(false);
    const boundary=await search(owner,ids,{startDate:'2030-10-31',endDate:'2030-11-01'});
    expect(boundary.data.days[0].unconfirmedUserIds).toEqual([]);
    expect(boundary.data.days[1].unconfirmedUserIds).toEqual(ids);
    const monthStart=await search(owner,ids,{startDate:'2030-10-01',endDate:'2030-10-01'});
    expect(monthStart.data.days[0].unconfirmedUserIds).toEqual(ids); // September night shifts are not confirmed.
  });

  it('intersects private events, overnight shifts and shared events without leaking details',async()=>{
    const ids=[owner.id,member.id];
    const ownerMember=await db.prepare('SELECT id FROM active_group_members WHERE group_id=?1 AND user_id=?2')
      .bind(groupId,owner.id).first<{id:string}>();
    await db.batch([
      db.prepare(`INSERT INTO member_calendar_entries(group_id,member_id,source_type,source_id,event_date,title,starts_at,ends_at,note)
        VALUES(?1,?2,'shift','night','2030-10-01','PRIVATE_EMPLOYER','20:00','10:00','PRIVATE_PAY')`)
        .bind(groupId,memberId),
      db.prepare(`INSERT INTO personal_events(user_id,id,event_date,title,starts_at,ends_at,all_day,note,version,created_at,updated_at,last_operation)
        VALUES(?1,'private-event',?2,'PRIVATE_PERSONAL_TITLE','11:00','12:00',0,'PRIVATE_PERSONAL_NOTE',1,'2030-01-01','2030-01-01','test')`)
        .bind(owner.id,day),
    ]);
    expect(ownerMember).not.toBeNull();
    const result=await search(owner,ids);
    const starts=result.data.days[0].slots.map((slot:any)=>slot.start);
    expect(starts).toContain('10:00');
    expect(starts).toContain('12:00');
    expect(starts).toContain('14:30');
    expect(starts).not.toContain('09:00');
    expect(starts).not.toContain('11:00');
    expect(starts).not.toContain('13:00');
    for (const privateText of ['PRIVATE_EMPLOYER','PRIVATE_PAY','PRIVATE_PERSONAL_TITLE','PRIVATE_PERSONAL_NOTE','PRIVATE_SHARED_TITLE','PRIVATE_SHARED_NOTE'])
      expect(JSON.stringify(result.data)).not.toContain(privateText);
    const single=await api(owner,'/api/shared/availability',{groupId,userId:member.id,date:day});
    expect(single.status).toBe(200);
    expect(single.data.busy).toContainEqual({start:'00:00',end:'10:00',label:'予定あり'});
  });

  it('does not expose a departed member or revive old coverage on rejoin',async()=>{
    await db.prepare('UPDATE group_members SET left_at=?1,departed_user_id=user_id,user_id=NULL WHERE id=?2')
      .bind('2030-10-03',memberId).run();
    expect((await search(owner,[owner.id,member.id])).status).toBe(403);
    expect((await search(member,[owner.id,member.id])).status).toBe(401);
    const newMemberId=crypto.randomUUID();
    await db.prepare("INSERT INTO group_members(id,group_id,user_id,display_name,access_token,created_at) VALUES(?1,?2,?3,'Member',?4,'2030-10-04')")
      .bind(newMemberId,groupId,member.id,crypto.randomUUID()).run();
    const after=await search(owner,[owner.id,member.id]);
    expect(after.status).toBe(200);
    expect(after.data.days[0].unconfirmedUserIds).toEqual([member.id]);
  });
});
