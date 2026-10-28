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

export function mainProtected(protection) {
  const status = protection.required_status_checks;
  const required = new Set(status?.contexts || []);
  const sources = new Map((status?.checks || []).map(check => [check.context,check.app_id]));
  return Boolean(protection.enforce_admins?.enabled && protection.required_pull_request_reviews && status?.strict &&
    REQUIRED_CHECKS.every(name => required.has(name) && sources.get(name) === (name === 'Vercel' ? 8329 : 15368)));
}

export async function previewFromVercel(sha,url,token,request=fetch) {
  const response = await request('https://api.vercel.com/v6/deployments?projectId=prj_kcPA0cRQ96Wqtw3gNJSywQAOTC0q&teamId=team_gy2kSXviLMPSR1WLoWaNhrks&limit=20',
    { headers:{ Authorization:`Bearer ${token}` } });
  if (!response.ok) throw new Error(`Vercel Preview read API returned HTTP ${response.status}`);
  const data = await response.json();
  const host = new URL(url).hostname;
  return (data.deployments || []).some(item => item.meta?.githubCommitSha === sha &&
    item.url === host && item.state === 'READY' && item.target !== 'production');
}
