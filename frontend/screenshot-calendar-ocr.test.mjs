import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCalendarCandidates,
  eventFingerprint,
  isImportEventReady,
  markImportDuplicates,
} from "./screenshot-calendar-ocr.mjs";

function line(text, y0, confidence = 96, x0 = 40) {
  return { text, confidence, bbox:{ x0, y0, x1:x0 + 640, y1:y0 + 36 } };
}

test("extracts explicit Japanese date headings and time-title rows with positions", () => {
  const { candidates, ignoredLineCount } = extractCalendarCandidates({
    blocks:[{ paragraphs:[{ lines:[
      line("2026年11月12日(木)", 20),
      line("14:00〜15:30 研究室ミーティング", 90),
      line("18:00-19:00 夕食 友人と", 160),
      line("2026/11/13", 260),
      line("09:30〜10:15 歯医者", 320),
    ] }] }],
  });

  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.map(({ title, date, start, end, allDay }) => ({ title, date, start, end, allDay })), [
    { title:"研究室ミーティング", date:"2026-11-12", start:"14:00", end:"15:30", allDay:false },
    { title:"夕食 友人と", date:"2026-11-12", start:"18:00", end:"19:00", allDay:false },
    { title:"歯医者", date:"2026-11-13", start:"09:30", end:"10:15", allDay:false },
  ]);
  assert(candidates.every((candidate) => !candidate.needsReview));
  assert.equal(ignoredLineCount, 0);
});

test("does not invent a year, a title, an end time, or an all-day setting", () => {
  const { candidates } = extractCalendarCandidates({ lines:[
    line("11月12日", 20),
    line("18:00 打合せ", 80),
    line("2026年11月13日", 150),
    line("20:00", 220),
    line("2026年11月14日", 300),
    line("休診 終日", 370),
  ] });

  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].date, "");
  assert.equal(candidates[0].start, "18:00");
  assert.equal(candidates[0].end, "");
  assert.equal(candidates[0].allDay, false);
  assert.equal(candidates[1].start, "20:00");
  assert.equal(candidates[1].end, "");
  assert.equal(candidates[1].title, "");
  assert.equal(candidates[2].allDay, true);
  assert.equal(candidates[2].start, "");
  assert.equal(candidates[2].end, "");
  assert(candidates[0].needsReview);
  assert(candidates[1].needsReview);
  assert.equal(candidates[2].needsReview, false, "explicit all-day date and title are complete, but still require a user checkbox confirmation");
  assert.equal(isImportEventReady(candidates[2]), true);
});

test("reads full-width digits and Japanese meridiem while keeping invalid periods review-only", () => {
  const { candidates } = extractCalendarCandidates({ lines:[
    line("２０２６年１１月１２日", 20),
    line("午後２:００〜午後３:３０ 面談", 80),
    line("午後１３:３０〜午後２:００ 夜間対応", 150),
  ] });

  assert.equal(candidates[0].start, "14:00");
  assert.equal(candidates[0].end, "15:30");
  assert.equal(candidates[0].date, "2026-11-12");
  assert(candidates[1].needsReview);
  assert.equal(candidates[1].end, "14:00");
});

test("recovers two OCR time tokens only as a review-required start/end pair", () => {
  const { candidates } = extractCalendarCandidates({ lines:[
    line("2026年11月12日", 20),
    line("14:00 15 30 研究室ミーティング", 80),
    line("18:0019:00 夕食", 150),
  ] });
  assert.deepEqual(candidates.map(({ title, start, end }) => ({ title, start, end })), [
    { title:"研究室ミーティング", start:"14:00", end:"15:30" },
    { title:"夕食", start:"18:00", end:"19:00" },
  ]);
  assert(candidates.every((candidate) => candidate.needsReview));
  assert(candidates.every((candidate) => candidate.reasons.some((reason) => reason.includes("区切り"))));
});

test("date-heading inheritance requires a nearby aligned line and never assigns a time in a second column or distant row", () => {
  const { candidates } = extractCalendarCandidates({ lines:[
    line("2026年11月12日", 20, 96, 40),
    line("14:00〜15:00 打合せ", 80, 96, 42),
    line("2026年11月13日", 160, 96, 40),
    line("10:00〜11:00 別日会議", 220, 96, 700),
    line("11:00〜12:00 日付見出しから離れた予定", 600, 96, 42),
  ] });

  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].date, "2026-11-12");
  assert.equal(candidates[1].date, "");
  assert(candidates[1].needsReview);
  assert.equal(candidates[2].date, "");
  assert(candidates[2].needsReview);
});

test("registration requires complete date, title and a valid explicit time range", () => {
  assert.equal(isImportEventReady({ date:"2026-11-12", title:"会議", start:"14:00", end:"15:00" }), true);
  assert.equal(isImportEventReady({ date:"2026-11-12", title:"休み", allDay:true }), true);
  assert.equal(isImportEventReady({ date:"2026-11-12", title:"会議", start:"18:00", end:"" }), false);
  assert.equal(isImportEventReady({ date:"2026-11-12", title:"会議", start:"15:00", end:"14:00" }), false);
  assert.equal(isImportEventReady({ date:"", title:"会議", start:"14:00", end:"15:00" }), false);
});

test("duplicate detection compares exact personal-event fields and marks repeated image rows", () => {
  const existing = { date:"2026-11-12", title:"研究室ミーティング", start:"14:00", end:"15:30", allDay:false };
  assert.notEqual(eventFingerprint(existing), "");
  const marked = markImportDuplicates([
    { ...existing, confidence:96 },
    { ...existing, title:"別予定", confidence:96 },
    { ...existing, confidence:96 },
  ], [existing]);
  assert.deepEqual(marked.map((event) => event.duplicate), [true, false, true]);
  const differentEnd = { ...existing, end:"16:00" };
  assert.equal(markImportDuplicates([differentEnd], [existing])[0].duplicate, false);
});
