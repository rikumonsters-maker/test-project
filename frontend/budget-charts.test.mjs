import test from 'node:test';
import assert from 'node:assert/strict';
import { expenseBreakdown, expenseTrend, shiftIncomeForMonth, incomeForecast } from './budget-charts.mjs';

test('expense charts count recorded expenses once and leave budget fixed costs and saving out', () => {
  const expenses={'2026-10-01':[{amount:1200,category:'食費'},{amount:300,category:'交通'}],
    '2026-10-02':[{amount:500,category:'固定費'}], '2026-09-30':[{amount:999,category:'食費'}]};
  const result=expenseBreakdown(expenses,new Date(2026,9,1));
  assert.equal(result.total,2000);
  assert.equal(result.amounts['食費'],1200);
  assert.equal(result.amounts['固定費'],500);
  assert.equal(result.amounts['その他'],0);
  assert.equal(result.amounts['食費']/result.total,0.6);
  assert.equal(result.count,3);
});

test('six months stay ordered across a year boundary and distinguish no records', () => {
  const trend=expenseTrend({'2025-11-15':[{amount:300,category:'娯楽'}],
    '2026-02-01':[{amount:999999999,category:'買い物'}]},new Date(2026,2,1));
  assert.deepEqual(trend.map(item=>`${item.month.getFullYear()}-${item.month.getMonth()+1}`),
    ['2025-10','2025-11','2025-12','2026-1','2026-2','2026-3']);
  assert.deepEqual(trend.map(item=>item.total),[0,300,0,0,999999999,0]);
  assert.deepEqual(trend.map(item=>item.count),[0,1,0,0,1,0]);
});

test('editing and deleting expense records immediately changes the next aggregation', () => {
  const rows={'2026-10-01':[{id:'one',amount:100,category:'食費'}]};
  assert.equal(expenseBreakdown(rows,new Date(2026,9,1)).total,100);
  rows['2026-10-01'][0]={id:'one',amount:400,category:'交通'};
  assert.equal(expenseBreakdown(rows,new Date(2026,9,1)).amounts['交通'],400);
  delete rows['2026-10-01'];
  assert.equal(expenseBreakdown(rows,new Date(2026,9,1)).total,0);
});

test('shift forecast uses the viewed month, overnight hours and current account only', () => {
  const state={incomeMode:'auto',hourly:'1200',manualIncome:'80000',shifts:{
    '2026-10-01':{start:'22:00',end:'06:00',breakMinutes:60},
    '2026-11-01':{start:'09:00',end:'17:00',breakMinutes:0}}};
  const now=new Date(2026,9,28);
  assert.equal(shiftIncomeForMonth(state.shifts,state.hourly,new Date(2026,9,1)),8400);
  assert.equal(incomeForecast(state,new Date(2026,9,1),now),8400);
  assert.equal(incomeForecast(state,new Date(2026,10,1),now),null);
  assert.equal(incomeForecast({...state,hourly:''},new Date(2026,9,1),now),null);
  assert.equal(incomeForecast({...state,incomeMode:'manual'},new Date(2026,9,1),now),80000);
  assert.equal(incomeForecast({...state,incomeMode:'manual',manualIncome:''},new Date(2026,9,1),now),null);
  assert.equal(incomeForecast({...state,shifts:{}},new Date(2026,9,1),now),0);
});

test('account data is supplied afresh and no expense cache survives a switch', () => {
  const first={'2026-10-01':[{amount:777,category:'その他'}]};
  assert.equal(expenseBreakdown(first,new Date(2026,9,1)).total,777);
  assert.equal(expenseBreakdown({},new Date(2026,9,1)).total,0);
});
