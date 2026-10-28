import { execFileSync } from 'node:child_process';

const repo = process.env.GITHUB_REPOSITORY;
const prNumber = Number(process.env.PR_NUMBER);
const runHead = process.env.RUN_HEAD_SHA;
if (repo !== 'rikumonsters-maker/test-project' || !Number.isSafeInteger(prNumber) || prNumber < 1 || !/^[0-9a-f]{40}$/.test(runHead || '')) {
  console.log('No eligible same-repository PR in the completed CI run.');
  process.exit(0);
}
const gh = (...args) => execFileSync('gh', args, { encoding:'utf8', maxBuffer:4*1024*1024 }).trim();
const pr = JSON.parse(gh('pr','view',String(prNumber),'-R',repo,'--json',
  'state,isDraft,headRefName,headRefOid,headRepositoryOwner,baseRefName,body'));
if (pr.state !== 'OPEN' || !pr.isDraft || pr.headRefOid !== runHead || pr.baseRefName !== 'main' ||
    pr.headRepositoryOwner?.login !== 'rikumonsters-maker' || !pr.headRefName.startsWith('feature/') ||
    !pr.body?.includes('<!-- DaySync automation: frontend-only -->')) {
  console.log('PR is not an unchanged, opted-in, same-repository frontend Draft PR.');
  process.exit(0);
}
const files = gh('api',`repos/${repo}/pulls/${prNumber}/files`,'--paginate','--jq','.[].filename').split(/\r?\n/).filter(Boolean);
if (!files.length || files.some(file => !file.startsWith('frontend/'))) {
  console.log('Backend, migration, settings, or non-frontend files require a separate release gate.');
  process.exit(0);
}
if (!process.env.VERCEL_READ_TOKEN) throw new Error('Production verification secret is missing; auto-merge is stopped.');
const protection = JSON.parse(gh('api',`repos/${repo}/branches/main/protection`));
const required = new Set(protection.required_status_checks?.contexts || []);
const needed = ['day-sync-frontend','day-sync-backend','day-sync-security','Vercel'];
if (!protection.enforce_admins?.enabled || !protection.required_pull_request_reviews ||
    !protection.required_status_checks?.strict || needed.some(name => !required.has(name))) {
  throw new Error('Main branch protection is missing required checks or admin enforcement.');
}
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
let ready = false;
for (let attempt=0;attempt<60;attempt++) {
  const fresh = JSON.parse(gh('pr','view',String(prNumber),'-R',repo,'--json','headRefOid,state,isDraft'));
  if (fresh.headRefOid !== runHead || fresh.state !== 'OPEN' || !fresh.isDraft) throw new Error('PR changed during verification.');
  const checks = JSON.parse(gh('pr','checks',String(prNumber),'-R',repo,'--json','name,bucket'));
  const byName = new Map(checks.map(check => [check.name,check.bucket]));
  if (checks.some(check => ['fail','cancel'].includes(check.bucket))) throw new Error('A PR check failed or was cancelled.');
  const checksPassed = needed.every(name => byName.get(name) === 'pass');
  const deployments = JSON.parse(gh('api',`repos/${repo}/deployments?sha=${runHead}&per_page=20`));
  let previewReady = false;
  for (const deployment of deployments.filter(item => item.environment === 'Preview' && item.sha === runHead)) {
    const statuses = JSON.parse(gh('api',`repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`));
    if (statuses[0]?.state === 'success') previewReady = true;
  }
  if (checksPassed && previewReady) { ready=true; break; }
  await sleep(10000);
}
if (!ready) throw new Error('Required checks or exact-head Vercel Preview did not become ready.');
// GitHub branch protection still applies. No --admin or direct push is used.
gh('pr','ready',String(prNumber),'-R',repo);
gh('pr','merge',String(prNumber),'-R',repo,'--auto','--merge','--match-head-commit',runHead);
console.log(`Auto-merge armed for PR #${prNumber} at ${runHead}.`);
