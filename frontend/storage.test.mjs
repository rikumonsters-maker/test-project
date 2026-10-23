import test from 'node:test';
import assert from 'node:assert/strict';
import { userStorageKey, readStoredState, savePersonalState, mergeLegacyNonEventState } from './storage.mjs';

test('personal data belongs to only the selected user ID', () => {
  const values = new Map();
  const storage = { getItem:key => values.get(key) ?? null, setItem:(key, value) => values.set(key, value) };
  const first = userStorageKey('11111111-1111-4111-8111-111111111111');
  const second = userStorageKey('22222222-2222-4222-8222-222222222222');
  savePersonalState(storage, first, { shifts:{ '2026-10-01':{ start:'09:00' } }, groups:[{ memberToken:'secret' }], expenses:{} });
  assert.equal(readStoredState(storage, first).shifts['2026-10-01'].start, '09:00');
  assert.deepEqual(readStoredState(storage, second), {});
  assert.equal(values.get(first).includes('memberToken'), false);
  assert.equal(values.get(first).includes('secret'), false);
});

test('legacy transfer excludes events while retaining non-event data without overwriting newer account values', () => {
  const current={events:{'2026-10-20':[{id:'new',title:'新予定'}]},shifts:{'2026-10-01':{start:'14:00'}},
    expenses:{'2026-10-01':[{id:'current-expense',amount:100}]},hourly:'22',manualIncome:'',incomeMode:'auto',theme:'dark',
    budget:{fixed:'5000',saving:'',spent:''},pendingGroupMonths:{group:{'2026-10':3}}};
  const legacy={events:{'2026-10-02':[{id:'old',title:'旧予定'}]},shifts:{'2026-10-01':{start:'09:00'},'2026-10-03':{start:'10:00'}},
    expenses:{'2026-10-01':[{id:'current-expense',amount:999},{id:'legacy-expense',amount:50}],'2026-10-04':[{id:'old-date-expense',amount:60}]},
    hourly:'18',manualIncome:'40000',incomeMode:'manual',theme:'light',budget:{fixed:'9000',saving:'2000',spent:'100'},
    pendingGroupMonths:{group:{'2026-10':1,'2026-11':1}}};
  const merged=mergeLegacyNonEventState(current,legacy);
  assert.deepEqual(merged.events,current.events);
  assert.equal(merged.shifts['2026-10-01'].start,'14:00');
  assert.equal(merged.shifts['2026-10-03'].start,'10:00');
  assert.deepEqual(merged.expenses['2026-10-01'].map(row=>row.id),['current-expense','legacy-expense']);
  assert.equal(merged.expenses['2026-10-04'][0].id,'old-date-expense');
  assert.equal(merged.hourly,'22');assert.equal(merged.manualIncome,'40000');assert.equal(merged.incomeMode,'manual');
  assert.equal(merged.theme,'dark');assert.equal(merged.budget.fixed,'5000');assert.equal(merged.budget.saving,'2000');
  assert.deepEqual(merged.pendingGroupMonths.group,{'2026-10':3,'2026-11':1});
});
