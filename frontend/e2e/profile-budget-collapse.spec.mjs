import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { EXPENSE_CATEGORIES } from '../budget-charts.mjs';
import { syntheticApi } from './synthetic-api.mjs';

const userId = '00000000-0000-4000-8000-000000000001';
const accountKey = `daysync-user-${userId}`;
const syncKey = `${accountKey}-personal-sync-v2`;
const chartPreferenceKey = 'daysync-expense-category-list';
const trendPreferenceKey = 'daysync-expense-trend';

async function screenshot(page, name) {
  await page.screenshot({ path:`test-results/screenshots/${name}`, fullPage:false });
}

test('personal sync and backup tools stay in the collapsed profile data section and restore only after confirmation', async ({ page }) => {
  const api = syntheticApi({ groups:[], personalSyncActive:true });
  await api.attach(page.context());
  const current = {
    id:'existing-synthetic-event', date:api.date, title:'Existing synthetic event',
    start:'11:00', end:'12:00', allDay:false, note:'Existing local record', extra:{},
    version:1, deleted:false,
  };
  await page.addInitScript(({ accountKey, syncKey, current }) => {
    localStorage.setItem(accountKey, JSON.stringify({ events:{ [current.date]:[current] } }));
    localStorage.setItem(syncKey, JSON.stringify({
      format:2, cursor:0, records:{ [current.id]:current }, queue:[], restoreQueue:[], active:true, results:{},
    }));
  }, { accountKey, syncKey, current });
  await page.setViewportSize({ width:390, height:844 });
  await page.goto('/');
  await expect(page.locator('#app-root')).toBeVisible();

  await expect(page.locator('#page-my #personal-sync-management')).toHaveCount(0);
  const profileData = page.locator('#profile-data-management');
  await expect(profileData).toHaveJSProperty('open', false);
  await page.locator('#account-open').click();
  await expect(page.locator('#page-profile')).toBeVisible();
  await expect(profileData).toHaveJSProperty('open', false);
  await screenshot(page, 'profile-data-management-collapsed.png');
  await page.locator('#profile-data-management-summary').focus();
  await page.keyboard.press('Enter');
  await expect(profileData).toHaveJSProperty('open', true);
  await expect(profileData.locator('#personal-sync-management')).toHaveCount(1);

  await expect(page.locator('#personal-sync-retry')).toBeVisible();
  await expect(page.locator('#personal-backup-export')).toBeVisible();
  await expect(page.locator('#personal-backup-import-trigger')).toBeVisible();
  await expect(page.locator('#personal-backup-archive-option')).toBeVisible();
  await expect(page.locator('#personal-backup-help')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#personal-backup-export').click(),
  ]);
  const backup = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(backup.events[api.date][0].id).toBe(current.id);

  const restoreFile = {
    name:'synthetic-personal-backup.json',
    mimeType:'application/json',
    buffer:Buffer.from(JSON.stringify({
      events:{ [api.date]:[{ id:'backup-current-event', title:'Backup current event', start:'15:00', end:'16:00' }] },
      archiveEvents:{ '2020-12-30':[{ id:'backup-legacy-event', title:'Backup legacy event', start:'09:00', end:'10:00' }] },
    })),
  };
  page.once('dialog', dialog => void dialog.dismiss());
  await page.locator('#personal-backup-import-file').setInputFiles(restoreFile);
  await expect.poll(() => api.state.requests.filter(row => row.path === '/api/personal/events/import').length).toBe(0);
  let stored = JSON.parse(await page.evaluate(key => localStorage.getItem(key), syncKey));
  expect(stored.records[current.id].title).toBe(current.title);
  expect(stored.records[current.id].deleted).toBe(false);

  page.once('dialog', dialog => void dialog.accept());
  await page.locator('#personal-backup-import-file').setInputFiles(restoreFile);
  await expect.poll(() => api.state.requests.filter(row => row.path === '/api/personal/events/import').length).toBe(1);
  let imports = api.state.requests.filter(row => row.path === '/api/personal/events/import');
  expect(imports[0].body.restoreConfirmed).toBe(true);
  expect(imports[0].body.event.title).toBe('Backup current event');
  expect(page.locator('#personal-backup-import-archive')).not.toBeChecked();

  await page.locator('#personal-backup-import-archive').check();
  page.once('dialog', dialog => void dialog.accept());
  await page.locator('#personal-backup-import-file').setInputFiles(restoreFile);
  await expect.poll(() => api.state.requests.filter(row => row.path === '/api/personal/events/import').length).toBe(2);
  imports = api.state.requests.filter(row => row.path === '/api/personal/events/import');
  expect(imports[1].body.event.title).toBe('Backup legacy event');
  stored = JSON.parse(await page.evaluate(key => localStorage.getItem(key), syncKey));
  expect(stored.records[current.id].title).toBe(current.title);
  expect(stored.records[current.id].deleted).toBe(false);
  expect(stored.records['restored-backup-current-event'].title).toBe('Backup current event');
  expect(stored.records['restored-backup-legacy-event'].title).toBe('Backup legacy event');
  expect(stored.restoreQueue).toHaveLength(0);
  await screenshot(page, 'profile-data-management-expanded.png');
  await page.locator('#profile-data-management-summary').focus();
  await page.keyboard.press('Space');
  await expect(profileData).toHaveJSProperty('open', false);
  expect(api.state.outside).toEqual([]);
});

test('budget layout follows keyboard order and chart disclosures persist independently', async ({ page }) => {
  const api = syntheticApi({ groups:[] });
  await api.attach(page.context());
  await page.addInitScript(({ accountKey, date, category, chartPreferenceKey, trendPreferenceKey }) => {
    if (!localStorage.getItem(accountKey)) {
      localStorage.setItem(accountKey, JSON.stringify({
        expenses:{ [date]:[{ id:'seed-expense', amount:1200, category, note:'Seed synthetic expense' }] },
        budget:{ fixed:'', saving:'' },
      }));
      localStorage.removeItem(chartPreferenceKey);
      localStorage.removeItem(trendPreferenceKey);
    }
  }, { accountKey, date:api.date, category:EXPENSE_CATEGORIES[0], chartPreferenceKey, trendPreferenceKey });
  await page.setViewportSize({ width:1280, height:900 });
  await page.goto('/');
  await page.locator('.nav-button[data-page="money"]').click();
  const budgetOrder = await page.locator('#page-budget').evaluate(panel => {
    const children = [...panel.children];
    return {
      metrics:children.findIndex(el => el.matches('.metrics')),
      calendar:children.findIndex(el => el.matches('.layout-two')),
      charts:children.findIndex(el => el.matches('.expense-charts')),
      settings:children.findIndex(el => el.matches('.budget-settings-card')),
      sideCards:panel.querySelectorAll('.side-stack > .card').length,
    };
  });
  expect(budgetOrder.metrics).toBeLessThan(budgetOrder.calendar);
  expect(budgetOrder.calendar).toBeLessThan(budgetOrder.charts);
  expect(budgetOrder.charts).toBeLessThan(budgetOrder.settings);
  expect(budgetOrder.sideCards).toBe(1);
  const toggle = page.locator('#expense-category-toggle');
  const content = page.locator('#expense-category-content');
  const trendToggle = page.locator('#expense-trend-toggle');
  const trendContent = page.locator('#expense-trend-content');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute('aria-controls', 'expense-category-content');
  await expect(trendToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(trendToggle).toHaveAttribute('aria-controls', 'expense-trend-content');
  await expect(content).toHaveAttribute('aria-hidden', 'true');
  await expect(trendContent).toHaveAttribute('aria-hidden', 'true');
  await expect(content).toHaveJSProperty('inert', true);
  await expect(trendContent).toHaveJSProperty('inert', true);
  await expect(page.locator('#expense-month-total')).toContainText('1,200');
  await expect(page.locator('#expense-donut')).toBeVisible();
  await expect(page.locator('#expense-donut-total')).toContainText('1,200');
  await expect(page.locator('#expense-income-forecast')).toBeVisible();
  await expect(page.locator('#expense-income-spent')).toContainText('1,200');
  await expect(page.locator('#expense-trend-bars li')).toHaveCount(6);
  await expect.poll(() => page.locator('#expense-category-content').evaluate(el => el.getBoundingClientRect().height)).toBe(0);
  await expect.poll(() => page.locator('#expense-trend-content').evaluate(el => el.getBoundingClientRect().height)).toBe(0);
  await screenshot(page, 'budget-category-breakdown-collapsed.png');
  await page.screenshot({ path:'test-results/screenshots/budget-after-desktop-full.png', fullPage:true, animations:'disabled' });

  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(content).toHaveAttribute('aria-hidden', 'false');
  await expect(content).toHaveJSProperty('inert', false);
  await expect(page.locator('#expense-category-chart-list .chart-category')).toHaveCount(EXPENSE_CATEGORIES.length);
  await expect.poll(() => page.locator('#expense-category-content').evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(100);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), chartPreferenceKey)).toBe('open');
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), trendPreferenceKey)).toBeNull();
  const desktopColumns = await page.locator('#expense-chart-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length);
  expect(desktopColumns).toBe(2);
  await screenshot(page, 'budget-category-breakdown-expanded.png');

  await trendToggle.focus();
  await page.keyboard.press('Enter');
  await expect(trendToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(trendContent).toHaveAttribute('aria-hidden', 'false');
  await expect(trendContent).toHaveJSProperty('inert', false);
  await expect(page.locator('#expense-trend-bars li')).toHaveCount(6);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), trendPreferenceKey)).toBe('open');
  await screenshot(page, 'budget-trend-expanded.png');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(trendToggle).toHaveAttribute('aria-expanded', 'true');
  await page.reload();
  await page.locator('.nav-button[data-page="money"]').click();
  await expect(page.locator('#expense-category-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#expense-trend-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#expense-category-chart-list .chart-category')).toHaveCount(EXPENSE_CATEGORIES.length);
  await expect(page.locator('#expense-donut')).toBeVisible();
  await page.locator('#expense-trend-toggle').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#expense-trend-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#expense-month-total')).toContainText('1,200');
  await expect(page.locator('#expense-trend-bars li')).toHaveCount(6);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), chartPreferenceKey)).toBe('closed');
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), trendPreferenceKey)).toBe('closed');
  const collapsedColumns = await page.locator('#expense-chart-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length);
  expect(collapsedColumns).toBe(2);

  for (const width of [320, 375, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height:844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `horizontal overflow at ${width}px`).toBe(true);
    await page.locator('#expense-category-toggle').click();
    await expect(page.locator('#expense-category-toggle')).toHaveAttribute('aria-expanded', 'true');
    const columns = await page.locator('#expense-chart-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length);
    expect(columns).toBe(width <= 700 ? 1 : 2);
    await page.locator('#expense-category-toggle').click();
    await page.locator('#expense-trend-toggle').click();
    await expect(page.locator('#expense-trend-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `trend horizontal overflow at ${width}px`).toBe(true);
    await page.locator('#expense-trend-toggle').click();
    if (width === 390 || width === 1280) {
      await page.screenshot({ path:`test-results/screenshots/budget-after-${width}px-full.png`, fullPage:true, animations:'disabled' });
    }
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.locator('#expense-category-toggle').click();
  const darkStyle = await page.locator('#expense-category-toggle').evaluate(el => ({ background:getComputedStyle(el).backgroundColor, color:getComputedStyle(el).color }));
  expect(darkStyle.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(darkStyle.color).not.toBe('rgba(0, 0, 0, 0)');
  expect(api.state.outside).toEqual([]);
});

test('expense chart refreshes after adding, editing and deleting a record and honors reduced motion', async ({ page, browser }) => {
  const api = syntheticApi({ groups:[] });
  await api.attach(page.context());
  await page.addInitScript(({ accountKey, date, category }) => localStorage.setItem(accountKey, JSON.stringify({
    expenses:{ [date]:[{ id:'seed-expense', amount:1200, category, note:'Seed synthetic expense' }] },
    budget:{ fixed:'', saving:'' },
  })), { accountKey, date:api.date, category:EXPENSE_CATEGORIES[0] });
  await page.setViewportSize({ width:390, height:844 });
  await page.goto('/');
  await page.locator('.nav-button[data-page="money"]').click();
  await page.locator('#expense-category-toggle').click();
  await expect(page.locator('#expense-month-total')).toContainText('1,200');

  await page.locator('#open-expense-dialog').click();
  await expect(page.locator('#expense-dialog')).toBeVisible();
  await page.locator('#expense-amount').fill('450');
  await page.locator('#expense-category').selectOption({ label:EXPENSE_CATEGORIES[1] });
  await page.locator('#expense-note').fill('Added synthetic expense');
  await page.locator('#save-expense').click();
  await expect(page.locator('#expense-dialog')).toBeHidden();
  await expect(page.locator('#expense-month-total')).toContainText('1,650');
  await expect(page.locator('#expense-donut-total')).toContainText('1,650');

  const seedRow = page.locator('#expense-list .expense-item').filter({ hasText:'Seed synthetic expense' });
  await seedRow.locator('.expense-actions button').first().click();
  await expect(page.locator('#expense-dialog')).toBeVisible();
  await page.locator('#expense-amount').fill('600');
  await page.locator('#expense-category').selectOption({ label:EXPENSE_CATEGORIES[2] });
  await page.locator('#expense-note').fill('Edited synthetic expense');
  await page.locator('#save-expense').click();
  await expect(page.locator('#expense-month-total')).toContainText('1,050');
  await expect(page.locator('#expense-donut-total')).toContainText('1,050');

  const addedRow = page.locator('#expense-list .expense-item').filter({ hasText:'Added synthetic expense' });
  await addedRow.locator('.expense-actions button').nth(1).click();
  await expect(page.locator('#expense-month-total')).toContainText('600');
  await expect(page.locator('#expense-donut-total')).toContainText('600');

  const reducedContext = await browser.newContext({ reducedMotion:'reduce', viewport:{ width:390, height:844 } });
  try {
    const reducedApi = syntheticApi({ groups:[] });
    await reducedApi.attach(reducedContext);
    const reducedPage = await reducedContext.newPage();
    await reducedPage.goto('/');
    await reducedPage.locator('.nav-button[data-page="money"]').click();
    const reducedContent = reducedPage.locator('#expense-trend-content');
    const transitionDuration = await reducedContent.evaluate(el => getComputedStyle(el).transitionDuration);
    expect(transitionDuration.split(',').every(duration => duration.trim() === '0s')).toBe(true);
    expect(reducedApi.state.outside).toEqual([]);
  } finally {
    await reducedContext.close();
  }
  expect(api.state.outside).toEqual([]);
});
