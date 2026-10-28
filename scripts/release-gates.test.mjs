import test from 'node:test';
import assert from 'node:assert/strict';
import { eligibleDraft, checkGate, mainProtected, previewFromVercel, REQUIRED_CHECKS } from './release-gates.mjs';

const head='a'.repeat(40);
const pr={state:'OPEN',isDraft:true,headRefOid:head,baseRefName:'main',headRefName:'feature/example',
  headRepositoryOwner:{login:'rikumonsters-maker'},body:'<!-- DaySync automation: frontend-only -->'};
test('only unchanged same-repo frontend Draft PRs can enter auto merge', () => {
  assert.equal(eligibleDraft(pr,head,['frontend/app.js']),true);
  assert.equal(eligibleDraft({...pr,headRefOid:'b'.repeat(40)},head,['frontend/app.js']),false);
  assert.equal(eligibleDraft(pr,head,['frontend/app.js','backend/src/index.ts']),false);
  assert.equal(eligibleDraft({...pr,isDraft:false},head,['frontend/app.js']),false);
  assert.equal(eligibleDraft({...pr,body:''},head,['frontend/app.js']),false);
});

test('CI failure and pending Vercel Check stop auto merge', () => {
  const passed=REQUIRED_CHECKS.map(name=>({name,bucket:'pass'}));
  assert.equal(checkGate(passed),'ready');
  assert.equal(checkGate(passed.filter(item=>item.name!=='Vercel')),'pending');
  assert.equal(checkGate([...passed,{name:'extra',bucket:'fail'}]),'failed');
});

test('main must report protected through the Contents-readable branch endpoint', () => {
  const branch={protected:true,commit:{sha:head}};
  assert.equal(mainProtected(branch),true);
  assert.equal(mainProtected({...branch,protected:false}),false);
  assert.equal(mainProtected({...branch,commit:{sha:'invalid'}}),false);
});

test('Preview accepts its immutable URL and assigned branch alias only', async () => {
  const immutable='test-project-36lf4f3m7-fff-7e58.vercel.app';
  const branch='test-project-git-feature-example-fff-7e58.vercel.app';
  const deployment={id:'dpl_synthetic',url:immutable,alias:[branch],target:null,state:'READY',
    project:{id:'prj_kcPA0cRQ96Wqtw3gNJSywQAOTC0q'},meta:{githubCommitSha:head}};
  const response=async()=>({ok:true,json:async()=>deployment});
  assert.equal(await previewFromVercel(head,`https://${immutable}/`,'synthetic',response),true);
  assert.equal(await previewFromVercel(head,`https://${branch}/`,'synthetic',response),true);
  await assert.rejects(previewFromVercel(head,'https://other.vercel.app/','synthetic',response),/identity/);
  await assert.rejects(previewFromVercel('b'.repeat(40),`https://${branch}/`,'synthetic',response),/identity/);
  await assert.rejects(previewFromVercel(head,`https://${branch}/`,'synthetic',async()=>({ok:true,json:async()=>({...deployment,project:{id:'prj_other'}})})),/identity/);
  await assert.rejects(previewFromVercel(head,`https://${branch}/`,'synthetic',async()=>({ok:true,json:async()=>({...deployment,target:'production'})})),/identity/);
  await assert.rejects(previewFromVercel(head,`https://${branch}/`,'synthetic',async()=>({ok:true,json:async()=>({...deployment,target:undefined})})),/identity/);
  assert.equal(await previewFromVercel(head,`https://${branch}/`,'synthetic',async()=>({ok:true,json:async()=>({...deployment,state:undefined,readyState:'READY'})})),true);
  await assert.rejects(previewFromVercel(head,`https://${branch}/`,'synthetic',async()=>({ok:true,json:async()=>({...deployment,readyState:'BUILDING'})})),/conflicting states/);
  await assert.rejects(previewFromVercel(head,`https://${branch}/`,'synthetic',async()=>({ok:true,json:async()=>({...deployment,meta:undefined})})),/incomplete/);
});
