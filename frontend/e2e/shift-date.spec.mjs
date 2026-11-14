import {test,expect} from '@playwright/test';
import {mkdirSync} from 'node:fs';
import {syntheticApi} from './synthetic-api.mjs';
async function boot(page){const root=process.env.SHIFT_TEST_URL||'http://127.0.0.1:5517';const origin=new URL(root).origin;const api=syntheticApi({groups:[],personalSyncActive:true,frontendOrigin:origin,apiOrigin:process.env.SHIFT_TEST_URL?origin:'http://127.0.0.1:8787'});await api.attach(page.context());await page.goto(root);await expect(page.locator('#home-card-shift')).toBeVisible();await page.evaluate(()=>window.__daysyncHomeCards.setAnimationTime(3));await page.locator('#home-card-shift').click();return api;}
async function date(page,value){await page.locator('#shift-work-date').fill(value);await page.locator('#shift-work-date').dispatchEvent('change');}
async function salary(page){await page.locator('#shift-mode-tab-salary').click();}
async function manage(page){await page.locator('#shift-mode-tab-shift').click();}

test('direct date preserves times, moves an overnight shift across years, and protects occupied dates',async({page})=>{
 const api=await boot(page);
 await salary(page);await page.locator('#hourly').fill('1200');await manage(page);
 await page.locator('#shift-start').fill('22:00');await page.locator('#shift-end').fill('06:00');await page.locator('#shift-break').fill('60');
 await date(page,'2026-12-31');await expect(page.locator('#shift-start')).toHaveValue('22:00');await expect(page.locator('#shift-break')).toHaveValue('60');
 await expect(page.locator('#shift-calendar .selected')).toHaveAttribute('aria-label',/12月31日/);
 await page.locator('#save-shift').click();await expect(page.locator('#shift-day-wage')).toHaveText('7時間 / ¥8,400');
 await salary(page);await expect(page.locator('#shift-month-wage')).toHaveText('¥8,400');await expect(page.locator('#salary-shift-count')).toHaveText('1件');await manage(page);
 await date(page,'2027-01-01');page.once('dialog',d=>d.dismiss());await page.locator('#save-shift').click();await expect(page.locator('#shift-start')).toHaveValue('22:00');
 page.once('dialog',d=>d.accept());await page.locator('#save-shift').click();await salary(page);await expect(page.locator('[data-shift-date="2027-01-01"]')).toHaveCount(1);await expect(page.locator('#shift-month-wage')).toHaveText('¥8,400');await manage(page);
 await page.locator('#shift-calendar .calendar-day:not(.outside):not(.has-entry)').first().click();
 await date(page,'2027-01-02');await page.locator('#shift-start').fill('09:00');await page.locator('#shift-end').fill('12:00');await page.locator('#shift-break').fill('0');await page.locator('#save-shift').click();
 await date(page,'2027-01-01');await page.locator('#save-shift').click();await expect(page.locator('#shift-error')).toContainText('登録済み');await salary(page);await expect(page.locator('#salary-shift-count')).toHaveText('2件');await expect(page.locator('#shift-month-wage')).toHaveText('¥12,000');await manage(page);
 page.once('dialog',d=>d.accept());await page.locator('#shift-calendar').getByRole('gridcell',{name:/1月2日/}).click();
 await expect(page.locator('#shift-work-date')).toHaveValue('2027-01-02');
 page.once('dialog',d=>d.dismiss());await page.locator('#delete-shift').click();await expect(page.locator('#delete-shift')).toBeVisible();
 page.once('dialog',d=>d.accept());await page.locator('#delete-shift').click();await salary(page);await expect(page.locator('#salary-shift-count')).toHaveText('1件');await expect(page.locator('#shift-month-wage')).toHaveText('¥8,400');
 expect(api.state.outside).toEqual([]);
});

test('failed date move preserves the original shift and draft',async({page})=>{
 await boot(page);await date(page,'2027-01-01');await page.locator('#shift-start').fill('09:00');await page.locator('#shift-end').fill('12:00');await page.locator('#save-shift').click();
 await date(page,'2027-01-02');
 await page.evaluate(()=>{window.__shiftSave=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('Synthetic quota','QuotaExceededError');};});
 page.once('dialog',d=>d.accept());await page.locator('#save-shift').click();await expect(page.locator('#shift-error')).toContainText('保存できません');await expect(page.locator('#shift-start')).toHaveValue('09:00');
 await page.evaluate(()=>{Storage.prototype.setItem=window.__shiftSave;delete window.__shiftSave;});
 await salary(page);await expect(page.locator('[data-shift-date="2027-01-01"]')).toHaveCount(1);await expect(page.locator('[data-shift-date="2027-01-02"]')).toHaveCount(0);await expect(page.locator('#salary-shift-count')).toHaveText('1件');
});

test('date validation, draft protection, mobile themes and keyboard preserve the form',async({page})=>{
 await boot(page);await date(page,'2028-02-29');await page.locator('#shift-start').fill('10:00');await page.locator('#shift-end').fill('11:00');
 page.once('dialog',d=>d.dismiss());await page.locator('#shift-next').click();await expect(page.locator('#shift-work-date')).toHaveValue('2028-02-29');await expect(page.locator('#shift-start')).toHaveValue('10:00');
 await page.locator('#shift-work-date').fill('');await page.locator('#shift-form').evaluate(form=>form.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})));await expect(page.locator('#shift-error')).toContainText('勤務日');
 await date(page,'2028-02-29');await page.locator('#shift-break').fill('120');await page.locator('#save-shift').click();await expect(page.locator('#shift-error')).toContainText('休憩');await page.locator('#shift-break').fill('0');
 mkdirSync('test-results/shift-date',{recursive:true});
 for(const width of [375,390,430,768,1280])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height:900});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
  expect(await page.locator('#shift-work-date').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth;})).toBe(true);
  await page.screenshot({path:`test-results/shift-date/${width}-${theme}.png`,fullPage:true,animations:'disabled'});
 }
 await page.locator('#save-shift').focus();await page.keyboard.press('Enter');await expect(page.locator('#shift-day-wage')).toContainText('1時間');
});
