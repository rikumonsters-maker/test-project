import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { syntheticApi } from './synthetic-api.mjs';

const userId = '00000000-0000-4000-8000-000000000001';
const accountKey = `daysync-user-${userId}`;
const syncKey = `${accountKey}-personal-sync-v2`;

async function screenshot(page, name) {
  mkdirSync('test-results/screenshots', { recursive:true });
  await page.screenshot({ path:`test-results/screenshots/${name}`, fullPage:false, animations:'disabled' });
}

test('normal sync has no status card or leftover space after load and reload', async ({ page }) => {
  const api = syntheticApi({ groups:[], personalSyncActive:true });
  await api.attach(page.context());
  await page.setViewportSize({ width:390, height:844 });
  await page.goto('/');
  await page.locator('#home-card-personal').click();

  const card = page.locator('#personal-sync-card');
  await expect(page.locator('#agenda-calendar')).toBeVisible();
  await expect(card).toBeHidden();
  await expect(page.locator('#personal-sync-status')).toHaveText('');
  await screenshot(page, 'sync-normal-mobile.png');

  const heading = page.locator('#agenda-page-title').boundingBox();
  const calendar = page.locator('#agenda-calendar').boundingBox();
  expect((await heading).y).toBeLessThan((await calendar).y);
  for (const width of [320, 375, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height:844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}px`).toBe(true);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await expect(card).toBeHidden();
  await page.reload();
  await expect(card).toBeHidden();
  expect(api.state.outside).toEqual([]);
});

test('sync error is visible, then clears automatically after a successful retry', async ({ page }) => {
  const api = syntheticApi({ groups:[], personalSyncActive:true, syncFailures:100 });
  await api.attach(page.context());
  await page.setViewportSize({ width:390, height:844 });
  await page.goto('/');
  await page.locator('#home-card-personal').click();

  const card = page.locator('#personal-sync-card');
  await expect(card).toBeVisible();
  await expect(page.locator('#personal-sync-status')).toContainText('同期失敗・オフライン');
  await expect(page.locator('#personal-sync-status')).toHaveAttribute('role', 'alert');
  await screenshot(page, 'sync-error-mobile.png');

  api.state.syncFailuresRemaining = 0;
  await page.locator('#settings-open').click();
  await expect(page.locator('#page-settings')).toBeVisible();
  await expect(page.locator('#settings-sync-state')).toContainText('同期失敗・オフライン');
  await page.locator('#personal-sync-retry').click();
  await expect(card).toBeHidden();
  await expect(page.locator('#settings-sync-state')).toContainText('同期有効');
  expect(api.state.requests.filter(item => item.path === '/api/personal/events/sync').length).toBeGreaterThanOrEqual(2);
  expect(api.state.outside).toEqual([]);
});

test('storage quota failure remains visible after a successful network sync', async ({ page }) => {
  const api = syntheticApi({ groups:[], personalSyncActive:true });
  await api.attach(page.context());
  await page.addInitScript(key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return original.call(this, name, value);
    };
  }, accountKey);
  await page.setViewportSize({ width:375, height:812 });
  await page.goto('/');
  await page.locator('#home-card-personal').click();
  await expect(page.locator('#personal-sync-card')).toBeVisible();
  await expect(page.locator('#personal-sync-status')).toContainText('保存領域が不足');
  await expect(page.locator('#personal-sync-status')).toHaveAttribute('role', 'alert');
  expect(api.state.outside).toEqual([]);
});

test('important duplicate restore notice remains visible after sync completion', async ({ page }) => {
  const api = syntheticApi({ groups:[], personalSyncActive:true });
  await api.attach(page.context());
  await page.addInitScript(({ syncKey }) => {
    localStorage.setItem(syncKey, JSON.stringify({ format:2, cursor:0, records:{}, queue:[], restoreQueue:[],
      active:true, results:{}, migrationConflicts:true }));
  }, { syncKey });
  await page.goto('/');
  await page.locator('#home-card-personal').click();
  await expect(page.locator('#personal-sync-card')).toBeVisible();
  await expect(page.locator('#personal-sync-status')).toContainText('復元予定は両方保管しました');
  expect(api.state.outside).toEqual([]);
});

test('unsynced conflict guidance remains visible', async ({ page }) => {
  const api = syntheticApi({ groups:[], personalSyncActive:true });
  await api.attach(page.context());
  await page.addInitScript(({ accountKey, syncKey }) => {
    const event = { id:'synthetic-conflict-event', date:'2026-11-09', title:'合成予定', start:'10:00', end:'11:00' };
    localStorage.setItem(accountKey, JSON.stringify({ events:{ [event.date]:[event] } }));
    localStorage.setItem(syncKey, JSON.stringify({ format:2, cursor:0, records:{},
      queue:[{ operationId:'synthetic-operation', action:'create', id:event.id, event, version:0, conflict:true,
        remote:{ id:event.id, date:event.date, title:'別端末の予定', version:1 } }],
      restoreQueue:[], active:true, results:{}, migrationConflicts:false }));
  }, { accountKey, syncKey });
  await page.goto('/');
  await page.locator('#home-card-personal').click();
  await expect(page.locator('#personal-sync-card')).toBeVisible();
  await expect(page.locator('#personal-sync-status')).toContainText('別端末との競合');
  await expect(page.locator('#personal-sync-conflicts .sync-conflict')).toHaveCount(1);
  await expect(page.locator('#personal-sync-conflicts')).toContainText('サーバーの内容を使う');
});
