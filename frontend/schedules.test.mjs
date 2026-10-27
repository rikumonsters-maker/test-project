import assert from 'node:assert/strict';
import test from 'node:test';
import {validateScheduleDraft,validateScheduleOption} from './schedules.mjs';

const draft={title:'週末の予定',deadline:'2030-10-20T18:00',participantUserIds:['a','b'],
  minimumParticipants:2,requireAll:true,option:{date:'2030-10-21',start:'13:00',end:'15:00'}};
test('schedule draft accepts a valid group poll and checks participant minimum',()=>{
  assert.equal(validateScheduleDraft(draft),null);
  for(const invalid of [
    {...draft,participantUserIds:['a','a']},
    {...draft,participantUserIds:['a']},
    {...draft,minimumParticipants:3},
    {...draft,requireAll:true,minimumParticipants:1},
    {...draft,deadline:'2020-01-01T00:00'},
  ])assert.ok(validateScheduleDraft(invalid));
});
test('schedule draft rejects invalid or overnight candidate times before calling API',()=>{
  for(const option of [
    {date:'2030-10-21',start:'13:15',end:'15:00'},
    {date:'2030-10-21',start:'21:30',end:'22:30'},
    {date:'2030-10-21',start:'15:00',end:'13:00'},
    {date:'2030-10-21',start:'13:00',end:'13:30'},
  ])assert.ok(validateScheduleDraft({...draft,option}));
  assert.equal(validateScheduleOption(draft.option),null);
});
