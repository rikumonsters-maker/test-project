import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {initShared} from './shared.js';
import {createPersonalSync} from './personal-sync.mjs';

const oldEvent={id:'legacy-private-id',title:'旧個人予定の秘密タイトル',start:'12:00',end:'13:00',allDay:false,note:'旧個人メモと場所'};
const newEvent={id:'new-private-id',title:'新しい個人予定の秘密タイトル',start:'15:00',end:'16:00',allDay:false,note:'本人だけの新しいメモ'};
const group={groupId:'group-1',memberId:'member-1',memberName:'本人',groupName:'友人'};

function storage(initial={}) {
  const values=new Map(Object.entries(initial));
  return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),values};
}

function createGroupSync(state,requestJson,personalSync={isActive:()=>false}) {
  const status={};
  return initShared({
    $:()=>status,
    state,
    view:{},
    requestJson,
    saveState:()=>{},
    personalSync,
  });
}

function serializedRequests(handler) {
  const calls=[];
  const requestJson=(path,options={})=>{
    // Mirrors app.js requestJson's fetch body: JSON.stringify(payload).
    const body=options.payload===undefined?undefined:JSON.stringify(options.payload);
    calls.push({path,method:options.method||'POST',body});
    return handler(path,options);
  };
  return {calls,requestJson};
}

function assertNoPrivateDetails(body) {
  assert.equal(typeof body,'string');
  for(const secret of [oldEvent.id,oldEvent.title,oldEvent.note,newEvent.id,newEvent.title,newEvent.note]) {
    assert.equal(body.includes(secret),false,`group sync body unexpectedly includes ${secret}`);
  }
}

test('pre-consent startup flush ignores old local events and a persisted v1 personal queue',async()=>{
  const oldQueue=JSON.stringify({active:false,queue:[{action:'create',id:oldEvent.id,event:oldEvent}]});
  const cache=storage({'account-personal-sync-v1':oldQueue});
  const state={
    events:{'2026-10-15':[oldEvent]},
    shifts:{'2026-10-16':{start:'09:00',end:'10:00',workplace:'秘密の勤務先',hourly:'秘密の給与'}},
    groups:[group],
    pendingGroupMonths:{[group.groupId]:{'2026-10':4}},
    pendingGroupShiftMonths:{[group.groupId]:{'2026-10':2}},
  };
  const beforeEvents=JSON.stringify(state.events);
  const {calls,requestJson}=serializedRequests(path=>{
    if(path==='/api/personal/events/status') return {active:false};
    if(path==='/api/shared/calendar/sync') return {ok:true,count:1};
    throw new Error(`Unexpected request ${path}`);
  });
  const personal=createPersonalSync({storage:cache,key:'account',state,requestJson});
  await personal.initialize();
  await createGroupSync(state,requestJson,personal).syncPending();
  await new Promise(resolve=>setImmediate(resolve));

  const groupCalls=calls.filter(call=>call.path==='/api/shared/calendar/sync');
  assert.equal(groupCalls.length,1);
  assertNoPrivateDetails(groupCalls[0].body);
  const body=JSON.parse(groupCalls[0].body);
  assert.deepEqual(body.entries,[{sourceType:'shift',sourceId:'2026-10-16',eventDate:'2026-10-16',title:'シフト',start:'09:00',end:'10:00',allDay:false,note:''}]);
  assert.equal(JSON.stringify(body).includes('秘密の勤務先'),false);
  assert.equal(JSON.stringify(body).includes('秘密の給与'),false);
  assert.equal(JSON.stringify(state.events),beforeEvents);
  assert.equal(cache.getItem('account-personal-sync-v1'),oldQueue);
  assert.deepEqual(calls.filter(call=>call.path.startsWith('/api/personal/events/')).map(call=>call.path),['/api/personal/events/status']);
});

test('a failed legacy group-month sync retry serializes no personal event details on either attempt',async()=>{
  const state={events:{'2026-10-15':[oldEvent]},shifts:{},groups:[group],pendingGroupMonths:{[group.groupId]:{'2026-10':1}},pendingGroupShiftMonths:{}};
  let fail=true;
  const {calls,requestJson}=serializedRequests(path=>{
    if(path!=='/api/shared/calendar/sync') throw new Error(`Unexpected request ${path}`);
    if(fail) {fail=false;throw new Error('一時的な通信エラー');}
    return {ok:true,count:0};
  });
  const sync=createGroupSync(state,requestJson);
  await sync.syncPending();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(state.pendingGroupMonths[group.groupId],{'2026-10':1});
  await sync.syncPending();
  await new Promise(resolve=>setImmediate(resolve));

  const bodies=calls.filter(call=>call.path==='/api/shared/calendar/sync').map(call=>call.body);
  assert.equal(bodies.length,2);
  for(const body of bodies) {
    assertNoPrivateDetails(body);
    assert.deepEqual(JSON.parse(body).entries,[]);
  }
  assert.deepEqual(state.pendingGroupMonths[group.groupId],{});
});

test('after explicit consent, new personal events use only the personal API and group sync stays private',async()=>{
  const legacyQueue=JSON.stringify({queue:[{action:'create',id:oldEvent.id,event:oldEvent}]});
  const cache=storage({'account-personal-sync-v1':legacyQueue});
  const state={events:{'2026-10-15':[oldEvent]},shifts:{},groups:[group],pendingGroupMonths:{[group.groupId]:{'2026-10':1}},pendingGroupShiftMonths:{}};
  let active=false;
  let cloudEvents=[];
  const {calls,requestJson}=serializedRequests((path,options={})=>{
    if(path==='/api/personal/events/status') return {active};
    if(path==='/api/personal/events/activate') {active=true;return {ok:true,active:true};}
    if(path.startsWith('/api/personal/events/sync?')) return {events:cloudEvents,cursor:cloudEvents.length,hasMore:false};
    if(path==='/api/personal/events/create') {
      const row={id:options.payload.id,...options.payload.event,version:1,deleted:false};
      cloudEvents=[row];
      return {event:row};
    }
    if(path==='/api/shared/calendar/sync') return {ok:true,count:0};
    throw new Error(`Unexpected request ${path}`);
  });
  const personal=createPersonalSync({storage:cache,key:'account',state,requestJson,makeId:()=> 'operation-1'});
  await personal.initialize();
  await personal.startFresh();
  assert.deepEqual(state.events,{});
  assert.equal(cache.getItem('account-personal-sync-v1'),legacyQueue);
  assert.equal(calls.some(call=>call.path==='/api/personal/events/import'),false);
  personal.queue('create',newEvent.id,newEvent,'2026-10-15',0);
  await personal.sync();
  assert.equal(state.events['2026-10-15'][0].title,newEvent.title);

  await createGroupSync(state,requestJson,personal).syncPending();
  await new Promise(resolve=>setImmediate(resolve));
  const personalWrites=calls.filter(call=>call.path==='/api/personal/events/create');
  assert.equal(personalWrites.length,1);
  assert.match(personalWrites[0].body,new RegExp(newEvent.title));
  assert.match(personalWrites[0].body,new RegExp(newEvent.note));
  assert.equal(personalWrites[0].body.includes(oldEvent.id),false);
  assert.equal(personalWrites[0].body.includes(oldEvent.title),false);
  const groupCall=calls.find(call=>call.path==='/api/shared/calendar/sync');
  assert.ok(groupCall);
  assertNoPrivateDetails(groupCall.body);
  assert.deepEqual(JSON.parse(groupCall.body).entries,[]);
  assert.equal(calls.some(call=>call.path==='/api/personal/events/import'),false);
  assert.equal(JSON.parse(cache.getItem('account-personal-backup-v2')).events['2026-10-15'][0].id,oldEvent.id);
});

test('group sharing explanation separates personal sync from the group calendar API',async()=>{
  const html=await readFile(new URL('./index.html',import.meta.url),'utf8');
  assert.match(html,/個人予定の詳細は本人が同意した同期APIにのみ送信し、グループ同期APIには含めません/);
  assert.match(html,/旧予定は自動移行されません/);
  assert.doesNotMatch(html,/この端末に保存済みのものも含め、個人予定は時間帯と「予定あり」のみ.*共有されます/);
});

test('multiple pending months keep private events out of group payloads through a retry before consent',async()=>{
  const monthlyEvents={
    '2026-10':{date:'2026-10-15',event:{id:'legacy-oct-private-id',title:'LEGACY_OCT_PRIVATE_TITLE',start:'10:00',end:'11:00',allDay:false,note:'LEGACY_OCT_PRIVATE_NOTE'}},
    '2026-11':{date:'2026-11-03',event:{id:'legacy-nov-private-id',title:'LEGACY_NOV_PRIVATE_TITLE',start:'14:00',end:'15:00',allDay:false,note:'LEGACY_NOV_PRIVATE_NOTE'}},
  };
  const legacyQueue=JSON.stringify({active:false,queue:Object.values(monthlyEvents).map(({event})=>({action:'create',id:event.id,event}))});
  const cache=storage({'account-personal-sync-v1':legacyQueue});
  const state={
    events:Object.fromEntries(Object.values(monthlyEvents).map(({date,event})=>[date,[event]])),
    shifts:{
      '2026-10-16':{start:'08:30',end:'12:00',workplace:'PRIVATE_OCT_WORKPLACE',hourly:'PRIVATE_OCT_WAGE'},
      '2026-11-06':{start:'14:00',end:'18:30',workplace:'PRIVATE_NOV_WORKPLACE',hourly:'PRIVATE_NOV_WAGE'},
    },
    groups:[group],
    pendingGroupMonths:{[group.groupId]:{'2026-10':4,'2026-11':2}},
    pendingGroupShiftMonths:{[group.groupId]:{'2026-10':1,'2026-11':1}},
  };
  const beforeEvents=JSON.stringify(state.events);
  const privateValues=Object.values(monthlyEvents).flatMap(({event})=>[event.id,event.title,event.note]);
  privateValues.push('PRIVATE_OCT_WORKPLACE','PRIVATE_OCT_WAGE','PRIVATE_NOV_WORKPLACE','PRIVATE_NOV_WAGE');
  let failFirstGroupRequest=true;
  const {calls,requestJson}=serializedRequests(path=>{
    if(path==='/api/personal/events/status') return {active:false};
    if(path==='/api/shared/calendar/sync') {
      if(failFirstGroupRequest) {failFirstGroupRequest=false;throw new Error('transient group sync failure');}
      return {ok:true,count:1};
    }
    throw new Error('Unexpected request '+path);
  });
  const personal=createPersonalSync({storage:cache,key:'account',state,requestJson});
  assert.deepEqual(await personal.initialize(),{active:false});
  const sync=createGroupSync(state,requestJson,personal);

  await sync.syncPending();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(state.pendingGroupMonths[group.groupId],{'2026-10':4,'2026-11':2});
  assert.deepEqual(calls.filter(call=>call.path==='/api/shared/calendar/sync').map(call=>JSON.parse(call.body).month),['2026-10']);

  await sync.syncPending();
  await new Promise(resolve=>setImmediate(resolve));

  const groupCalls=calls.filter(call=>call.path==='/api/shared/calendar/sync');
  assert.deepEqual(groupCalls.map(call=>JSON.parse(call.body).month),['2026-10','2026-10','2026-11']);
  const expectedShiftByMonth={
    '2026-10':{sourceId:'2026-10-16',eventDate:'2026-10-16',start:'08:30',end:'12:00'},
    '2026-11':{sourceId:'2026-11-06',eventDate:'2026-11-06',start:'14:00',end:'18:30'},
  };
  for(const call of groupCalls) {
    assert.equal(call.method,'POST');
    assert.equal(typeof call.body,'string');
    for(const value of privateValues) assert.equal(call.body.includes(value),false,'group sync body unexpectedly includes '+value);
    const body=JSON.parse(call.body);
    assert.equal(body.personalSync,false);
    assert.equal(body.syncPersonal,false);
    const shift=expectedShiftByMonth[body.month];
    assert.ok(shift);
    assert.deepEqual(body.entries,[{
      sourceType:'shift',sourceId:shift.sourceId,eventDate:shift.eventDate,title:String.fromCodePoint(0x30b7,0x30d5,0x30c8),
      start:shift.start,end:shift.end,allDay:false,note:'',
    }]);
  }
  assert.deepEqual(state.pendingGroupMonths[group.groupId],{});
  assert.deepEqual(state.pendingGroupShiftMonths[group.groupId],{});
  assert.equal(JSON.stringify(state.events),beforeEvents);
  assert.equal(cache.getItem('account-personal-sync-v1'),legacyQueue);
  assert.deepEqual(calls.filter(call=>call.path.startsWith('/api/personal/events/')).map(call=>call.path),['/api/personal/events/status']);
});
