import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { syntheticApi } from "./synthetic-api.mjs";

const fixture = readFileSync(new URL("./fixtures/japanese-calendar-list.png", import.meta.url));
const shots = "test-results/ocr-review";

async function enterVerifiedTimes(card, start, end) {
  await card.locator('[data-field="start"]').fill(start);
  await card.locator('[data-field="end"]').fill(end);
}

test("real Japanese OCR excludes time axes and keeps only explicit event rows", async ({ page }) => {
  test.setTimeout(240_000);
  const api = syntheticApi({ groups:[], personalSyncActive:false });
  await api.attach(page.context());
  await page.goto('/');
  await page.locator('#account-open').click();
  await page.locator('#profile-data-management').evaluate(el => { el.open = true; });
  for (const withEvents of [false, true]) {
    await page.locator('#screenshot-import-open').click();
    const image = await page.evaluate(events => {
      const canvas = document.createElement('canvas');
      canvas.width = 1800; canvas.height = 1100;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#111'; ctx.font = '32px "Meiryo", sans-serif';
      ctx.fillText('2026年11月12日', 200, 55);
      for (let hour = 9; hour <= 22; hour++) ctx.fillText(`${String(hour).padStart(2, '0')}:00`, 20, 110 + (hour - 9) * 68);
      if (events) {
        ctx.fillText('2026年11月12日 10:00-12:00 大学の授業', 200, 190);
        ctx.fillText('2026年11月12日 13:00-14:00 会議', 200, 400);
      }
      return canvas.toDataURL('image/png').split(',')[1];
    }, withEvents);
    await page.locator('#screenshot-import-file').setInputFiles({name:'synthetic-time-axis.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
    await expect(page.locator('#screenshot-import-cancel-ocr')).toBeHidden({timeout:90_000});
    await expect(page.locator('.screenshot-import-candidate')).toHaveCount(withEvents ? 2 : 0);
    if (withEvents) {
      const actual = await page.locator('.screenshot-import-candidate').evaluateAll(cards => cards.map(card => ['title','date','start','end'].map(field => card.querySelector(`[data-field="${field}"]`).value)));
      expect(actual).toEqual([['大学の授業','2026-11-12','10:00','12:00'],['会議','2026-11-12','13:00','14:00']]);
    } else await expect(page.locator('#screenshot-import-status')).toContainText('予定候補0件');
    mkdirSync(shots, {recursive:true});
    await page.screenshot({path:`${shots}/axis-${withEvents ? 'events' : 'empty'}-after.png`});
    await page.locator('#screenshot-import-close').click();
  }
  expect(api.state.outside).toEqual([]);
});

test("Japanese calendar screenshot OCR stays local and imports only explicitly confirmed personal events", async ({ page }) => {
  test.setTimeout(180_000);
  const api = syntheticApi({ groups:[], personalSyncActive:false });
  await api.attach(page.context());
  const ocrRequests = [];
  page.on("request", (request) => {
    if (request.url().includes("/vendor/tesseract/")) ocrRequests.push(request.url());
  });
  await page.goto("/");
  await expect(page.locator("#app-root")).toBeVisible();
  expect(await page.evaluate(() => performance.getEntriesByType("resource").some((entry) => entry.name.includes("/vendor/tesseract/"))))
    .toBe(false, "OCR runtime must not be fetched during initial application startup");

  await page.setViewportSize({ width:390, height:844 });
  await page.locator("#account-open").click();
  await page.locator("#profile-data-management").evaluate((element) => { element.open = true; });
  await page.evaluate(() => { document.querySelector("#screenshot-import-entry").hidden = true; });
  mkdirSync(shots, { recursive:true });
  await page.screenshot({ path:`${shots}/390-before-import.png`, fullPage:true });
  await page.evaluate(() => { document.querySelector("#screenshot-import-entry").hidden = false; });
  await page.screenshot({ path:`${shots}/390-after-import-entry.png`, fullPage:true });

  await page.locator("#screenshot-import-open").click();
  const dialog = page.locator("#screenshot-import-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("#screenshot-import-file").setInputFiles({
    name:"synthetic-japanese-calendar.png", mimeType:"image/png", buffer:fixture,
  });
  const cards = dialog.locator(".screenshot-import-candidate");
  await expect.poll(async () => {
    const count = await cards.count();
    const error = await dialog.locator("#screenshot-import-status").getAttribute("data-kind");
    return error === "error" ? -1 : count;
  }, { timeout:90_000 }).not.toBe(0);
  const count = await cards.count();
  if (count !== 3) throw new Error(`OCR failed before candidate extraction: ${await dialog.locator("#screenshot-import-status").textContent()}`);
  const expected = [
    ["研究室ミーティング", "2026-11-12", "14:00", "15:30"],
    ["夕食 友人と", "2026-11-12", "18:00", "19:00"],
    ["歯医者", "2026-11-13", "09:30", "10:15"],
  ];
  const actual = [];
  for (let index = 0; index < expected.length; index += 1) {
    const card = cards.nth(index);
    const fields = {
      title:await card.locator('[data-field="title"]').inputValue(),
      date:await card.locator('[data-field="date"]').inputValue(),
      start:await card.locator('[data-field="start"]').inputValue(),
      end:await card.locator('[data-field="end"]').inputValue(),
    };
    actual.push([fields.title, fields.date, fields.start, fields.end]);
    expect(await card.locator('[data-field="selected"]').isChecked()).toBe(false);
    expect(await card.locator(".screenshot-import-badge").textContent()).toContain("要確認");
  }
  const totalRequiredFields = expected.length * 4;
  const matchingFields = actual.reduce((count, event, index) => count + event.reduce((fields, value, field) => fields + (value === expected[index][field] ? 1 : 0), 0), 0);
  // The fixture loses delimiters in two rows in the actual OCR engine. Keep
  // those clocks empty, measure the loss, and require explicit user correction.
  expect(matchingFields, JSON.stringify({ actual, expected })).toBe(8);
  expect(totalRequiredFields).toBe(12);
  expect(actual).toEqual([[expected[0][0], expected[0][1], '', ''], [expected[1][0], expected[1][1], '', ''], expected[2]]);
  await enterVerifiedTimes(cards.first(), expected[0][2], expected[0][3]);
  await cards.nth(1).locator('[data-field="title"]').fill("研究室ミーティング");
  await cards.nth(1).locator('[data-field="start"]').fill("14:00");
  await cards.nth(1).locator('[data-field="end"]').fill("15:30");
  await expect(cards.nth(1).locator(".screenshot-import-duplicate")).toBeVisible();
  expect(await cards.nth(1).locator('[data-field="selected"]').isChecked()).toBe(false);
  await cards.nth(1).locator('[data-field="title"]').fill(expected[1][0]);
  await cards.nth(1).locator('[data-field="start"]').fill(expected[1][2]);
  await cards.nth(1).locator('[data-field="end"]').fill(expected[1][3]);
  await expect(cards.nth(1).locator(".screenshot-import-duplicate")).toBeHidden();
  await page.evaluate(() => document.activeElement?.blur());
  for (const width of [320,390,768,1280]) {
    await page.setViewportSize({ width, height:width < 500 ? 844 : 900 });
    const geometry = await dialog.evaluate((element) => ({
      pageWidth:document.documentElement.scrollWidth,
      viewportWidth:innerWidth,
      dialogWidth:element.clientWidth,
      dialogScrollWidth:element.scrollWidth,
    }));
    expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.dialogScrollWidth).toBeLessThanOrEqual(geometry.dialogWidth);
  }
  await page.setViewportSize({ width:1280, height:900 });
  await cards.first().scrollIntoViewIfNeeded();
  await page.evaluate(() => document.activeElement?.blur());
  await page.screenshot({ path:`${shots}/1280-light-review.png` });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path:`${shots}/1280-dark-review.png` });
  await page.setViewportSize({ width:390, height:844 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await cards.first().scrollIntoViewIfNeeded();
  await page.evaluate(() => document.activeElement?.blur());
  await page.screenshot({ path:`${shots}/390-light-review.png` });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path:`${shots}/390-dark-review.png` });

  await expect(dialog.locator("#screenshot-import-register")).toBeDisabled();
  for (let index = 0; index < expected.length; index += 1) await cards.nth(index).locator('[data-field="selected"]').check();
  await expect(dialog.locator("#screenshot-import-register")).toBeEnabled();
  await page.once("dialog", (browserDialog) => browserDialog.accept());
  await dialog.locator("#screenshot-import-register").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#screenshot-import-result")).toContainText("3件");
  expect(api.state.outside).toEqual([]);
  expect(api.state.requests.some(({ path, method }) => path.startsWith("/api/personal/events/") && method !== "GET")).toBe(false,
    "local-only personal calendar import must not start or use cloud sync");
  expect(ocrRequests.length).toBeGreaterThan(0);
  expect(ocrRequests.every((url) => new URL(url).origin === "http://127.0.0.1:5517")).toBe(true);
  const savedStorage = await page.evaluate(() => Object.values(localStorage).join("\n"));
  expect(savedStorage).not.toContain("sourceText");
  expect(savedStorage).not.toContain("data:image");

  await page.locator("#screenshot-import-open").click();
  await dialog.locator("#screenshot-import-file").setInputFiles({
    name:"synthetic-japanese-calendar-again.png", mimeType:"image/png", buffer:fixture,
  });
  await expect(dialog.locator("#screenshot-import-status")).toContainText("3件の候補を読み取りました", { timeout:90_000 });
  await expect(cards).toHaveCount(3, { timeout:90_000 });
  for (let index = 0; index < expected.length; index += 1) {
    const card = cards.nth(index);
    await enterVerifiedTimes(card, expected[index][2], expected[index][3]);
    await expect(card.locator(".screenshot-import-duplicate")).toBeVisible();
    expect(await card.locator('[data-field="selected"]').isChecked()).toBe(false);
  }
  await expect(dialog.locator("#screenshot-import-register")).toBeDisabled();
  await cards.first().locator('[data-field="selected"]').check();
  await expect(dialog.locator("#screenshot-import-register")).toBeEnabled();
  await page.once("dialog", (browserDialog) => browserDialog.accept());
  await dialog.locator("#screenshot-import-close").click();
  await expect(dialog).toBeHidden();

  await page.locator("#screenshot-import-open").click();
  await dialog.locator("#screenshot-import-file").setInputFiles({
    name:"cancelled-japanese-calendar.png", mimeType:"image/png", buffer:fixture,
  });
  await expect(dialog.locator("#screenshot-import-cancel-ocr")).toBeVisible();
  await dialog.locator("#screenshot-import-cancel-ocr").click();
  await expect(dialog.locator("#screenshot-import-status")).toContainText("OCRをキャンセルしました");
  await expect(cards).toHaveCount(0);
  await expect(dialog.locator("#screenshot-import-register")).toBeDisabled();
  await expect(dialog.locator("#screenshot-import-file")).toHaveValue("");
  await dialog.locator("#screenshot-import-cancel").click();
  await expect(dialog).toBeHidden();

  await page.locator('.nav-button[data-page="my"]').click();
  await expect(page.locator("#agenda-events")).toContainText("研究室ミーティング");
  await expect(page.locator("#agenda-events")).toContainText("夕食 友人と");
  await expect(page.locator("#agenda-events")).not.toContainText("OCR");
});

test("calendar event add dialog hands off to the existing OCR dialog after discard confirmation", async ({ page }) => {
  test.setTimeout(180_000);
  const api = syntheticApi({ groups:[], personalSyncActive:false });
  await api.attach(page.context());
  await page.goto("/");
  await expect(page.locator("#app-root")).toBeVisible();
  await page.setViewportSize({ width:390, height:844 });
  const eventDialog = page.locator("#event-dialog");
  const importDialog = page.locator("#screenshot-import-dialog");
  const importButton = page.locator("#event-screenshot-import-open");
  await page.locator("#open-event-dialog").click();
  await expect(page.locator("#event-screenshot-import-entry")).toBeVisible();
  await expect(page.locator("#event-screenshot-import-divider")).toBeVisible();
  await expect(importButton).toHaveAttribute("aria-controls", "screenshot-import-dialog");
  mkdirSync("test-results/ocr-event-entry", { recursive:true });
  await page.screenshot({ path:"test-results/ocr-event-entry/390-event-dialog-light.png", animations:"disabled" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.screenshot({ path:"test-results/ocr-event-entry/390-event-dialog-dark.png", animations:"disabled" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.setViewportSize({ width:1280, height:900 });
  await page.screenshot({ path:"test-results/ocr-event-entry/1280-event-dialog-light.png", animations:"disabled" });
  await page.setViewportSize({ width:390, height:844 });

  await page.locator("#event-title").fill("Unfinished manual draft");
  await page.once("dialog", (browserDialog) => browserDialog.dismiss());
  await importButton.click();
  await expect(eventDialog).toBeVisible();
  await expect(importDialog).toBeHidden();
  await expect(page.locator("#event-title")).toHaveValue("Unfinished manual draft");

  await page.once("dialog", (browserDialog) => browserDialog.accept());
  await importButton.evaluate((button) => { button.click(); button.click(); });
  await expect(eventDialog).toBeHidden();
  await expect(importDialog).toBeVisible();
  await expect(page.locator("#screenshot-import-file")).toBeFocused();
  await expect(page.locator("dialog[open]")).toHaveCount(1);
  await page.screenshot({ path:"test-results/ocr-event-entry/390-ocr-dialog-light.png", animations:"disabled" });

  await importDialog.locator("#screenshot-import-file").setInputFiles({
    name:"synthetic-japanese-calendar.png", mimeType:"image/png", buffer:fixture,
  });
  const cards = importDialog.locator(".screenshot-import-candidate");
  await expect(cards).toHaveCount(3, { timeout:90_000 });
  await enterVerifiedTimes(cards.first(), '14:00', '15:30');
  await cards.first().locator('[data-field="selected"]').check();
  await page.screenshot({ path:"test-results/ocr-event-entry/390-ocr-review.png", animations:"disabled" });
  await page.once("dialog", (browserDialog) => browserDialog.accept());
  await importDialog.locator("#screenshot-import-register").click();
  await expect(importDialog).toBeHidden();
  await expect(eventDialog).toBeHidden();
  await expect(page.locator("#agenda-events")).toContainText("研究室ミーティング");
  await expect(page.locator("#agenda-events")).not.toContainText("夕食 友人と");
  await expect(page.locator("#agenda-date")).toContainText("12日");
  await expect(page.locator("#event-screenshot-import-result")).toContainText("1件をこの端末の個人予定に追加しました");
  await expect(page.locator("#open-event-dialog")).toBeFocused();
  expect(await page.locator("#agenda-events .agenda-personal").count()).toBe(1);
  expect(api.state.outside).toEqual([]);
});

test("calendar-origin import reports queued events when the existing sync retry is pending", async ({ page }) => {
  test.setTimeout(180_000);
  const api = syntheticApi({ groups:[], personalSyncActive:true, personalCreateFailures:1 });
  await api.attach(page.context());
  await page.goto("/");
  await expect(page.locator("#app-root")).toBeVisible();
  await page.locator("#open-event-dialog").click();
  await page.locator("#event-screenshot-import-open").click();
  const dialog = page.locator("#screenshot-import-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("#screenshot-import-file").setInputFiles({
    name:"synthetic-japanese-calendar.png", mimeType:"image/png", buffer:fixture,
  });
  const cards = dialog.locator(".screenshot-import-candidate");
  await expect(cards).toHaveCount(3, { timeout:90_000 });
  await enterVerifiedTimes(cards.first(), '14:00', '15:30');
  await cards.first().locator('[data-field="selected"]').check();
  await page.once("dialog", (browserDialog) => browserDialog.accept());
  await dialog.locator("#screenshot-import-register").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#event-screenshot-import-result")).toContainText("1件を同期キューに追加しました");
  expect(api.state.personalCreateFailuresRemaining).toBe(0);
  const pending = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((item) => item.endsWith("-personal-sync-v2"));
    return key ? JSON.parse(localStorage.getItem(key)).queue.length : 0;
  });
  expect(pending).toBe(1);
  expect(api.state.outside).toEqual([]);
});

test("confirmed screenshot events use the already-active personal sync and report server confirmation", async ({ page }) => {
  test.setTimeout(120_000);
  const api = syntheticApi({ groups:[], personalSyncActive:true });
  await api.attach(page.context());
  await page.goto("/");
  await expect(page.locator("#app-root")).toBeVisible();
  await page.locator("#account-open").click();
  await page.locator("#profile-data-management").evaluate((element) => { element.open = true; });
  await page.locator("#screenshot-import-open").click();
  const dialog = page.locator("#screenshot-import-dialog");
  await dialog.locator("#screenshot-import-file").setInputFiles({
    name:"synthetic-japanese-calendar.png", mimeType:"image/png", buffer:fixture,
  });
  const cards = dialog.locator(".screenshot-import-candidate");
  await expect.poll(async () => {
    const count = await cards.count();
    const error = await dialog.locator("#screenshot-import-status").getAttribute("data-kind");
    return error === "error" ? -1 : count;
  }, { timeout:90_000 }).not.toBe(0);
  await expect(cards).toHaveCount(3);
  await enterVerifiedTimes(cards.nth(1), '18:00', '19:00');
  await cards.nth(1).locator('[data-field="selected"]').check();
  const requestStart = api.state.requests.length;
  await page.once("dialog", (browserDialog) => browserDialog.accept());
  await dialog.locator("#screenshot-import-register").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#screenshot-import-result")).toContainText("同期先に保存しました");

  const creates = api.state.requests.filter(({ path, method }) => path === "/api/personal/events/create" && method === "POST");
  expect(creates).toHaveLength(1);
  expect(creates[0].body).toMatchObject({ syncProtocol:2, event:{ title:"夕食 友人と", date:"2026-11-12", start:"18:00", end:"19:00" } });
  expect(api.state.requests.slice(requestStart).some(({ path }) => path.startsWith("/api/groups/"))).toBe(false);
  expect(api.state.outside).toEqual([]);
});
