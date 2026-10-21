import {env,createExecutionContext} from 'cloudflare:test';
import {beforeAll,describe,it,expect} from 'vitest';
import worker from '../src/index';
import {PUBLIC_APP_ORIGIN} from '../src/app-origin';
import {applySQL} from './migration-helper';
import {createPersonalSync} from '../../frontend/personal-sync.mjs';

const migrations=import.meta.glob('../migrations/*.sql',{query:'?raw',import:'default',eager:true}) as Record<string,string>;
const privateEvent={date:'2026-10-15',title:'非公開タイトル',start:'13:00',end:'14:00',allDay:false,note:'非公開メモ',extra:{place:'秘密の場所'}};
let n=0;
async function api(cookie:string,path:string,body?:any,origin:string|null=PUBLIC_APP_ORIGIN) {
  const headers=new Headers({'Content-Type':'application/json'});if(origin)headers.set('Origin',origin);if(cookie)headers.set('Cookie',cookie);
  const r=await worker.fetch(new Request(`https://example.com${path}`,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)}),env,createExecutionContext());
  return {status:r.status,data:await r.json() as any,cookie:r.headers.get('set-cookie')?.split(';')[0]||''};
}
async function account(){const email=`personal-${++n}@example.test`;const r=await api('','/api/auth/register',{email,displayName:`予定${n}`,password:'Safe-password-123',passwordConfirm:'Safe-password-123'});expect(r.status).toBe(200);return{cookie:r.cookie,user:r.data.user,email};}
const path='/api/personal/events';
async function activate(cookie:string){return api(cookie,`${path}/activate`,{freshStart:true});}
beforeAll(async()=>{for(const key of Object.keys(migrations).sort()) await applySQL(env.DB,migrations[key]);});

describe('personal event sync opt-in and privacy',()=>{
  it('keeps the RC migration set on 0001-0010 plus 0012, with 0011 excluded',()=>{
    const names=Object.keys(migrations).map(file=>file.split('/').at(-1));
    expect(names).toContain('0012_personal_event_sync.sql');expect(names).not.toContain('0011_password_recovery.sql');
  });

  it('pre-consent status and local initialization make no activation/import calls or data changes',async()=>{
    const a=await account();
    expect((await api(a.cookie,`${path}/status`)).data).toEqual({active:false});
    expect((await api(a.cookie,path)).status).toBe(409);
    expect((await api(a.cookie,`${path}/sync?cursor=0`)).status).toBe(409);
    expect((await api(a.cookie,`${path}/activate`,{})).status).toBe(400);
    expect((await api(a.cookie,`${path}/import`,{sourceId:'stale',event:privateEvent})).status).toBe(403);
    const values=new Map<string,string>([['test-personal-sync-v1',JSON.stringify({migration:[{sourceId:'stale',event:privateEvent}],queue:[{action:'create'}]})]]);
    const state:any={events:{[privateEvent.date]:[{id:'old-device',...privateEvent}]},shifts:{'2026-10-16':{start:'10:00'}},expenses:{secret:1}};
    const before=JSON.stringify(state.events),calls:string[]=[];
    const sync=createPersonalSync({storage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)},key:'test',state,
      requestJson:async(url:string)=>{calls.push(url);const result=await api(a.cookie,url);if(result.status>=400)throw new Error(result.data.error);return result.data;}});
    await sync.initialize();await sync.sync();
    expect(JSON.stringify(state.events)).toBe(before);expect(state.shifts['2026-10-16'].start).toBe('10:00');expect(state.expenses.secret).toBe(1);
    expect(calls).toEqual([`${path}/status`]);expect(values.get('test-personal-sync-v1')).toContain('stale');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM personal_sync_users WHERE user_id=?1').bind(a.user.id).first<any>())?.n).toBe(0);
  });

  it('real D1: explicit consent starts blank; a second device pulls new data and edits/deletes sync both ways',async()=>{
    const a=await account();
    async function device(events:any) {
      const values=new Map<string,string>();const storage={getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>{values.set(key,value);}};
      const state={events};let failure='',lastStatus='';
      const requestJson=async(url:string,options:any={})=>{
        const result=await api(a.cookie,url,options.method==='GET'?undefined:options.payload);
        if(failure && url.endsWith(failure)){failure='';throw new Error('通信切断（適用後）');}
        if(result.status>=400)throw Object.assign(new Error(result.data.error),{status:result.status,data:result.data});return result.data;
      };
      const build=()=>createPersonalSync({storage,key:'test-user',state,requestJson,onStatus:(message:string)=>{lastStatus=message;}});
      let sync=build();await sync.initialize();
      return{state,values,get sync(){return sync;},restart:async()=>{sync=build();await sync.initialize();},fail:(endpoint:string)=>{failure=endpoint;},status:()=>lastStatus};
    }
    const old={id:'old-on-pc',title:privateEvent.title,start:privateEvent.start,end:privateEvent.end,allDay:false,note:privateEvent.note};
    const A=await device({[privateEvent.date]:[old]}),B=await device({'2026-10-16':[{...old,id:'old-on-phone',title:'スマホだけの旧予定'}]});
    expect(A.state.events[privateEvent.date][0].id).toBe('old-on-pc');expect(B.state.events['2026-10-16'][0].id).toBe('old-on-phone');
    await A.sync.startFresh();expect(A.state.events).toEqual({});
    await B.sync.initialize();expect(B.state.events).toEqual({});expect((await api(a.cookie,path)).data.events).toEqual([]);
    const id=crypto.randomUUID();
    A.sync.queue('create',id,privateEvent,privateEvent.date,0);A.fail('/create');await A.sync.sync();expect(A.status()).toContain('通信切断');
    await A.restart();await B.sync.sync();expect(B.state.events[privateEvent.date][0].title).toBe(privateEvent.title);
    const current=(B.state.events[privateEvent.date] as any[])[0];
    B.sync.queue('update',id,{...privateEvent,title:'スマホ編集'},privateEvent.date,current.version);await B.sync.sync();await A.sync.sync();
    expect((A.state.events[privateEvent.date] as any[])[0].title).toBe('スマホ編集');
    const latest=(B.state.events[privateEvent.date] as any[])[0];B.sync.queue('delete',id,null,null,latest.version);await B.sync.sync();await A.sync.sync();
    expect(A.state.events).toEqual({});expect((await api(a.cookie,path)).data.events).toEqual([]);
  });

  it('requires opt-in for writes and explicit confirmation to restore; restore tokens remain idempotent',async()=>{
    const a=await account();
    expect((await api(a.cookie,`${path}/create`,{id:crypto.randomUUID(),operationId:crypto.randomUUID(),event:privateEvent})).status).toBe(409);
    const activation=await activate(a.cookie);expect(activation.status).toBe(200);expect(activation.data).toEqual({ok:true,active:true});
    expect((await api(a.cookie,`${path}/create`,{id:crypto.randomUUID(),operationId:crypto.randomUUID(),event:privateEvent})).status).toBe(409);
    expect((await api(a.cookie,`${path}/import`,{sourceId:'old-id',event:privateEvent})).status).toBe(403);
    const body={sourceId:'old-id',event:privateEvent,restoreConfirmed:true};const first=await api(a.cookie,`${path}/import`,body);
    expect(first.status).toBe(200);expect((await api(a.cookie,`${path}/import`,body)).data.event.id).toBe(first.data.event.id);
    expect((await api(a.cookie,path)).data.events).toHaveLength(1);
  });

  it('keeps per-user ownership and requires Cookie authentication for status, reads, activation and writes',async()=>{
    const a=await account(),b=await account(),id=crypto.randomUUID();await activate(a.cookie);
    expect((await api(a.cookie,`${path}/create`,{syncProtocol:2,id,operationId:crypto.randomUUID(),event:privateEvent})).status).toBe(200);
    expect((await api(b.cookie,`${path}/status`)).data).toEqual({active:false});
    expect((await api(b.cookie,path)).status).toBe(409);
    expect((await api(b.cookie,`${path}/update`,{syncProtocol:2,id,user_id:a.user.id,operationId:crypto.randomUUID(),version:1,event:privateEvent})).status).toBe(409);
    await activate(b.cookie);
    expect((await api(b.cookie,path)).data.events).toEqual([]);
    expect((await api(b.cookie,`${path}/update`,{syncProtocol:2,id,user_id:a.user.id,operationId:crypto.randomUUID(),version:1,event:privateEvent})).status).toBe(404);
    for(const endpoint of ['/status','','/sync?cursor=0','/activate','/import','/create']) {
      const body=endpoint==='/status'||endpoint===''||endpoint.startsWith('/sync')?undefined:{freshStart:true};
      expect((await api('',path+endpoint,body)).status).toBe(401);
    }
    expect((await api(a.cookie,`${path}/activate`,{freshStart:true},null)).status).toBe(403);
  });

  it('hides legacy mirrors only after consent, protects personal details, and refuses empty shift overwrite',async()=>{
    const a=await account(),b=await account();
    const group=await api(a.cookie,'/api/groups/create',{name:'共有テスト'});const g=group.data.membership;
    await api(b.cookie,'/api/groups/join',{inviteCode:g.inviteCode});
    const legacyPersonal={sourceType:'personal',sourceId:'old-personal-id',eventDate:privateEvent.date,...privateEvent,allDay:false};
    const shift={sourceType:'shift',sourceId:'shift-2026-10-15',eventDate:privateEvent.date,title:'シフト',start:'10:00',end:'12:00',allDay:false,note:''};
    await env.DB.prepare(`INSERT INTO member_calendar_entries
      (group_id,member_id,source_type,source_id,event_date,title,starts_at,ends_at,all_day,note)
      VALUES (?1,?2,'personal','old-personal-id',?3,'既存の旧予定','13:00','14:00',0,'旧メモ')`)
      .bind(g.groupId,g.memberId,privateEvent.date).run();
    await api(a.cookie,'/api/shared/calendar/sync',{groupId:g.groupId,month:'2026-10',entries:[legacyPersonal,shift],personalSync:false});
    let before=await api(b.cookie,'/api/shared/events/list',{groupId:g.groupId,month:'2026-10'});
    expect(before.data.events).toHaveLength(2);
    expect(before.data.events.every((event:any)=>event.title==='予定あり')).toBe(true);
    const preservedPersonal=await env.DB.prepare(`SELECT source_id,title,note FROM member_calendar_entries
      WHERE group_id=?1 AND member_id=?2 AND source_type='personal'`).bind(g.groupId,g.memberId).first<any>();
    expect(preservedPersonal).toEqual({source_id:'old-personal-id',title:'既存の旧予定',note:'旧メモ'});
    await activate(a.cookie);
    const id=crypto.randomUUID();await api(a.cookie,`${path}/create`,{syncProtocol:2,id,operationId:crypto.randomUUID(),event:privateEvent});
    const noShiftSync=await api(a.cookie,'/api/shared/calendar/sync',{groupId:g.groupId,month:'2026-10',entries:[],personalSync:true,syncShifts:false});
    expect(noShiftSync.data.count).toBe(0);
    const mirrorCounts=await env.DB.prepare("SELECT source_type,COUNT(*) AS n FROM member_calendar_entries WHERE group_id=?1 GROUP BY source_type").bind(g.groupId).all<any>();
    expect(mirrorCounts.results).toContainEqual(expect.objectContaining({source_type:'personal',n:1}));
    expect(mirrorCounts.results).toContainEqual(expect.objectContaining({source_type:'shift',n:1}));
    const shared=await api(b.cookie,'/api/shared/events/list',{groupId:g.groupId,month:'2026-10'});
    for(const secret of ['非公開タイトル','非公開メモ','秘密の場所','old-personal-id','shift-2026-10-15',a.user.id,id]) expect(JSON.stringify(shared.data)).not.toContain(secret);
    expect(shared.data.events.every((event:any)=>event.title==='予定あり')).toBe(true);
    expect(shared.data.events.every((event:any)=>!('note' in event)&&!('createdByUserId' in event)&&!('extra' in event))).toBe(true);
    expect((await api(b.cookie,'/api/shared/availability',{groupId:g.groupId,userId:a.user.id,date:privateEvent.date})).data.busy).toContainEqual({start:'13:00',end:'14:00',label:'予定あり'});
    expect((await api(b.cookie,'/api/shared/availability',{groupId:g.groupId,userId:'not-a-member',date:privateEvent.date})).status).toBe(403);
  });

  it('rejects stale concurrent writes and tombstones prevent deleted events from returning',async()=>{
    const a=await account(),id=crypto.randomUUID();await activate(a.cookie);
    await api(a.cookie,`${path}/create`,{syncProtocol:2,id,operationId:crypto.randomUUID(),event:privateEvent});
    const edits=[1,2].map(index=>({syncProtocol:2,id,operationId:crypto.randomUUID(),version:1,event:{...privateEvent,title:`編集${index}`}}));
    const results=await Promise.all(edits.map(body=>api(a.cookie,`${path}/update`,body)));
    expect(results.map(result=>result.status).sort()).toEqual([200,409]);
    const latest=results.find(result=>result.status===200)!.data.event;
    expect((await api(a.cookie,`${path}/update`,edits[results.findIndex(result=>result.status===200)] )).data.event.version).toBe(latest.version);
    await api(a.cookie,`${path}/delete`,{syncProtocol:2,id,operationId:crypto.randomUUID(),version:latest.version});
    expect((await api(a.cookie,path)).data.events).toEqual([]);
    expect((await api(a.cookie,`${path}/create`,{syncProtocol:2,id,operationId:crypto.randomUUID(),event:privateEvent})).status).toBe(409);
  });

  it('pages deltas without missing writes or trusting device clocks',async()=>{
    const a=await account();await activate(a.cookie);
    await env.DB.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<503)
      INSERT INTO personal_events(user_id,id,event_date,title,starts_at,ends_at,all_day,note,version,created_at,updated_at,last_operation)
      SELECT ?1,'page-'||x,'2026-10-15','予定','','',1,'',1,'2026-01-01','2026-01-01','page-'||x FROM n`).bind(a.user.id).run();
    const first=await api(a.cookie,`${path}/sync?cursor=0`);expect(first.data.events).toHaveLength(500);expect(first.data.hasMore).toBe(true);
    const last=await api(a.cookie,`${path}/sync?cursor=${first.data.cursor}`);expect(last.data.events).toHaveLength(3);expect(last.data.hasMore).toBe(false);
    expect((await api(a.cookie,`${path}/sync?cursor=${last.data.cursor}`)).data.events).toEqual([]);
  });
});
