import { vercelJson } from './vercel-read.mjs';

export function readProductionDomain(domain, team, token, request = fetch) {
  return vercelJson(`/v13/deployments/${encodeURIComponent(domain)}?teamId=${encodeURIComponent(team)}`,
    token, 'production deployment', request);
}

export function projectAccountMatches(current, project, team) {
  if (current.id !== project || current.accountId !== team)
    throw new Error('Vercel project or team does not match.');
  return true;
}

export function verifiedProduction(detail, sha, domain, project) {
  return detail.project?.id === project && detail.meta?.githubCommitSha === sha &&
    detail.target === 'production' && detail.state === 'READY' &&
    Array.isArray(detail.alias) && detail.alias.includes(domain);
}
