import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPersonalSync} from './personal-sync.mjs';

const oldEvent={id:'legacy',title:'端末内の旧予定',start:'10:00',end:'11:00',allDay:false,note:'旧メモ',custom:{color:'blue'}};
function storage(initial={}) {
  const values=new Map(Object.entries(initial));
  return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),values};
}
function requestFixture({active=false,remote=[]}={}) {
  const calls=[];
  const requestJson=async(url,options={})=>{
    calls.push({url,options});
    if(url==='/api/personal/events/status') return {active};
    if(url==='/api/personal/events/activate') {active=true;return {ok:true,active:true};}
    if(url.startsWith('/api/personal/events/sync?')) return {events:remote,cursor:0,hasMore:false};
    if(url==='/api/personal/events/import') {assert.equal(options.payload.restoreConfirmed,true);const event={...options.payload.event,id:'restored-test',version:1,deleted:false};remote.push(event);return {event,migrationConflict:false};}
    if(url.endsWith('/create')) {const event={...options.payload.event,id:options.payload.id,version:1,deleted:false};remote.push(event);return {event};}
    throw new Error(`Unexpected request ${url}`);
  };
  return {calls,requestJson,get active(){return active;},remote};
}

test('pre-consent initialization and retries do not mutate events, metadata, or call sync/import/activate APIs',async()=>{
  const legacyMeta=JSON.stringify({active:false,migration:[{sourceId:'old-queued',event:{title:'queue'}}],queue:[{action:'create'}]});
  const cache=storage({'user-A-personal-sync-v1':legacyMeta});
  const state={events:{'2026-10-15':[oldEvent]},shifts:{'2026-10-16':{start:'12:00'}},expenses:{secret:'支出'}};
  const server=requestFixture();
  const sync=createPersonalSync({storage:cache,key:'user-A',state,requestJson:server.requestJson});
  const before=JSON.stringify(state.events);
  assert.deepEqual(await sync.initialize(),{active:false});
  await sync.sync();
  assert.equal(JSON.stringify(state.events),before);
  assert.equal(cache.getItem('user-A-personal-sync-v1'),legacyMeta);
  assert.deepEqual(server.calls.map(call=>call.url),['/api/personal/events/status']);
  assert.equal(sync.isActive(),false);
});

test('explicit consent starts a blank D1 calendar and archives, rather than deleting, old device data and v1 queue',async()=>{
  const legacyMeta=JSON.stringify({active:false,migration:[{sourceId:'stale',event:oldEvent}],queue:[{action:'create'}]});
  const cache=storage({'user-A-personal-sync-v1':legacyMeta});
  const state={events:{'2026-10-15':[oldEvent]},shifts:{'2026-10-16':{workplace:'keep-shift'}},expenses:{private:'keep-expenses'},budget:{fixed:'keep-budget'}};
  const server=requestFixture();
  const sync=createPersonalSync({storage:cache,key:'user-A',state,requestJson:server.requestJson});
  await sync.initialize();
  await sync.startFresh();
  assert.equal(sync.isActive(),true);
  assert.deepEqual(state.events,{});
  assert.equal(state.shifts['2026-10-16'].workplace,'keep-shift');
  assert.equal(state.expenses.private,'keep-expenses');
  assert.equal(state.budget.fixed,'keep-budget');
  assert.equal(cache.getItem('user-A-personal-sync-v1'),legacyMeta);
  const backup=JSON.parse(cache.getItem('user-A-personal-backup-v2'));
  assert.equal(backup.events['2026-10-15'][0].id,'legacy');
  assert.deepEqual(server.calls.filter(call=>call.url.endsWith('/import')),[]);
  assert.deepEqual(server.calls.find(call=>call.url.endsWith('/activate')).options.payload,{freshStart:true});
  assert.deepEqual(JSON.parse(cache.getItem('user-A-personal-sync-v2')).migration,undefined);
});

test('an already-consented account on a second device pulls the same cloud calendar and never imports its old local events',async()=>{
  const cache=storage({'user-B-personal-sync-v1':JSON.stringify({active:false,migration:[{sourceId:'old-device-queue',event:oldEvent}],queue:[]})});
  const remote=[{id:'cloud-event',date:'2026-10-17',title:'端末Aで作成した予定',start:'15:00',end:'16:00',allDay:false,note:'',extra:{},version:1,deleted:false}];
  const state={events:{'2026-10-16':[oldEvent]}};
  const server=requestFixture({active:true,remote});
  const sync=createPersonalSync({storage:cache,key:'user-B',state,requestJson:server.requestJson});
  await sync.initialize();
  assert.equal(state.events['2026-10-17'][0].title,'端末Aで作成した予定');
  assert.equal(state.events['2026-10-16'],undefined);
  assert.equal(server.calls.some(call=>call.url.endsWith('/import')),false);
  assert.equal(server.calls.some(call=>call.url.endsWith('/activate')),false);
  assert.ok(cache.getItem('user-B-personal-sync-v1'));
  assert.equal(JSON.parse(cache.getItem('user-B-personal-backup-v2')).events['2026-10-16'][0].id,'legacy');
});

test('old v1 unsent migration queues remain inert even when a user has previously opted in',async()=>{
  const legacyMeta=JSON.stringify({active:true,migration:[{sourceId:'stale-queued-event',event:oldEvent,done:false}],queue:[{action:'create',id:'stale'}]});
  const cache=storage({'user-A-personal-sync-v1':legacyMeta});
  const state={events:{'2026-10-15':[oldEvent]}};
  const server=requestFixture({active:true});
  const sync=createPersonalSync({storage:cache,key:'user-A',state,requestJson:server.requestJson});
  await sync.initialize();
  assert.equal(cache.getItem('user-A-personal-sync-v1'),legacyMeta);
  assert.equal(server.calls.some(call=>call.url.endsWith('/import')),false);
  assert.deepEqual(state.events,{});
});

test('only an explicit restore call queues events and sends the backend restore confirmation',async()=>{
  const cache=storage(),state={events:{}};const server=requestFixture({active:true});
  const sync=createPersonalSync({storage:cache,key:'user-A',state,requestJson:server.requestJson});
  await sync.initialize();
  assert.equal(server.calls.some(call=>call.url.endsWith('/import')),false);
  sync.restore({'2026-10-15':[oldEvent]});
  await sync.sync();
  const restoreCall=server.calls.find(call=>call.url.endsWith('/import'));
  assert.equal(restoreCall.options.payload.restoreConfirmed,true);
  assert.equal(state.events['2026-10-15'][0].title,oldEvent.title);
});

test('backup export contains event snapshots only, never shifts, wages, or expenses',async()=>{
  const cache=storage(),state={events:{'2026-10-15':[oldEvent]},expenses:{private:'spending'},hourly:'private-wage',shifts:{'2026-10-16':{workplace:'private-work'}}};
  const server=requestFixture();const sync=createPersonalSync({storage:cache,key:'user-A',state,requestJson:server.requestJson});
  await sync.initialize();
  const exported=JSON.parse(sync.backup());
  assert.deepEqual(exported.events,{});
  assert.deepEqual(exported.archiveEvents,state.events);
  assert.match(JSON.stringify(exported),/端末内の旧予定/);
  assert.doesNotMatch(JSON.stringify(exported),/private-wage|private-work|spending/);
});

test('legacy full-data import archives its events locally without adding them to the sync calendar',async()=>{
  const cache=storage(),state={events:{'2026-10-15':[oldEvent]}};const server=requestFixture();
  const sync=createPersonalSync({storage:cache,key:'user-A',state,requestJson:server.requestJson});
  await sync.initialize();sync.archiveLegacy({'2026-10-16':[{...oldEvent,id:'legacy-global'}]});
  await sync.startFresh();
  assert.deepEqual(state.events,{});
  assert.equal(server.remote.length,0);
  const exported=JSON.parse(sync.backup());
  assert.deepEqual(exported.events,{});
  assert.equal(exported.archiveEvents['2026-10-15'][0].id,'legacy');
  assert.equal(exported.archiveEvents['2026-10-16'][0].id,'legacy-global');
  assert.equal(server.calls.some(call=>call.url.endsWith('/import')),false);
});

test('a failed sync after consent keeps the old event snapshot recoverable and does not send it',async()=>{
  const cache=storage(),state={events:{'2026-10-15':[oldEvent]}};let active=false;const calls=[];
  const requestJson=async(url,options={})=>{
    calls.push(url);
    if(url.endsWith('/status')) return {active};
    if(url.endsWith('/activate')) {active=true;return {ok:true,active:true};}
    if(url.startsWith('/api/personal/events/sync?')) throw new Error('通信切断');
    throw new Error('unexpected');
  };
  const sync=createPersonalSync({storage:cache,key:'user-A',state,requestJson});
  await sync.initialize();await sync.startFresh();
  assert.deepEqual(state.events,{});
  assert.equal(JSON.parse(cache.getItem('user-A-personal-backup-v2')).events['2026-10-15'][0].title,oldEvent.title);
  assert.equal(calls.some(url=>url.endsWith('/import')),false);
  assert.match(sync.status(),/通信切断/);
});

test('logout during an active request cannot overwrite the next account state',async()=>{
  const cache=storage(),state={events:{}};let current=true,finish;
  const sync=createPersonalSync({storage:cache,key:'user-A',state,isCurrent:()=>current,requestJson:(url)=>{
    if(url.endsWith('/status')) return Promise.resolve({active:true});
    return new Promise(resolve=>{finish=resolve;});
  }});
  const pending=sync.initialize();
  await new Promise(resolve=>setImmediate(resolve));
  current=false;state.events={'2026-10-20':[{id:'user-b',title:'別ユーザー'}]};
  finish({events:[],cursor:0,hasMore:false});await pending;
  assert.equal(state.events['2026-10-20'][0].id,'user-b');
});
