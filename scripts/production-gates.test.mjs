import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectProduction, productionDecision, projectAccountMatches, readProductionDomain, verifiedProduction } from './production-gates.mjs';

const sha='a'.repeat(40);
const domain='daysync-app.vercel.app';
const project='prj_kcPA0cRQ96Wqtw3gNJSywQAOTC0q';
const team='team_gy2kSXviLMPSR1WLoWaNhrks';
test('Production read uses the official domain directly', async () => {
  const expected=`https://api.vercel.com/v13/deployments/${domain}?teamId=${team}`;
  const detail={id:'dpl_production'};
  const actual=await readProductionDomain(domain,team,'synthetic',async url=>{
    assert.equal(url,expected);
    return {ok:true,json:async()=>detail};
  });
  assert.equal(actual,detail);
});
test('official domain resolves to the older Production even when latestDeployment is Preview', () => {
  const current={id:project,accountId:team,latestDeployment:{id:'dpl_preview'}};
  const detail={id:'dpl_production',project:{id:project},target:'production',state:'READY',
    meta:{githubCommitSha:sha},alias:[domain]};
  assert.equal(projectAccountMatches(current,project,team),true);
  assert.equal(verifiedProduction(detail,sha,domain,project),true);
  assert.equal(verifiedProduction({...detail,target:null},sha,domain,project),false);
  assert.equal(verifiedProduction({...detail,state:'BUILDING'},sha,domain,project),false);
  assert.equal(verifiedProduction({...detail,meta:{githubCommitSha:'b'.repeat(40)}},sha,domain,project),false);
  assert.equal(verifiedProduction({...detail,project:{id:'prj_other'}},sha,domain,project),false);
  assert.equal(verifiedProduction({...detail,alias:['other.example']},sha,domain,project),false);
});
test('project lookup rejects wrong project or team', () => {
  const current={id:project,accountId:team};
  assert.throws(()=>projectAccountMatches(current,'prj_other',team));
  assert.throws(()=>projectAccountMatches(current,project,'team_other'));
});

test('state and readyState variants preserve strict Production matching', () => {
  const base={id:'dpl_expected',project:{id:project},target:'production',
    meta:{githubCommitSha:sha},alias:[domain]};
  assert.equal(verifiedProduction({...base,state:'READY'},sha,domain,project),true);
  assert.equal(verifiedProduction({...base,readyState:'READY'},sha,domain,project),true);
  assert.equal(verifiedProduction({...base,state:'READY',readyState:'READY'},sha,domain,project),true);
  const conflict=inspectProduction({...base,state:'BUILDING',readyState:'READY'},sha,domain,project);
  assert.equal(conflict.stateConflicts,true);
  assert.equal(verifiedProduction({...base,state:'BUILDING',readyState:'READY'},sha,domain,project),false);
  assert.equal(verifiedProduction({...base,state:'READY',readyState:'BUILDING'},sha,domain,project),false);
  assert.throws(()=>productionDecision(conflict),/conflicting states/);
  assert.equal(productionDecision(inspectProduction({...base,readyState:'READY'},sha,domain,project)),'ready');
  assert.equal(productionDecision(inspectProduction({...base,state:'BUILDING'},sha,domain,project)),'retry');
});

test('missing required fields and mismatched identity cannot be READY', () => {
  const base={id:'dpl_expected',project:{id:project},target:'production',state:'READY',
    meta:{githubCommitSha:sha},alias:[domain]};
  for (const detail of [
    {...base,meta:undefined}, {...base,alias:undefined}, {...base,state:undefined},
    {...base,project:{id:'prj_wrong'}}, {...base,meta:{githubCommitSha:'b'.repeat(40)}},
    {...base,target:null},
  ]) assert.equal(verifiedProduction(detail,sha,domain,project),false);
  assert.equal(inspectProduction({...base,meta:undefined},sha,domain,project).requiredFieldsPresent,false);
  assert.equal(inspectProduction({...base,alias:undefined},sha,domain,project).requiredFieldsPresent,false);
  assert.throws(()=>productionDecision(inspectProduction({...base,alias:undefined},sha,domain,project)),/incomplete/);
  assert.throws(()=>productionDecision(inspectProduction({...base,meta:undefined},sha,domain,project)),/incomplete/);
  assert.throws(()=>productionDecision(inspectProduction({...base,project:{id:'prj_wrong'}},sha,domain,project)),/expected Production project/);
});
