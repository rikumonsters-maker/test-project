import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {extname} from 'node:path';

const worker='http://127.0.0.1:8787', app='http://127.0.0.1:5500', day='2030-10-02';
async function post(context,path,body) {
  const response=await context.request.post(worker+path,{data:body,headers:{Origin:app}});
  expect(response.ok(),`${path}: ${response.status()}`).toBe(true);
  return response.json();
}
async function account(browser,name) {
  const context=await browser.newContext();
  const response=await post(context,'/api/auth/register',{displayName:name,
    email:`synthetic-${crypto.randomUUID()}@example.invalid`,
    password:'Synthetic-password-123',passwordConfirm:'Synthetic-password-123'});
  return {context,user:response.user};
}
async function legacyFiles(page) {
  const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.mjs':'application/javascript',
    '.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'};
  await page.route(`${app}/**`,route=>{
    const pathname=decodeURIComponent(new URL(route.request().url()).pathname);
    const path=`frontend${pathname==='/'?'/index.html':pathname}`;
    if(path.includes('..')) return route.abort();
    try {return route.fulfill({status:200,contentType:mime[extname(path)]||'application/octet-stream',
      body:execFileSync('git',['show',`0e1f71d715e13da1d5096d95de3905d567a737ee:${path}`],
        {cwd:process.cwd(),maxBuffer:8*1024*1024})});}
    catch {return route.fulfill({status:404,body:'Not found'});}
  });
}
test('local Worker and D1 preserve legacy OFF before activation',async({browser})=>{
  test.setTimeout(60000);
  const owner=await account(browser,'Group Owner'),member=await account(browser,'Tanaka'),
    outsider=await account(browser,'Outside Member');
  try {
    for(const context of [owner.context,member.context,outsider.context]) await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin===app) return route.continue();
      if(url.origin!==worker||!url.pathname.startsWith('/api/')) return route.abort();
      return route.fulfill({response:await route.fetch()});
    });
    const group=(await post(owner.context,'/api/groups/create',
      {name:'Synthetic Group',memberName:'Group Owner'})).membership;
    await post(member.context,'/api/groups/join',{inviteCode:group.inviteCode,memberName:'Tanaka'});
    await post(member.context,'/api/shared/calendar/sync',{groupId:group.groupId,month:'2030-10',syncShifts:true,
      entries:[{sourceType:'shift',sourceId:crypto.randomUUID(),eventDate:day,title:'PRIVATE_EMPLOYER',
        start:'13:00',end:'15:00',allDay:false,note:'PRIVATE_NOTE'}]});
    const oldPage=await member.context.newPage();await legacyFiles(oldPage);
    await oldPage.goto(`${app}/?group=${group.groupId}&date=${day}`);
    await expect(oldPage.locator('#group-calendar-view')).toBeVisible();
    await expect(oldPage.locator('#member-timeline-consent')).not.toBeChecked();
    const setting=await post(member.context,'/api/shared/named-busy/setting',{groupId:group.groupId});
    expect(setting).toMatchObject({enabled:false,policy:'legacy'});
    const page=await owner.context.newPage();await page.goto(`${app}/?group=${group.groupId}&date=${day}`);
    await expect(page.locator('#group-shared-events')).not.toContainText('Tanaka');
    await page.locator('#member-timeline-details summary').click();
    await expect(page.locator('#member-timeline')).not.toContainText('13:00');
    await expect(page.locator('#page-group')).not.toContainText('PRIVATE_EMPLOYER');
    await expect(page.locator('#page-group')).not.toContainText('PRIVATE_NOTE');
    const stale=await member.context.request.post(worker+'/api/shared/named-busy/update',
      {data:{groupId:group.groupId,enabled:false},headers:{Origin:app}});
    expect(stale.status()).toBe(200);
    await page.locator('#refresh-group-events').click();
    await expect(page.locator('#group-shared-events')).not.toContainText('Tanaka');
    const denied=await outsider.context.request.post(worker+'/api/shared/events/list',
      {data:{groupId:group.groupId,month:'2030-10'},headers:{Origin:app}});
    expect([401,403]).toContain(denied.status());
    const anonymous=await browser.newContext();
    try {const response=await anonymous.request.post(worker+'/api/shared/events/list',
      {data:{groupId:group.groupId,month:'2030-10'},headers:{Origin:app}});
      expect(response.status()).toBe(401);
    } finally {await anonymous.close();}
    const otherGroup=(await post(owner.context,'/api/groups/create',
      {name:'Other Group',memberName:'Group Owner'})).membership;
    await post(outsider.context,'/api/groups/join',
      {inviteCode:otherGroup.inviteCode,memberName:'Outside Member'});
    await post(owner.context,'/api/shared/events/create',{groupId:group.groupId,
      title:'PRIVATE_OTHER_GROUP_TITLE',eventDate:day,start:'18:00',end:'20:00',
      allDay:false,note:'PRIVATE_OTHER_GROUP_NOTE'});
    const otherList=await post(outsider.context,'/api/shared/events/list',
      {groupId:otherGroup.groupId,month:'2030-10'});
    const redacted=otherList.events.find(event=>event.start==='18:00'&&event.end==='20:00');
    expect(redacted).toMatchObject({sourceType:'busy',title:'予定あり'});
    expect(redacted.busyDisplayName).toBeUndefined();
    expect(JSON.stringify(otherList)).not.toContain('PRIVATE_OTHER_GROUP_TITLE');
    expect(JSON.stringify(otherList)).not.toContain('PRIVATE_OTHER_GROUP_NOTE');
  } finally {await owner.context.close();await member.context.close();await outsider.context.close();}
});
