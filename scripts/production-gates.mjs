export function exactProduction(list, sha) {
  return (list.deployments || []).find(item => item.meta?.githubCommitSha === sha && item.target === 'production');
}

export function verifiedProduction(detail, sha, domain) {
  return detail.meta?.githubCommitSha === sha && detail.target === 'production' &&
    Array.isArray(detail.alias) && detail.alias.includes(domain);
}
