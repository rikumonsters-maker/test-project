import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { syntheticApi } from './synthetic-api.mjs';

const actions = [
  { screen:'my', button:'#open-event-dialog', dialog:'#event-dialog', close:'#close-event-dialog', name:'event', key:'Enter' },
  { screen:'money', button:'#open-expense-dialog', dialog:'#expense-dialog', close:'#close-expense-dialog', name:'expense', key:'Space' },
  { screen:'group', button:'#open-group-add', dialog:'#group-add-dialog', close:'#close-group-add-dialog', name:'group', key:'Enter' },
];
const screenshotDir = 'test-results/release-screenshots';

async function boot(page) {
  const api = syntheticApi({ groups:[] });
  await api.attach(page.context());
  await page.goto('/');
  await expect(page.locator('#app-root')).toBeVisible();
  return api;
}

async function showPage(page, screen) {
  await page.locator(`.nav-button[data-page="${screen}"]`).click();
}

async function closeDialog(page, action) {
  await page.locator(action.close).click();
  await expect(page.locator(action.dialog)).toBeHidden();
  await expect(page.locator(action.button)).toBeFocused();
}

test('the three add actions share the press-depth style without affecting layout or other controls', async ({ page }) => {
  const api = await boot(page);
  await page.emulateMedia({ reducedMotion:'no-preference' });
  mkdirSync(screenshotDir, { recursive:true });
  await expect(page.locator('.add-action-button')).toHaveCount(3);
  expect(await page.locator('.add-action-button').evaluateAll(elements => elements.map(element => element.id).sort()))
    .toEqual(['open-event-dialog','open-expense-dialog','open-group-add']);

  for (const width of [320,390,768,1280]) {
    await page.setViewportSize({ width, height:width < 500 ? 844 : 900 });
    for (const action of actions) {
      await showPage(page, action.screen);
      await page.evaluate(() => {
        document.querySelectorAll('.nav-button').forEach(element => {
          element.style.transition = 'none';
          element.style.animation = 'none';
        });
      });
      const button = page.locator(action.button);
      await expect(button).toBeVisible();
      const normal = await button.evaluate(element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return { className:element.className, height:rect.height, transform:style.transform,
          shadow:style.boxShadow, transitionProperty:style.transitionProperty.split(',').map(value => value.trim()),
          transitionDuration:style.transitionDuration.split(',').map(value => parseFloat(value)) };
      });
      expect(normal.className).toContain('add-action-button');
      expect(normal.height).toBeGreaterThanOrEqual(44);
      expect(normal.transform).not.toBe('none');
      expect(normal.shadow).not.toBe('none');
      expect(normal.transitionProperty).toEqual(['transform','box-shadow','filter']);
      expect(normal.transitionDuration.length).toBeGreaterThan(0);
      expect(normal.transitionDuration.every(value => Math.abs(value - 0.11) < 0.001)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `page overflow at ${width}px`).toBe(true);

      const excludedBefore = await page.evaluate(() => ({
        calendar:getComputedStyle(document.querySelector('#agenda-calendar .calendar-day')).transform,
        navigation:getComputedStyle(document.querySelector('.nav-button')).transform,
      }));
      const dialog = page.locator(action.dialog);
      if (width === 390) {
        await page.evaluate(selector => {
          const element = document.querySelector(selector);
          const nativeShowModal = element.showModal.bind(element);
          element.__showModalCalls = 0;
          element.showModal = () => { element.__showModalCalls += 1; nativeShowModal(); };
        }, action.dialog);
      }
      if (width === 390) {
        await button.evaluate(element => { element.style.transition = 'none'; });
        await button.hover();
        const hoverShadow = await button.evaluate(element => getComputedStyle(element).boxShadow);
        const rect = await button.boundingBox();
        if (!rect) throw new Error(`Missing ${action.button} geometry`);
        await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
        await page.mouse.down();
        const pressed = await button.evaluate(element => {
          const style = getComputedStyle(element);
          const matrix = new DOMMatrixReadOnly(style.transform);
          return { x:matrix.m41, y:matrix.m42, scaleX:matrix.m11, scaleY:matrix.m22, shadow:style.boxShadow };
        });
        expect(pressed.y).toBeCloseTo(1, 1);
        expect(pressed.x).toBeCloseTo(0, 2);
        expect(pressed.scaleX).toBeCloseTo(0.99, 2);
        expect(pressed.scaleY).toBeCloseTo(0.99, 2);
        expect(pressed.shadow).not.toBe(hoverShadow);
        if (action.name === 'event') {
          await page.screenshot({ path:`${screenshotDir}/add-buttons-pressed-event-390px.png`, fullPage:true });
        }
        await page.mouse.up();
        await button.evaluate(element => element.style.removeProperty('transition'));
        expect(await dialog.evaluate(element => element.__showModalCalls)).toBe(1);
      } else {
        if (width === 390 || width === 1280) {
          await page.screenshot({ path:`${screenshotDir}/add-buttons-after-${action.name}-${width}px.png`, fullPage:true, animations:'disabled' });
        }
        await button.click();
      }

      await expect(dialog).toBeVisible();
      if (width === 390) {
        await page.screenshot({ path:`${screenshotDir}/add-buttons-after-modal-${action.name}-390px.png`, fullPage:true, animations:'disabled' });
        expect(await dialog.evaluate(element => element.__showModalCalls)).toBe(1);
        await expect(dialog).toBeVisible();
      }
      const excludedAfter = await page.evaluate(() => ({
        calendar:getComputedStyle(document.querySelector('#agenda-calendar .calendar-day')).transform,
        navigation:getComputedStyle(document.querySelector('.nav-button')).transform,
      }));
      expect(excludedAfter).toEqual(excludedBefore);
      await closeDialog(page, action);
      await button.click();
      await expect(dialog).toBeVisible();
      await closeDialog(page, action);
    }
  }
  expect(api.state.outside).toEqual([]);
});

test('add actions remain keyboard, touch, dark-theme and reduced-motion friendly', async ({ page, browser }) => {
  const api = await boot(page);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  for (const action of actions) {
    await showPage(page, action.screen);
    const button = page.locator(action.button);
    const colors = await button.evaluate(element => ({
      background:getComputedStyle(element).backgroundColor,
      color:getComputedStyle(element).color,
      shadow:getComputedStyle(element).boxShadow,
    }));
    expect(colors.background).not.toBe(colors.color);
    expect(colors.shadow).not.toBe('none');
    await button.press(action.key);
    await expect(page.locator(action.dialog)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(action.dialog)).toBeHidden();
    await expect(button).toBeFocused();
    expect(await button.evaluate(element => getComputedStyle(element).outlineWidth)).not.toBe('0px');
  }

  await page.emulateMedia({ reducedMotion:'reduce' });
  for (const action of actions) {
    await showPage(page, action.screen);
    const button = page.locator(action.button);
    const style = await button.evaluate(element => ({
      duration:getComputedStyle(element).transitionDuration,
      shadow:getComputedStyle(element).boxShadow,
    }));
    expect(style.duration.split(',').every(value => parseFloat(value) === 0)).toBe(true);
    const rect = await button.boundingBox();
    if (!rect) throw new Error(`Missing ${action.button} geometry`);
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    const active = await button.evaluate(element => ({
      transform:getComputedStyle(element).transform,
      shadow:getComputedStyle(element).boxShadow,
    }));
    expect(active.transform).toBe('none');
    expect(active.shadow).not.toBe(style.shadow);
    await page.mouse.up();
    await expect(page.locator(action.dialog)).toBeVisible();
    await closeDialog(page, action);
  }

  const touch = await browser.newContext({ hasTouch:true, viewport:{ width:320, height:720 } });
  try {
    const touchApi = syntheticApi({ groups:[] });
    await touchApi.attach(touch);
    const touchPage = await touch.newPage();
    await touchPage.goto('/');
    for (const action of actions) {
      await touchPage.locator(`.nav-button[data-page="${action.screen}"]`).tap();
      const button = touchPage.locator(action.button);
      await expect(button).toBeVisible();
      await button.tap();
      await expect(touchPage.locator(action.dialog)).toBeVisible();
      await touchPage.locator(action.close).tap();
      await expect(touchPage.locator(action.dialog)).toBeHidden();
      expect(await touchPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(touchApi.state.outside).toEqual([]);
  } finally {
    await touch.close();
  }
  expect(api.state.outside).toEqual([]);
});
