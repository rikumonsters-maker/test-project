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
  it('0019 is additive, defaults to no consent, and preserves foreign keys',async()=>{
    const row=await db.prepare('SELECT COUNT(*) AS count FROM group_named_busy_sharing').first<{count:number}>();
    expect(row?.count).toBe(0);
    const integrity=await db.prepare('PRAGMA foreign_key_check').all();
    expect(integrity.results).toEqual([]);
  });
  it('names in-group busy intervals without legacy consent and ignores old OFF requests',async()=>{
    await db.prepare(`INSERT INTO member_calendar_entries(group_id,member_id,source_type,source_id,event_date,title,starts_at,ends_at,note)
      VALUES(?,?,'shift',?,?,?,'13:00','15:00',?)`)
      .bind(groupId,memberId,crypto.randomUUID(),day,'PRIVATE_EMPLOYER','PRIVATE_SHIFT_NOTE').run();
    await db.prepare('INSERT INTO group_named_busy_sharing(member_id,enabled,updated_at) VALUES(?,0,?)')
      .bind(memberId,'2030-01-01').run();
    const list=()=>api(owner,'/api/shared/events/list',{groupId,month:day.slice(0,7)});
    const anonymous=(await list()).data.events.find((event:any)=>event.sourceType==='busy'&&event.start==='13:00'&&event.end==='15:00');
    expect(anonymous.busyDisplayName).toBe('Member');
    const endpoint='/api/shared/named-busy/timeline';
    const before=await api(owner,endpoint,{groupId,date:day});
    expect(before.status).toBe(200);
    expect(before.data.members.find((row:any)=>row.name==='Member')).toMatchObject({sharing:true,busy:[{start:'13:00',end:'15:00',allDay:false}]});
    expect((await api(outsider,endpoint,{groupId,date:day})).status).toBe(403);
    expect((await api(member,'/api/shared/named-busy/update',{groupId,enabled:true})).status).toBe(200);
    const named=(await list()).data.events.find((event:any)=>event.sourceType==='busy'&&event.start==='13:00'&&event.end==='15:00');
    expect(named.busyDisplayName).toBe('Member');
    expect(JSON.stringify(named)).not.toContain('PRIVATE_EMPLOYER');
    expect(JSON.stringify(named)).not.toContain('PRIVATE_SHIFT_NOTE');
    const enabled=await api(owner,endpoint,{groupId,date:day});
    expect(enabled.data.members.find((row:any)=>row.name==='Member').sharing).toBe(true);
    expect(JSON.stringify(enabled.data)).not.toContain('PRIVATE_SHARED_TITLE');
    expect(JSON.stringify(enabled.data)).not.toContain('PRIVATE_SHARED_NOTE');
    expect((await api(member,'/api/shared/named-busy/update',{groupId,enabled:false})).status).toBe(200);
    expect((await db.prepare('SELECT enabled FROM group_named_busy_sharing WHERE member_id=?').bind(memberId).first<{enabled:number}>())?.enabled).toBe(0);
    expect((await list()).data.events.find((event:any)=>event.sourceType==='busy'&&event.start==='13:00'&&event.end==='15:00').busyDisplayName).toBe('Member');
    expect((await api(owner,endpoint,{groupId,date:day})).data.members.find((row:any)=>row.name==='Member'))
      .toMatchObject({sharing:true,busy:[{start:'13:00',end:'15:00',allDay:false}]});
  });
  it('never carries named busy consent into another group',async()=>{
    const otherGroup=crypto.randomUUID(),otherOwnerMember=crypto.randomUUID(),otherMember=crypto.randomUUID(),otherEvent=crypto.randomUUID();
    await db.batch([
      db.prepare("INSERT INTO groups(id,name,invite_code,created_at) VALUES(?,'Other group',?,'2030-01-01')")
        .bind(otherGroup,crypto.randomUUID()),
      db.prepare("INSERT INTO group_members(id,group_id,user_id,display_name,access_token,created_at) VALUES(?,?,?,'Owner',?,'2030-01-01')")
        .bind(otherOwnerMember,otherGroup,owner.id,crypto.randomUUID()),
      db.prepare("INSERT INTO group_members(id,group_id,user_id,display_name,access_token,created_at) VALUES(?,?,?,'Member',?,'2030-01-01')")
        .bind(otherMember,otherGroup,member.id,crypto.randomUUID()),
      db.prepare("INSERT INTO member_calendar_entries(group_id,member_id,source_type,source_id,event_date,title,starts_at,ends_at) VALUES(?,?,'shift',?,?,'PRIVATE_OTHER_EMPLOYER','17:00','19:00')")
        .bind(otherGroup,otherMember,crypto.randomUUID(),day),
      db.prepare("INSERT INTO shared_events(id,group_id,created_by_member_id,title,event_date,starts_at,ends_at,created_at,updated_at) VALUES(?,?,?,'PRIVATE_OTHER_GROUP_EVENT',?,'18:00','20:00','2030-01-01','2030-01-01')")
        .bind(otherEvent,otherGroup,otherMember,day),
      db.prepare('INSERT INTO shared_event_participants(event_id,user_id) VALUES(?,?)').bind(otherEvent,member.id),
    ]);
    expect((await api(member,'/api/shared/named-busy/update',{groupId,enabled:true})).status).toBe(200);
    const otherList=await api(owner,'/api/shared/events/list',{groupId:otherGroup,month:day.slice(0,7)});
    const otherBusy=otherList.data.events.find((event:any)=>event.sourceType==='busy'&&event.start==='17:00');
    expect(otherBusy.busyDisplayName).toBe('Member');
    expect(JSON.stringify(otherList.data)).not.toContain('PRIVATE_OTHER_EMPLOYER');
    const otherTimeline=await api(owner,'/api/shared/named-busy/timeline',{groupId:otherGroup,date:day});
    expect(otherTimeline.data.members.find((row:any)=>row.name==='Member').sharing).toBe(true);
    const firstTimeline=await api(owner,'/api/shared/named-busy/timeline',{groupId,date:day});
    expect(firstTimeline.data.members.find((row:any)=>row.name==='Member').busy).not.toContainEqual({start:'18:00',end:'20:00',allDay:false});
    const firstList=await api(owner,'/api/shared/events/list',{groupId,month:day.slice(0,7)});
    const anonymousOther=firstList.data.events.find((event:any)=>event.sourceType==='busy'&&event.start==='18:00'&&event.end==='20:00');
    expect(anonymousOther.busyDisplayName).toBeUndefined();
    expect(JSON.stringify(firstList.data)).not.toContain('PRIVATE_OTHER_GROUP_EVENT');
    expect((await api(member,'/api/shared/named-busy/update',{groupId,enabled:false})).status).toBe(200);
  });
  it('rejects invalid ranges, durations, outsiders and departed members',async()=>{
    const ids=[owner.id,member.id];
    expect((await search(owner,ids,{endDate:'2030-10-16'})).status).toBe(400);
    expect((await search(owner,ids,{durationMinutes:390})).status).toBe(400);
    expect((await search(owner,ids,{durationMinutes:75})).status).toBe(400);
    expect((await search(owner,[owner.id,outsider.id])).status).toBe(403);
    expect((await search(outsider,ids)).status).toBe(401);
    expect((await search(owner,ids,{windowStart:1300,windowEnd:1320})).status).toBe(400);
    const hours=await search(owner,ids,{windowStart:600,windowEnd:780,excludePast:true});
    expect(hours.status).toBe(200);
    expect(hours.data.days[0].slots.every((slot:{start:string;end:string})=>slot.start>='10:00'&&slot.end<='13:00')).toBe(true);
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
    expect((await api(owner,'/api/shared/named-busy/update',{groupId,enabled:true})).status).toBe(200);
    const namedPersonal=await api(member,'/api/shared/events/list',{groupId,month:day.slice(0,7)});
    const busyPersonal=namedPersonal.data.events.find((event:any)=>event.sourceType==='busy'&&event.start==='11:00'&&event.end==='12:00');
    expect(busyPersonal.busyDisplayName).toBe('Owner');
    expect(JSON.stringify(namedPersonal.data)).not.toContain('PRIVATE_PERSONAL_TITLE');
    expect(JSON.stringify(namedPersonal.data)).not.toContain('PRIVATE_PERSONAL_NOTE');
    expect((await api(owner,'/api/shared/named-busy/update',{groupId,enabled:false})).status).toBe(200);
    const single=await api(owner,'/api/shared/availability',{groupId,userId:member.id,date:day});
    expect(single.status).toBe(200);
    expect(single.data.busy).toContainEqual({start:'00:00',end:'10:00',label:'予定あり'});
  });

  it('does not expose a departed member or revive old coverage on rejoin',async()=>{
    expect((await api(member,'/api/shared/named-busy/update',{groupId,enabled:true})).status).toBe(200);
    await db.prepare('UPDATE group_members SET left_at=?1,departed_user_id=user_id,user_id=NULL WHERE id=?2')
      .bind('2030-10-03',memberId).run();
    expect((await api(member,'/api/shared/events/list',{groupId,month:day.slice(0,7)})).status).toBe(401);
    expect((await api(owner,'/api/shared/named-busy/timeline',{groupId,date:day})).data.members
      .some((row:any)=>row.name==='Member')).toBe(false);
    expect((await search(owner,[owner.id,member.id])).status).toBe(403);
    expect((await search(member,[owner.id,member.id])).status).toBe(401);
    const newMemberId=crypto.randomUUID();
    await db.prepare("INSERT INTO group_members(id,group_id,user_id,display_name,access_token,created_at) VALUES(?1,?2,?3,'Member',?4,'2030-10-04')")
      .bind(newMemberId,groupId,member.id,crypto.randomUUID()).run();
    const after=await search(owner,[owner.id,member.id]);
    expect(after.status).toBe(200);
    expect(after.data.days[0].unconfirmedUserIds).toEqual([member.id]);
    expect((await api(owner,'/api/shared/named-busy/timeline',{groupId,date:day})).data.members
      .find((row:any)=>row.name==='Member').sharing).toBe(true);
  });
});
