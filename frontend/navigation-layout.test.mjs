import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {activateMainPage,activateMoneyView} from './navigation.mjs';

const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
function sectionParents(source){
  const stack=[],parents=new Map();
  for(const match of source.matchAll(/<\/?section\b[^>]*>/g)){
    if(match[0].startsWith('</')){assert.ok(stack.length,'unmatched section');stack.pop();continue;}
    const id=match[0].match(/\bid="([^"]+)"/)?.[1];
    if(id)parents.set(id,stack.at(-1)||null);
    stack.push(id||stack.at(-1)||null);
  }
  assert.equal(stack.length,0,'section tags must balance');
  return parents;
}
test('main navigation is planned, shared, money; money contains both existing panels',()=>{
  const nav=html.match(/<nav class="page-nav"[\s\S]*?<\/nav>/)?.[0]||'';
  assert.deepEqual([...nav.matchAll(/data-page="([^"]+)"/g)].map(match=>match[1]),['my','group','money']);
  assert.ok(html.indexOf('id="page-calendar"')<html.indexOf('id="page-group"'));
  assert.ok(html.indexOf('id="page-money"')<html.indexOf('id="page-budget"'));
  assert.ok(html.indexOf('id="page-money"')<html.indexOf('id="page-shift"'));
  assert.deepEqual([...html.matchAll(/data-money-view="([^"]+)"/g)].map(match=>match[1]),['budget','shift']);
  assert.match(html,/id="money-page-title">お金<\/h2>/);
  assert.match(html,/data-money-view="budget">家計簿<\/button>/);
  assert.match(html,/data-money-view="shift">シフト・給与<\/button>/);
  const parents=sectionParents(html);
  assert.equal(parents.get('page-calendar'),'page-my');
  assert.equal(parents.get('page-budget'),'page-money');
  assert.equal(parents.get('page-shift'),'page-money');
  for(const id of ['page-calendar','page-budget','page-shift','agenda-calendar','shift-calendar','expense-calendar','common-availability-open'])
    assert.equal([...html.matchAll(new RegExp('id="'+id+'"','g'))].length,1,id);
});
test('shared calendar remains primary and availability keeps automatic controls',()=>{
  assert.ok(html.indexOf('id="group-calendar-title"')<html.indexOf('id="group-actions-title"'));
  assert.ok(html.indexOf('id="group-calendar-title"')<html.indexOf('id="group-info-title"'));
  assert.match(html,/id="common-availability-refresh"/);
  assert.doesNotMatch(html,/id="common-availability-submit"/);
});
test('money subtab switches panels and keeps DOM state',()=>{
  const buttons=['budget','shift'].map(moneyView=>({dataset:{moneyView},setAttribute(name,value){this[name]=value;},tabIndex:0}));
  const panels={budget:{hidden:false,value:'draft expense'},shift:{hidden:true,value:'draft shift'}};
  let budgetRefreshes=0,shiftRefreshes=0;
  const document={querySelectorAll:()=>buttons,getElementById:id=>panels[id.slice(5)]};
  const callbacks={onBudget:()=>budgetRefreshes++,onShift:()=>shiftRefreshes++};
  assert.equal(activateMoneyView(document,'shift',callbacks),true);
  assert.equal(panels.budget.hidden,true);assert.equal(panels.shift.hidden,false);
  assert.equal(panels.budget.value,'draft expense');assert.equal(buttons[1]['aria-selected'],'true');
  assert.equal(activateMoneyView(document,'budget',callbacks),true);
  assert.equal(panels.budget.hidden,false);assert.equal(panels.shift.hidden,true);
  assert.equal(panels.shift.value,'draft shift');assert.equal(budgetRefreshes,1);assert.equal(shiftRefreshes,1);
  assert.equal(activateMoneyView(document,'unknown',callbacks),false);
});
test('startup chooses planned calendar and later switches preserve money panel input',()=>{
  const panels=['my','group','money','profile'].map(name=>({id:'page-'+name,hidden:true}));
  const buttons=['my','group','money'].map(page=>({dataset:{page},setAttribute(name,value){this[name]=value;},removeAttribute(name){delete this[name];}}));
  let planRenders=0,moneyOpens=0;
  const document={querySelectorAll:selector=>selector==='.page-panel'?panels:buttons};
  const callbacks={onPlan:()=>planRenders++,onMoney:()=>moneyOpens++};
  assert.equal(activateMainPage(document,'my',callbacks),true);
  assert.equal(panels[0].hidden,false);assert.equal(buttons[0]['aria-current'],'page');
  activateMainPage(document,'money',callbacks);
  assert.equal(panels[2].hidden,false);assert.equal(panels[0].hidden,true);assert.equal(moneyOpens,1);
  activateMainPage(document,'group',callbacks);
  assert.equal(panels[1].hidden,false);assert.equal(planRenders,1);
  assert.equal(activateMainPage(document,'invalid',callbacks),false);
});
