import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCommonAvailability } from './common-availability.mjs';

const valid={userIds:['a','b'],startDate:'2030-10-01',endDate:'2030-10-14',durationMinutes:90};
test('common availability accepts 14 days and half-hour duration steps',()=>{
  assert.equal(validateCommonAvailability(valid),null);
  assert.equal(validateCommonAvailability({...valid,startDate:'2030-10-31',endDate:'2030-11-01'}),null);
});
test('common availability rejects insufficient members, long ranges and invalid durations',()=>{
  for (const payload of [
    {...valid,userIds:['a']},
    {...valid,endDate:'2030-10-15'},
    {...valid,endDate:'2030-09-30'},
    {...valid,startDate:'2030-02-30'},
    {...valid,durationMinutes:75},
    {...valid,durationMinutes:390},
  ]) assert.ok(validateCommonAvailability(payload));
});
