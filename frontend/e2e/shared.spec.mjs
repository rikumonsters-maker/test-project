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

test('旧OFFかつ告知未確認でも同じグループの名前と時間帯を表示',async({page})=>{
  const api=syntheticApi();const failures=await openShared(page,api);
  await expect(page.locator('#group-shared-events')).toContainText('田中さん');
  await expect(page.locator('#named-busy-notice')).toHaveCount(0);
  await page.locator('#member-timeline-details summary').click();
  await expect(page.locator('#member-timeline')).toBeVisible();
  await expect(page.locator('#member-timeline')).toContainText('13:00');
  expect(api.state.requests.some(r=>r.path==='/api/shared/named-busy/notice')).toBe(false);
  for(const marker of api.privateMarkers) await expect(page.locator('#page-group')).not.toContainText(marker);
  expect(api.state.outside).toEqual([]);
  expect(failures).toEqual([]);
});

test('旧ONの履歴があっても同じ名前と時間帯を表示',async({page})=>{
  const api=syntheticApi({legacyEnabled:true});await openShared(page,api);
  await expect(page.locator('#group-shared-events')).toContainText('田中');
  await expect(page.locator('#group-shared-events')).toContainText('13:00');
});

test('calendar labels agree with detail and never infer names for anonymous busy time',async({browser})=>{
  const namedContext=await browser.newContext(),namedPage=await namedContext.newPage();
  const named=syntheticApi({legacyEnabled:true,extraBusyMember:true});await openShared(namedPage,named);
  await expect(namedPage.locator('#group-calendar .calendar-busy').filter({hasText:'田中さん 13:00〜15:00'})).toHaveCount(1);
  await expect(namedPage.locator('#group-calendar .calendar-busy').filter({hasText:'佐藤さん 13:00〜15:00'})).toHaveCount(1);
  await expect(namedPage.locator('#group-shared-events')).toContainText('田中さん');
  await namedContext.close();
  const anonymousContext=await browser.newContext(),anonymousPage=await anonymousContext.newPage();
  const anonymous=syntheticApi({anonymousBusy:true});await openShared(anonymousPage,anonymous);
  await expect(anonymousPage.locator('#group-calendar .calendar-busy')).toContainText([
    '田中さん 13:00〜15:00','予定あり 18:00〜20:00']);
  await anonymousContext.close();
});

test('expired wishes stay absent from the list, count and calendar with a stale API response',async({page})=>{
  const api=syntheticApi({legacyEnabled:true,includeExpired:true});await openShared(page,api);
  await expect(page.locator('#group-wishes-list .group-wish-card')).toHaveCount(3);
  await expect(page.locator('#group-wishes-more')).toBeHidden();
  await expect(page.locator('#group-calendar')).not.toContainText('合成の遊びたい日 1');
  expect(api.state.outside).toEqual([]);
});

test('an open group removes a proposal when Tokyo midnight passes',async({page})=>{
  const api=syntheticApi({legacyEnabled:true});
  const midnight=Date.parse(`${api.date}T15:00:00Z`);
  // Leave enough time for the initial API-backed render before advancing the
  // synthetic browser clock across Tokyo midnight.
  await page.clock.install({time:new Date(midnight-60_000)});
  await openShared(page,api);
  await expect(page.locator('#group-wishes-list .group-wish-card')).toHaveCount(3);
  await page.clock.fastForward(60_001);
  await expect(page.locator('#group-wishes-list .group-wish-card')).toHaveCount(0);
  await expect(page.locator('#group-calendar')).not.toContainText('合成の遊びたい日');
  await expect(page.locator('#group-wishes-more')).toBeHidden();
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

test('availability is shown as status blocks with daily recommendation, participant counts and legend',async({page})=>{
  const api=syntheticApi({legacyEnabled:true});await openShared(page,api);
  await page.locator('#common-availability-open').click();
  const dialog=page.locator('#common-availability-dialog');
  await expect(dialog.locator('.availability-day-card')).toHaveCount(1);
  const day=dialog.locator('.availability-day-card').first();
  const blocks=day.locator('.availability-block');
  await expect(blocks).toHaveCount(26);
  await expect(day.locator('.availability-block.is-conflict').first()).toHaveAttribute('aria-label',/09:00開始/);
  await expect(day.locator('.availability-block.is-unconfirmed').first()).toHaveAttribute('aria-label',/10:00開始/);
  await expect(day.locator('.availability-block.is-insufficient').first()).toHaveAttribute('aria-label',/10:30開始/);
  await expect(day.locator('.availability-block.is-candidate').first()).toHaveAttribute('aria-label',/16:00開始/);
  await expect(day.locator('.availability-day-recommendation')).toContainText('おすすめ時間帯');
  await expect(day.locator('.availability-day-recommendation')).toContainText('16:00〜18:00');
  await expect(day.locator('.availability-day-recommendation')).toContainText(/空き候補 2\/2人/);
  await expect(day.locator('.availability-day-recommendation')).toContainText('競合 0人');
  await expect(day.locator('.availability-day-recommendation')).toContainText('未確認 0人');
  await expect(day.locator('.availability-legend-item')).toHaveCount(5);
  for(const [index,label] of ['空き候補','未確認','競合あり','必要人数に未達','対象外・情報なし'].entries())
    await expect(day.locator('.availability-legend-item').nth(index)).toContainText(label);

  const before=api.state.requests.filter(request=>request.path==='/api/shared/availability/search').length;
  await dialog.locator('.common-availability-conditions > summary').click();
  await dialog.locator('#common-availability-window-start').selectOption('600');
  await expect.poll(()=>api.state.requests.filter(request=>request.path==='/api/shared/availability/search').length).toBeGreaterThan(before);
  await expect(day.locator('.availability-block').first()).toHaveAttribute('aria-label',/10:00開始/);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  expect(api.state.outside).toEqual([]);
});

test('a day with no qualifying start is labeled without fabricating a recommendation',async({page})=>{
  const api=syntheticApi({availabilityMode:'no-candidate'});await openShared(page,api);
  await page.locator('#common-availability-open').click();
  const day=page.locator('#common-availability-results .availability-day-card');
  await expect(day).toHaveCount(1);
  await expect(day.locator('.availability-day-recommendation-none')).toHaveText('条件に合う候補なし');
  await expect(day.locator('.availability-block.is-insufficient').first()).toBeVisible();
  expect(api.state.outside).toEqual([]);
});

test('status blocks remain readable in dark reduced-motion mobile and preserve scheduling',async({page})=>{
  const api=syntheticApi();await page.setViewportSize({width:390,height:844});
  await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});await openShared(page,api);
  await page.locator('#common-availability-open').click();
  const day=page.locator('.availability-day-card').first();
  await expect(day.locator('.availability-block.is-candidate')).toBeVisible();
  await expect(day.locator('.availability-legend')).toBeVisible();
  const result=await day.evaluate(el=>({scroll:el.scrollWidth,client:el.clientWidth,
    colors:[...el.querySelectorAll('.availability-block')].slice(0,4).map(block=>getComputedStyle(block).backgroundColor)}));
  expect(result.scroll).toBeLessThanOrEqual(result.client);
  expect(new Set(result.colors).size).toBeGreaterThan(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await day.locator('.availability-range button').first().click();
  await expect(page.locator('#schedules-dialog')).toBeVisible();
  expect(api.state.outside).toEqual([]);
});

test('古いタブのOFF要求は409で名前公開を取り消さない',async({browser})=>{
  const context=await browser.newContext();const api=syntheticApi({legacyEnabled:false});await api.attach(context);
  const oldTab=await context.newPage(),newTab=await context.newPage();
  await useLegacyFrontend(oldTab);
  await oldTab.goto('/');await newTab.goto(`/?group=${api.group.groupId}&date=${api.date}`);
  await oldTab.locator('[data-page="group"]').click();
  await oldTab.locator('.group-name-button').first().click();
  expect(api.state.requests.some(r=>r.path==='/api/shared/named-busy/setting')).toBe(true);
  const staleStatus=await oldTab.evaluate(async groupId=>(await fetch('http://127.0.0.1:8787/api/shared/named-busy/update',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groupId,enabled:false})})).status,
    api.group.groupId);
  expect(staleStatus).toBe(409);
  await expect(newTab.locator('#group-shared-events')).toContainText('田中');
  await context.close();
});

for(const width of [320,375,390,430,768,1280]) for(const theme of ['light','dark']) {
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

test('shared availability and wish depth stays scoped and interactive',async({page})=>{
  const api=syntheticApi();await openShared(page,api);
  const availabilityDialog=page.locator('#common-availability-dialog');
  await availabilityDialog.evaluate(el=>{
    el.__depthRuns=[];el.__depthEnds=[];
    el.addEventListener('transitionrun',event=>el.__depthRuns.push(event.propertyName));
    el.addEventListener('transitionend',event=>el.__depthEnds.push(event.propertyName));
  });
  await page.locator('#common-availability-open').click();
  await expect(availabilityDialog).toHaveClass(/is-visible/);
  await expect(availabilityDialog).toHaveCSS('opacity','1');
  await expect.poll(()=>availabilityDialog.evaluate(el=>el.__depthRuns)).toContain('transform');
  await expect.poll(()=>availabilityDialog.evaluate(el=>el.__depthEnds)).toContain('transform');
  const availabilityCard=page.locator('#common-availability-recommendations .availability-card').first();
  await expect(availabilityCard).toBeVisible();
  const before=await availabilityCard.evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));
  await availabilityCard.hover();
  await expect.poll(()=>availabilityCard.evaluate(el=>getComputedStyle(el).transform)).not.toBe('none');
  const after=await availabilityCard.evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));
  expect(after).toEqual(before);
  await page.mouse.move(2,2);
  await expect.poll(()=>availabilityCard.evaluate(el=>getComputedStyle(el).transform)).toBe('none');
  const conditions=page.locator('.common-availability-conditions');
  const summary=conditions.locator('summary');
  const conditionBounds=await conditions.boundingBox();
  await summary.click();
  await expect(conditions).toHaveAttribute('open','');
  expect(await conditions.evaluate(el=>getComputedStyle(el).boxShadow)).not.toBe('none');
  expect((await conditions.boundingBox()).width).toBe(conditionBounds.width);
  await page.keyboard.press('Escape');
  await expect(availabilityDialog).toBeHidden();
  expect(api.state.outside).toEqual([]);
});

test('availability empty, failed, and cancelled searches remain isolated',async({page})=>{
  const failed=syntheticApi({availabilityMode:'error'});await openShared(page,failed);
  await page.locator('#common-availability-open').click();
  await expect(page.locator('#common-availability-error')).toBeVisible();
  await expect(page.locator('#common-availability-recommendations .availability-card')).toHaveCount(0);
  expect(failed.state.outside).toEqual([]);

  await page.goto('/');
  const empty=syntheticApi({availabilityMode:'empty'});await openShared(page,empty);
  await page.locator('#common-availability-open').click();
  await expect(page.locator('#common-availability-dialog')).toHaveClass(/is-visible/);
  await expect(page.locator('#common-availability-recommendations .availability-card')).toHaveCount(0);
  await expect(page.locator('#common-availability-results .availability-day-card')).toHaveCount(0);
  await page.locator('#common-availability-close').click();
  await expect(page.locator('#common-availability-dialog')).toBeHidden();

  await page.goto('/');
  const pending=syntheticApi({holdAvailability:true});await openShared(page,pending);
  await page.locator('#common-availability-open').click();
  await expect.poll(()=>pending.state.availabilityPending).toBe(1);
  await page.locator('#common-availability-close').click();
  await expect(page.locator('#common-availability-dialog')).toBeHidden();
  pending.state.releaseAvailability();
  await expect.poll(()=>pending.state.availabilityPending).toBe(0);
  await expect(page.locator('#common-availability-results .availability-day-card')).toHaveCount(0);
  expect(pending.state.outside).toEqual([]);
});

test('wish add and edit dialogs animate and preserve existing requests',async({page})=>{
  const api=syntheticApi();await openShared(page,api);
  const add=page.locator('#add-group-wish');
  const dialog=page.locator('#group-wish-dialog');
  await add.click();
  await expect(dialog).toHaveClass(/is-visible/);
  await expect(dialog).toHaveCSS('opacity','1');
  await expect(page.locator('#group-wish-date')).toBeFocused();
  await page.locator('#group-wish-date').fill(api.date);
  await page.locator('#group-wish-message').fill('synthetic wish message');
  await page.locator('#group-wish-form [type=submit]').click();
  await expect(dialog).toBeHidden();
  await expect.poll(()=>api.state.requests.some(request=>request.path==='/api/groups/wishes/create')).toBe(true);
  expect(api.state.requests.find(request=>request.path==='/api/groups/wishes/create').body.message).toBe('synthetic wish message');

  const card=page.locator('#group-wishes-list .group-wish-card').first();
  const buttons=card.locator('.group-wish-actions button');
  const edit=buttons.nth(await buttons.count()-2);
  await edit.click();
  await expect(dialog).toHaveClass(/is-visible/);
  await expect(page.locator('#group-wish-date')).toHaveValue(api.date);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(edit).toBeFocused();
  expect(api.state.requests.some(request=>request.path==='/api/groups/wishes/update')).toBe(false);
  expect(api.state.outside).toEqual([]);
});

test('wish deletion and reaction requests remain available',async({page})=>{
  const api=syntheticApi({wishReactable:true});await openShared(page,api);
  const firstCard=page.locator('#group-wishes-list .group-wish-card').first();
  await firstCard.locator('.group-wish-actions button').click();
  await expect.poll(()=>api.state.requests.some(request=>request.path==='/api/groups/wishes/react')).toBe(true);
  const ownCard=page.locator('#group-wishes-list .group-wish-card').nth(1);
  const buttons=ownCard.locator('.group-wish-actions button');
  page.once('dialog',dialog=>dialog.accept());
  await buttons.last().click();
  await expect.poll(()=>api.state.requests.some(request=>request.path==='/api/groups/wishes/delete')).toBe(true);
  expect(api.state.outside).toEqual([]);
});

test('wish card, add press, touch, and reduced motion keep working',async({browser,page})=>{
  const api=syntheticApi();await openShared(page,api);
  const wishCard=page.locator('#group-wishes-list .group-wish-card').first();
  const wishBounds=await wishCard.evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));
  await wishCard.hover();
  await expect.poll(()=>wishCard.evaluate(el=>getComputedStyle(el).transform)).not.toBe('none');
  const hoveredBounds=await wishCard.evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));
  expect(Math.abs(hoveredBounds.width-wishBounds.width)).toBeLessThan(0.1);
  expect(Math.abs(hoveredBounds.height-wishBounds.height)).toBeLessThan(0.1);
  await page.mouse.move(2,2);
  await expect.poll(()=>wishCard.evaluate(el=>getComputedStyle(el).transform)).toBe('none');

  const add=page.locator('#add-group-wish');
  const resting=await add.evaluate(el=>getComputedStyle(el).transform);
  await add.hover();await page.mouse.down();
  await expect.poll(()=>add.evaluate(el=>getComputedStyle(el).transform)).not.toBe(resting);
  await page.mouse.up();
  const addDialog=page.locator('#group-wish-dialog');
  await expect(addDialog).toHaveClass(/is-visible/);
  await page.keyboard.press('Escape');await expect(addDialog).toBeHidden();
  await expect(add).toBeFocused();
  await page.keyboard.press('Space');
  await expect(addDialog).toHaveClass(/is-visible/);
  await page.keyboard.press('Escape');await expect(addDialog).toBeHidden();

  const touchContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  const touchPage=await touchContext.newPage();const touchApi=syntheticApi();await touchApi.attach(touchContext);
  await touchPage.goto('/?group='+touchApi.group.groupId+'&date='+touchApi.date);
  await expect(touchPage.locator('#group-calendar-view')).toBeVisible();
  const touchModes=await touchPage.evaluate(()=>({hover:matchMedia('(hover:hover) and (pointer:fine)').matches}));
  expect(touchModes.hover).toBe(false);
  const touchCard=touchPage.locator('#group-wishes-list .group-wish-card').first();
  await touchCard.tap();
  expect(await touchCard.evaluate(el=>getComputedStyle(el).transform)).toBe('none');
  const touchOverflow=await touchPage.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  expect(touchOverflow).toBe(false);
  await touchContext.close();

  await page.emulateMedia({reducedMotion:'reduce'});
  await add.click();
  const wishDialog=page.locator('#group-wish-dialog');
  await expect(wishDialog).toHaveClass(/is-visible/);
  expect(await wishDialog.evaluate(el=>getComputedStyle(el).transform)).toBe('none');
  expect(await wishDialog.evaluate(el=>getComputedStyle(el).transitionDuration)).toBe('0s');
  await page.keyboard.press('Escape');await expect(wishDialog).toBeHidden();
  expect(api.state.outside).toEqual([]);
});

for(const width of [320,390,768,1280]) for(const theme of ['light','dark']) {
  test('shared wish depth at '+width+'px in '+theme,async({page})=>{
    const api=syntheticApi();await page.setViewportSize({width,height:850});await page.emulateMedia({colorScheme:theme});await openShared(page,api);
    const card=page.locator('#group-wishes-list .group-wish-card').first();await expect(card).toBeVisible();
    const before=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth}));
    expect(before.scroll).toBeLessThanOrEqual(before.viewport);
    await page.locator('#add-group-wish').click();
    const wishDialog=page.locator('#group-wish-dialog');await expect(wishDialog).toHaveClass(/is-visible/);
    const wishRect=await wishDialog.boundingBox();expect(wishRect.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');await expect(wishDialog).toBeHidden();
    await page.locator('#common-availability-open').click();
    const availabilityDialog=page.locator('#common-availability-dialog');await expect(availabilityDialog).toHaveClass(/is-visible/);
    const availabilityRect=await availabilityDialog.boundingBox();expect(availabilityRect.width).toBeLessThanOrEqual(width);
    const after=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth}));
    expect(after.scroll).toBeLessThanOrEqual(after.viewport);expect(api.state.outside).toEqual([]);
  });
}

for(const width of [320,375,390,430,768,1280]) for(const theme of ["light","dark"]) {
  test("availability palette matches all five states and legend in "+theme+" at "+width+"px",async({page})=>{
    const api=syntheticApi();await page.setViewportSize({width,height:844});
    await page.emulateMedia({colorScheme:theme});await openShared(page,api);
    await page.locator("#common-availability-open").click();
    const dialog=page.locator("#common-availability-dialog");
    const expected=theme==="dark"?
      {candidate:["rgb(21, 79, 58)","rgb(116, 208, 162)"],unconfirmed:["rgb(89, 64, 8)","rgb(255, 215, 122)"],conflict:["rgb(90, 38, 50)","rgb(255, 159, 168)"],insufficient:["rgb(57, 43, 89)","rgb(196, 174, 255)"],unavailable:["rgb(48, 57, 68)","rgb(145, 160, 174)"]}:
      {candidate:["rgb(197, 235, 208)","rgb(35, 122, 73)"],unconfirmed:["rgb(255, 228, 154)","rgb(168, 106, 0)"],conflict:["rgb(245, 189, 193)","rgb(162, 45, 56)"],insufficient:["rgb(222, 209, 247)","rgb(107, 66, 168)"],unavailable:["rgb(231, 235, 240)","rgb(120, 132, 146)"]};
    const actual=await dialog.evaluate(el=>Object.fromEntries(["candidate","unconfirmed","conflict","insufficient","unavailable"].map(state=>{
      const block=getComputedStyle(el.querySelector(".availability-block.is-"+state));
      const swatch=getComputedStyle(el.querySelector(".availability-block-swatch.is-"+state));
      return [state,[block.backgroundColor,block.borderTopColor,swatch.backgroundColor,swatch.borderTopColor,block.borderTopStyle,block.borderBottomWidth]];
    })));
    for(const [state,[background,border]] of Object.entries(expected)){
      expect(actual[state].slice(0,4),state+" block and legend colors").toEqual([background,border,background,border]);
    }
    expect(actual.candidate[5]).toBe("3px");expect(actual.insufficient[5]).toBe("3px");
    expect(actual.unconfirmed[4]).toBe("dashed");expect(actual.unavailable[4]).toBe("dashed");
    await expect(dialog.locator("#common-availability-status")).toContainText("参加の承諾は本人に確認してください");
    const labelContrast=await dialog.locator(".availability-day-recommendation").evaluate(el=>{
      const components=value=>value.slice(value.indexOf("(")+1,value.indexOf(")")).split(",").map(Number);
      const luminance=value=>{const channels=components(value).map(channel=>{channel/=255;return channel<=0.04045?channel/12.92:((channel+0.055)/1.055)**2.4;});return 0.2126*channels[0]+0.7152*channels[1]+0.0722*channels[2];};
      const foreground=luminance(getComputedStyle(el.querySelector(".availability-day-recommendation-label")).color);
      const background=luminance(getComputedStyle(el).backgroundColor);
      return (Math.max(foreground,background)+0.05)/(Math.min(foreground,background)+0.05);
    });
    expect(labelContrast).toBeGreaterThanOrEqual(4.5);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(await dialog.locator(".availability-block-grid").evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    expect(api.state.outside).toEqual([]);
  });
}

for(const theme of ["light","dark"]) {
  test("no-candidate recommendation uses readable neutral contrast in "+theme,async({page})=>{
    const api=syntheticApi({availabilityMode:"no-candidate"});
    await page.emulateMedia({colorScheme:theme});await openShared(page,api);
    await page.locator("#common-availability-open").click();
    const day=page.locator(".availability-day-card");
    await expect(day.locator(".availability-day-recommendation-none")).toHaveText("条件に合う候補なし");
    const styles=await day.locator(".availability-day-recommendation").evaluate(el=>({
      background:getComputedStyle(el).backgroundColor,
      foreground:getComputedStyle(el.querySelector(".availability-day-recommendation-none")).color,
    }));
    expect(styles.background).toBe(theme==="dark"?"rgb(48, 57, 68)":"rgb(231, 235, 240)");
    expect(styles.foreground).toBe(theme==="dark"?"rgb(242, 245, 243)":"rgb(23, 32, 24)");
    expect(api.state.outside).toEqual([]);
  });
}
