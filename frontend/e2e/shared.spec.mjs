import {test,expect} from '@playwright/test';
import {syntheticApi} from './synthetic-api.mjs';
import {execFileSync} from 'node:child_process';
import {extname} from 'node:path';

// First parent of the PR #17 merge is the shipped legacy frontend. Loading its
// exact files from Git tests an old tab without keeping a second source copy.
const legacyRevision='0e1f71d715e13da1d5096d95de3905d567a737ee';
async function useLegacyFrontend(page) {
  const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.mjs':'application/javascript',
    '.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'};
  await page.route('http://127.0.0.1:5517/**',route=>{
    const pathname=decodeURIComponent(new URL(route.request().url()).pathname);
    const path=`frontend${pathname==='/'?'/index.html':pathname}`;
    if(path.includes('..')) return route.abort();
    try {const body=execFileSync('git',['show',`${legacyRevision}:${path}`],{cwd:process.cwd(),maxBuffer:8*1024*1024});
      return route.fulfill({status:200,contentType:mime[extname(path)]||'application/octet-stream',body});}
    catch {return route.fulfill({status:404,body:'Not found'});}
  });
}

async function openShared(page,api) {
  await api.attach(page.context());
  const failures=[];
  page.on('pageerror',error=>failures.push(error.message));
  await page.goto(`/?group=${api.group.groupId}&date=${api.date}`);
  await expect(page.locator('#group-calendar-view')).toBeVisible();
  await expect(page.locator('#group-wishes-list')).toContainText('合成の遊びたい日');
  await expect(page.locator('#group-shared-events')).toContainText('予定あり');
  return failures;
}

test('旧OFFかつ告知未確認は匿名、確認後は同じグループで名前を表示',async({page})=>{
  const api=syntheticApi();const failures=await openShared(page,api);
  await expect(page.locator('#group-shared-events')).not.toContainText('田中');
  await expect(page.locator('#named-busy-notice')).toBeVisible();
  await page.locator('#member-timeline-details summary').click();
  await expect(page.locator('#member-timeline')).toBeVisible();
  await expect(page.locator('#member-timeline')).not.toContainText('13:00');
  await page.locator('#named-busy-notice-ack').click();
  await expect(page.locator('#named-busy-notice')).toBeHidden();
  await expect(page.locator('#group-shared-events')).toContainText('田中');
  await expect(page.locator('#member-timeline')).toContainText('13:00');
  for(const marker of api.privateMarkers) await expect(page.locator('#page-group')).not.toContainText(marker);
  expect(api.state.outside).toEqual([]);
  expect(failures).toEqual([]);
});

test('旧ONは告知前から名前と時間帯を表示',async({page})=>{
  const api=syntheticApi({legacyEnabled:true});await openShared(page,api);
  await expect(page.locator('#group-shared-events')).toContainText('田中');
  await expect(page.locator('#group-shared-events')).toContainText('13:00');
});

test('共有画面、カレンダー、空き時間、画面遷移をモバイル幅で表示',async({page})=>{
  const api=syntheticApi({legacyEnabled:true});await page.setViewportSize({width:375,height:812});await openShared(page,api);
  await expect(page.locator('#group-calendar')).toBeVisible();
  await page.locator('#common-availability-open').click();
  await expect(page.locator('#common-availability-dialog')).toBeVisible();
  await expect(page.locator('#common-availability-recommendations')).toContainText('16:00');
  await expect(page.locator('#common-availability-results')).toContainText('16:00');
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  expect(overflow).toBe(false);
  await page.locator('#common-availability-close').click();
  await expect(page.locator('#common-availability-dialog')).toBeHidden();
  expect(api.state.outside).toEqual([]);
});

test('遊びたい日は3件から展開し、日付変更でもタイムラインを維持する',async({page})=>{
  const api=syntheticApi({legacyEnabled:true});await openShared(page,api);
  await expect(page.locator('#group-wishes-list .group-wish-card')).toHaveCount(3);
  await page.locator('#group-wishes-more').click();
  await expect(page.locator('#group-wishes-list .group-wish-card')).toHaveCount(4);
  await page.locator('#member-timeline-details summary').click();
  await expect(page.locator('#member-timeline')).toContainText('13:00');
  await page.locator('#group-next').click();
  await page.locator('#group-calendar .calendar-day:not(.outside)').first().click();
  await expect(page.locator('#member-timeline-details')).toHaveAttribute('open','');
  await expect(page.locator('#member-timeline')).not.toContainText('13:00');
  expect(api.state.outside).toEqual([]);
});

test('おすすめ日時から日程調整へ日時と参加者を引き継ぐ',async({page})=>{
  const api=syntheticApi({legacyEnabled:true});await openShared(page,api);
  await page.locator('#common-availability-open').click();
  await expect(page.locator('#common-availability-recommendations .availability-card')).toHaveCount(1);
  await page.locator('#common-availability-recommendations .availability-card button').click();
  await expect(page.locator('#schedules-dialog')).toBeVisible();
  await expect(page.locator('#schedules-content input[type="date"]')).toHaveValue(api.date);
  await expect(page.locator('#schedules-content input[type="time"]').first()).toHaveValue('16:00');
  await expect(page.locator('#schedules-content input[type="time"]').last()).toHaveValue('18:00');
  await expect(page.locator('#schedules-content fieldset input:checked')).toHaveCount(2);
  expect(api.state.requests.some(r=>r.path==='/api/groups/schedules/create')).toBe(false);
});

test('古いタブのOFF要求は告知確認後409で名前公開を取り消さない',async({browser})=>{
  const context=await browser.newContext();const api=syntheticApi({legacyEnabled:false});await api.attach(context);
  const oldTab=await context.newPage(),newTab=await context.newPage();
  await useLegacyFrontend(oldTab);
  await oldTab.goto('/');await newTab.goto(`/?group=${api.group.groupId}&date=${api.date}`);
  await oldTab.locator('[data-page="group"]').click();
  await oldTab.locator('.group-name-button').first().click();
  await expect(oldTab.locator('#member-timeline-consent')).not.toBeChecked();
  await expect(newTab.locator('#named-busy-notice')).toBeVisible();
  await newTab.locator('#named-busy-notice-ack').click();
  // The stale checkbox can still send OFF. The backend must reject that write.
  await oldTab.locator('#member-timeline-consent').check();
  await expect(oldTab.locator('#member-timeline-consent')).toBeChecked();
  await oldTab.locator('#member-timeline-consent').uncheck();
  await expect(oldTab.locator('#member-timeline-setting-status')).toBeVisible();
  await expect(oldTab.locator('#member-timeline-consent')).toBeChecked();
  expect(api.state.requests.some(r=>r.path==='/api/shared/named-busy/update'&&r.body.enabled===false)).toBe(true);
  await expect(newTab.locator('#group-shared-events')).toContainText('田中');
  await context.close();
});

for(const width of [375,390,430,768,1280]) for(const theme of ['light','dark']) {
  test(`${width}px ${theme} で共有画面と空き時間の配置を確認`,async({page},testInfo)=>{
    const api=syntheticApi({legacyEnabled:true});
    await page.setViewportSize({width,height:850});
    await page.emulateMedia({colorScheme:theme});
    await openShared(page,api);
    const bounds=await page.evaluate(()=>({document:document.documentElement.scrollWidth,viewport:innerWidth}));
    expect(bounds.document).toBeLessThanOrEqual(bounds.viewport);
    await page.screenshot({path:testInfo.outputPath(`shared-${width}-${theme}.png`),fullPage:true});
    await page.locator('#common-availability-open').click();
    await expect(page.locator('#common-availability-recommendations')).toContainText('16:00');
    await expect(page.locator('#common-availability-dialog')).toBeInViewport();
    await page.screenshot({path:testInfo.outputPath(`availability-${width}-${theme}.png`)});
    expect(api.state.outside).toEqual([]);
  });
}

test('Service Workerはローカルで有効化され、古い画面のfetchキャッシュを保持しない',async({page})=>{
  const api=syntheticApi({legacyEnabled:true});await openShared(page,api);
  const result=await page.evaluate(async()=>{
    await navigator.serviceWorker.register('/sw.js',{scope:'/',type:'module'});
    const registration=await navigator.serviceWorker.ready;
    await registration.update();
    return {active:registration.active?.scriptURL.endsWith('/sw.js'),cacheKeys:await caches.keys()};
  });
  expect(result).toEqual({active:true,cacheKeys:[]});
  expect(api.state.outside).toEqual([]);
});
