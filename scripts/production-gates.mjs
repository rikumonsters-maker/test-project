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

export function inspectProduction(detail, sha, domain, project) {
  const statePresent = typeof detail.state === 'string';
  const readyStatePresent = typeof detail.readyState === 'string';
  const requiredFieldsPresent = Boolean(
    typeof detail.id === 'string' && detail.id &&
    typeof detail.project?.id === 'string' &&
    typeof detail.meta?.githubCommitSha === 'string' &&
    typeof detail.target === 'string' &&
    Array.isArray(detail.alias) &&
    (statePresent || readyStatePresent)
  );
  const stateConflicts = statePresent && readyStatePresent && detail.state !== detail.readyState;
  const normalizedState = stateConflicts ? undefined :
    (statePresent ? detail.state : detail.readyState);
  return {
    projectMatches: detail.project?.id === project,
    shaMatches: detail.meta?.githubCommitSha === sha,
    targetMatches: detail.target === 'production',
    stateMatches: detail.state === 'READY',
    readyStateMatches: detail.readyState === 'READY',
    aliasMatches: Array.isArray(detail.alias) && detail.alias.includes(domain),
    requiredFieldsPresent,
    stateConflicts,
    normalizedState,
  };
}

export function verifiedProduction(detail, sha, domain, project) {
  const result = inspectProduction(detail, sha, domain, project);
  return result.requiredFieldsPresent && !result.stateConflicts &&
    result.projectMatches && result.shaMatches && result.targetMatches &&
    result.aliasMatches && result.normalizedState === 'READY';
}

export function productionDecision(result) {
  if (!result.requiredFieldsPresent || result.stateConflicts)
    throw new Error('Production deployment response is incomplete or has conflicting states.');
  if (!result.projectMatches || !result.targetMatches || !result.aliasMatches)
    throw new Error('Official domain did not resolve to the expected Production project and alias.');
  if (!['READY','BUILDING','QUEUED','INITIALIZING','ERROR','CANCELED','BLOCKED'].includes(result.normalizedState))
    throw new Error('Production deployment has an unrecognized state.');
  if (result.shaMatches && ['ERROR','CANCELED','BLOCKED'].includes(result.normalizedState))
    throw new Error('Production deployment failed.');
  return result.shaMatches && result.normalizedState === 'READY' ? 'ready' : 'retry';
}
