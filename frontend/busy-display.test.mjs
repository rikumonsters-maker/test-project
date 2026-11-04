import test from 'node:test';
import assert from 'node:assert/strict';
import {busyAgendaName,busyCalendarLabel,busyCalendarAriaLabel} from './busy-display.mjs';

test('the busy label does not infer a name from private event fields',()=>{
  assert.equal(busyAgendaName({title:'田中の予定',note:'田中',start:'14:00'}),'予定あり');
});

test('calendar and detail use only the server-authorized name, including overlapping members',()=>{
  const events=[
    {busyDisplayName:'田中',start:'13:30',end:'14:38',title:'private title'},
    {busyDisplayName:'佐藤',start:'13:30',end:'15:00',note:'private note'},
    {start:'13:30',end:'14:38',title:'another group private'},
  ];
  assert.deepEqual(events.map(busyCalendarLabel),[
    '田中さん 13:30〜14:38','佐藤さん 13:30〜15:00','予定あり 13:30〜14:38',
  ]);
  assert.equal(busyAgendaName(events[0]),'田中さん　予定あり');
  assert.equal(busyCalendarAriaLabel(events[0]),'田中さん　予定あり 13:30から14:38');
  assert.equal(busyCalendarAriaLabel(events[2]),'予定あり 13:30から14:38');
  assert.equal(busyCalendarLabel({busyDisplayName:'田中さん',allDay:true}),'田中さん 終日');
  assert.equal(busyCalendarLabel({busyDisplayName:'メンバー',start:'13:30',end:'14:38'}),'メンバー 13:30〜14:38');
});

test('only an explicitly supplied display name labels a busy event',()=>{
  assert.equal(busyAgendaName({busyDisplayName:'田中',title:'秘密の予定',start:'13:00',end:'15:00'}),'田中さん　予定あり');
  assert.equal(busyAgendaName({busyDisplayName:'田中さん',title:'秘密の予定'}),'田中さん　予定あり');
  assert.equal(busyAgendaName({title:'秘密の予定',start:'13:00',end:'15:00'}),'予定あり');
  assert.equal(busyAgendaName({busyDisplayName:'',title:'秘密の予定'}),'予定あり');
});
