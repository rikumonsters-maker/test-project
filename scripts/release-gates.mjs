import { vercelJson } from './vercel-read.mjs';

export const REQUIRED_CHECKS = ['day-sync-frontend','day-sync-backend','day-sync-security','Vercel'];

export function eligibleDraft(pr,runHead,files) {
  return pr.state === 'OPEN' && pr.isDraft && pr.headRefOid === runHead &&
    pr.baseRefName === 'main' && pr.headRepositoryOwner?.login === 'rikumonsters-maker' &&
    pr.headRefName?.startsWith('feature/') && pr.body?.includes('<!-- DaySync automation: frontend-only -->') &&
    files.length > 0 && files.every(file => file.startsWith('frontend/'));
}

export function checkGate(checks) {
  if (checks.some(check => ['fail','cancel'].includes(check.bucket))) return 'failed';
  const passed = new Set(checks.filter(check => check.bucket === 'pass').map(check => check.name));
  return REQUIRED_CHECKS.every(name => passed.has(name)) ? 'ready' : 'pending';
}

export function mainProtected(branch) {
  // GITHUB_TOKEN has Contents read, but not Administration read for /protection.
  // GitHub itself enforces required checks and reviews when --auto is armed.
  return branch.protected === true && /^[0-9a-f]{40}$/.test(branch.commit?.sha || '');
}

export async function previewFromVercel(sha,url,token,request=fetch) {
  const host = new URL(url).hostname;
  const item = await vercelJson(`/v13/deployments/${encodeURIComponent(host)}?teamId=team_gy2kSXviLMPSR1WLoWaNhrks`,
    token, 'Preview deployment', request);
  const assigned = item.url === host || (Array.isArray(item.alias) && item.alias.includes(host));
  const statePresent = typeof item.state === 'string';
  const readyStatePresent = typeof item.readyState === 'string';
  const stateConflicts = statePresent && readyStatePresent && item.state !== item.readyState;
  const requiredFieldsPresent = Boolean(typeof item.id === 'string' && typeof item.url === 'string' &&
    typeof item.meta?.githubCommitSha === 'string' &&
    (typeof item.project?.id === 'string' || typeof item.projectId === 'string') &&
    Object.hasOwn(item,'target') && (statePresent || readyStatePresent));
  const flags = {
    projectMatches: item.project?.id === 'prj_kcPA0cRQ96Wqtw3gNJSywQAOTC0q' ||
      item.projectId === 'prj_kcPA0cRQ96Wqtw3gNJSywQAOTC0q',
    shaMatches: item.meta?.githubCommitSha === sha,
    targetMatches: item.target === null || item.target === 'preview',
    urlMatches: assigned,
    stateMatches: item.state === 'READY',
    readyStateMatches: item.readyState === 'READY',
    requiredFieldsPresent,
    stateConflicts,
  };
  console.log(`Preview verification flags: ${JSON.stringify(flags)}`);
  if (!requiredFieldsPresent || stateConflicts) throw new Error('Preview response is incomplete or has conflicting states.');
  if (!flags.projectMatches || !flags.shaMatches || !flags.targetMatches || !flags.urlMatches)
    throw new Error('Preview deployment identity does not match the PR.');
  const normalizedState = statePresent ? item.state : item.readyState;
  if (!['READY','BUILDING','QUEUED','INITIALIZING','ERROR','CANCELED','BLOCKED'].includes(normalizedState))
    throw new Error('Preview deployment has an unrecognized state.');
  if (['ERROR','CANCELED','BLOCKED'].includes(normalizedState)) throw new Error('Preview deployment failed.');
  return normalizedState === 'READY';
}
