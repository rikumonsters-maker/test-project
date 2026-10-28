import { projectAccountMatches, readProductionDomain, verifiedProduction } from './production-gates.mjs';
import { vercelJson } from './vercel-read.mjs';

const sha=process.env.EXPECTED_SHA;
const token=process.env.VERCEL_TOKEN;
const project='prj_kcPA0cRQ96Wqtw3gNJSywQAOTC0q';
const team='team_gy2kSXviLMPSR1WLoWaNhrks';
const domain='daysync-app.vercel.app';
if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('Expected merge commit SHA is missing.');
if (!token) throw new Error('VERCEL_READ_TOKEN is not configured; exact deployment and domain assignment cannot be verified.');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const current=await vercelJson(`/v9/projects/${project}?teamId=${team}`,token,'project');
projectAccountMatches(current,project,team);
let deployment;
for(let attempt=0;attempt<60;attempt++) {
  // latestDeployment may be a Preview. Resolve the official Production alias directly.
  deployment=await readProductionDomain(domain,team,token);
  if (deployment.project?.id!==project || deployment.target!=='production')
    throw new Error('Official domain did not resolve to the expected Production project.');
  if (deployment.meta?.githubCommitSha===sha && ['ERROR','CANCELED'].includes(deployment.state))
    throw new Error('Production deployment failed.');
  if (verifiedProduction(deployment,sha,domain,project)) break;
  await sleep(10000);
}
if (!verifiedProduction(deployment,sha,domain,project))
  throw new Error('Official domain did not become READY for the expected merge commit.');
const response=await fetch(`https://${domain}/`,{redirect:'follow'});
if (response.status!==200) throw new Error(`Official domain returned HTTP ${response.status}`);
console.log(`Production READY: ${deployment.id}, commit ${sha}, domain ${domain}, HTTP 200.`);
