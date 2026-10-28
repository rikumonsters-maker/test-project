import { runGh } from './github-cli.mjs';
import { eligibleDraft, checkGate, mainProtected, previewFromVercel } from './release-gates.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const prNumber = Number(process.env.PR_NUMBER);
const runHead = process.env.RUN_HEAD_SHA;
if (repo !== 'rikumonsters-maker/test-project' || !Number.isSafeInteger(prNumber) || prNumber < 1 || !/^[0-9a-f]{40}$/.test(runHead || '')) {
  console.log('No eligible same-repository PR in the completed CI run.');
  process.exit(0);
}
const gh = (...args) => runGh(args);
const pr = JSON.parse(gh('pr','view',String(prNumber),'-R',repo,'--json',
  'state,isDraft,headRefName,headRefOid,headRepositoryOwner,baseRefName,body'));
const files = gh('api',`repos/${repo}/pulls/${prNumber}/files`,'--paginate','--jq','.[].filename').split(/\r?\n/).filter(Boolean);
if (!eligibleDraft(pr,runHead,files)) {
  console.log('PR is not an unchanged, opted-in, same-repository frontend Draft PR.');
  process.exit(0);
}
if (!process.env.VERCEL_READ_TOKEN) throw new Error('Production verification secret is missing; auto-merge is stopped.');
const protection = JSON.parse(gh('api',`repos/${repo}/branches/main/protection`));
if (!mainProtected(protection)) {
  throw new Error('Main branch protection is missing required checks or admin enforcement.');
}
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
let ready = false;
for (let attempt=0;attempt<60;attempt++) {
  const fresh = JSON.parse(gh('pr','view',String(prNumber),'-R',repo,'--json','headRefOid,state,isDraft'));
  if (fresh.headRefOid !== runHead || fresh.state !== 'OPEN' || !fresh.isDraft) throw new Error('PR changed during verification.');
  const checks = JSON.parse(gh('pr','checks',String(prNumber),'-R',repo,'--json','name,bucket'));
  const gate=checkGate(checks);
  if (gate === 'failed') throw new Error('A PR check failed or was cancelled.');
  const checksPassed=gate === 'ready';
  const deployments = JSON.parse(gh('api',`repos/${repo}/deployments?sha=${runHead}&per_page=20`));
  let previewReady = false;
  for (const deployment of deployments.filter(item => item.environment === 'Preview' && item.sha === runHead)) {
    const statuses = JSON.parse(gh('api',`repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`));
    if (statuses[0]?.state === 'success' && statuses[0]?.environment_url && checksPassed)
      previewReady = await previewFromVercel(runHead,statuses[0].environment_url,process.env.VERCEL_READ_TOKEN);
  }
  if (checksPassed && previewReady) { ready=true; break; }
  await sleep(10000);
}
if (!ready) throw new Error('Required checks or exact-head Vercel Preview did not become ready.');
// GitHub branch protection still applies. No --admin or direct push is used.
gh('pr','ready',String(prNumber),'-R',repo);
gh('pr','merge',String(prNumber),'-R',repo,'--auto','--merge','--match-head-commit',runHead);
console.log(`Auto-merge armed for PR #${prNumber} at ${runHead}.`);
