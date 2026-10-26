import {env,createExecutionContext} from 'cloudflare:test';
import {beforeAll,describe,expect,it} from 'vitest';
import {applySQL} from './migration-helper';
import {handleSharedRequest} from '../src/shared';
import {handleNotificationRequest} from '../src/notifications';
import {drainScheduleNotices} from '../src/schedule-cron';
import {queueScheduleNotice} from '../src/schedule-notices';
import {drainPushQueue} from '../src/push';
import type {SessionUser} from '../src/auth';

const migrations=import.meta.glob('../migrations/*.sql',{query:'?raw',import:'default',eager:true}) as Record<string,string>;
const db=env.DB;
const request=(path:string,body?:unknown)=>new Request('https://example.test'+path,{
  method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},
  body:body===undefined?undefined:JSON.stringify(body),
});
async function api(user:SessionUser,path:string,body:Record<string,unknown>={}){
  const response=await handleSharedRequest(request(path,body),{DB:db},createExecutionContext(),path,user);
  return {status:response.status,data:await response.json() as any};
}
async function user(name:string):Promise<SessionUser>{
  const id=crypto.randomUUID(),email=id+'@example.test';
  await db.prepare(`INSERT INTO users(id,email,display_name,password_hash,password_salt,created_at)
    VALUES(?1,?2,?3,'test-only','test-only',?4)`).bind(id,email,name,new Date().toISOString()).run();
  return {id,email,displayName:name};
}
async function fixture(){
  const owner=await user('作成者'),member=await user('参加者'),other=await user('第三者');
  const group=(await api(owner,'/api/groups/create',{name:'日程調整テスト'})).data.membership;
  await api(member,'/api/groups/join',{inviteCode:group.inviteCode});
  return {owner,member,other,group};
}
const due=()=>new Date(Date.now()+3*86400000).toISOString();
async function create(f:Awaited<ReturnType<typeof fixture>>,extra:Record<string,unknown>={}){
  return api(f.owner,'/api/groups/schedules/create',{
    groupId:f.group.groupId,title:'調整テスト',description:'説明はグループ内限定',
    responseDeadline:due(),participantUserIds:[f.owner.id,f.member.id],minimumParticipants:2,
    options:[{date:'2030-10-21',start:'13:00',end:'15:00'}],clientRequestId:crypto.randomUUID(),...extra,
  });
}
async function get(f:Awaited<ReturnType<typeof fixture>>,id:string,who=f.owner){
  return api(who,'/api/groups/schedules/get',{groupId:f.group.groupId,scheduleId:id});
}
async function inbox(user:SessionUser){
  return await (await handleNotificationRequest(request('/api/notifications'),db,'/api/notifications',user)).json() as any;
}
let legacy:{wishId:string;memberId:string};
beforeAll(async()=>{
  for(const key of Object.keys(migrations).sort().filter(key=>!key.includes('0017_')&&!key.includes('0018_'))) await applySQL(db,migrations[key]);
  const creator=await user('移行前の作成者'),groupId=crypto.randomUUID(),memberId=crypto.randomUUID(),wishId=crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO groups(id,name,invite_code,created_at) VALUES(?1,'既存','schedule-legacy','2026-01-01')`).bind(groupId),
    db.prepare(`INSERT INTO group_members(id,group_id,user_id,display_name,access_token,created_at)
      VALUES(?1,?2,?3,'既存','local-test','2026-01-01')`).bind(memberId,groupId,creator.id),
    db.prepare(`INSERT INTO group_availability_wishes
      (id,group_id,user_id,wish_date,start_time,end_time,is_all_day,message,created_at,updated_at)
      VALUES(?1,?2,?3,'2030-10-21','','',1,'既存募集','2026-01-01','2026-01-01')`).bind(wishId,groupId,creator.id),
  ]);
  legacy={wishId,memberId};
  await applySQL(db,migrations[Object.keys(migrations).find(key=>key.includes('0017_'))!]);
  await applySQL(db,migrations[Object.keys(migrations).find(key=>key.includes('0018_'))!]);
});

describe('group scheduling and departure',()=>{
  it('backfills old wishes and preserves foreign keys',async()=>{
    expect(await db.prepare('SELECT manager_member_id,management_state FROM group_availability_wishes WHERE id=?1')
      .bind(legacy.wishId).first()).toEqual({manager_member_id:legacy.memberId,management_state:'open'});
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
  it('creates once, scopes details, and stores generic inbox notices without Push permission',async()=>{
    const f=await fixture(),clientRequestId=crypto.randomUUID();
    const first=await create(f,{clientRequestId});expect(first.status).toBe(201);
    const retry=await create(f,{clientRequestId});expect(retry.data).toMatchObject({id:first.data.id,replayed:true});
    expect((await api(f.other,'/api/groups/schedules/get',{groupId:f.group.groupId,scheduleId:first.data.id})).status).toBe(401);
    expect((await get(f,first.data.id,f.member)).status).toBe(200);
    const notices=await inbox(f.member);
    expect(notices.notifications.some((n:any)=>n.kind==='schedule_started'&&n.targetPath.includes(first.data.id))).toBe(true);
    expect(JSON.stringify(notices)).not.toContain('説明はグループ内限定');
    expect((await db.prepare('SELECT COUNT(*) AS n FROM group_schedules WHERE id=?1').bind(first.data.id).first<{n:number}>())?.n).toBe(1);
  });
  it('uses cross-midnight shifts and private events for ranking without returning their contents',async()=>{
    const f=await fixture(),now=new Date().toISOString();
    await db.batch([
      db.prepare('INSERT INTO personal_sync_users(user_id,activated_at) VALUES(?1,?2)').bind(f.member.id,now),
      db.prepare(`INSERT INTO personal_events(user_id,id,event_date,title,starts_at,ends_at,all_day,note,
        version,created_at,updated_at,last_operation) VALUES(?1,?2,'2030-10-21','PRIVATE_TITLE','12:00','13:00',0,
        'PRIVATE_NOTE',1,?3,?3,'test')`).bind(f.member.id,crypto.randomUUID(),now),
      db.prepare(`INSERT INTO member_calendar_entries(group_id,member_id,source_type,source_id,event_date,title,
        starts_at,ends_at,all_day,note) VALUES(?1,?2,'shift',?3,'2030-10-20','PRIVATE_EMPLOYER',
        '21:00','11:00',0,'PRIVATE_PAY')`).bind(f.group.groupId,(await db.prepare(
        'SELECT id FROM active_group_members WHERE group_id=?1 AND user_id=?2').bind(f.group.groupId,f.member.id)
        .first<{id:string}>())!.id,crypto.randomUUID()),
    ]);
    const search=await api(f.owner,'/api/shared/availability/search',{groupId:f.group.groupId,
      userIds:[f.owner.id,f.member.id],startDate:'2030-10-21',endDate:'2030-10-21',durationMinutes:60});
    expect(search.status).toBe(200);
    expect(search.data.days[0].slots.some((slot:any)=>slot.start==='09:00'||slot.start==='10:00'||slot.start==='12:00')).toBe(false);
    for(const secret of ['PRIVATE_TITLE','PRIVATE_NOTE','PRIVATE_EMPLOYER','PRIVATE_PAY'])
      expect(JSON.stringify(search.data)).not.toContain(secret);
    expect((await api(f.other,'/api/shared/availability/search',{groupId:f.group.groupId,
      userIds:[f.owner.id,f.member.id],startDate:'2030-10-21',endDate:'2030-10-21',durationMinutes:60})).status).toBe(401);
  });
  it('supports vote changes, confirmed maybe, option replacement, and finalization after deadline',async()=>{
    const f=await fixture(),created=await create(f),id=created.data.id;
    expect(created.status).toBe(201);
    const initial=(await get(f,id)).data.schedule.options[0].id;
    expect((await api(f.member,'/api/groups/schedules/vote',{groupId:f.group.groupId,scheduleId:id,
      optionId:initial,response:'no'})).status).toBe(200);
    expect((await api(f.owner,'/api/groups/schedules/confirm',{groupId:f.group.groupId,scheduleId:id,
      optionId:initial,participantUserIds:[f.owner.id,f.member.id]})).status).toBe(409);
    const replaced=await api(f.owner,'/api/groups/schedules/options/replace',{groupId:f.group.groupId,
      scheduleId:id,optionId:initial,option:{date:'2030-10-22',start:'14:00',end:'16:00'},clientRequestId:crypto.randomUUID()});
    expect(replaced.status).toBe(201);
    for(const [who,response] of [[f.owner,'yes'],[f.member,'maybe']] as const)
      expect((await api(who,'/api/groups/schedules/vote',{groupId:f.group.groupId,scheduleId:id,
        optionId:replaced.data.id,response})).status).toBe(200);
    expect((await api(f.owner,'/api/groups/schedules/confirm',{groupId:f.group.groupId,scheduleId:id,
      optionId:replaced.data.id,participantUserIds:[f.owner.id,f.member.id]})).status).toBe(409);
    expect((await api(f.member,'/api/groups/schedules/vote/confirm-maybe',{groupId:f.group.groupId,
      scheduleId:id,optionId:replaced.data.id})).status).toBe(200);
    await db.prepare('UPDATE group_schedules SET response_deadline=?1 WHERE id=?2')
      .bind(new Date(Date.now()-1000).toISOString(),id).run();
    expect((await api(f.member,'/api/groups/schedules/vote',{groupId:f.group.groupId,scheduleId:id,
      optionId:replaced.data.id,response:'yes'})).status).toBe(409);
    const confirmed=await api(f.owner,'/api/groups/schedules/confirm',{groupId:f.group.groupId,scheduleId:id,
      optionId:replaced.data.id,participantUserIds:[f.owner.id,f.member.id]});
    expect(confirmed.status).toBe(200);
    expect((await api(f.owner,'/api/groups/schedules/confirm',{groupId:f.group.groupId,scheduleId:id,
      optionId:replaced.data.id,participantUserIds:[f.owner.id,f.member.id]})).data.replayed).toBe(true);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM shared_events WHERE schedule_plan_id=?1').bind(id).first<{n:number}>())?.n).toBe(1);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
  it('edits a live poll, adds and removes options, and cancels without losing history',async()=>{
    const f=await fixture(),created=await create(f),id=created.data.id,first=(await get(f,id)).data.schedule.options[0].id;
    expect((await api(f.member,'/api/groups/schedules/update',{groupId:f.group.groupId,scheduleId:id,
      title:'不正編集',description:'',responseDeadline:due()})).status).toBe(403);
    expect((await api(f.owner,'/api/groups/schedules/update',{groupId:f.group.groupId,scheduleId:id,
      title:'更新済み',description:'説明を更新',responseDeadline:due()})).status).toBe(200);
    const clientRequestId=crypto.randomUUID(),payload={groupId:f.group.groupId,scheduleId:id,
      option:{date:'2030-10-22',start:'14:00',end:'16:00'},clientRequestId};
    const added=await api(f.owner,'/api/groups/schedules/options/add',payload);expect(added.status).toBe(201);
    expect((await api(f.owner,'/api/groups/schedules/options/add',payload)).data.replayed).toBe(true);
    expect((await api(f.owner,'/api/groups/schedules/options/cancel',{
      groupId:f.group.groupId,scheduleId:id,optionId:first})).status).toBe(200);
    expect((await api(f.owner,'/api/groups/schedules/options/cancel',{
      groupId:f.group.groupId,scheduleId:id,optionId:added.data.id})).status).toBe(409);
    expect((await api(f.member,'/api/groups/schedules/vote',{groupId:f.group.groupId,
      scheduleId:id,optionId:first,response:'yes'})).status).toBe(409);
    expect((await api(f.owner,'/api/groups/schedules/cancel',{groupId:f.group.groupId,scheduleId:id})).status).toBe(200);
    expect((await api(f.owner,'/api/groups/schedules/cancel',{groupId:f.group.groupId,scheduleId:id})).data.replayed).toBe(true);
    const plan=(await get(f,id)).data.schedule;
    expect(plan).toMatchObject({title:'更新済み',state:'cancelled'});
    expect(plan.options).toHaveLength(2);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
  it('rejects new hard conflicts at finalization',async()=>{
    const f=await fixture(),created=await create(f),id=created.data.id,option=(await get(f,id)).data.schedule.options[0].id;
    for(const who of [f.owner,f.member])await api(who,'/api/groups/schedules/vote',{
      groupId:f.group.groupId,scheduleId:id,optionId:option,response:'yes'});
    await api(f.owner,'/api/shared/events/create',{groupId:f.group.groupId,title:'重複',eventDate:'2030-10-21',
      start:'14:00',end:'15:00',allDay:false,note:''});
    expect((await api(f.owner,'/api/groups/schedules/confirm',{groupId:f.group.groupId,scheduleId:id,
      optionId:option,participantUserIds:[f.owner.id,f.member.id]})).status).toBe(409);
    expect(await db.prepare('SELECT id FROM shared_events WHERE schedule_plan_id=?1').bind(id).first()).toBeNull();
  });
  it('retains a confirmed schedule event after its creator leaves and lets a remaining member cancel it',async()=>{
    const f=await fixture(),created=await create(f),id=created.data.id,option=(await get(f,id)).data.schedule.options[0].id;
    for(const who of [f.owner,f.member])expect((await api(who,'/api/groups/schedules/vote',{
      groupId:f.group.groupId,scheduleId:id,optionId:option,response:'yes'})).status).toBe(200);
    expect((await api(f.owner,'/api/groups/schedules/confirm',{groupId:f.group.groupId,scheduleId:id,
      optionId:option,participantUserIds:[f.owner.id,f.member.id]})).status).toBe(200);
    expect((await api(f.owner,'/api/groups/leave',{groupId:f.group.groupId})).status).toBe(200);
    expect((await api(f.owner,'/api/shared/events/list',{groupId:f.group.groupId,month:'2030-10'})).status).toBe(401);
    expect((await api(f.member,'/api/shared/events/delete',{groupId:f.group.groupId,id})).status).toBe(200);
    expect((await db.prepare('SELECT cancelled_at FROM shared_events WHERE schedule_plan_id=?1')
      .bind(id).first<{cancelled_at:string|null}>())?.cancelled_at).toBeTruthy();
    expect((await db.prepare('SELECT state FROM group_schedules WHERE id=?1').bind(id).first<{state:string}>())?.state).toBe('cancelled');
    const listed=await api(f.member,'/api/shared/events/list',{groupId:f.group.groupId,month:'2030-10'});
    expect(listed.data.events.some((event:any)=>event.id===id)).toBe(false);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
  it('converts a wish without deleting its reactions and retires its tentative event on confirmation',async()=>{
    const f=await fixture();
    const wish=(await api(f.owner,'/api/groups/wishes/create',{groupId:f.group.groupId,
      wishDate:'2030-10-21',isAllDay:true,message:'元の募集'})).data.id;
    expect((await api(f.member,'/api/groups/wishes/react',{groupId:f.group.groupId,wishId:wish})).status).toBe(200);
    const old=await db.prepare("SELECT id FROM shared_events WHERE wish_id=?1 AND status='tentative'")
      .bind(wish).first<{id:string}>();expect(old).not.toBeNull();
    const created=await create(f,{sourceWishId:wish});expect(created.status).toBe(201);
    expect((await db.prepare('SELECT management_state FROM group_availability_wishes WHERE id=?1')
      .bind(wish).first<{management_state:string}>())?.management_state).toBe('converted');
    expect((await db.prepare('SELECT COUNT(*) AS n FROM group_availability_reactions WHERE wish_id=?1')
      .bind(wish).first<{n:number}>())?.n).toBe(1);
    await expect(db.prepare('DELETE FROM shared_events WHERE id=?1').bind(old!.id).run())
      .rejects.toThrow('closed wish event must be retained');
    await expect(db.prepare("UPDATE shared_events SET title='stale old Worker' WHERE id=?1")
      .bind(old!.id).run()).rejects.toThrow('closed wish event must be retained');
    expect((await api(f.owner,'/api/groups/wishes/update',{groupId:f.group.groupId,wishId:wish,
      wishDate:'2030-10-22',isAllDay:true,message:'変更'})).status).toBe(403);
    const option=(await get(f,created.data.id)).data.schedule.options[0].id;
    for(const who of [f.owner,f.member])await api(who,'/api/groups/schedules/vote',{
      groupId:f.group.groupId,scheduleId:created.data.id,optionId:option,response:'yes'});
    expect((await api(f.owner,'/api/groups/schedules/confirm',{groupId:f.group.groupId,
      scheduleId:created.data.id,optionId:option,participantUserIds:[f.owner.id,f.member.id],
      acceptTentativeConflicts:true})).status).toBe(200);
    expect((await db.prepare('SELECT cancelled_at FROM shared_events WHERE id=?1').bind(old!.id)
      .first<{cancelled_at:string|null}>())?.cancelled_at).toBeTruthy();
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
  it('serializes concurrent confirmations to one shared event',async()=>{
    const f=await fixture(),created=await create(f),id=created.data.id,option=(await get(f,id)).data.schedule.options[0].id;
    for(const who of [f.owner,f.member])await api(who,'/api/groups/schedules/vote',{
      groupId:f.group.groupId,scheduleId:id,optionId:option,response:'yes'});
    const body={groupId:f.group.groupId,scheduleId:id,optionId:option,participantUserIds:[f.owner.id,f.member.id]};
    const attempts=await Promise.all([api(f.owner,'/api/groups/schedules/confirm',body),
      api(f.owner,'/api/groups/schedules/confirm',body)]);
    expect(attempts.map(result=>result.status)).toEqual([200,200]);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM shared_events WHERE schedule_plan_id=?1')
      .bind(id).first<{n:number}>())?.n).toBe(1);
  });
  it('reminds only unanswered active members and deduplicates Cron retries',async()=>{
    const f=await fixture(),created=await create(f),id=created.data.id,option=(await get(f,id)).data.schedule.options[0].id;
    await api(f.owner,'/api/groups/schedules/vote',{groupId:f.group.groupId,scheduleId:id,optionId:option,response:'yes'});
    await db.prepare('UPDATE group_schedules SET response_deadline=?1 WHERE id=?2')
      .bind(new Date(Date.now()+30*60000).toISOString(),id).run();
    await drainScheduleNotices({DB:db});await drainScheduleNotices({DB:db});
    const owner=await inbox(f.owner),member=await inbox(f.member);
    expect(owner.notifications.filter((n:any)=>n.kind==='schedule_reminder'&&n.targetPath.includes(id))).toHaveLength(0);
    expect(member.notifications.filter((n:any)=>n.kind==='schedule_reminder'&&n.targetPath.includes(id))).toHaveLength(1);
    expect(member.notifications.filter((n:any)=>n.kind==='schedule_deadline'&&n.targetPath.includes(id))).toHaveLength(1);
    expect((await api(f.owner,'/api/groups/schedules/update',{groupId:f.group.groupId,scheduleId:id,
      title:'新しい回答期限',description:'',responseDeadline:new Date(Date.now()+45*60000).toISOString()})).status).toBe(200);
    await drainScheduleNotices({DB:db});
    const revised=await inbox(f.member);
    expect(revised.notifications.filter((n:any)=>n.kind==='schedule_reminder'&&n.targetPath.includes(id))).toHaveLength(2);
  });
  it('keeps an app notification when Push queue insertion fails',async()=>{
    const f=await fixture(),created=await create(f),id=created.data.id,key='push-failure:'+id;
    const failingDB={prepare:(sql:string)=>{
      if(sql.includes('INSERT OR IGNORE INTO push_deliveries'))throw new Error('simulated Push queue failure');
      return db.prepare(sql);
    }} as unknown as D1Database;
    await expect(queueScheduleNotice({DB:failingDB,VAPID_PUBLIC_KEY:'test',VAPID_PRIVATE_KEY:'test',VAPID_SUBJECT:'test'},
      f.group.groupId,id,[f.member.id],'schedule_changed',key)).rejects.toThrow('simulated Push queue failure');
    expect((await db.prepare('SELECT COUNT(*) AS n FROM in_app_notifications WHERE user_id=?1 AND dedupe_key=?2')
      .bind(f.member.id,key).first<{n:number}>())?.n).toBe(1);
  });
  it('discards queued schedule Push after cancellation before attempting delivery',async()=>{
    const f=await fixture(),created=await create(f),id=created.data.id,subscription=crypto.randomUUID(),delivery=crypto.randomUUID();
    await db.batch([
      db.prepare(`INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,created_at,updated_at)
        VALUES(?1,?2,?3,'test','test',?4,?4)`)
        .bind(subscription,f.member.id,'https://push.example.test/'+subscription,new Date().toISOString()),
      db.prepare(`INSERT INTO push_deliveries(id,subscription_id,group_id,kind,body,created_at,
        next_attempt_at,scope,recipient_user_id,schedule_id)
        VALUES(?1,?2,?3,'schedule_started','generic',?4,?4,'group',?5,?6)`)
        .bind(delivery,subscription,f.group.groupId,new Date().toISOString(),f.member.id,id),
    ]);
    expect((await api(f.owner,'/api/groups/schedules/cancel',{groupId:f.group.groupId,scheduleId:id})).status).toBe(200);
    await drainPushQueue({DB:db,VAPID_PUBLIC_KEY:'local',VAPID_PRIVATE_KEY:'local',VAPID_SUBJECT:'mailto:test@example.test'});
    expect(await db.prepare('SELECT id FROM push_deliveries WHERE id=?1').bind(delivery).first()).toBeNull();
  });
  it('closes or transfers open work atomically, revokes access, and never restores old authority',async()=>{
    const f=await fixture(),created=await create(f),id=created.data.id;
    const wish=(await api(f.owner,'/api/groups/wishes/create',{groupId:f.group.groupId,
      wishDate:'2030-10-23',isAllDay:true,message:'保管する募集'})).data.id;
    expect((await api(f.owner,'/api/groups/leave',{groupId:f.group.groupId})).status).toBe(409);
    const transfer=await api(f.owner,'/api/groups/leave',{groupId:f.group.groupId,
      exitChoice:'transfer',successorUserId:f.member.id});expect(transfer.status).toBe(200);
    expect((await api(f.owner,'/api/groups/schedules/get',{groupId:f.group.groupId,scheduleId:id})).status).toBe(401);
    expect((await get(f,id,f.member)).data.schedule.canManage).toBe(true);
    expect((await api(f.member,'/api/groups/wishes/list',{groupId:f.group.groupId})).data.wishes
      .find((w:any)=>w.id===wish).isOwn).toBe(true);
    const rejoined=await api(f.owner,'/api/groups/join',{inviteCode:f.group.inviteCode});expect(rejoined.status).toBe(201);
    expect((await get(f,id,f.owner)).status).toBe(403);
    expect((await api(f.owner,'/api/groups/wishes/update',{groupId:f.group.groupId,wishId:wish,
      wishDate:'2030-10-24',isAllDay:true,message:'乗っ取り'})).status).toBe(403);
    expect((await api(f.member,'/api/groups/leave',{groupId:f.group.groupId,exitChoice:'close'})).status).toBe(200);
    expect((await db.prepare('SELECT state FROM group_schedules WHERE id=?1').bind(id).first()).state).toBe('cancelled');
    expect((await db.prepare('SELECT management_state FROM group_availability_wishes WHERE id=?1').bind(wish).first()).management_state).toBe('closed');
    expect((await db.prepare('SELECT COUNT(*) AS n FROM group_departure_assertions').first<{n:number}>())?.n).toBe(0);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
  it('lets a successor finalize a retained tentative wish without restoring the original creator',async()=>{
    const f=await fixture();
    await api(f.other,'/api/groups/join',{inviteCode:f.group.inviteCode});
    const wish=(await api(f.owner,'/api/groups/wishes/create',{groupId:f.group.groupId,
      wishDate:'2030-10-25',isAllDay:true,message:'引き継ぐ募集'})).data.id;
    await api(f.member,'/api/groups/wishes/react',{groupId:f.group.groupId,wishId:wish});
    const event=await db.prepare("SELECT id FROM shared_events WHERE wish_id=?1 AND status='tentative'")
      .bind(wish).first<{id:string}>();expect(event).not.toBeNull();
    expect((await api(f.owner,'/api/groups/leave',{groupId:f.group.groupId,
      exitChoice:'transfer',successorUserId:f.member.id})).status).toBe(200);
    expect((await api(f.other,'/api/groups/wishes/react',{groupId:f.group.groupId,wishId:wish})).status).toBe(200);
    expect((await api(f.member,'/api/groups/wishes/confirm',{groupId:f.group.groupId,wishId:wish,
      title:'引き継ぎ後の予定',eventDate:'2030-10-25',allDay:true,
      participantUserIds:[f.member.id,f.other.id]})).status).toBe(200);
    expect((await db.prepare('SELECT status,created_by_member_id FROM shared_events WHERE id=?1')
      .bind(event!.id).first<{status:string;created_by_member_id:string}>())?.status).toBe('confirmed');
    expect((await api(f.owner,'/api/groups/wishes/list',{groupId:f.group.groupId})).status).toBe(401);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
});
