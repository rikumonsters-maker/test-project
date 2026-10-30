import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initMemberTimeline} from './member-timeline.mjs';

test('comparison stays closed initially and legacy consent control is absent',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/id="member-timeline-consent"/);
  assert.match(html,/id="member-timeline-details"[^>]*>\s*<summary[^>]*>メンバー別の時間帯を比較<\/summary>/);
  assert.doesNotMatch(html,/id="member-timeline-details"[^>]*\bopen\b/);
});

test('closed comparison makes no request; expanded date changes refresh it',async()=>{
  const listeners=new Map(),calls=[];
  const root={textContent:'',replaceChildren(){this.textContent='';}};
  const details={open:false,addEventListener(name,callback){listeners.set(name,callback);}};
  const timeline=initMemberTimeline({$:id=>({'member-timeline':root,'member-timeline-details':details})[id],
    activeGroup:()=>({groupId:'group-1'}),requestJson:async(path)=>{calls.push(path);return {members:[]};}});
  await timeline.show('2030-10-30');assert.deepEqual(calls,[]);
  details.open=true;listeners.get('toggle')();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1);
  await timeline.show('2030-10-31');assert.equal(details.open,true);assert.equal(calls.length,2);
  details.open=false;listeners.get('toggle')();await timeline.show('2030-11-01');assert.equal(calls.length,2);
});

test('group switch discards an old response and closes comparison',async()=>{
  const listeners=new Map(),root={textContent:'',replaceChildren(){this.textContent='';}};
  const details={open:false,addEventListener(name,callback){listeners.set(name,callback);}};
  let groupId='first',release;
  const timeline=initMemberTimeline({$:id=>({'member-timeline':root,'member-timeline-details':details})[id],
    activeGroup:()=>({groupId}),requestJson:()=>new Promise(resolve=>{release=resolve;})});
  await timeline.show('2030-10-30');details.open=true;listeners.get('toggle')();
  groupId='second';await timeline.show('2030-10-30');assert.equal(details.open,false);
  release({members:[]});await new Promise(resolve=>setImmediate(resolve));assert.equal(root.textContent,'');
});
