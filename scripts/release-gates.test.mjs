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

test('main protection requires pinned CI and Vercel app sources', () => {
  const protection={enforce_admins:{enabled:true},required_pull_request_reviews:{required_approving_review_count:0},
    required_status_checks:{strict:true,contexts:REQUIRED_CHECKS,
      checks:REQUIRED_CHECKS.map(context=>({context,app_id:context==='Vercel'?8329:15368}))}};
  assert.equal(mainProtected(protection),true);
  assert.equal(mainProtected({...protection,enforce_admins:{enabled:false}}),false);
  assert.equal(mainProtected({...protection,required_status_checks:{...protection.required_status_checks,strict:false}}),false);
});

test('Vercel authentication error and wrong Preview SHA fail the gate', async () => {
  const url='https://preview.example.vercel.app/';
  await assert.rejects(previewFromVercel(head,url,'synthetic',async()=>({ok:false,status:401})),/HTTP 401/);
  const response=async()=>({ok:true,json:async()=>({deployments:[{url:'preview.example.vercel.app',target:null,state:'READY',meta:{githubCommitSha:'b'.repeat(40)}}]})});
  assert.equal(await previewFromVercel(head,url,'synthetic',response),false);
  assert.equal(await previewFromVercel('b'.repeat(40),url,'synthetic',response),true);
});
