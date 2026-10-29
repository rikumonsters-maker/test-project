import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {initMemberTimeline} from './member-timeline.mjs';

test('day detail keeps consent visible and puts comparison inside a keyboard-operable closed details',()=>{
  const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
  const consent=html.indexOf('id="member-timeline-consent"');
  const details=html.indexOf('id="member-timeline-details"');
  const timeline=html.indexOf('id="member-timeline"');
  assert.ok(consent>0&&consent<details&&details<timeline);
  assert.match(html,/id="member-timeline-details"[^>]*>\s*<summary[^>]*>メンバー別の時間帯を比較<\/summary>/);
  assert.doesNotMatch(html,/id="member-timeline-details"[^>]*\bopen\b/);
});

test('closed comparison fetches setting only; expansion and date changes retain open state',async()=>{
  const listeners=new Map(),calls=[];
  const root={textContent:'',replaceChildren(){this.textContent='';}};
  const toggle={checked:false,disabled:false,addEventListener(name,callback){listeners.set('consent',callback);}};
  const details={open:false,addEventListener(name,callback){listeners.set('details',callback);}};
  const elements={'member-timeline':root,'member-timeline-consent':toggle,'member-timeline-details':details};
  const timeline=initMemberTimeline({$:id=>elements[id],activeGroup:()=>({groupId:'group-1'}),
    requestJson:async(path)=>{calls.push(path);return path.endsWith('/setting')?{enabled:false}:{members:[]};}});
  await timeline.show('2030-10-30');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['/api/shared/named-busy/setting']);
  assert.equal(details.open,false);
  details.open=true;listeners.get('details')();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.filter(path=>path.endsWith('/timeline')).length,1);
  await timeline.show('2030-10-31');
  assert.equal(details.open,true);
  assert.equal(calls.filter(path=>path.endsWith('/timeline')).length,2);
  details.open=false;listeners.get('details')();
  await timeline.show('2030-11-01');
  assert.equal(calls.filter(path=>path.endsWith('/timeline')).length,2);
});
