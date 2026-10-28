import test from 'node:test';
import assert from 'node:assert/strict';
import {groupCandidateSlots,dayLabel} from './availability-presentation.mjs';
import {timelineSegments} from './member-timeline.mjs';

test('adjacent 30 minute starts appear as one range but keep every valid start',()=>{
  const groups=groupCandidateSlots([
    {start:'14:00',end:'16:00',needsConfirmation:false},
    {start:'14:30',end:'16:30',needsConfirmation:false},
    {start:'15:00',end:'17:00',needsConfirmation:false},
  ]);
  assert.equal(groups.length,1);
  assert.equal(groups[0].start,'14:00');assert.equal(groups[0].end,'17:00');
  assert.equal(groups[0].slots.length,3);
  assert.match(dayLabel('2030-10-30'),/10/);
});
test('busy intervals merge overlaps and clip to the visible clock',()=>{
  assert.deepEqual(timelineSegments([
    {start:'08:00',end:'10:00'},
    {start:'09:30',end:'12:30'},
    {start:'18:00',end:'23:00'},
  ]).map(({a,b})=>[a,b]),[[540,750],[1080,1320]]);
});
