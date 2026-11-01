import {test,expect} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import {extname} from 'node:path';

const worker='http://127.0.0.1:8787';
const app='http://127.0.0.1:5500';
const oldRevision='0e1f71d715e13da1d5096d95de3905d567a737ee';
const day='2030-10-02';

async function post(context,path,body) {
  const response=await context.request.post(worker+path,{data:body,headers:{Origin:app}});
  expect(response.ok(),`${path} returned HTTP ${response.status()}`).toBe(true);
  return response.json();
}
async function account(browser,name) {
  const context=await browser.newContext();
  const email=`synthetic-${crypto.randomUUID()}@example.invalid`;
  const result=await post(context,'/api/auth/register',{displayName:name,email,
    password:'Synthetic-password-123',passwordConfirm:'Synthetic-password-123'});
  return {context,user:result.user};
}
async function legacyFiles(page) {
  const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.mjs':'application/javascript',
    '.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'};
  await page.route(`${app}/**`,route=>{
    const pathname=decodeURIComponent(new URL(route.request().url()).pathname);
    const path=`frontend${pathname==='/'?'/index.html':pathname}`;
    if(path.includes('..')) return route.abort();
    try {return route.fulfill({status:200,contentType:mime[extname(path)]||'application/octet-stream',
      body:execFileSync('git',['show',`${oldRevision}:${path}`],{cwd:process.cwd(),maxBuffer:8*1024*1024})});}
    catch {return route.fulfill({status:404,body:'Not found'});}
  });
}

test('合成ユーザーと隔離D1の実Workerで旧画面OFF、告知後の名前表示、旧タブ409を確認',async({browser})=>{
  test.setTimeout(60000);
  const owner=await account(browser,'合成所有者');
  const member=await account(browser,'田中');
  const outsider=await account(browser,'別グループ会員');
  try {
    for(const context of [owner.context,member.context,outsider.context]) await context.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin===app) return route.continue();
      if(url.origin!==worker||!url.pathname.startsWith('/api/')) return route.abort();
      const response=await route.fetch();
      return route.fulfill({response});
    });
    const group=(await post(owner.context,'/api/groups/create',{name:'隔離E2Eグループ',memberName:'合成所有者'})).membership;
    await post(member.context,'/api/groups/join',{inviteCode:group.inviteCode,memberName:'田中'});
    await post(member.context,'/api/shared/calendar/sync',{groupId:group.groupId,month:'2030-10',syncShifts:true,
      entries:[{sourceType:'shift',sourceId:crypto.randomUUID(),eventDate:day,title:'PRIVATE_EMPLOYER',
        start:'13:00',end:'15:00',allDay:false,note:'PRIVATE_NOTE'}]});
    const oldPage=await member.context.newPage();await legacyFiles(oldPage);await oldPage.goto(`${app}/?group=${group.groupId}&date=${day}`);
    await expect(oldPage.locator('#group-calendar-view')).toBeVisible();
    await expect(oldPage.locator('#member-timeline-consent')).not.toBeChecked();
    const ownerPage=await owner.context.newPage();await ownerPage.goto(`${app}/?group=${group.groupId}&date=${day}`);
    await expect(ownerPage.locator('#group-calendar-view')).toBeVisible();
    await expect(ownerPage.locator('#group-shared-events')).toContainText('予定あり');
    await expect(ownerPage.locator('#group-shared-events')).not.toContainText('田中');
    await oldPage.locator('#member-timeline-consent').check();
    await expect(oldPage.locator('#member-timeline-consent')).toBeChecked();
    await ownerPage.locator('#refresh-group-events').click();
    await expect(ownerPage.locator('#group-shared-events')).toContainText('田中');
    await oldPage.locator('#member-timeline-consent').uncheck();
    await expect(oldPage.locator('#member-timeline-consent')).not.toBeChecked();
    await ownerPage.locator('#refresh-group-events').click();
    await expect(ownerPage.locator('#group-shared-events')).not.toContainText('田中');
    await ownerPage.locator('#member-timeline-details summary').click();
    await expect(ownerPage.locator('#member-timeline')).not.toContainText('13:00');
    await post(member.context,'/api/shared/named-busy/notice',{acknowledge:true});
    await ownerPage.locator('#refresh-group-events').click();
    await expect(ownerPage.locator('#group-shared-events')).toContainText('田中');
    await expect(ownerPage.locator('#member-timeline')).toContainText('13:00');
    await expect(ownerPage.locator('#page-group')).not.toContainText('PRIVATE_EMPLOYER');
    await expect(ownerPage.locator('#page-group')).not.toContainText('PRIVATE_NOTE');
    await oldPage.locator('#member-timeline-consent').check();
    await expect(oldPage.locator('#member-timeline-consent')).toBeChecked();
    await oldPage.locator('#member-timeline-consent').uncheck();
    await expect(oldPage.locator('#member-timeline-setting-status')).toBeVisible();
    await expect(oldPage.locator('#member-timeline-consent')).toBeChecked();
    const denied=await outsider.context.request.post(worker+'/api/shared/events/list',{
      data:{groupId:group.groupId,month:'2030-10'},headers:{Origin:app}});
    expect([401,403]).toContain(denied.status());
    const anonymous=await browser.newContext();
    try {const response=await anonymous.request.post(worker+'/api/shared/events/list',{
      data:{groupId:group.groupId,month:'2030-10'},headers:{Origin:app}});
      expect(response.status()).toBe(401);
    } finally {await anonymous.close();}
    const otherGroup=(await post(owner.context,'/api/groups/create',{name:'別グループの秘密',memberName:'合成所有者'})).membership;
    await post(outsider.context,'/api/groups/join',{inviteCode:otherGroup.inviteCode,memberName:'別グループ会員'});
    await post(owner.context,'/api/shared/events/create',{groupId:group.groupId,title:'PRIVATE_OTHER_GROUP_TITLE',
      eventDate:day,start:'18:00',end:'20:00',allDay:false,note:'PRIVATE_OTHER_GROUP_NOTE'});
    const otherList=await post(outsider.context,'/api/shared/events/list',{groupId:otherGroup.groupId,month:'2030-10'});
    const redacted=otherList.events.find(event=>event.start==='18:00'&&event.end==='20:00');
    expect(redacted).toMatchObject({sourceType:'busy',title:'予定あり'});
    expect(redacted.busyDisplayName).toBeUndefined();
    expect(JSON.stringify(otherList)).not.toContain('PRIVATE_OTHER_GROUP_TITLE');
    expect(JSON.stringify(otherList)).not.toContain('PRIVATE_OTHER_GROUP_NOTE');
  } finally {await owner.context.close();await member.context.close();await outsider.context.close();}
});
