import assert from 'node:assert/strict';
import test from 'node:test';
import { createPersonalSync } from './personal-sync.mjs';

const event = {
  id:'server-event', date:'2026-10-22', title:'本人の予定', start:'18:00', end:'19:00',
  allDay:false, note:'', extra:{}, version:2, deleted:false,
};

function storedSync(records={}) {
  const values=new Map([['account-personal-sync-v2',JSON.stringify({
    format:2, cursor:8, records, queue:[], restoreQueue:[], active:true, results:{},
  })]]);
  return {
    getItem:key=>values.get(key)??null,
    setItem:(key,value)=>values.set(key,value),
  };
}

test('a saved cursor with an empty device cache restores the owner snapshot without writes',async()=>{
  const calls=[],state={events:{}};
  const requestJson=async(path)=>{
    calls.push(path);
    if(path==='/api/personal/events/status') return {active:true};
    if(path==='/api/personal/events/sync?cursor=8') return {events:[],cursor:8,hasMore:false};
    if(path==='/api/personal/events') return {events:[event]};
    throw new Error(`Unexpected request: ${path}`);
  };
  const sync=createPersonalSync({storage:storedSync(),key:'account',state,requestJson});
  await sync.initialize();
  assert.equal(state.events[event.date]?.[0]?.id,event.id);
  assert.equal(sync.status(),'同期完了');
  assert.deepEqual(calls,[
    '/api/personal/events/status', '/api/personal/events/sync?cursor=8', '/api/personal/events',
  ]);
});

test('snapshot failure leaves cached events intact and reports a failed sync',async()=>{
  const state={events:{}};
  const requestJson=async(path)=>{
    if(path==='/api/personal/events/status') return {active:true};
    if(path==='/api/personal/events/sync?cursor=8') return {events:[],cursor:8,hasMore:false};
    if(path==='/api/personal/events') throw new Error('network unavailable');
    throw new Error(`Unexpected request: ${path}`);
  };
  const sync=createPersonalSync({storage:storedSync({[event.id]:event}),key:'account',state,requestJson});
  await sync.initialize();
  assert.equal(state.events[event.date]?.[0]?.id,event.id);
  assert.match(sync.status(),/^同期失敗・オフライン：/);
});

test('snapshot repair preserves a queued conflict for explicit resolution',async()=>{
  const storage=storedSync();
  const saved=JSON.parse(storage.getItem('account-personal-sync-v2'));
  saved.queue=[{
    operationId:'pending-op', action:'update', id:event.id, version:1,
    event:{...event,title:'端末内の未解決変更'}, conflict:true,
  }];
  storage.setItem('account-personal-sync-v2',JSON.stringify(saved));
  const state={events:{}};
  const requestJson=async(path)=>{
    if(path==='/api/personal/events/status') return {active:true};
    if(path==='/api/personal/events/sync?cursor=8') return {events:[],cursor:8,hasMore:false};
    if(path==='/api/personal/events') return {events:[event]};
    throw new Error(`Unexpected request: ${path}`);
  };
  const sync=createPersonalSync({storage,key:'account',state,requestJson});
  await sync.initialize();
  assert.equal(state.events[event.date]?.[0]?.title,'端末内の未解決変更');
  assert.match(sync.status(),/競合/);
  assert.equal(JSON.parse(storage.getItem('account-personal-sync-v2')).queue.length,1);
});
