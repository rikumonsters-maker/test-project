import test from 'node:test';
import assert from 'node:assert/strict';
import { exactProduction, currentProjectDeploymentId, verifiedProduction } from './production-gates.mjs';

const sha='a'.repeat(40);
const domain='daysync-app.vercel.app';
test('production deployment must match merge commit and target', () => {
  const deployment={id:'correct',target:'production',state:'READY',meta:{githubCommitSha:sha}};
  assert.equal(exactProduction({deployments:[{...deployment,id:'preview',target:null},deployment]},sha)?.id,'correct');
  assert.equal(exactProduction({deployments:[deployment]},'b'.repeat(40)),undefined);
});
test('deployment detail must be READY target SHA and official domain', () => {
  const detail={target:'production',meta:{githubCommitSha:sha},alias:[domain]};
  assert.equal(verifiedProduction(detail,sha,domain),true);
  assert.equal(verifiedProduction({...detail,target:'preview'},sha,domain),false);
  assert.equal(verifiedProduction({...detail,alias:['other.example']},sha,domain),false);
});
test('project-scoped lookup rejects wrong project or team', () => {
  const current={id:'prj_expected',accountId:'team_expected',latestDeployment:{id:'dpl_latest'}};
  assert.equal(currentProjectDeploymentId(current,'prj_expected','team_expected'),'dpl_latest');
  assert.throws(()=>currentProjectDeploymentId(current,'prj_other','team_expected'));
  assert.throws(()=>currentProjectDeploymentId(current,'prj_expected','team_other'));
});
