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
  return item.meta?.githubCommitSha === sha && assigned && item.state === 'READY' &&
    (item.target === null || item.target === 'preview') &&
    (item.project?.id === 'prj_kcPA0cRQ96Wqtw3gNJSywQAOTC0q' ||
      item.projectId === 'prj_kcPA0cRQ96Wqtw3gNJSywQAOTC0q');
}
