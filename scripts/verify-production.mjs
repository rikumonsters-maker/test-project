import { inspectProduction, productionDecision, projectAccountMatches, readProductionDomain, verifiedProduction } from './production-gates.mjs';
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
console.log(`Vercel project flags: ${JSON.stringify({
  projectMatches:current.id===project,
  teamMatches:current.accountId===team,
})}`);
projectAccountMatches(current,project,team);
let deployment;
let lastDiagnostic;
for(let attempt=0;attempt<60;attempt++) {
  // latestDeployment may be a Preview. Resolve the official Production alias directly.
  deployment=await readProductionDomain(domain,team,token);
  const result=inspectProduction(deployment,sha,domain,project);
  const diagnostic=JSON.stringify({
    projectMatches:result.projectMatches,
    teamMatches:true, // The project endpoint's accountId was checked above.
    shaMatches:result.shaMatches,
    targetMatches:result.targetMatches,
    stateMatches:result.stateMatches,
    readyStateMatches:result.readyStateMatches,
    aliasMatches:result.aliasMatches,
    requiredFieldsPresent:result.requiredFieldsPresent,
    stateConflicts:result.stateConflicts,
  });
  if (diagnostic!==lastDiagnostic) { console.log(`Production verification flags: ${diagnostic}`); lastDiagnostic=diagnostic; }
  if (productionDecision(result)==='ready') break;
  await sleep(10000);
}
if (!verifiedProduction(deployment,sha,domain,project))
  throw new Error('Official domain did not become READY for the expected merge commit.');
const response=await fetch(`https://${domain}/`,{redirect:'follow'});
if (response.status!==200) throw new Error(`Official domain returned HTTP ${response.status}`);
console.log(`Production READY: ${deployment.id}, commit ${sha}, domain ${domain}, HTTP 200.`);
