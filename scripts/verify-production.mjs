import { currentProjectDeploymentId, verifiedProduction } from './production-gates.mjs';

const sha=process.env.EXPECTED_SHA;
const token=process.env.VERCEL_TOKEN;
const project='prj_kcPA0cRQ96Wqtw3gNJSywQAOTC0q';
const team='team_gy2kSXviLMPSR1WLoWaNhrks';
const domain='daysync-app.vercel.app';
if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('Expected merge commit SHA is missing.');
if (!token) throw new Error('VERCEL_READ_TOKEN is not configured; exact deployment and domain assignment cannot be verified.');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function vercel(path,label) {
  const response=await fetch(`https://api.vercel.com${path}`,{headers:{Authorization:`Bearer ${token}`}});
  if (!response.ok) {
    // Only the endpoint label and HTTP status are safe to write to Actions logs.
    throw new Error(`Vercel ${label} read returned HTTP ${response.status}; check token team/project scope and Deployment read permission.`);
  }
  return response.json();
}
let deployment;
for(let attempt=0;attempt<60;attempt++) {
  // A project-scoped read token need not enumerate team-wide deployments.
  const current=await vercel(`/v9/projects/${project}?teamId=${team}`,'project');
  const id=currentProjectDeploymentId(current,project,team);
  if (id) deployment=await vercel(`/v13/deployments/${encodeURIComponent(id)}?teamId=${team}`,'deployment');
  if (deployment?.meta?.githubCommitSha!==sha || deployment?.target!=='production') deployment=undefined;
  if (deployment?.state==='ERROR' || deployment?.state==='CANCELED') throw new Error('Production deployment failed.');
  if (deployment?.state==='READY') break;
  await sleep(10000);
}
if (deployment?.state!=='READY') throw new Error('Production did not become READY for the expected merge commit.');
if (!verifiedProduction(deployment,sha,domain))
  throw new Error('Production commit or official domain alias does not match the deployment.');
const response=await fetch(`https://${domain}/`,{redirect:'follow'});
if (response.status!==200) throw new Error(`Official domain returned HTTP ${response.status}`);
console.log(`Production READY: ${deployment.id}, commit ${sha}, domain ${domain}, HTTP 200.`);
