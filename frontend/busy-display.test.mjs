import test from 'node:test';
import assert from 'node:assert/strict';
import {busyAgendaName} from './busy-display.mjs';

test('the busy label does not infer a name from private event fields',()=>{
  assert.equal(busyAgendaName({title:'田中の予定',note:'田中',start:'14:00'}),'予定あり');
});

test('only an explicitly supplied display name labels a busy event',()=>{
  assert.equal(busyAgendaName({busyDisplayName:'田中',title:'秘密の予定',start:'13:00',end:'15:00'}),'田中さん　予定あり');
  assert.equal(busyAgendaName({busyDisplayName:'田中さん',title:'秘密の予定'}),'田中さん　予定あり');
  assert.equal(busyAgendaName({title:'秘密の予定',start:'13:00',end:'15:00'}),'予定あり');
  assert.equal(busyAgendaName({busyDisplayName:'',title:'秘密の予定'}),'予定あり');
});
