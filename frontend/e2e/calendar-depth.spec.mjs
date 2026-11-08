import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { syntheticApi } from './synthetic-api.mjs';

const localStorageKey = 'daysync-user-00000000-0000-4000-8000-000000000001';

async function screenshot(page, name) {
  mkdirSync('test-results/screenshots', { recursive:true });
  await page.screenshot({ path:'test-results/screenshots/' + name, fullPage:false });
}

async function rect(element) {
  return element.evaluate(node => {
    const r = node.getBoundingClientRect();
    return { x:r.x, y:r.y, width:r.width, height:r.height };
  });
}

async function assertSameRect(before, after, label) {
  for (const key of ['x', 'y', 'width', 'height']) {
    expect(Math.abs(after[key] - before[key]), label + ' ' + key).toBeLessThan(0.2);
  }
}

async function assertDetailsMotion(page, panel) {
  const motion = await page.evaluate(() => window.__calendarDetailAnimations?.at(-1));
  expect(motion).toBeTruthy();
  expect(motion.options.duration).toBe(200);
  expect(motion.keyframes[0].transform).toBe('translateY(5px)');
  expect(motion.keyframes[1].transform).toMatch(/^translateY\(0(?:px)?\)$/);
  expect(motion.keyframes[0].boxShadow).not.toBe(motion.keyframes[1].boxShadow);
}

async function trackDetailsAnimations(page) {
  await page.addInitScript(() => {
    window.__calendarDetailAnimations = [];
    const nativeAnimate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      if (this.matches?.('.calendar-details-panel')) {
        window.__calendarDetailAnimations.push({ keyframes, options });
      }
      return nativeAnimate.call(this, keyframes, options);
    };
  });
}

async function hoverLabel(page, label) {
  await label.scrollIntoViewIfNeeded();
  const before = await rect(label);
  const box = await label.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => label.evaluate(el => getComputedStyle(el).transform)).not.toBe('none');
  await page.waitForTimeout(220);
  const after = await rect(label);
  const style = await label.evaluate(el => ({
    transform:getComputedStyle(el).transform,
    shadow:getComputedStyle(el).boxShadow,
    gloss:getComputedStyle(el, '::after').opacity,
  }));
  expect(before.y - after.y).toBeGreaterThan(1.5);
  expect(before.y - after.y).toBeLessThan(2.5);
  expect(style.shadow).not.toBe('none');
  expect(Number(style.gloss)).toBeGreaterThan(0.9);
  return { before, after, style };
}

test('shared calendar cells stay aligned while only appointment labels lift', async ({ page }) => {
  const api = syntheticApi({ legacyEnabled:true });
  await api.attach(page.context());
  await trackDetailsAnimations(page);
  await page.setViewportSize({ width:1280, height:900 });
  await page.goto('/?group=' + api.group.groupId + '&date=' + api.date);
  await expect(page.locator('#group-calendar-view')).toBeVisible();

  const cell = page.locator('#group-calendar .calendar-day.today');
  const busyLabel = cell.locator('.calendar-busy').first();
  await expect(busyLabel).toBeVisible();
  await cell.scrollIntoViewIfNeeded();
  await expect(cell).not.toHaveClass(/calendar-tilt-card/);
  expect(await cell.evaluate(el => getComputedStyle(el).transform)).toBe('none');
  const gridBefore = await page.locator('#group-calendar').evaluate(el =>
    [...el.querySelectorAll('.calendar-day')].map(node => {
      const r = node.getBoundingClientRect();
      return { x:r.x, y:r.y, width:r.width, height:r.height };
    }));
  await screenshot(page, 'shared-calendar-grid-before.png');

  const neutralDay = page.locator('#group-calendar .calendar-day:not(.outside):not(.today):not(.selected)').first();
  const neutralBefore = await rect(neutralDay);
  const neutralBox = await neutralDay.boundingBox();
  await page.mouse.move(neutralBox.x + neutralBox.width / 2, neutralBox.y + neutralBox.height / 2);
  const neutralStyle = await neutralDay.evaluate(el => ({
    transform:getComputedStyle(el).transform,
    shadow:getComputedStyle(el).boxShadow,
    background:getComputedStyle(el).backgroundColor,
  }));
  expect(neutralStyle.transform).toBe('none');
  expect(neutralStyle.shadow).toContain('inset');
  await assertSameRect(neutralBefore, await rect(neutralDay), 'shared day cell hover');
  await screenshot(page, 'shared-calendar-cell-hover.png');

  const hovered = await hoverLabel(page, busyLabel);
  expect(hovered.style.transform).not.toBe('none');
  expect(await cell.evaluate(el => getComputedStyle(el).transform)).toBe('none');
  const cellShadow = await cell.evaluate(el => getComputedStyle(el).boxShadow);
  expect(cellShadow === 'none' || cellShadow.startsWith('inset')).toBe(true);
  await screenshot(page, 'shared-calendar-label-hover.png');
  await page.mouse.move(1, 1);
  await expect.poll(() => busyLabel.evaluate(el => getComputedStyle(el).transform)).toBe('none');
  expect(await cell.evaluate(el => getComputedStyle(el).transform)).toBe('none');

  const gridAfter = await page.locator('#group-calendar').evaluate(el =>
    [...el.querySelectorAll('.calendar-day')].map(node => {
      const r = node.getBoundingClientRect();
      return { x:r.x, y:r.y, width:r.width, height:r.height };
    }));
  expect(gridAfter).toEqual(gridBefore);

  await neutralDay.click();
  await expect(page.locator('#group-calendar .calendar-day.selected')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('#group-calendar .calendar-day[aria-pressed="true"]').count()).toBe(1);
  const sharedDetails = page.locator('.calendar-details-panel').filter({ has:page.locator('#group-date') });
  await assertDetailsMotion(page, sharedDetails);
  await page.waitForTimeout(220);
  await screenshot(page, 'shared-calendar-details-selected.png');
  await cell.locator('.calendar-busy').first().click();
  await expect(cell).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('#group-calendar .calendar-day[aria-pressed="true"]').count()).toBe(1);
  expect(api.state.outside).toEqual([]);
});

test('personal event labels lift without moving cells; selection details, edit and delete remain usable', async ({ page }) => {
  const api = syntheticApi({ groups:[] });
  await api.attach(page.context());
  await trackDetailsAnimations(page);
  await page.addInitScript(({ key, date }) => {
    localStorage.setItem(key, JSON.stringify({ events:{ [date]:[{
      id:'synthetic-personal-event', title:'Synthetic calendar event',
      start:'14:00', end:'15:00', allDay:false, note:'Synthetic note',
    }] } }));
  }, { key:localStorageKey, date:api.date });
  await page.setViewportSize({ width:1280, height:900 });
  await page.goto('/');
  const cell = page.locator('#agenda-calendar .calendar-day.today');
  const label = cell.locator('.calendar-event').first();
  await expect(label).toBeVisible();
  await cell.scrollIntoViewIfNeeded();
  const cellBefore = await rect(cell);
  await screenshot(page, 'personal-calendar-grid-before.png');
  const hovered = await hoverLabel(page, label);
  expect(hovered.style.transform).not.toBe('none');
  await assertSameRect(cellBefore, await rect(cell), 'personal date cell label hover');
  expect(await cell.evaluate(el => getComputedStyle(el).transform)).toBe('none');
  await screenshot(page, 'personal-calendar-label-hover.png');
  await page.mouse.move(1, 1);
  await expect.poll(() => label.evaluate(el => getComputedStyle(el).transform)).toBe('none');

  const detailPanel = page.locator('.calendar-details-panel').filter({ has:page.locator('#agenda-date') });
  const otherDay = page.locator('#agenda-calendar .calendar-day:not(.outside):not(.today)').first();
  await otherDay.click();
  await expect(otherDay).toHaveAttribute('aria-pressed', 'true');
  await assertDetailsMotion(page, detailPanel);
  await page.waitForTimeout(220);
  await screenshot(page, 'calendar-details-selected.png');

  const today = page.locator('#agenda-calendar .calendar-day.today');
  await today.locator('.calendar-event').click();
  await expect(today).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('#agenda-calendar .calendar-day[aria-pressed="true"]').count()).toBe(1);
  await expect(page.locator('#agenda-events .agenda-personal')).toContainText('Synthetic calendar event');

  const nextMonthBefore = await page.locator('#agenda-calendar').getAttribute('data-rendered-month-key');
  await page.locator('#agenda-next').click();
  await expect.poll(() => page.locator('#agenda-calendar').getAttribute('data-rendered-month-key')).not.toBe(nextMonthBefore);
  await expect.poll(() => page.locator('#agenda-calendar').evaluate(el =>
    el.getAnimations().some(animation => animation.effect.getKeyframes().some(frame => String(frame.transform || '').includes('7px'))),
  )).toBe(true);

  await page.locator('#agenda-previous').click();
  await expect.poll(() => page.locator('#agenda-calendar').getAttribute('data-rendered-month-key')).toBe(nextMonthBefore);
  await page.locator('#agenda-calendar .calendar-day.today .calendar-event').click();
  await expect(page.locator('#agenda-calendar .calendar-day.today')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#agenda-events .agenda-personal .agenda-actions button').first().click();
  await page.locator('#event-title').fill('Edited synthetic event');
  await page.locator('#save-event').click();
  await expect(page.locator('#agenda-events .agenda-personal')).toContainText('Edited synthetic event');
  await page.locator('#agenda-events .agenda-personal .agenda-actions button').nth(1).click();
  await expect(page.locator('#agenda-events .agenda-personal')).toHaveCount(0);
  expect(api.state.outside).toEqual([]);
});

test('date selection animations respect reduced motion and all target widths remain aligned', async ({ page, browser }) => {
  const api = syntheticApi({ legacyEnabled:true });
  await api.attach(page.context());
  await page.goto('/?group=' + api.group.groupId + '&date=' + api.date);
  await expect(page.locator('#group-calendar-view')).toBeVisible();

  for (const width of [320, 375, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height:844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow at ' + width + 'px').toBe(true);
    const grid = page.locator('#group-calendar');
    const cell = grid.locator('.calendar-day.today');
    const before = await rect(cell);
    const selectedStyles = await cell.evaluate(el => ({
      cellOutline:getComputedStyle(el).outlineStyle,
      numberBackground:getComputedStyle(el.querySelector('.day-number')).backgroundColor,
    }));
    expect(selectedStyles.cellOutline).toBe('solid');
    expect(selectedStyles.numberBackground).not.toBe('rgba(0, 0, 0, 0)');
    const nearby = grid.locator('.calendar-day:not(.outside):not(.today):not(.selected)').first();
    const nearbyBox = await nearby.boundingBox();
    await page.mouse.move(nearbyBox.x + nearbyBox.width / 2, nearbyBox.y + nearbyBox.height / 2);
    await assertSameRect(before, await rect(cell), 'grid alignment at ' + width + 'px');
    const themes = [];
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme);
      themes.push(await cell.evaluate(el => ({
        background:getComputedStyle(el).backgroundColor,
        number:getComputedStyle(el.querySelector('.day-number')).color,
      })));
    }
    expect(themes.every(value => value.background !== 'rgba(0, 0, 0, 0)' && value.number !== 'rgba(0, 0, 0, 0)')).toBe(true);
  }

  const keyboardTarget = page.locator('#group-calendar .calendar-day:not(.outside):not(.today)').first();
  await keyboardTarget.focus();
  expect(await keyboardTarget.evaluate(el => el.matches(':focus-visible'))).toBe(true);
  expect(await keyboardTarget.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(keyboardTarget).toHaveAttribute('aria-pressed', 'true');

  const reducedContext = await browser.newContext({
    viewport:{ width:1280, height:900 },
    reducedMotion:'reduce',
    timezoneId:'Asia/Tokyo',
  });
  try {
    const reducedApi = syntheticApi({ groups:[] });
    await reducedApi.attach(reducedContext);
    const reducedPage = await reducedContext.newPage();
    await reducedPage.addInitScript(({ key, date }) => {
      localStorage.setItem(key, JSON.stringify({ events:{ [date]:[{
        id:'reduced-event', title:'Reduced motion event', start:'10:00', end:'11:00',
      }] } }));
    }, { key:localStorageKey, date:reducedApi.date });
    await reducedPage.goto('/');
    const reducedCell = reducedPage.locator('#agenda-calendar .calendar-day.today');
    const reducedLabel = reducedCell.locator('.calendar-event').first();
    const labelBox = await reducedLabel.boundingBox();
    await reducedPage.mouse.move(labelBox.x + labelBox.width / 2, labelBox.y + labelBox.height / 2);
    expect(await reducedLabel.evaluate(el => getComputedStyle(el).transform)).toBe('none');
    expect(await reducedCell.evaluate(el => el.getAnimations().length)).toBe(0);
    const panel = reducedPage.locator('.calendar-details-panel').filter({ has:reducedPage.locator('#agenda-date') });
    const other = reducedPage.locator('#agenda-calendar .calendar-day:not(.outside):not(.today)').first();
    await other.click();
    expect(await panel.evaluate(el => el.getAnimations().length)).toBe(0);
    const oldMonth = await reducedPage.locator('#agenda-calendar').getAttribute('data-rendered-month-key');
    await reducedPage.locator('#agenda-next').click();
    await expect.poll(() => reducedPage.locator('#agenda-calendar').getAttribute('data-rendered-month-key')).not.toBe(oldMonth);
    expect(await reducedPage.locator('#agenda-calendar').evaluate(el => el.getAnimations().length)).toBe(0);
  } finally {
    await reducedContext.close();
  }
});

test('touch input suppresses label lift while calendar dates remain selectable', async ({ browser }) => {
  const context = await browser.newContext({
    viewport:{ width:390, height:844 },
    isMobile:true,
    hasTouch:true,
    timezoneId:'Asia/Tokyo',
  });
  try {
    const api = syntheticApi({ legacyEnabled:true });
    await api.attach(context);
    const page = await context.newPage();
    await page.goto('/?group=' + api.group.groupId + '&date=' + api.date);
    const cell = page.locator('#group-calendar .calendar-day.today');
    const label = cell.locator('.calendar-busy').first();
    await expect(label).toBeVisible();
    expect(await page.evaluate(() => matchMedia('(hover:hover) and (pointer:fine)').matches)).toBe(false);
    const box = await label.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    expect(await label.evaluate(el => getComputedStyle(el).transform)).toBe('none');
    const dayBox = await cell.boundingBox();
    await page.touchscreen.tap(dayBox.x + dayBox.width / 2, dayBox.y + dayBox.height / 2);
    await expect(cell).toHaveAttribute('aria-pressed', 'true');
    expect(api.state.outside).toEqual([]);
  } finally {
    await context.close();
  }
});
