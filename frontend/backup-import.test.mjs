import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePersonalBackup } from './backup-import.mjs';
import { createPersonalSync } from './personal-sync.mjs';

const sample = { '2026-10-15': [{ id:'old-id', title:'読書', start:'18:00', end:'19:00', note:'駅前' }] };

test('reads a DaySync JSON backup and preserves the complete dated event map', () => {
  const backup = JSON.stringify({ savedAt:'2026-10-10T00:00:00.000Z', originalState:'{}', events:sample });
  assert.deepEqual(parsePersonalBackup(backup), { events:sample, count:1 });
});

test('reads raw state JSON and the originalState envelope from older backups', () => {
  assert.deepEqual(parsePersonalBackup(JSON.stringify({ events:sample })), { events:sample, count:1 });
  assert.deepEqual(parsePersonalBackup(JSON.stringify({ originalState:JSON.stringify({ events:sample }) })), { events:sample, count:1 });
});

test('a current backup does not silently fall back to its archived pre-cutover calendar', () => {
  const backup=JSON.stringify({events:{},archiveEvents:sample,originalState:JSON.stringify({events:sample})});
  assert.throws(()=>parsePersonalBackup(backup),/予定がありません/);
  assert.deepEqual(parsePersonalBackup(backup,{includeArchive:true}),{events:sample,count:1});
});

test('rejects malformed or empty event data before any import can begin', () => {
  assert.throws(() => parsePersonalBackup('{broken'), /JSON/);
  assert.throws(() => parsePersonalBackup(JSON.stringify({ events:{ '2026-02-30':[{ title:'無効な日付' }] } })), /形式/);
  assert.throws(() => parsePersonalBackup(JSON.stringify({ events:{ '2026-10-15':[{ title:'' }] } })), /予定/);
  assert.throws(() => parsePersonalBackup(JSON.stringify({ events:{} })), /見つかりません/);
});

test('explicitly restored backup events are queued separately from ordinary local state', async () => {
  const values = new Map();
  const storage = { getItem:key=>values.get(key) ?? null, setItem:(key,value)=>values.set(key,value) };
  const current = { id:'current', title:'同期済みの予定', start:'09:00', end:'10:00' };
  const state = { events:{ '2026-10-20':[current] } };
  let activated=false;
  const requests=[];
  const sync = createPersonalSync({ storage, key:'user-A', state, requestJson:async(url,options={})=>{
    requests.push({url,options});
    if(url.endsWith('/status')) return {active:true};
    if(url.startsWith('/api/personal/events/sync?')) return {events:[{...current,id:'current',date:'2026-10-20',allDay:false,note:'',extra:{},version:1,deleted:false}],cursor:0,hasMore:false};
    if(url.endsWith('/import')) { assert.equal(options.payload.restoreConfirmed,true); return {event:{...options.payload.event,id:'restored',version:1},migrationConflict:false}; }
    if(url.endsWith('/activate')) {activated=true;return {active:true};}
    throw new Error(`unexpected ${url}`);
  }, makeId:(()=>{let n=0;return()=>`import-${++n}`;})() });
  await sync.initialize();
  assert.equal(activated,false);
  const { events } = parsePersonalBackup(JSON.stringify({ events:sample }));
  sync.restore(events);
  await sync.sync();
  assert.equal(state.events['2026-10-20'][0].title, '同期済みの予定');
  assert.equal(state.events['2026-10-15'].length, 1);
  assert.equal(state.events['2026-10-15'][0].title, '読書');
  assert.equal(requests.some(request=>request.url.endsWith('/activate')),false);
});
