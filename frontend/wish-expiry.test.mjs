import test from 'node:test';
import assert from 'node:assert/strict';
import {tokyoToday,visibleWishes,millisUntilNextTokyoDay} from './wish-expiry.mjs';

test('Tokyo midnight hides yesterday but keeps today across month and year boundaries',()=>{
  for(const [before,after,oldDate,newDate] of [
    ['2026-10-29T14:59:59Z','2026-10-29T15:00:00Z','2026-10-29','2026-10-30'],
    ['2026-10-31T14:59:59Z','2026-10-31T15:00:00Z','2026-10-31','2026-11-01'],
    ['2026-12-31T14:59:59Z','2026-12-31T15:00:00Z','2026-12-31','2027-01-01'],
  ]){
    assert.equal(tokyoToday(new Date(before)),oldDate);
    assert.equal(tokyoToday(new Date(after)),newDate);
    assert.deepEqual(visibleWishes([{wishDate:oldDate},{wishDate:newDate}],tokyoToday(new Date(after))),[{wishDate:newDate}]);
    assert.equal(millisUntilNextTokyoDay(new Date(before)),1050);
  }
});
