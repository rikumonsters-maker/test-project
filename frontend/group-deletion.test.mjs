import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createGroupDeletion} from './group-deletion.mjs';

function setup(requestJson=async()=>({ok:true})){
  const nodes=new Map();
  const $=id=>{
    if(!nodes.has(id))nodes.set(id,{
      listeners:{},open:false,disabled:false,textContent:'',
      addEventListener(name,callback){this.listeners[name]=callback;},
      showModal(){this.open=true;},close(){this.open=false;},
    });
    return nodes.get(id);
  };
  const errors=[],completed=[],changed=[];
  const controller=createGroupDeletion({$,requestJson,setError:(message,id)=>errors.push({message,id}),
    onSuccess:group=>completed.push(group),onMemberChanged:()=>changed.push(true)});
  return {controller,$,errors,completed,changed};
}

test('last-member dialog shows the server group name and No makes no request',async()=>{
  const calls=[],s=setup(async(...args)=>{calls.push(args);});
  s.controller.open({groupId:'group-1',groupName:'Local label'},'Server group');
  assert.equal(s.$('group-delete-dialog').open,true);
  assert.equal(s.$('group-delete-description').textContent,'グループ『Server group』を削除しますか？');
  s.$('group-delete-no').listeners.click();
  assert.equal(s.$('group-delete-dialog').open,false);
  assert.deepEqual(calls,[]);
  assert.deepEqual(s.completed,[]);
});

test('Yes calls the delete API once, prevents retries, and completes only after success',async()=>{
  const calls=[];let finish;
  const s=setup((...args)=>{calls.push(args);return new Promise(resolve=>finish=resolve);});
  const group={groupId:'group-1',groupName:'Friends'};
  s.controller.open(group,'Friends');
  const pending=s.$('group-delete-yes').listeners.click();
  await s.$('group-delete-yes').listeners.click();
  assert.deepEqual(calls,[['/api/groups/delete',{payload:{groupId:'group-1'}}]]);
  assert.equal(s.$('group-delete-no').disabled,true);
  assert.deepEqual(s.completed,[]);
  finish({ok:true});await pending;
  assert.deepEqual(s.completed,[group]);
  assert.equal(s.$('group-delete-dialog').open,false);
});

test('member-count conflict returns to group management without completing deletion',async()=>{
  const error=Object.assign(new Error('count changed'),{data:{code:'GROUP_MEMBER_COUNT_CHANGED'}});
  const s=setup(async()=>{throw error;});
  s.controller.open({groupId:'g'},'Friends');
  await s.$('group-delete-yes').listeners.click();
  assert.equal(s.$('group-delete-dialog').open,false);
  assert.deepEqual(s.changed,[true]);
  assert.deepEqual(s.completed,[]);
});

test('dialog has an accessible title and touch-sized actions',async()=>{
  const html=await readFile(new URL('./index.html',import.meta.url),'utf8');
  const css=await readFile(new URL('./style.css',import.meta.url),'utf8');
  assert.match(html,/id="group-delete-dialog" aria-labelledby="group-delete-title" aria-describedby="group-delete-description"/);
  assert.match(html,/<h3 id="group-delete-title">あなたは最後のメンバーです<\/h3>/);
  assert.match(html,/id="group-delete-no"[^>]*>いいえ<\/button>/);
  assert.match(html,/id="group-delete-yes"[^>]*>はい<\/button>/);
  assert.match(css,/\.group-delete-dialog \.actions \.action-button \{[^}]*min-height:44px/);
});
