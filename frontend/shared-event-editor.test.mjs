import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canManageSharedEvent, initSharedEventEditor } from './shared-event-editor.mjs';

const event = {id:'e1',sourceType:'shared',status:'confirmed',canManage:true,creatorLeft:true,
  title:'共有タイトル',eventDate:'2030-10-21',start:'13:00',end:'14:00',allDay:false,note:'共有メモ'};
function setup(handler=async()=>({ok:true})) {
  const element=()=>({listeners:{},value:'',checked:false,disabled:false,required:false,
    addEventListener(type,fn){this.listeners[type]=fn;},focus(){this.focused=true;}});
  const fields=Object.fromEntries(['title','eventDate','start','end','note','allDay'].map(n=>[n,element()]));
  const elements=Object.values(fields); elements.namedItem=n=>fields[n];
  const nodes=Object.fromEntries(['shared-event-editor','shared-event-edit-form','shared-event-edit-status',
    'shared-event-edit-delete','shared-event-edit-close'].map(n=>[n,element()]));
  const dialog=nodes['shared-event-editor']; dialog.showModal=()=>dialog.open=true;dialog.close=()=>dialog.open=false;
  nodes['shared-event-edit-form'].elements=elements;
  let group={groupId:'g1'}, saved=0;
  const calls=[];
  const editor=initSharedEventEditor({$:id=>nodes[id],activeGroup:()=>group,
    requestJson:async(...args)=>{calls.push(args);return handler(...args);},onSaved:()=>{saved++;}});
  return {editor,fields,nodes,calls,dialog,get saved(){return saved;},changeGroup:()=>group={groupId:'g2'},
    submit:()=>nodes['shared-event-edit-form'].listeners.submit({preventDefault(){}})};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('only server-authorized confirmed shared events have management controls',()=>{
  assert.equal(canManageSharedEvent(event),true);
  for(const changed of [{canManage:false},{canManage:undefined},{sourceType:'personal'},{sourceType:'busy'},{status:'tentative'}])
    assert.equal(canManageSharedEvent({...event,...changed}),false);
});

test('editor saves shared fields to the selected group and refreshes after success',async()=>{
  const s=setup();s.editor.open(event);
  assert.equal(s.dialog.open,true);assert.equal(s.fields.title.focused,true);
  s.fields.title.value='変更';s.submit();await settle();
  assert.deepEqual(s.calls,[['/api/shared/events/update',{payload:{groupId:'g1',id:'e1',title:'変更',eventDate:event.eventDate,allDay:false,start:'13:00',end:'14:00',note:event.note}}]]);
  assert.equal(s.saved,1);assert.equal(s.dialog.open,false);
});

test('all-day editor clears time fields and does not send stale-group changes',async()=>{
  const s=setup();s.editor.open(event);s.fields.allDay.checked=true;
  s.fields.allDay.listeners.change();assert.equal(s.fields.start.disabled,true);
  s.submit();await settle();assert.equal(s.calls[0][1].payload.start,'');
  s.editor.open(event);s.changeGroup();s.submit();await settle();assert.equal(s.calls.length,1);
});

test('API rejection preserves the open editor and reports the error',async()=>{
  const s=setup(async()=>{throw new Error('権限がありません');});s.editor.open(event);s.submit();await settle();
  assert.equal(s.dialog.open,true);assert.equal(s.saved,0);
  assert.equal(s.nodes['shared-event-edit-status'].textContent,'権限がありません');
  assert.equal(s.fields.title.disabled,false);
});

test('delete requires explicit confirmation and only sends group/event IDs',async()=>{
  const previous=globalThis.window;
  try {
    const s=setup();s.editor.open(event);
    globalThis.window={confirm:()=>false};s.nodes['shared-event-edit-delete'].listeners.click();await settle();
    assert.equal(s.calls.length,0);
    globalThis.window={confirm:()=>true};s.nodes['shared-event-edit-delete'].listeners.click();await settle();
    assert.deepEqual(s.calls,[['/api/shared/events/delete',{payload:{groupId:'g1',id:'e1'}}]]);
    assert.equal(s.saved,1);
  } finally {globalThis.window=previous;}
});

test('editor labels, error announcement and leave confirmation reflect retention',async()=>{
  const html=await readFile(new URL('./index.html',import.meta.url),'utf8');
  const js=await readFile(new URL('./shared.js',import.meta.url),'utf8');
  assert.match(html,/id="shared-event-editor" aria-labelledby="shared-event-edit-title"/);
  assert.match(html,/id="shared-event-edit-status"[^>]*role="alert"/);
  assert.match(html,/id="group-icon-error"[^>]*role="alert"/);
  assert.match(js,/確定済みの共有予定は残り/);
  assert.match(js,/setError\(error\.message \|\| "グループから退出できませんでした。", managedGroupId === group\.groupId \? "group-icon-error"/);
  assert.doesNotMatch(js,/共有済みのあなたの予定もグループから削除されます/);
});
