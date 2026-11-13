import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { syntheticApi } from './synthetic-api.mjs';

const accountKey = 'daysync-user-00000000-0000-4000-8000-000000000001';
const screenshotDir = 'test-results/release-screenshots';

test('OCR removal keeps manual entry and profile backup without loading OCR resources', async ({page})=>{
  const api=syntheticApi({personalSyncActive:true});await api.attach(page.context());
  const resources=[];page.on('request',request=>{if(/tesseract|screenshot-calendar|calendar-card-regions/.test(request.url()))resources.push(request.url());});
  await page.goto('/');await page.locator('#open-event-dialog').click();
  await expect(page.locator('#event-title')).toBeVisible();
  await expect(page.locator('#event-screenshot-import-open')).toHaveCount(0);
  await page.locator('#close-event-dialog').click();
  await page.locator('#account-open').click();
  await page.locator('#profile-data-management').evaluate(el=>{el.open=true;});
  await expect(page.locator('#personal-backup-export')).toBeVisible();
  await expect(page.locator('#screenshot-import-open')).toHaveCount(0);
  await expect(page.locator('#screenshot-import-dialog')).toHaveCount(0);
  expect(resources).toEqual([]);expect(api.state.outside).toEqual([]);
});

async function screenshot(page, name) {
  mkdirSync(screenshotDir, { recursive:true });
  await page.screenshot({ path:`${screenshotDir}/${name}.png`, fullPage:true, animations:'disabled' });
}

async function boot(page, { event = null, expense = null, failStorage = false } = {}) {
  const api = syntheticApi({ groups:[] });
  await api.attach(page.context());
  await page.addInitScript(({ key, date, event:seedEvent, expense:seedExpense, fail }) => {
    const state = {};
    if (seedEvent) state.events = { [date]:[seedEvent] };
    if (seedExpense) state.expenses = { [date]:[seedExpense] };
    state.budget = { fixed:'', saving:'' };
    localStorage.setItem(key, JSON.stringify(state));
    if (fail) {
      const originalSetItem = Storage.prototype.setItem;
      window.__failDaysyncStateSave = false;
      Storage.prototype.setItem = function(storageKey, value) {
        if (storageKey === key && window.__failDaysyncStateSave) throw new Error('synthetic storage failure');
        return originalSetItem.call(this, storageKey, value);
      };
    }
  }, { key:accountKey, date:api.date, event, expense, fail:failStorage });
  await page.goto('/');
  await expect(page.locator('#app-root')).toBeVisible();
  return api;
}

test('personal event modal adds timed and all-day events with reminders and selected date', async ({ page }) => {
  const api = await boot(page, { event:{ id:'seed-personal', title:'Synthetic appointment', start:'14:00', end:'15:00', allDay:false, note:'Synthetic note', extra:{} } });
  await page.setViewportSize({ width:390, height:844 });
  await expect(page.locator('#agenda-calendar')).toBeVisible();
  await expect(page.locator('#agenda-events')).toBeVisible();
  await expect(page.locator('#event-dialog')).toBeHidden();
  await screenshot(page, 'after-personal-390px');
  await page.setViewportSize({ width:1280, height:900 });
  await screenshot(page, 'after-personal-1280px');
  await page.setViewportSize({ width:390, height:844 });
  const otherDay = page.locator('#agenda-calendar .calendar-day:not(.outside):not(.today)').first();
  await otherDay.click();
  await expect(otherDay).toHaveAttribute('aria-pressed', 'true');
  const selectedLabel = (await otherDay.getAttribute('aria-label')).split('、')[0];
  let selectedDateValue;
  await page.locator('#open-event-dialog').click();
  await expect(page.locator('#event-dialog')).toBeVisible();
  await expect(page.locator('#event-title')).toBeFocused();
  expect(await page.locator('#event-dialog').evaluate(dialog => dialog.scrollHeight > dialog.clientHeight)).toBe(true);
  selectedDateValue = await page.locator('#event-date').inputValue();
  const selectedDateLabel = new Intl.DateTimeFormat('ja-JP', {
    timeZone:'Asia/Tokyo', year:'numeric', month:'long', day:'numeric', weekday:'short',
  }).format(new Date(`${selectedDateValue}T12:00:00+09:00`));
  expect(selectedDateLabel).toBe(selectedLabel);
  expect(selectedDateValue).not.toBe(api.date);
  await page.locator('#event-title').fill('Synthetic timed event');
  await page.locator('#event-start').fill('16:30');
  await page.locator('#event-end').fill('17:30');
  await page.locator('#personal-reminder-controls [data-reminder-offset][value="30"]').check();
  await screenshot(page, 'after-event-modal-390px');
  await page.locator('#save-event').click();
  await expect(page.locator('#event-dialog')).toBeHidden();
  await expect(page.locator('#agenda-events')).toContainText('Synthetic timed event');
  let stored = JSON.parse(await page.evaluate(key => localStorage.getItem(key), accountKey));
  expect(stored.events[selectedDateValue].find(event => event.title === 'Synthetic timed event')).toMatchObject({
    start:'16:30', end:'17:30', allDay:false, extra:{ daySyncReminders:{ offsetMinutes:[30] } },
  });

  await page.locator('#open-event-dialog').click();
  await expect(page.locator('#event-date')).toHaveValue(selectedDateValue);
  await page.locator('#event-title').fill('Synthetic all-day event');
  await page.locator('#event-all-day').check();
  await expect(page.locator('#event-time-fields')).toBeHidden();
  await page.locator('#save-event').click();
  await expect(page.locator('#agenda-events')).toContainText('Synthetic all-day event');
  stored = JSON.parse(await page.evaluate(key => localStorage.getItem(key), accountKey));
  expect(stored.events[selectedDateValue].find(event => event.title === 'Synthetic all-day event')).toMatchObject({ allDay:true, start:'', end:'' });
  expect(api.state.outside).toEqual([]);
});

test('editing a personal event reuses the modal and preserves existing values until save', async ({ page }) => {
  const api = await boot(page, { event:{ id:'seed-event', title:'Seed appointment', start:'10:00', end:'11:00', allDay:false, note:'Seed note', extra:{} } });
  const row = page.locator('#agenda-events .agenda-personal').filter({ hasText:'Seed appointment' });
  await row.locator('button').first().click();
  await expect(page.locator('#event-dialog')).toBeVisible();
  await expect(page.locator('#event-form-title')).toHaveText('個人予定を編集');
  await expect(page.locator('#event-screenshot-import-entry')).toHaveCount(0);
  await expect(page.locator('#event-screenshot-import-divider')).toHaveCount(0);
  await expect(page.locator('#event-title')).toHaveValue('Seed appointment');
  await expect(page.locator('#event-date')).toHaveValue(api.date);
  await expect(page.locator('#event-start')).toHaveValue('10:00');
  await page.locator('#event-title').fill('Edited appointment');
  await page.locator('#save-event').click();
  await expect(page.locator('#event-dialog')).toBeHidden();
  await expect(page.locator('#agenda-events')).toContainText('Edited appointment');
  const stored = JSON.parse(await page.evaluate(key => localStorage.getItem(key), accountKey));
  expect(stored.events[api.date]).toHaveLength(1);
  expect(stored.events[api.date][0].note).toBe('Seed note');
  expect(api.state.outside).toEqual([]);
});

test('expense modal adds, edits and deletes against the selected date and refreshes totals and charts', async ({ page }) => {
  const api = await boot(page, { expense:{ id:'seed-expense', amount:1200, category:'食費', note:'Seed lunch' } });
  await page.locator('.nav-button[data-page="money"]').click();
  await page.setViewportSize({ width:390, height:844 });
  await expect(page.locator('#expense-calendar')).toBeVisible();
  await expect(page.locator('#expense-dialog')).toBeHidden();
  await screenshot(page, 'after-budget-390px');
  await page.locator('#open-expense-dialog').click();
  await expect(page.locator('#expense-dialog')).toBeVisible();
  await expect(page.locator('#expense-amount')).toBeFocused();
  await expect(page.locator('#expense-form-date')).toHaveText(`登録日：${await page.locator('#expense-date').textContent()}`);
  await screenshot(page, 'after-expense-modal-390px');
  await page.locator('#expense-amount').fill('450');
  await page.locator('#expense-category').selectOption('交通');
  await page.locator('#expense-note').fill('Added transit');
  await page.locator('#save-expense').click();
  await expect(page.locator('#expense-dialog')).toBeHidden();
  await expect(page.locator('#expense-day-total')).toContainText('1,650');
  await expect(page.locator('#expense-month-total')).toContainText('1,650');
  await expect(page.locator('#expense-donut-total')).toContainText('1,650');
  await expect(page.locator('#expense-income-spent')).toContainText('1,650');
  const added = page.locator('#expense-list .expense-item').filter({ hasText:'Added transit' });
  await added.locator('button').first().click();
  await expect(page.locator('#expense-dialog')).toBeVisible();
  await expect(page.locator('#expense-form-title')).toHaveText('支出を編集');
  await expect(page.locator('#expense-amount')).toHaveValue('450');
  await expect(page.locator('#expense-category')).toHaveValue('交通');
  await page.locator('#expense-amount').fill('600');
  await page.locator('#save-expense').click();
  await expect(page.locator('#expense-day-total')).toContainText('1,800');
  await expect(page.locator('#expense-donut-total')).toContainText('1,800');
  const toDelete = page.locator('#expense-list .expense-item').filter({ hasText:'Added transit' });
  await toDelete.locator('button').nth(1).click();
  await expect(page.locator('#expense-day-total')).toContainText('1,200');
  await expect(page.locator('#expense-month-total')).toContainText('1,200');
  await expect(page.locator('#expense-donut-total')).toContainText('1,200');
  const stored = JSON.parse(await page.evaluate(key => localStorage.getItem(key), accountKey));
  expect(stored.expenses[api.date]).toHaveLength(1);
  expect(api.state.outside).toEqual([]);
});

test('dialog close paths confirm dirty input, preserve rejected input and restore focus', async ({ page }) => {
  await boot(page);
  const opener = page.locator('#open-event-dialog');
  await opener.click();
  await page.locator('#event-title').fill('Keep this draft');
  let confirmAction = 'dismiss';
  page.on('dialog', dialog => confirmAction === 'accept' ? dialog.accept() : dialog.dismiss());
  await page.keyboard.press('Escape');
  await expect(page.locator('#event-dialog')).toBeVisible();
  await expect(page.locator('#event-title')).toHaveValue('Keep this draft');
  confirmAction = 'accept';
  await page.locator('#close-event-dialog').click();
  await expect(page.locator('#event-dialog')).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  await page.locator('#event-dialog').evaluate(dialog => dialog.dispatchEvent(new MouseEvent('click', { bubbles:true })));
  await expect(page.locator('#event-dialog')).toBeHidden();
  await expect(opener).toBeFocused();
  expect(await page.locator('#event-title').inputValue()).toBe('');
});

test('event, expense and group dialogs share a restrained depth entrance and exit', async ({ page }) => {
  await boot(page, {
    event:{ id:'depth-event', title:'Synthetic event', start:'14:00', end:'15:00', allDay:false, note:'Synthetic note', extra:{} },
    expense:{ id:'depth-expense', amount:800, category:'食費', note:'Synthetic expense' },
  });
  const screenshots = 'test-results/release-screenshots';
  mkdirSync(screenshots, { recursive:true });

  async function assertDepth(dialogSelector, panelSelector, screenshotName) {
    const dialog = page.locator(dialogSelector);
    const panel = page.locator(`${dialogSelector} ${panelSelector}`);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveClass(/is-visible/);
    const opened = await panel.evaluate(element => {
      const style = getComputedStyle(element);
      const backdrop = getComputedStyle(element.closest('dialog'), '::backdrop');
      return {
        opacity:style.opacity,
        transform:style.transform,
        origin:style.transformOrigin,
        properties:style.transitionProperty,
        durations:style.transitionDuration.split(',').map(value => value.trim()),
        easing:style.transitionTimingFunction,
        backdropDuration:backdrop.transitionDuration,
        backdropColor:backdrop.backgroundColor,
        transitions:element.getAnimations().map(animation => ({
          property:animation.transitionProperty,
          frames:animation.effect.getKeyframes(),
        })),
      };
    });
    expect(Number(opened.opacity)).toBeGreaterThanOrEqual(0);
    expect(Number(opened.opacity)).toBeLessThanOrEqual(1);
    expect(opened.transform).not.toBe('none');
    expect(opened.origin).toContain('px');
    expect(opened.properties).toContain('opacity');
    expect(opened.properties).toContain('transform');
    expect(opened.durations.length).toBeGreaterThanOrEqual(2);
    expect(opened.durations.every(value => Math.abs(parseFloat(value) - 0.26) < 0.001)).toBe(true);
    expect(opened.easing).toContain('cubic-bezier');
    expect(opened.backdropDuration).toContain('0.26s');
    expect(opened.backdropColor).not.toBe('rgba(0, 0, 0, 0)');
    const opacityTransition = opened.transitions.find(animation => animation.property === 'opacity');
    expect(opacityTransition?.frames.length).toBeGreaterThanOrEqual(2);
    expect(opacityTransition.frames[0].opacity).not.toBe(opacityTransition.frames.at(-1).opacity);
    const transformTransition = opened.transitions.find(animation => animation.property === 'transform');
    expect(transformTransition?.frames.length).toBeGreaterThanOrEqual(2);
    expect(transformTransition.frames[0].transform).not.toBe(transformTransition.frames.at(-1).transform);
    await page.screenshot({ path:`${screenshots}/${screenshotName.replace('after-', 'during-')}.png`, fullPage:true });
    await panel.evaluate(async element => {
      const animations = element.getAnimations();
      await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
    });
    await expect(panel).toHaveCSS('opacity', '1');
    await page.screenshot({ path:`${screenshots}/${screenshotName}.png`, fullPage:true, animations:'disabled' });
    return { dialog, panel };
  }

  await page.setViewportSize({ width:390, height:844 });
  await page.locator('#open-event-dialog').click();
  let active = await assertDepth('#event-dialog', '.entry-dialog-panel', 'modal-depth-after-event-390px');
  await page.locator('#close-event-dialog').click();
  await expect(active.dialog).toBeVisible();
  await expect(active.dialog).not.toHaveClass(/is-visible/);
  const exitOpacity = Number(await active.panel.evaluate(element => getComputedStyle(element).opacity));
  expect(exitOpacity).toBeGreaterThanOrEqual(0);
  expect(exitOpacity).toBeLessThan(1);
  await expect(active.dialog).toBeHidden();

  await page.locator('#agenda-events .agenda-personal button').first().click();
  active = await assertDepth('#event-dialog', '.entry-dialog-panel', 'modal-depth-after-event-edit-390px');
  await page.locator('#close-event-dialog').click();
  await expect(active.dialog).toBeHidden();

  await page.locator('.nav-button[data-page="money"]').click();
  await page.locator('#open-expense-dialog').click();
  active = await assertDepth('#expense-dialog', '.entry-dialog-panel', 'modal-depth-after-expense-390px');
  await page.locator('#close-expense-dialog').click();
  await expect(active.dialog).toBeHidden();
  await page.locator('#expense-list .expense-item button').first().click();
  active = await assertDepth('#expense-dialog', '.entry-dialog-panel', 'modal-depth-after-expense-edit-390px');
  await page.locator('#close-expense-dialog').click();
  await expect(active.dialog).toBeHidden();

  await page.locator('.nav-button[data-page="group"]').click();
  await page.locator('#open-group-add').click();
  active = await assertDepth('#group-add-dialog', '.group-add-dialog-panel', 'modal-depth-after-group-create-390px');
  await page.locator('#group-add-join-tab').click();
  await expect(page.locator('#group-add-join-tab')).toHaveAttribute('aria-selected', 'true');
  await page.setViewportSize({ width:1280, height:900 });
  await page.locator('#group-add-dialog .group-add-dialog-panel').evaluate(async element => {
    const animations = element.getAnimations();
    await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
  });
  await page.screenshot({ path:`${screenshots}/modal-depth-after-group-join-1280px.png`, fullPage:true, animations:'disabled' });
  await page.locator('#close-group-add-dialog').click();
  await expect(active.dialog).toBeHidden();

  await page.emulateMedia({ reducedMotion:'reduce' });
  await page.locator('#open-group-add').click();
  const reduced = await page.locator('#group-add-dialog .group-add-dialog-panel').evaluate(element => ({
    duration:getComputedStyle(element).transitionDuration,
    transform:getComputedStyle(element).transform,
  }));
  expect(reduced.duration.split(',').every(value => parseFloat(value) === 0)).toBe(true);
  await page.locator('#close-group-add-dialog').click();
  await expect(page.locator('#group-add-dialog')).toBeHidden();
});

test('storage failures keep modal input and show an accessible error for both forms', async ({ page }) => {
  const api = await boot(page, { failStorage:true });
  await page.locator('#open-event-dialog').click();
  await page.locator('#event-title').fill('Unsaved synthetic event');
  await page.locator('#event-start').fill('14:00');
  await page.locator('#event-end').fill('15:00');
  await page.evaluate(() => { window.__failDaysyncStateSave = true; });
  await page.locator('#save-event').click();
  await expect(page.locator('#event-error')).toBeVisible();
  await expect(page.locator('#event-dialog')).toBeVisible();
  await expect(page.locator('#event-title')).toHaveValue('Unsaved synthetic event');
  let stored = JSON.parse(await page.evaluate(key => localStorage.getItem(key), accountKey));
  expect(stored.events).toBeUndefined();

  await page.evaluate(() => { window.__failDaysyncStateSave = false; });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#close-event-dialog').click();
  await expect(page.locator('#event-dialog')).toBeHidden();
  await page.locator('.nav-button[data-page="money"]').click();
  await page.locator('#open-expense-dialog').click();
  await page.locator('#expense-amount').fill('720');
  await page.locator('#expense-note').fill('Unsaved synthetic expense');
  await page.evaluate(() => { window.__failDaysyncStateSave = true; });
  await page.locator('#save-expense').click();
  await expect(page.locator('#expense-form-error')).toBeVisible();
  await expect(page.locator('#expense-dialog')).toBeVisible();
  await expect(page.locator('#expense-amount')).toHaveValue('720');
  stored = JSON.parse(await page.evaluate(key => localStorage.getItem(key), accountKey));
  expect(stored.expenses).toBeUndefined();
  expect(api.state.outside).toEqual([]);
});

test('dialogs stay usable at mobile and desktop widths, in dark mode, touch and reduced motion', async ({ page, browser }) => {
  await boot(page);
  for (const width of [320, 375, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height:844 });
    await page.locator('.nav-button[data-page="my"]').click();
    await expect(page.locator('#open-event-dialog')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `personal overflow at ${width}px`).toBe(true);
    await page.locator('#open-event-dialog').click();
    const eventBounds = await page.locator('#event-dialog').boundingBox();
    expect(eventBounds?.width).toBeLessThanOrEqual(width);
    await page.locator('#close-event-dialog').click();
    await expect(page.locator('#event-dialog')).toBeHidden();
    await page.locator('.nav-button[data-page="money"]').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `budget overflow at ${width}px`).toBe(true);
    await page.locator('#open-expense-dialog').click();
    const expenseBounds = await page.locator('#expense-dialog').boundingBox();
    expect(expenseBounds?.width).toBeLessThanOrEqual(width);
    await page.locator('#close-expense-dialog').click();
    await expect(page.locator('#expense-dialog')).toBeHidden();
    if (width === 1280) await screenshot(page, 'after-budget-1280px');
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.locator('#open-expense-dialog').click();
  const dark = await page.locator('#expense-dialog').evaluate(dialog => ({
    background:getComputedStyle(dialog).backgroundColor, color:getComputedStyle(dialog).color,
  }));
  expect(dark.background).not.toBe(dark.color);
  await page.locator('#close-expense-dialog').click();
  await page.emulateMedia({ reducedMotion:'reduce' });
  await page.locator('#open-expense-dialog').click();
  expect(await page.locator('#expense-dialog .entry-dialog-panel').evaluate(el => getComputedStyle(el).transitionDuration))
    .toMatch(/0s/);
  await page.locator('#close-expense-dialog').click();

  const touch = await browser.newContext({ hasTouch:true, viewport:{ width:390, height:844 } });
  try {
    const touchApi = syntheticApi({ groups:[] });
    await touchApi.attach(touch);
    const touchPage = await touch.newPage();
    await touchPage.goto('/');
    await touchPage.locator('#open-event-dialog').tap();
    await expect(touchPage.locator('#event-dialog')).toBeVisible();
    await touchPage.locator('#close-event-dialog').tap();
    await expect(touchPage.locator('#event-dialog')).toBeHidden();
    expect(touchApi.state.outside).toEqual([]);
  } finally {
    await touch.close();
  }
});

test('existing group add dialog remains isolated and functional', async ({ page }) => {
  const api = syntheticApi();
  await api.attach(page.context());
  await page.goto('/');
  await page.locator('.nav-button[data-page="group"]').click();
  await page.locator('#open-group-add').click();
  await expect(page.locator('#group-add-dialog')).toBeVisible();
  await expect(page.locator('#create-group-form')).toBeVisible();
  await expect(page.locator('#join-group-form')).toBeHidden();
  await page.locator('#close-group-add-dialog').click();
  await expect(page.locator('#group-add-dialog')).toBeHidden();
  expect(api.state.outside).toEqual([]);
});
