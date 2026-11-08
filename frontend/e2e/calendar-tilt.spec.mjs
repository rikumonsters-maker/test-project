import {test,expect} from '@playwright/test';
import {mkdirSync} from 'node:fs';
import {syntheticApi} from './synthetic-api.mjs';

const localStorageKey='daysync-user-00000000-0000-4000-8000-000000000001';
const legacyTiltKey='daysync-card-3d-tilt';

async function measureTilt(cell,page,{screenshotName}={}) {
  await expect(cell).toBeVisible();
  await cell.scrollIntoViewIfNeeded();
  const box=await cell.boundingBox();
  expect(box).not.toBeNull();
  if(screenshotName) {
    mkdirSync('test-results/screenshots',{recursive:true});
    await page.screenshot({path:'test-results/screenshots/'+screenshotName+'-before.png',fullPage:false});
  }
  await page.mouse.move(box.x+2,box.y+2);
  await expect.poll(()=>cell.evaluate(el=>el.style.getPropertyValue('--card-rotate-x'))).not.toBe('');
  const edge=await cell.evaluate(el=>({
    x:parseFloat(el.style.getPropertyValue('--card-rotate-x')),
    y:parseFloat(el.style.getPropertyValue('--card-rotate-y')),
    transform:getComputedStyle(el).transform,
    shadow:getComputedStyle(el).boxShadow,
    reflection:getComputedStyle(el).backgroundImage,
    lift:getComputedStyle(el).getPropertyValue('--calendar-tilt-lift').trim(),
  }));
  expect(Math.abs(edge.x)).toBeLessThanOrEqual(7);
  expect(Math.abs(edge.y)).toBeLessThanOrEqual(7);
  expect(Math.abs(edge.x)).toBeGreaterThan(6.5);
  expect(Math.abs(edge.y)).toBeGreaterThan(6.5);
  expect(edge.transform).not.toBe('none');
  expect(edge.lift).toBe('-6px');
  expect(edge.shadow).not.toBe('none');
  expect(edge.reflection).toContain('radial-gradient');
  if(screenshotName) await page.screenshot({path:'test-results/screenshots/'+screenshotName+'-hover.png',fullPage:false});

  await page.mouse.move(1,1);
  await expect.poll(()=>cell.evaluate(el=>el.style.getPropertyValue('--card-rotate-x'))).toBe('');
  await page.waitForTimeout(240);
  const reset=await cell.evaluate(el=>({
    transform:getComputedStyle(el).transform,
    x:el.style.getPropertyValue('--card-rotate-x'),
    y:el.style.getPropertyValue('--card-rotate-y'),
    reflection:getComputedStyle(el).backgroundImage,
  }));
  expect(reset.transform).toBe('none');
  expect(reset.x).toBe('');
  expect(reset.y).toBe('');
  expect(reset.reflection).toBe('none');
}

test('shared calendar date cells have visible tilt despite the legacy OFF preference',async({page})=>{
  const api=syntheticApi({legacyEnabled:true});
  await api.attach(page.context());
  await page.addInitScript(key=>localStorage.setItem(key,'off'),legacyTiltKey);
  await page.setViewportSize({width:1280,height:900});
  await page.goto('/?group='+api.group.groupId+'&date='+api.date);
  await expect(page.locator('#group-calendar-view')).toBeVisible();
  const cell=page.locator('#group-calendar .calendar-day.today');
  await expect(cell).toHaveAttribute('aria-pressed','true');
  await expect(cell).toHaveClass(/calendar-tilt-card/);
  expect(await cell.evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await measureTilt(cell,page,{screenshotName:'shared-calendar-cell'});

  const day=page.locator('#group-calendar .calendar-day:not(.outside):not(.today)').first();
  await day.click();
  await expect(day).toHaveAttribute('aria-pressed','true');
  expect(await page.evaluate(()=>document.querySelectorAll('#group-calendar .calendar-day[aria-pressed="true"]').length)).toBe(1);
  expect(await page.locator('#card-tilt-toggle').count()).toBe(0);
  expect(await page.locator('.card-tilt-setting').count()).toBe(0);
  expect(api.state.outside).toEqual([]);
});

test('personal calendar date cells tilt and event selection, editing and deletion still work',async({page})=>{
  const api=syntheticApi({groups:[]});
  await api.attach(page.context());
  await page.addInitScript(({key,date,tiltKey})=>{
    localStorage.setItem(tiltKey,'off');
    localStorage.setItem(key,JSON.stringify({events:{[date]:[{
      id:'synthetic-personal-event',title:'Synthetic calendar event',start:'14:00',end:'15:00',allDay:false,note:'Synthetic note',
    }]}}));
  },{key:localStorageKey,date:api.date,tiltKey:legacyTiltKey});
  await page.setViewportSize({width:1280,height:900});
  await page.goto('/');
  await expect(page.locator('#agenda-calendar .calendar-day.today')).toBeVisible();
  const cell=page.locator('#agenda-calendar .calendar-day.today');
  await expect(cell).toContainText('Synthetic calendar event');
  await measureTilt(cell,page,{screenshotName:'personal-calendar-cell'});

  const otherDay=page.locator('#agenda-calendar .calendar-day:not(.outside):not(.today)').first();
  await otherDay.click();
  await expect(otherDay).toHaveAttribute('aria-pressed','true');
  const today=page.locator('#agenda-calendar .calendar-day.today');
  await today.click();
  await expect(today).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('#agenda-events .agenda-personal')).toContainText('Synthetic calendar event');
  const requestsBeforeEdit=api.state.requests.length;
  await page.locator('#agenda-events .agenda-personal .agenda-actions button').first().click();
  await page.locator('#event-title').fill('Edited synthetic event');
  await page.locator('#save-event').click();
  await expect(page.locator('#agenda-events .agenda-personal')).toContainText('Edited synthetic event');
  await page.locator('#agenda-events .agenda-personal .agenda-actions button').nth(1).click();
  await expect(page.locator('#agenda-events .agenda-personal')).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(api.state.requests).toHaveLength(requestsBeforeEdit);
  expect(api.state.outside).toEqual([]);
});

test('calendar cells remain keyboard operable, readable in both themes and within viewport widths',async({page})=>{
  const api=syntheticApi({legacyEnabled:true});
  await api.attach(page.context());
  await page.goto('/?group='+api.group.groupId+'&date='+api.date);
  await expect(page.locator('#group-calendar-view')).toBeVisible();
  for(const width of [320,375,390,430,768,1280]) {
    await page.setViewportSize({width,height:844});
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    expect(overflow,'horizontal overflow at '+width+'px').toBe(false);
      const today=page.locator('#group-calendar .calendar-day.today');
    for(const theme of ['light','dark']) {
      await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
      const state=await today.evaluate(el=>({
        background:getComputedStyle(el).backgroundColor,
        text:getComputedStyle(el.querySelector('.day-number')).color,
      }));
      expect(state.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(state.text).not.toBe('rgba(0, 0, 0, 0)');
      const keyboardTarget=page.locator('#group-calendar .calendar-day:not(.outside):not(.today)').first();
      await keyboardTarget.focus();
      expect(await keyboardTarget.evaluate(el=>el.matches(':focus-visible'))).toBe(true);
      expect(await keyboardTarget.evaluate(el=>getComputedStyle(el).outlineStyle)).not.toBe('none');
      await page.keyboard.press('Enter');
      expect(await page.evaluate(()=>document.querySelectorAll('#group-calendar .calendar-day[aria-pressed="true"]').length)).toBe(1);
    }
  }
  await page.locator('.nav-button[data-page="my"]').click();
  await expect(page.locator('#agenda-calendar')).toBeVisible();
  for(const width of [320,375,390,430,768,1280]) {
    await page.setViewportSize({width,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), 'personal calendar overflow at '+width+'px').toBe(true);
    const today=page.locator('#agenda-calendar .calendar-day.today');
    await expect(today).toHaveClass(/calendar-tilt-card/);
    const surface=await today.evaluate(el=>({
      background:getComputedStyle(el).backgroundColor,
      number:getComputedStyle(el.querySelector('.day-number')).color,
    }));
    expect(surface.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(surface.number).not.toBe('rgba(0, 0, 0, 0)');
  }
  expect(api.state.outside).toEqual([]);
});

test('touch and reduced-motion modes suppress calendar rotation',async({browser})=>{
  const touchContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  try {
    const api=syntheticApi({legacyEnabled:true});
    await api.attach(touchContext);
    const page=await touchContext.newPage();
    await page.goto('/?group='+api.group.groupId+'&date='+api.date);
    await expect(page.locator('#group-calendar-view')).toBeVisible();
    const cell=page.locator('#group-calendar .calendar-day.today');
    expect(await page.evaluate(()=>matchMedia('(hover:hover) and (pointer:fine)').matches)).toBe(false);
    const box=await cell.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    expect(await cell.evaluate(el=>getComputedStyle(el).transform)).toBe('none');
    expect(await cell.evaluate(el=>el.style.getPropertyValue('--card-rotate-x'))).toBe('');
  } finally { await touchContext.close(); }

  const reducedContext=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
  try {
    const api=syntheticApi({legacyEnabled:true});
    await api.attach(reducedContext);
    const page=await reducedContext.newPage();
    await page.goto('/?group='+api.group.groupId+'&date='+api.date);
    await expect(page.locator('#group-calendar-view')).toBeVisible();
    const cell=page.locator('#group-calendar .calendar-day.today');
    const box=await cell.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    expect(await cell.evaluate(el=>getComputedStyle(el).transform)).toBe('none');
    expect(await cell.evaluate(el=>el.style.getPropertyValue('--card-rotate-x'))).toBe('');
    expect(await cell.evaluate(el=>getComputedStyle(el).transitionDuration.split(',').every(v=>parseFloat(v)===0))).toBe(true);
  } finally { await reducedContext.close(); }
});
