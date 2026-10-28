import { execFileSync } from 'node:child_process';

const [base, head] = process.argv.slice(2);
const cached = base === '--cached';
if (!cached && ![base, head].every(sha => /^[0-9a-f]{40}$/.test(sha || ''))) {
  console.error('Expected exact base and head commit SHA values.');
  process.exit(1);
}
const range = cached ? ['--cached'] : [`${base}...${head}`];
const changed = execFileSync('git', ['diff', ...range, '--name-only'], { encoding:'utf8' })
  .trim().split(/\r?\n/).filter(Boolean);
const privatePath = /(^|\/)(\.env(?:\.|$)|\.dev\.vars$|\.local-legacy-archive(?:\/|$)|\.wrangler[^/]*(?:\/|$)|node_modules(?:\/|$)|.*\.(?:sqlite|sqlite3|db|dpapi|pem|key|p12)$)/i;
const bad = changed.filter(path => privatePath.test(path));
if (bad.length) {
  console.error('Private or generated paths are included in the PR:', bad.join(', '));
  process.exit(1);
}
const patch = execFileSync('git', ['diff', ...range, '--unified=0', '--', ...changed],
  { encoding:'utf8', maxBuffer:20*1024*1024 });
const added = patch.split(/\r?\n/).filter(line => line.startsWith('+') && !line.startsWith('+++'));
const credential = /(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|(?:CLOUDFLARE_API_TOKEN|VERCEL_TOKEN|VERCEL_READ_TOKEN|GITHUB_TOKEN|VAPID_PRIVATE_KEY)\s*[:=]\s*["']?[^\s"'${}]{12,})/i;
if (added.some(line => credential.test(line))) {
  console.error('Possible credential literal in added lines. Review locally; values are not printed.');
  process.exit(1);
}
console.log(`Checked ${changed.length} changed paths and added lines; no known private paths or credential literals found.`);
