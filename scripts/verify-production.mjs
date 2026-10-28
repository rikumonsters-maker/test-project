const sha=process.env.EXPECTED_SHA;
const token=process.env.VERCEL_TOKEN;
const project='prj_kcPA0cRQ96Wqtw3gNJSywQAOTC0q';
const team='team_gy2kSXviLMPSR1WLoWaNhrks';
const domain='daysync-app.vercel.app';
if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('Expected merge commit SHA is missing.');
if (!token) throw new Error('VERCEL_READ_TOKEN is not configured; exact deployment and domain assignment cannot be verified.');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function vercel(path) {
  const response=await fetch(`https://api.vercel.com${path}`,{headers:{Authorization:`Bearer ${token}`}});
  if (!response.ok) throw new Error(`Vercel read API returned HTTP ${response.status}`);
  return response.json();
}
let deployment;
for(let attempt=0;attempt<60;attempt++) {
  const list=await vercel(`/v6/deployments?projectId=${project}&teamId=${team}&target=production&limit=10`);
  deployment=(list.deployments||[]).find(item=>item.meta?.githubCommitSha===sha && item.target==='production');
  if (deployment?.state==='ERROR' || deployment?.state==='CANCELED') throw new Error('Production deployment failed.');
  if (deployment?.state==='READY') break;
  await sleep(10000);
}
if (deployment?.state!=='READY') throw new Error('Production did not become READY for the expected merge commit.');
const detail=await vercel(`/v13/deployments/${encodeURIComponent(deployment.id)}?teamId=${team}`);
if (detail.meta?.githubCommitSha!==sha || !detail.alias?.includes(domain))
  throw new Error('Production commit or official domain alias does not match the deployment.');
const response=await fetch(`https://${domain}/`,{redirect:'follow'});
if (response.status!==200) throw new Error(`Official domain returned HTTP ${response.status}`);
console.log(`Production READY: ${deployment.id}, commit ${sha}, domain ${domain}, HTTP 200.`);
