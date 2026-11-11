import test from 'node:test';
import assert from 'node:assert/strict';
import {groupCandidateSlots,dayLabel,availabilitySlotState,bestDailyCandidate} from './availability-presentation.mjs';
import {timelineSegments} from './member-timeline.mjs';
import {readFile} from 'node:fs/promises';
const stylesheet=await readFile(new URL('./style.css',import.meta.url),'utf8');

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
test('time block state distinguishes conflicts, missing confirmation, candidates and insufficient minimums',()=>{
  assert.equal(availabilitySlotState({hardConflictCount:1,unconfirmedCount:0,meetsMinimum:false}),'conflict');
  assert.equal(availabilitySlotState({hardConflictCount:0,tentativeConflictCount:0,unconfirmedCount:1,meetsMinimum:false}),'unconfirmed');
  assert.equal(availabilitySlotState({hardConflictCount:0,tentativeConflictCount:0,unconfirmedCount:0,meetsMinimum:false}),'insufficient');
  assert.equal(availabilitySlotState({hardConflictCount:0,tentativeConflictCount:0,unconfirmedCount:0,meetsMinimum:true}),'candidate');
  assert.equal(availabilitySlotState(undefined),'unavailable');
});
test('daily display summary chooses only an existing backend candidate and follows backend ranking',()=>{
  const insufficient={start:'09:00',meetsMinimum:false,registeredClearCount:0};
  const partial={start:'10:00',meetsMinimum:true,allRegisteredClear:false,hardConflictCount:1,registeredClearCount:2};
  const clear={start:'11:00',meetsMinimum:true,allRegisteredClear:true,hardConflictCount:0,registeredClearCount:3};
  assert.equal(bestDailyCandidate([insufficient,partial,clear]),clear);
  assert.equal(bestDailyCandidate([insufficient]),null);
});
test("availability palettes are scoped, theme-specific, and shared by blocks and legend",()=>{
  const ruleBody=selector=>{
    const start=stylesheet.indexOf(selector);
    assert.notEqual(start,-1,"missing CSS rule: "+selector);
    const open=stylesheet.indexOf("{",start),close=stylesheet.indexOf("}",open);
    assert.ok(open>start&&close>open,"invalid CSS rule: "+selector);
    return stylesheet.slice(open+1,close);
  };
  const light=ruleBody(".common-availability-dialog");
  const dark=ruleBody(":root[data-theme=\"dark\"] .common-availability-dialog");
  const states={
    candidate:["#C5EBD0","#237A49","#154F3A","#74D0A2"],
    unconfirmed:["#FFE49A","#A86A00","#594008","#FFD77A"],
    conflict:["#F5BDC1","#A22D38","#5A2632","#FF9FA8"],
    insufficient:["#DED1F7","#6B42A8","#392B59","#C4AEFF"],
    unavailable:["#E7EBF0","#788492","#303944","#91A0AE"],
  };
  for(const [state,palette] of Object.entries(states)){
    const [lightBg,lightBorder,darkBg,darkBorder]=palette;
    assert.ok(light.includes("--availability-"+state+"-bg:"+lightBg),"wrong light "+state+" background");
    assert.ok(light.includes("--availability-"+state+"-border:"+lightBorder),"wrong light "+state+" border");
    assert.ok(dark.includes("--availability-"+state+"-bg:"+darkBg),"wrong dark "+state+" background");
    assert.ok(dark.includes("--availability-"+state+"-border:"+darkBorder),"wrong dark "+state+" border");
    const backgroundProperty=state==="conflict"?"background-color":"background";
    assert.ok(stylesheet.includes(".availability-block.is-"+state+",.availability-block-swatch.is-"+state+" { "+backgroundProperty+":var(--availability-"+state+"-bg);"),"block and legend do not share "+state+" background");
    const selector=".availability-block.is-"+state+",.availability-block-swatch.is-"+state+" {";
    const start=stylesheet.indexOf(selector),end=stylesheet.indexOf("}",start);
    const stateRule=stylesheet.slice(start,end);
    assert.ok(stateRule.includes("border:1px")&&stateRule.includes("var(--availability-"+state+"-border)"),"block and legend do not share "+state+" outline");
  }
  assert.ok(stylesheet.includes(".availability-block.has-conflict::before"));
  assert.ok(stylesheet.includes(".availability-block.has-unconfirmed::after"));
  assert.ok(stylesheet.includes(".availability-day-recommendation:has(> .availability-day-recommendation-none)"));
});
