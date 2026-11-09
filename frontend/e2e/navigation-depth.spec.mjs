import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { syntheticApi } from './synthetic-api.mjs';

const screenshotDir = 'test-results/screenshots';
const groups = [{
  groupId:'synthetic-nav-group', memberId:'synthetic-nav-member', memberName:'テスト利用者',
  groupName:'ナビゲーション確認用', inviteCode:'MP-NAV-TEST', memberCount:1,
}];

async function boot(page, { width = 390, height = 844, groupList = [] } = {}) {
  const api = syntheticApi({ groups:groupList, personalSyncActive:true });
  await api.attach(page.context());
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await expect(page.locator('#app-root')).toBeVisible();
  await expect(page.locator('.page-nav')).toBeVisible();
  return { api, pageErrors };
}

async function selectedAlignment(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('.page-nav');
    const indicator = nav.querySelector('.page-nav-indicator');
    const button = nav.querySelector('.nav-button[aria-current="page"]');
    if (!button) return null;
    const a = indicator.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    const transform = new DOMMatrixReadOnly(getComputedStyle(button).transform);
    return {
      leftDelta:Math.abs(a.left - b.left),
      topDelta:Math.abs(a.top - b.top),
      widthDelta:Math.abs(a.width - b.width),
      selectedY:transform.m42,
      indicatorOpacity:getComputedStyle(indicator).opacity,
      indicatorPointerEvents:getComputedStyle(indicator).pointerEvents,
      active:nav.dataset.indicatorActive,
    };
  });
}

test('three main tabs keep their navigation behavior and the highlight slides into alignment', async ({ page }) => {
  const { api, pageErrors } = await boot(page);
  const nav = page.locator('.page-nav');
  const indicator = nav.locator('.page-nav-indicator');
  const pages = [
    ['my', '#page-my'],
    ['group', '#page-group'],
    ['money', '#page-money'],
  ];

  await expect(nav.locator('[aria-current="page"]')).toHaveAttribute('data-page', 'my');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  let alignment = await selectedAlignment(page);
  expect(alignment.leftDelta).toBeLessThan(1);
  expect(alignment.topDelta).toBeLessThan(1);
  expect(alignment.widthDelta).toBeLessThan(1);
  expect(alignment.selectedY).toBeCloseTo(-4, 0);
  expect(alignment.indicatorPointerEvents).toBe('none');

  for (const [index, [name, panel]] of pages.entries()) {
    if (index > 0) {
      const target = nav.locator(`[data-page="${name}"]`);
      const motion = await target.evaluate(element => {
        const nav = element.closest('.page-nav');
        const indicator = nav.querySelector('.page-nav-indicator');
        const fromX = new DOMMatrixReadOnly(getComputedStyle(indicator).transform).m41;
        element.click();
        const animation = indicator.getAnimations().find(item => item.transitionProperty === 'transform');
        if (!animation) return null;
        const duration = animation.effect.getComputedTiming().duration;
        animation.pause();
        animation.currentTime = duration / 2;
        const midX = new DOMMatrixReadOnly(getComputedStyle(indicator).transform).m41;
        const navRect = nav.getBoundingClientRect();
        const buttonRect = element.getBoundingClientRect();
        const toX = buttonRect.left - navRect.left - parseFloat(getComputedStyle(nav).borderLeftWidth || '0');
        const value = { fromX, midX, toX, duration };
        for (const active of indicator.getAnimations()) active.finish();
        return value;
      });
      expect(motion).not.toBeNull();
      expect(motion.duration).toBe(260);
      expect(motion.midX).toBeGreaterThan(Math.min(motion.fromX,motion.toX));
      expect(motion.midX).toBeLessThan(Math.max(motion.fromX,motion.toX));
    }
    await expect(nav.locator('[aria-current="page"]')).toHaveAttribute('data-page', name);
    await expect(page.locator(panel)).toBeVisible();
    await expect(page.locator('.page-panel:not([hidden])')).toHaveCount(1);
    await expect.poll(async () => Math.abs((await selectedAlignment(page)).selectedY + 4) < 0.1).toBe(true);
    const inactiveY = await nav.locator(`.nav-button:not([data-page="${name}"])`).evaluateAll(buttons =>
      buttons.map(button => new DOMMatrixReadOnly(getComputedStyle(button).transform).m42));
    for (const y of inactiveY) expect(y).toBeCloseTo(0, 0);
    await expect.poll(async () => {
      const result = await selectedAlignment(page);
      return result && result.leftDelta < 1 && result.topDelta < 1 && result.widthDelta < 1;
    }).toBe(true);
  }

  await page.locator('.nav-button[data-page="my"]').click();
  await page.locator('#account-open').click();
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(0);
  await expect(nav).toHaveAttribute('data-indicator-active', 'false');
  await page.locator('.nav-button[data-page="money"]').click();
  await expect(nav.locator('[aria-current="page"]')).toHaveAttribute('data-page', 'money');

  await page.reload();
  await expect(nav.locator('[aria-current="page"]')).toHaveAttribute('data-page', 'my');
  await expect.poll(async () => (await selectedAlignment(page))?.leftDelta < 1).toBe(true);
  expect(pageErrors).toEqual([]);
  expect(api.state.outside).toEqual([]);
  expect(await indicator.evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
});

test('navigation fits phone, tablet and desktop widths in both themes', async ({ page }) => {
  await boot(page);
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height:844 });
    const layout = await page.evaluate(() => ({
      viewport:innerWidth,
      document:document.documentElement.scrollWidth,
      buttons:[...document.querySelectorAll('.nav-button')].map(button => button.getBoundingClientRect()),
    }));
    expect(layout.document).toBeLessThanOrEqual(layout.viewport);
    for (const button of layout.buttons) {
      expect(button.width).toBeGreaterThan(0);
      expect(button.height).toBeGreaterThanOrEqual(44);
    }
    await expect.poll(async () => {
      const result = await selectedAlignment(page);
      return result && result.leftDelta < 1 && result.widthDelta < 1;
    }).toBe(true);
    const aligned = await selectedAlignment(page);
    expect(aligned.leftDelta).toBeLessThan(1);
    expect(aligned.widthDelta).toBeLessThan(1);
    if (width === 390) {
      mkdirSync(screenshotDir, { recursive:true });
      await page.locator('.page-nav').screenshot({ path:`${screenshotDir}/navigation-after-390px.png`, animations:'disabled' });
    }
  }

  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  const dark = await page.locator('.page-nav-indicator').evaluate(element => ({
    background:getComputedStyle(element).backgroundImage,
    shadow:getComputedStyle(element).boxShadow,
  }));
  expect(dark.background).not.toBe('none');
  expect(dark.shadow).not.toBe('none');
  await page.setViewportSize({ width:390, height:844 });
  mkdirSync(screenshotDir, { recursive:true });
  await page.locator('.page-nav').screenshot({ path:`${screenshotDir}/navigation-after-dark-390px.png`, animations:'disabled' });
});

test('reduced motion removes lift and sliding while selected state stays clear', async ({ page }) => {
  await boot(page);
  await page.emulateMedia({ reducedMotion:'reduce' });
  await page.locator('.nav-button[data-page="group"]').click();
  const state = await page.evaluate(() => {
    const nav = document.querySelector('.page-nav');
    const selected = nav.querySelector('[aria-current="page"]');
    const icon = selected.querySelector('.nav-symbol');
    const indicator = nav.querySelector('.page-nav-indicator');
    return {
      buttonTransform:getComputedStyle(selected).transform,
      iconTransform:getComputedStyle(icon).transform,
      buttonDuration:getComputedStyle(selected).transitionDuration,
      indicatorDuration:getComputedStyle(indicator).transitionDuration,
      indicatorOpacity:getComputedStyle(indicator).opacity,
      indicatorY:new DOMMatrixReadOnly(getComputedStyle(indicator).transform).m42,
      alignmentTop:Math.abs(indicator.getBoundingClientRect().top - selected.getBoundingClientRect().top),
    };
  });
  expect(state.buttonTransform).toBe('none');
  expect(state.iconTransform).toBe('none');
  expect(state.buttonDuration).toBe('0s');
  expect(state.indicatorDuration.split(',').every(value => value.trim() === '0s')).toBe(true);
  expect(state.indicatorOpacity).toBe('1');
  expect(state.indicatorY).toBe(0);
  expect(state.alignmentTop).toBeLessThan(1);
});

test('keyboard activation preserves focus-visible and modal backdrop does not switch pages', async ({ page }) => {
  await boot(page, { groupList:groups });
  const groupButton = page.locator('.nav-button[data-page="group"]');
  await page.locator('.nav-button[data-page="my"]').focus();
  await page.keyboard.press('Tab');
  await expect(groupButton).toBeFocused();
  expect(await groupButton.evaluate(element => element.matches(':focus-visible'))).toBe(true);
  await page.keyboard.press('Enter');
  await expect(groupButton).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#page-group')).toBeVisible();

  await page.locator('#open-group-add').click();
  await expect(page.locator('#group-add-dialog')).toBeVisible();
  const moneyBox = await page.locator('.nav-button[data-page="money"]').boundingBox();
  await page.mouse.click(moneyBox.x + moneyBox.width / 2, moneyBox.y + moneyBox.height / 2);
  await expect(page.locator('.nav-button[aria-current="page"]')).toHaveAttribute('data-page', 'group');
  await expect(page.locator('#page-group')).toBeVisible();
});

test('touch input switches tabs without overflow and keeps tap targets usable', async ({ browser }) => {
  const context = await browser.newContext({
    baseURL:'http://127.0.0.1:5517', viewport:{ width:390, height:844 }, isMobile:true, hasTouch:true,
  });
  const page = await context.newPage();
  const { api } = await boot(page);
  await page.locator('.nav-button[data-page="group"]').tap();
  await expect(page.locator('.nav-button[data-page="group"]')).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(api.state.outside).toEqual([]);
  await context.close();
});

test('mouse press briefly compresses the target without delaying navigation', async ({ page }) => {
  await boot(page, { width:1280, height:900 });
  const target = page.locator('.nav-button[data-page="group"]');
  const box = await target.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(35);
  const pressed = await target.evaluate(element => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { y:matrix.m42, scale:matrix.m11 };
  });
  expect(pressed.y).toBeGreaterThan(0);
  expect(pressed.scale).toBeLessThan(1);
  await page.mouse.up();
  await expect(target).toHaveAttribute('aria-current', 'page');
  await expect.poll(async () => Math.abs((await selectedAlignment(page)).selectedY + 4) < 0.1).toBe(true);
});
