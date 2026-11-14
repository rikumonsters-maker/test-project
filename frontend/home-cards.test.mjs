import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  HOME_LOOP_DURATION_SECONDS,
  HOME_LOOP_DURATION_MS,
  HOME_CARD_SPECS,
  normalizeLoopTime,
  computeHomeCardFrame,
  computeIconParts,
  computeGlossState,
} from "./home-cards.mjs";

test("home loop duration is strictly 7.0 seconds and four pastel cards are defined", () => {
  assert.equal(HOME_LOOP_DURATION_SECONDS, 7.0);
  assert.equal(HOME_LOOP_DURATION_MS, 7000);
  assert.deepEqual(
    HOME_CARD_SPECS.map((c) => [c.id, c.title, c.theme]),
    [
      ["personal", "個人予定", "mint"],
      ["shared", "共有予定", "blue"],
      ["shift", "シフト", "orange"],
      ["salary", "給与", "purple"],
    ]
  );
});

test("0.0s to 1.0s stacked phase keeps 20px border-radius and layered thickness offsets", () => {
  for (const t of [0.0, 0.4, 0.99]) {
    const frame = computeHomeCardFrame(t, { dx: 90, dy: 95 });
    assert.equal(frame.phase, "stacked");
    assert.equal(frame.isStacked, true);
    for (const card of frame.cards) {
      assert.equal(card.borderRadius, 20);
      assert.ok(Math.abs(card.x) > 50, `card ${card.id} should be offset to center stack at ${t}s`);
      assert.ok(Math.abs(card.y) > 50, `card ${card.id} should be offset to center stack at ${t}s`);
    }
  }
});

test("1.0s to 2.5s spreading phase follows a curved trajectory and interpolates border-radius from 20px to 60px", () => {
  const start = computeHomeCardFrame(1.0, { dx: 90, dy: 95 });
  const mid = computeHomeCardFrame(1.5, { dx: 90, dy: 95 });
  const end = computeHomeCardFrame(2.5, { dx: 90, dy: 95 });

  assert.equal(mid.phase, "spreading");
  for (let i = 0; i < 4; i += 1) {
    const s = start.cards[i];
    const m = mid.cards[i];
    const e = end.cards[i];
    assert.ok(m.borderRadius > 20 && m.borderRadius < 60, `mid radius should be between 20 and 60, got ${m.borderRadius}`);
    assert.equal(e.borderRadius, 60);
    assert.equal(e.x, 0);
    assert.equal(e.y, 0);
    // Verify curved trajectory: cross product of (m - s) and (e - s) is non-zero
    const cross = (m.x - s.x) * (e.y - s.y) - (m.y - s.y) * (e.x - s.x);
    assert.ok(Math.abs(cross) > 50, `card ${s.id} should follow a curved non-linear trajectory (cross=${cross})`);
  }
});

test("2.5s to 4.0s icon assembly builds multi-part SVG icons sequentially", () => {
  const before = computeIconParts(2.4, 0);
  const mid = computeIconParts(3.0, 0);
  const after = computeIconParts(4.0, 0);

  assert.ok(before[0] < 0.5 && before[1] < 0.2 && before[2] === 0);
  // At 3.0s, part 1 is ahead of part 2, which is ahead of part 3
  assert.ok(mid[0] > mid[1] && mid[1] > mid[2], `expected sequential assembly at 3.0s: ${JSON.stringify(mid)}`);
  assert.deepEqual(after, [1, 1, 1]);
});

test("4.0s to 5.5s glass gloss sweeps across the four cards at staggered timings and fades smoothly", () => {
  const peakTimes = HOME_CARD_SPECS.map((spec) => (spec.glossWindow[0] + spec.glossWindow[1]) / 2);
  assert.ok(peakTimes[0] < peakTimes[1] && peakTimes[1] < peakTimes[2] && peakTimes[2] < peakTimes[3]);

  for (let i = 0; i < 4; i += 1) {
    const atPeak = computeGlossState(peakTimes[i], i);
    assert.equal(atPeak.active, true);
    assert.ok(atPeak.opacity > 0.6 && atPeak.opacity <= 0.75);
    assert.equal(computeGlossState(0.0, i).opacity, 0);
    assert.equal(computeGlossState(5.5, i).opacity, 0);
    assert.equal(computeGlossState(7.0, i).opacity, 0);
  }
});

test("5.5s to 7.0s convergence returns smoothly to exact 0.0s state without any jump at 7.0s -> 0.0s", () => {
  const atZero = computeHomeCardFrame(0.0, { dx: 90, dy: 95 });
  const atSix = computeHomeCardFrame(6.0, { dx: 90, dy: 95 });
  const atAlmostSeven = computeHomeCardFrame(6.999, { dx: 90, dy: 95 });
  const atSeven = computeHomeCardFrame(7.0, { dx: 90, dy: 95 });

  assert.equal(atSix.phase, "converging");
  assert.ok(atSix.cards[0].borderRadius > 20 && atSix.cards[0].borderRadius < 60);
  assert.deepEqual(atSeven.cards, atZero.cards);

  for (let i = 0; i < 4; i += 1) {
    assert.ok(Math.abs(atAlmostSeven.cards[i].x - atZero.cards[i].x) < 0.2);
    assert.ok(Math.abs(atAlmostSeven.cards[i].y - atZero.cards[i].y) < 0.2);
    assert.ok(Math.abs(atAlmostSeven.cards[i].borderRadius - atZero.cards[i].borderRadius) < 0.2);
    assert.equal(atAlmostSeven.cards[i].gloss.opacity, 0);
  }
});

test("index.html includes the four home cards, completed simple salary elements, header order (notification, profile, settings), and dedicated settings page", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  for (const id of [
    "home-four-card-section",
    "home-card-stage",
    "home-card-personal",
    "home-card-shared",
    "home-card-shift",
    "home-card-salary",
    "home-stack-expand",
    "shift-focus-tabs",
    "shift-mode-tab-shift",
    "shift-mode-tab-salary",
    "shift-day-summary",
    "salary-summary-card",
    "salary-shift-list-card",
    "salary-shift-list",
    "salary-shift-empty",
    "salary-hourly-card",
    "salary-hourly-value",
    "salary-shift-count",
    "page-budget",
    "page-shift",
    "page-profile",
    "page-settings",
    "settings-open",
    "settings-sync-card",
    "settings-backup-card",
    "settings-display-card",
    "settings-sync-state",
    "back-to-home-from-calendar",
    "back-to-home-from-group",
    "back-to-home-from-shift",
    "back-to-home-from-budget",
    "back-to-home-from-profile",
    "back-to-home-from-settings",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `expected #${id} in index.html`);
  }
  assert.doesNotMatch(html, /id="home-expand-toggle"/, "home-expand-toggle should be removed for cleaner UI");
  assert.doesNotMatch(html, /id="header-budget-open"/, "header-budget-open should be removed from common header");
  assert.doesNotMatch(html, /id="header-home-open"/, "header-home-open should be removed to prevent duplicate home buttons");
  assert.doesNotMatch(html, /id="salary-management-card"/, "salary-management-card (準備中) should be removed");
  assert.doesNotMatch(html, /id="salary-prep-badge"/, "salary-prep-badge (準備中) should be removed");
  assert.doesNotMatch(html, /id="profile-data-management"/, "profile-data-management should be moved to #page-settings");

  // Verify header order: notification -> profile -> settings (gear)
  const iNotif = html.indexOf('id="notification-open"');
  const iAccount = html.indexOf('id="account-open"');
  const iSettings = html.indexOf('id="settings-open"');
  assert.ok(iNotif > 0 && iNotif < iAccount && iAccount < iSettings, "header buttons must be ordered: notification, profile, settings");

  // Verify sync/backup/theme controls are inside #page-settings and not duplicated in #page-calendar or #page-profile
  const calendarSection = html.slice(html.indexOf('id="page-calendar"'), html.indexOf('id="page-group"'));
  const profileSection = html.slice(html.indexOf('id="page-profile"'), html.indexOf('id="page-settings"'));
  const settingsSection = html.slice(html.indexOf('id="page-settings"'));
  assert.doesNotMatch(calendarSection, /id="personal-sync-consent"|id="personal-sync-deferred"/, "sync consent must not be in #page-calendar");
  assert.doesNotMatch(profileSection, /id="personal-sync-consent"|id="personal-sync-deferred"|id="personal-backup-export"|theme-choices/, "sync, backup, and theme UI must not be duplicated in #page-profile");
  assert.match(settingsSection, /id="personal-sync-consent"/, "personal-sync-consent must be in #page-settings");
  assert.match(settingsSection, /id="personal-sync-deferred"/, "personal-sync-deferred must be in #page-settings");
  assert.match(settingsSection, /id="personal-backup-export"/, "personal-backup-export must be in #page-settings");
  assert.match(settingsSection, /theme-choices/, "theme-choices must be in #page-settings");

  // Verify daily shift summary (#shift-day-summary) is inside #shift-entry-card and not inside #salary-summary-card
  const salarySummaryCard = html.slice(html.indexOf('id="salary-summary-card"'), html.indexOf('id="salary-shift-list-card"'));
  const shiftEntryCard = html.slice(html.indexOf('id="shift-entry-card"'), html.indexOf('id="salary-hourly-card"'));
  assert.doesNotMatch(salarySummaryCard, /id="shift-day-wage"/, "shift-day-wage should not be inside #salary-summary-card");
  assert.match(shiftEntryCard, /id="shift-day-wage"/, "shift-day-wage must be inside #shift-entry-card");
});
