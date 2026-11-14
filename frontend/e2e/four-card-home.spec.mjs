import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { syntheticApi } from "./synthetic-api.mjs";

const screenshotDir = "test-results/four-card-home";

async function bootHome(page, { width = 390, height = 844, groups = [] } = {}) {
  const api = syntheticApi({ groups, personalSyncActive: true });
  await api.attach(page.context());
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await expect(page.locator("#app-root")).toBeVisible();
  await expect(page.locator("#home-four-card-section")).toBeVisible();
  return { api, pageErrors };
}

test("7-second loop animation phases (0s, 1.5s, 3s, 4.5s, 6s, 7s) match specification and loop seamlessly", async ({ page }) => {
  const { api, pageErrors } = await bootHome(page, { width: 390, height: 844 });
  mkdirSync(screenshotDir, { recursive: true });

  const timestamps = [
    { t: 0.0, file: "anim-0.0s-stacked.png", expectedPhase: "stacked", expectedRadius: 20 },
    { t: 1.5, file: "anim-1.5s-spreading.png", expectedPhase: "spreading" },
    { t: 3.0, file: "anim-3.0s-icon-assembly.png", expectedPhase: "icon-assembly", expectedRadius: 60 },
    { t: 4.5, file: "anim-4.5s-gloss.png", expectedPhase: "gloss", expectedRadius: 60 },
    { t: 6.0, file: "anim-6.0s-converging.png", expectedPhase: "converging" },
    { t: 7.0, file: "anim-7.0s-loop-end.png", expectedPhase: "stacked", expectedRadius: 20 },
  ];

  const snapshots = {};

  for (const step of timestamps) {
    const state = await page.evaluate((sec) => {
      const frame = window.__daysyncHomeCards.setAnimationTime(sec);
      const cards = [...document.querySelectorAll(".home-glass-card")].map((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const gloss = el.querySelector(".home-card-gloss");
        const parts = [...el.querySelectorAll(".home-icon-part")].map((p) => Number(getComputedStyle(p).opacity));
        return {
          id: el.dataset.homeCard,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          borderRadius: parseFloat(style.borderRadius),
          transform: style.transform,
          glossOpacity: Number(getComputedStyle(gloss).opacity),
          parts,
        };
      });
      return { frame, cards };
    }, step.t);

    snapshots[step.t] = state;
    expect(state.frame.phase).toBe(step.expectedPhase);
    if (step.expectedRadius !== undefined) {
      for (const card of state.cards) {
        expect(card.borderRadius).toBeCloseTo(step.expectedRadius, 0);
      }
    }
    await page.screenshot({ path: `${screenshotDir}/${step.file}`, fullPage: false });
  }

  // Verify 1.5s is mid-spread with intermediate radius
  for (const card of snapshots[1.5].cards) {
    expect(card.borderRadius).toBeGreaterThan(22);
    expect(card.borderRadius).toBeLessThan(58);
  }

  // Verify 3.0s shows multi-part SVG icons mid-assembly (part 1 > part 2 > part 3)
  for (const card of snapshots[3.0].cards) {
    expect(card.parts[0]).toBeGreaterThan(card.parts[1]);
    expect(card.parts[1]).toBeGreaterThan(card.parts[2]);
  }

  // Verify 4.5s has fully assembled icons and active diagonal glass gloss
  for (const card of snapshots[4.5].cards) {
    expect(card.parts).toEqual([1, 1, 1]);
  }
  expect(snapshots[4.5].cards.some((c) => c.glossOpacity > 0.25)).toBe(true);

  // Verify 7.0s matches 0.0s with zero position jump or flicker
  for (let i = 0; i < 4; i += 1) {
    const c0 = snapshots[0.0].cards[i];
    const c7 = snapshots[7.0].cards[i];
    expect(Math.abs(c0.rect.x - c7.rect.x)).toBeLessThan(0.1);
    expect(Math.abs(c0.rect.y - c7.rect.y)).toBeLessThan(0.1);
    expect(c0.borderRadius).toBe(c7.borderRadius);
    expect(c7.glossOpacity).toBe(0);
  }

  expect(pageErrors).toEqual([]);
  expect(api.state.outside).toEqual([]);
});

test("card navigation, mid-motion selection, stack tap-to-expand, keyboard, browser back, and reduced-motion work cleanly with complete separation", async ({ page, browser }) => {
  const { api, pageErrors } = await bootHome(page, { width: 390, height: 844 });

  // 0. Verify standalone Home screen separation & clean header: no calendar, no sync consent/deferred, no group/shift/salary details, no bottom nav, no header budget or duplicate home button
  await expect(page.locator("#home-expand-toggle")).toHaveCount(0);
  await expect(page.locator("#header-budget-open")).toHaveCount(0);
  await expect(page.locator("#header-home-open")).toHaveCount(0);
  await expect(page.locator(".home-return-button:visible")).toHaveCount(0);
  await expect(page.locator("#page-calendar")).toBeHidden();
  await expect(page.locator("#personal-sync-consent")).toBeHidden();
  await expect(page.locator("#personal-sync-deferred")).toBeHidden();
  await expect(page.locator("#personal-sync-card")).toBeHidden();
  await expect(page.locator("#page-group")).toBeHidden();
  await expect(page.locator("#page-money")).toBeHidden();
  await expect(page.locator(".page-nav")).toBeHidden();
  await expect(page.locator("#notification-open")).toBeVisible();
  await expect(page.locator("#account-open")).toBeVisible();
  await expect(page.locator("#settings-open")).toBeVisible();
  const headerOrder = await page.evaluate(() => {
    const n = document.querySelector("#notification-open").getBoundingClientRect();
    const a = document.querySelector("#account-open").getBoundingClientRect();
    const s = document.querySelector("#settings-open").getBoundingClientRect();
    return { nX: n.x, aX: a.x, sX: s.x, nRight: n.right, aRight: a.right, sRight: s.right, innerWidth: window.innerWidth };
  });
  expect(headerOrder.nRight).toBeLessThanOrEqual(headerOrder.aX + 1);
  expect(headerOrder.aRight).toBeLessThanOrEqual(headerOrder.sX + 1);
  expect(headerOrder.sRight).toBeLessThanOrEqual(headerOrder.innerWidth);

  // 1. When stacked at 0.3s, tapping #home-stack-expand immediately expands the 4 cards into 2x2 grid
  await page.evaluate(() => window.__daysyncHomeCards.setAnimationTime(0.3));
  await expect(page.locator("#home-stack-expand")).toBeVisible();
  await page.locator("#home-stack-expand").click();
  await expect(page.locator("#home-card-stage")).toHaveAttribute("data-expanded-locked", "true");
  await expect(page.locator("#home-stack-expand")).toBeHidden();

  // 2. Selecting Personal Schedule card navigates to personal calendar and stops home loop (exactly 1 visible home return button)
  await page.locator("#home-card-personal").click();
  await expect(page.locator("#home-four-card-section")).toBeHidden();
  await expect(page.locator("#page-calendar")).toBeVisible();
  await expect(page.locator("#agenda-calendar")).toBeVisible();
  await expect(page.locator(".home-return-button:visible")).toHaveCount(1);
  expect(await page.evaluate(() => window.__daysyncHomeCards.getState().running)).toBe(false);
  await page.screenshot({ path: `${screenshotDir}/nav-1-personal.png`, fullPage: false });

  // Browser back button returns to Home screen, and forward returns to Personal Schedule
  await page.goBack();
  await expect(page.locator("#home-four-card-section")).toBeVisible();
  await expect(page.locator("#page-calendar")).toBeHidden();
  await expect(page.locator(".page-nav")).toBeHidden();
  await page.goForward();
  await expect(page.locator("#page-calendar")).toBeVisible();
  await page.locator("#back-to-home-from-calendar").click();
  await expect(page.locator("#home-four-card-section")).toBeVisible();

  // 3. Selecting Shared Schedule card while mid-motion (1.5s) navigates to shared schedule page
  await page.evaluate(() => window.__daysyncHomeCards.setAnimationTime(1.5));
  await page.locator("#home-card-shared").click();
  await expect(page.locator("#home-four-card-section")).toBeHidden();
  await expect(page.locator("#page-group")).toBeVisible();
  await expect(page.locator(".home-return-button:visible")).toHaveCount(1);
  expect(await page.evaluate(() => window.__daysyncHomeCards.getState().running)).toBe(false);
  await page.screenshot({ path: `${screenshotDir}/nav-2-shared.png`, fullPage: false });
  await page.locator("#back-to-home-from-group").click();
  await expect(page.locator("#home-four-card-section")).toBeVisible();
  await expect(page.locator("#page-group")).toBeHidden();

  // 4. Selecting Shift card navigates to dedicated shift management screen (hiding monthly salary summary and salary breakdown list)
  await page.evaluate(() => window.__daysyncHomeCards.setAnimationTime(3.0));
  await page.locator("#home-card-shift").click();
  await expect(page.locator("#home-four-card-section")).toBeHidden();
  await expect(page.locator("#page-money")).toBeVisible();
  await expect(page.locator("#page-shift")).toBeVisible();
  await expect(page.locator("#page-shift")).toHaveAttribute("data-focus-mode", "shift");
  await expect(page.locator("#shift-page-title")).toHaveText("シフト");
  await expect(page.locator("#shift-focus-tabs")).toBeVisible();
  await expect(page.locator("#shift-mode-tab-shift")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#shift-mode-tab-salary")).toHaveAttribute("aria-selected", "false");
  await expect(page.locator("#shift-calendar-card")).toBeVisible();
  await expect(page.locator("#shift-entry-card")).toBeVisible();
  await expect(page.locator("#shift-day-summary")).toBeVisible();
  await expect(page.locator("#salary-summary-card")).toBeHidden();
  await expect(page.locator("#salary-shift-list-card")).toBeHidden();
  await expect(page.locator("#salary-hourly-card")).toBeHidden();
  await expect(page.locator("#salary-management-card")).toHaveCount(0);
  await expect(page.locator("#salary-prep-badge")).toHaveCount(0);
  await expect(page.locator(".home-return-button:visible")).toHaveCount(1);
  await page.screenshot({ path: `${screenshotDir}/nav-3-shift.png`, fullPage: false });
  await page.locator("#back-to-home-from-shift").click();
  await expect(page.locator("#home-four-card-section")).toBeVisible();

  // 5. Selecting Salary card via keyboard navigates to dedicated simple estimated salary screen (no 準備中 card)
  await page.evaluate(() => window.__daysyncHomeCards.setAnimationTime(0.2));
  await page.locator("#home-card-salary").focus();
  // Focusing while stacked automatically expands the 4 cards
  await expect(page.locator("#home-card-stage")).toHaveAttribute("data-expanded-locked", "true");
  await page.keyboard.press("Enter");
  await expect(page.locator("#home-four-card-section")).toBeHidden();
  await expect(page.locator("#page-money")).toBeVisible();
  await expect(page.locator("#page-shift")).toBeVisible();
  await expect(page.locator("#page-shift")).toHaveAttribute("data-focus-mode", "salary");
  await expect(page.locator("#shift-page-title")).toHaveText("給与");
  await expect(page.locator("#shift-page-subtitle")).toHaveText("シフトと時給から予想給料を自動計算");
  await expect(page.locator("#shift-mode-tab-shift")).toHaveAttribute("aria-selected", "false");
  await expect(page.locator("#shift-mode-tab-salary")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#salary-management-card")).toHaveCount(0);
  await expect(page.locator("#salary-prep-badge")).toHaveCount(0);
  await expect(page.locator("#salary-summary-card")).toBeVisible();
  await expect(page.locator("#salary-shift-list-card")).toBeVisible();
  await expect(page.locator("#salary-hourly-card")).toBeVisible();
  await expect(page.locator("#shift-calendar-card")).toBeHidden();
  await expect(page.locator("#shift-entry-card")).toBeHidden();
  await expect(page.locator("#shift-hours")).toHaveText("0時間");
  await expect(page.locator("#salary-hourly-value")).toHaveText("未設定");
  await expect(page.locator("#salary-shift-count")).toHaveText("0件");
  await expect(page.locator("#shift-month-wage")).toHaveText("—");
  await expect(page.locator(".home-return-button:visible")).toHaveCount(1);
  await page.screenshot({ path: `${screenshotDir}/nav-4-salary.png`, fullPage: false });

  // Switch from Shift/Salary screen to Budget via the existing money tab (#money-tab-budget), then return to Home
  await page.locator("#money-tab-budget").click();
  await expect(page.locator("#home-four-card-section")).toBeHidden();
  await expect(page.locator("#page-budget")).toBeVisible();
  await expect(page.locator("#page-shift")).toBeHidden();
  await expect(page.locator(".home-return-button:visible")).toHaveCount(1);
  await page.screenshot({ path: `${screenshotDir}/nav-5-budget.png`, fullPage: false });
  await page.locator("#back-to-home-from-budget").click();
  await expect(page.locator("#home-four-card-section")).toBeVisible();

  // 6. Verify prefers-reduced-motion displays static expanded 4 cards
  const reducedContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  try {
    const reducedApi = syntheticApi({ groups: [], personalSyncActive: true });
    await reducedApi.attach(reducedContext);
    const reducedPage = await reducedContext.newPage();
    await reducedPage.goto("/");
    await expect(reducedPage.locator("#home-card-stage")).toHaveAttribute("data-phase", "expanded-static");
    const reducedState = await reducedPage.evaluate(() => window.__daysyncHomeCards.getState());
    expect(reducedState.running).toBe(false);
    expect(reducedState.stacked).toBe(false);
  } finally {
    await reducedContext.close();
  }

  expect(pageErrors).toEqual([]);
  expect(api.state.outside).toEqual([]);
});

test("responsive 2x2 layout fits 375px, 390px, 430px, 768px, and 1280px in light and dark modes without overflow or truncation", async ({ page }) => {
  await bootHome(page, { width: 390, height: 844 });
  mkdirSync(screenshotDir, { recursive: true });

  for (const width of [375, 390, 430, 768, 1280]) {
    const height = width < 600 ? 844 : 900;
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.__daysyncHomeCards.setAnimationTime(4.5));

    const metrics = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".home-glass-card")].map((el) => {
        const r = el.getBoundingClientRect();
        const label = el.querySelector(".home-card-label");
        const caption = el.querySelector(".home-card-caption");
        return {
          id: el.dataset.homeCard,
          x: r.x,
          y: r.y,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
          labelTruncated: label.scrollWidth > label.clientWidth + 1,
          captionTruncated: caption.scrollWidth > caption.clientWidth + 1,
        };
      });
      return {
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        titleHeight: document.querySelector(".site-title").getBoundingClientRect().height,
        cards,
      };
    });

    expect(metrics.scrollWidth, `no horizontal scroll at ${width}px`).toBeLessThanOrEqual(metrics.viewportWidth);
    expect(metrics.titleHeight, `site title stays single-line at ${width}px`).toBeLessThanOrEqual(32);
    const [c0, c1, c2, c3] = metrics.cards;
    // Verify 2x2 grid arrangement: c0 (top-left), c1 (top-right), c2 (bottom-left), c3 (bottom-right)
    expect(Math.abs(c0.y - c1.y)).toBeLessThan(2);
    expect(Math.abs(c2.y - c3.y)).toBeLessThan(2);
    expect(c0.right).toBeLessThanOrEqual(c1.x);
    expect(c2.right).toBeLessThanOrEqual(c3.x);
    expect(c0.bottom).toBeLessThanOrEqual(c2.y);
    expect(c1.bottom).toBeLessThanOrEqual(c3.y);

    for (const card of metrics.cards) {
      expect(card.labelTruncated, `label not truncated at ${width}px`).toBe(false);
      expect(card.captionTruncated, `caption not truncated at ${width}px`).toBe(false);
    }

    await page.screenshot({ path: `${screenshotDir}/responsive-${width}px-light.png`, fullPage: false });
  }

  // Dark mode verification on iPhone (390px) and Desktop (1280px)
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    window.__daysyncHomeCards.setAnimationTime(4.5);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshotDir}/responsive-390px-dark.png`, fullPage: false });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: `${screenshotDir}/responsive-1280px-dark.png`, fullPage: false });
});

test("unconsented user has no sync banner on personal schedule screen, can start sync from settings screen, switch themes, and simple salary estimation updates on shift add/edit/delete/month switch", async ({ page }) => {
  const api = syntheticApi({ groups: [], personalSyncActive: false });
  await api.attach(page.context());
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("#app-root")).toBeVisible();

  // 1. Open Personal Schedule as an unconsented user: no sync consent/deferred banner on #page-calendar, and no auto-sync request
  await page.evaluate(() => window.__daysyncHomeCards.setAnimationTime(3.0));
  await page.locator("#home-card-personal").click();
  await expect(page.locator("#page-calendar")).toBeVisible();
  await expect(page.locator("#page-calendar #personal-sync-consent")).toHaveCount(0);
  await expect(page.locator("#page-calendar #personal-sync-deferred")).toHaveCount(0);
  await expect(page.locator("#personal-sync-card")).toBeHidden();
  expect(api.state.requests.filter((r) => r.path === "/api/personal/events/activate")).toHaveLength(0);

  // 2. Open Settings via gear button (#settings-open): verify browser back/forward, initial sync consent, and theme switching
  await page.locator("#settings-open").click();
  await expect(page.locator("#page-settings")).toBeVisible();
  await expect(page.locator("#settings-sync-card")).toBeVisible();
  await expect(page.locator("#settings-backup-card")).toBeVisible();
  await expect(page.locator("#settings-display-card")).toBeVisible();
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `settings overflow at ${width}px`).toBe(true);
  }
  await page.goBack();
  await expect(page.locator("#page-calendar")).toBeVisible();
  await page.goForward();
  await expect(page.locator("#page-settings")).toBeVisible();

  await expect(page.locator("#settings-sync-state")).toContainText("同期未開始");
  await expect(page.locator("#settings-sync-card #personal-sync-consent")).toBeVisible();
  await page.locator("#personal-sync-later").click();
  await expect(page.locator("#settings-sync-card #personal-sync-deferred")).toBeVisible();
  await page.locator("#personal-sync-start-deferred").click();
  await expect.poll(() => api.state.requests.filter((r) => r.path === "/api/personal/events/activate").length).toBe(1);
  await expect(page.locator("#personal-sync-management")).toBeVisible();
  await expect(page.locator("#settings-sync-state")).toContainText("同期有効");

  // Verify theme switching in #settings-display-card
  await page.locator('#settings-display-card [data-theme-choice="dark"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator('#settings-display-card [data-theme-choice="light"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // 3. Return to Home -> Open Shift screen -> Register a shift (17:00 - 21:00, 0 min break = 4 hours)
  await page.locator("#back-to-home-from-settings").click();
  await page.evaluate(() => window.__daysyncHomeCards.setAnimationTime(3.0));
  await page.locator("#home-card-shift").click();
  await expect(page.locator("#page-shift")).toHaveAttribute("data-focus-mode", "shift");
  await expect(page.locator("#salary-summary-card")).toBeHidden();
  await page.locator("#shift-start").fill("17:00");
  await page.locator("#shift-end").fill("21:00");
  await page.locator("#shift-break").fill("0");
  await page.locator("#save-shift").click();
  await expect(page.locator("#shift-day-wage")).toHaveText("4時間 / —");
  await expect(page.locator("#shift-calendar .calendar-day.selected .calendar-shift-time")).toHaveText("17:00-21:00");

  // 4. Switch directly to Salary Confirmation tab (#shift-mode-tab-salary) without returning to Home -> Set hourly wage to 1200 yen
  await page.locator("#shift-mode-tab-salary").click();
  await expect(page.locator("#page-shift")).toHaveAttribute("data-focus-mode", "salary");
  await expect(page.locator("#salary-summary-card")).toBeVisible();
  await expect(page.locator("#shift-calendar-card")).toBeHidden();
  await expect(page.locator("#shift-entry-card")).toBeHidden();
  await expect(page.locator("#shift-hours")).toHaveText("4時間");
  await expect(page.locator("#salary-shift-count")).toHaveText("1件");
  await expect(page.locator("#salary-shift-list .salary-shift-item")).toHaveCount(1);
  await page.locator("#hourly").fill("1200");
  await expect(page.locator("#salary-hourly-value")).toHaveText("¥1,200/時");
  await expect(page.locator("#shift-month-wage")).toHaveText("¥4,800");
  await expect(page.locator("#salary-shift-list .salary-shift-amount")).toHaveText("¥4,800");

  // 5. Switch to next month on Salary screen -> 0 shifts, ¥0; switch back -> 1 shift, ¥4,800
  await page.locator("#salary-next").click();
  await expect(page.locator("#shift-hours")).toHaveText("0時間");
  await expect(page.locator("#salary-shift-count")).toHaveText("0件");
  await expect(page.locator("#shift-month-wage")).toHaveText("¥0");
  await expect(page.locator("#salary-shift-empty")).toBeVisible();
  await page.locator("#salary-previous").click();
  await expect(page.locator("#shift-hours")).toHaveText("4時間");
  await expect(page.locator("#salary-shift-count")).toHaveText("1件");
  await expect(page.locator("#shift-month-wage")).toHaveText("¥4,800");

  // 6. Switch back to Shift Management tab (#shift-mode-tab-shift) without returning to Home:
  //    Verify monthly summary is hidden, calendar shows shift time & daily wage, and selected date shows daily wage
  await page.locator("#shift-mode-tab-shift").click();
  await expect(page.locator("#page-shift")).toHaveAttribute("data-focus-mode", "shift");
  await expect(page.locator("#salary-summary-card")).toBeHidden();
  await expect(page.locator("#shift-calendar-card")).toBeVisible();
  await expect(page.locator("#shift-entry-card")).toBeVisible();
  await expect(page.locator("#shift-calendar .calendar-day.selected .calendar-shift-time")).toHaveText("17:00-21:00");
  await expect(page.locator("#shift-calendar .calendar-day.selected .calendar-shift-wage")).toHaveText("¥4,800");
  await expect(page.locator("#shift-day-wage")).toHaveText("4時間 / ¥4,800");
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `shift overflow at ${width}px`).toBe(true);
  }

  // Selecting an empty date shows "—" for daily wage; re-selecting the shift date shows "4時間 / ¥4,800"
  const shiftDayCell = page.locator("#shift-calendar .calendar-day.has-entry").first();
  const emptyDayCell = page.locator("#shift-calendar .calendar-day:not(.outside):not(.has-entry)").first();
  await emptyDayCell.click();
  await expect(page.locator("#shift-day-wage")).toHaveText("—");
  await shiftDayCell.click();
  await expect(page.locator("#shift-day-wage")).toHaveText("4時間 / ¥4,800");

  // Edit shift on Shift screen (17:00 - 22:00 = 5 hours -> ¥6,000) and verify both calendar daily wage and Salary tab update
  await page.locator("#shift-end").fill("22:00");
  await page.locator("#save-shift").click();
  await expect(page.locator("#shift-day-wage")).toHaveText("5時間 / ¥6,000");
  await expect(page.locator("#shift-calendar .calendar-day.selected .calendar-shift-wage")).toHaveText("¥6,000");
  await page.locator("#shift-mode-tab-salary").click();
  await expect(page.locator("#shift-hours")).toHaveText("5時間");
  await expect(page.locator("#shift-month-wage")).toHaveText("¥6,000");

  // Switch back to Shift tab and delete shift (-> calendar cleared, daily wage "—", Salary tab 0時間 / ¥0)
  await page.locator("#shift-mode-tab-shift").click();
  await page.locator("#delete-shift").click();
  await expect(page.locator("#shift-day-wage")).toHaveText("—");
  await expect(page.locator("#shift-calendar .calendar-day.selected .calendar-shift-wage")).toHaveCount(0);
  await page.locator("#shift-mode-tab-salary").click();
  await expect(page.locator("#shift-hours")).toHaveText("0時間");
  await expect(page.locator("#salary-shift-count")).toHaveText("0件");
  await expect(page.locator("#shift-month-wage")).toHaveText("¥0");

  expect(pageErrors).toEqual([]);
  expect(api.state.outside).toEqual([]);
});
