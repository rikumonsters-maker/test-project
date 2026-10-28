import test from 'node:test';
import assert from 'node:assert/strict';
import { initBudget } from './budget.js';

test('budget calculation sends the viewed month and the device date without other private data', async () => {
  const current=new Date();
  const month=new Date(current.getFullYear(),current.getMonth(),1);
  const monthKey=`${month.getFullYear()}-${String(month.getMonth()+1).padStart(2,'0')}`;
  const elements = new Map([
    ['fixed',{value:'10000'}], ['saving',{value:'5000'}],
    ['expense-month-total-label',{}], ['expense-month-total',{}],
    ['remaining',{}], ['daily',{}], ['budget-status',{}],
  ]);
  let sent;
  const app = {
    $:id => elements.get(id),
    state:{expenses:{},incomeMode:'manual',manualIncome:'50000'},
    view:{budgetMonth:month,budgetRequest:0},
    monthPrefix:() => `${monthKey}-`,
    dateKey:() => '2028-03-01',
    money:{format:value => String(value)},
    formatMoney:value => String(value),
    status:() => {},
    postJson:async (path,payload) => {sent={path,payload};return {remaining:35000,daily:null,status:'safe'};},
  };
  await initBudget(app).calculate();
  assert.equal(sent.path,'/api/budget');
  assert.deepEqual(sent.payload,{income:50000,fixed:10000,saving:5000,spent:0,month:monthKey,today:'2028-03-01'});
  assert.equal(elements.get('daily').textContent,'—');
});

test('historical month does not compare current income forecast as past income', async () => {
  const elements=new Map([
    ['fixed',{value:'10000'}],['saving',{value:'5000'}],['expense-month-total-label',{}],
    ['expense-month-total',{}],['remaining',{}],['daily',{}],['budget-status',{}],
  ]);
  let calls=0;
  const app={ $:id=>elements.get(id),state:{expenses:{},incomeMode:'manual',manualIncome:'50000'},
    view:{budgetMonth:new Date(2020,0,1),budgetRequest:0},formatMoney:value=>String(value),
    status:()=>{},postJson:async()=>{calls++;return {};}};
  await initBudget(app).calculate();
  assert.equal(calls,0);
  assert.equal(elements.get('remaining').textContent,'—');
});
