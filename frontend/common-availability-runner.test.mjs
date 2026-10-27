import assert from 'node:assert/strict';
import test from 'node:test';
import {createAvailabilityRunner} from './common-availability-runner.mjs';
import {tokyoToday,validateCommonAvailability} from './common-availability.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('Tokyo date and 14-day, duration and window limits',()=>{
  assert.equal(tokyoToday(new Date('2026-10-26T15:30:00Z')),'2026-10-27');
  const query={userIds:['a','b'],startDate:'2026-10-27',endDate:'2026-11-02',durationMinutes:120,windowStart:540,windowEnd:1320};
  assert.equal(validateCommonAvailability(query),null);
  assert.ok(validateCommonAvailability({...query,endDate:'2026-11-10'}));
  assert.ok(validateCommonAvailability({...query,windowStart:1230}));
});
test('changes debounce, old results cannot overwrite and close stops pending requests',async()=>{
  const pending=[],shown=[];
  const runner=createAvailabilityRunner({delay:15,request:(payload,signal)=>new Promise(resolve=>pending.push({payload,signal,resolve})),show:data=>shown.push(data),fail:()=>{},loading:()=>{}});
  runner.open('account');
  runner.run({groupId:'one',n:1});runner.run({groupId:'one',n:2});
  runner.run({groupId:'one',n:2});
  await pause(25);assert.equal(pending.length,1);assert.equal(pending[0].payload.n,2);
  runner.run({groupId:'one',n:2},{immediate:true});assert.equal(pending.length,1);
  runner.run({groupId:'one',n:3},{immediate:true});assert.equal(pending[0].signal.aborted,true);
  pending[0].resolve('stale');pending[1].resolve('new');await pause(0);assert.deepEqual(shown,['new']);
  runner.run({groupId:'one',n:4});runner.close();await pause(25);assert.equal(pending.length,2);
});
test('cache expires, invalidation and logout separate accounts',async()=>{
  let clock=0,calls=0;const shown=[];
  const runner=createAvailabilityRunner({now:()=>clock,ttl:100,request:async()=>++calls,show:data=>shown.push(data),fail:()=>{},loading:()=>{}});
  const query={groupId:'group',userIds:['a','b']};runner.open('one');runner.run(query,{immediate:true});await pause(0);
  runner.run(query,{immediate:true});assert.equal(calls,1);
  clock=101;runner.run(query,{immediate:true});await pause(0);assert.equal(calls,2);
  runner.invalidate('group');runner.run(query,{immediate:true});await pause(0);assert.equal(calls,3);
  runner.clear();runner.open('two');runner.run(query,{immediate:true});await pause(0);assert.equal(calls,4);
  assert.deepEqual(shown,[1,1,2,3,4]);
});
