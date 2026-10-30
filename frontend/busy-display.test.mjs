import test from 'node:test';
import assert from 'node:assert/strict';
import {busyAgendaName} from './busy-display.mjs';

test('only an explicitly supplied display name labels a busy event',()=>{
  assert.equal(busyAgendaName({busyDisplayName:'田中',title:'秘密の予定',start:'13:00',end:'15:00'}),'田中　予定あり');
  assert.equal(busyAgendaName({title:'秘密の予定',start:'13:00',end:'15:00'}),'予定あり');
  assert.equal(busyAgendaName({busyDisplayName:'',title:'秘密の予定'}),'予定あり');
});
