import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCalendarCandidates,
  eventFingerprint,
  isImportEventReady,
  markImportDuplicates,
} from "./screenshot-calendar-ocr.mjs";

test("time axis 09 to 22, empty days, headings and status clocks never become events", () => {
  const ticks = Array.from({ length:14 }, (_, i) => line(`${String(i + 9).padStart(2, '0')}:00`, 80 + i * 40, 96, 10));
  const empty = extractCalendarCandidates({ lines:[line('2026年11月12日', 0), ...ticks] });
  assert.equal(empty.candidates.length, 0);
  assert.equal(empty.ignoredLineCount, 14);
  const mixed = extractCalendarCandidates({ lines:[line('2026年11月12日', 0), ...ticks,
    line('10:00〜12:00 大学の授業', 130, 96, 200),
    line('13:00〜14:00 会議', 250, 96, 200),
    line('15:00 無関係な説明', 350, 96, 10),
  ] });
  assert.deepEqual(mixed.candidates.map(c => c.title), ['大学の授業', '会議']);
});

test("separate title and range need a shared paragraph and aligned adjacent boxes", () => {
  const range = line('10:00〜12:00', 80);
  const title = line('大学の授業', 120);
  const parsed = extractCalendarCandidates({ blocks:[{paragraphs:[{lines:[line('2026年11月12日', 0)]}, {lines:[range, title]}]}] });
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].title, '大学の授業');
  assert.equal(parsed.candidates[0].end, '12:00');
  assert.equal(extractCalendarCandidates({lines:[range, title]}).candidates.length, 0);
  assert.equal(extractCalendarCandidates({blocks:[{paragraphs:[{lines:[range, {...title, bbox:{...title.bbox, x0:700}}]}]}]}).candidates.length, 0);
});

test("OCR lines spanning unrelated columns are excluded rather than attached to a time axis", () => {
  const row = line('09:00 会議', 80);
  row.words = [{text:'09:00', bbox:{x0:10,x1:70}}, {text:'会議', bbox:{x0:300,x1:370}}];
  assert.equal(extractCalendarCandidates({lines:[row]}).candidates.length, 0);
});

function line(text, y0, confidence = 96, x0 = 40) {
  return { text, confidence, bbox:{ x0, y0, x1:x0 + 640, y1:y0 + 36 } };
}

test('weekly columns require their own explicit dates; grid titles never inherit axis clocks', () => {
  const result = extractCalendarCandidates({lines:[
    line('2026年11月12日 10:00-12:00 授業', 80, 96, 200),
    line('2026年11月13日 13:00-14:00 会議', 80, 96, 900),
    line('09:00', 90, 96, 10), line('10:00', 150, 96, 10), line('11:00', 210, 96, 10),
    line('別列の予定名だけ', 150, 96, 900), line('今日', 20),
  ]});
  assert.deepEqual(result.candidates.map(c => [c.title,c.date,c.start,c.end]), [
    ['授業','2026-11-12','10:00','12:00'], ['会議','2026-11-13','13:00','14:00'],
  ]);
  assert.equal(extractCalendarCandidates({lines:[line('18:00', 80),line('会議',120)]}).candidates.length,0);
});

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

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].date, "");
  assert.equal(candidates[0].start, "18:00");
  assert.equal(candidates[0].end, "");
  assert.equal(candidates[0].allDay, false);
  assert.equal(candidates[1].allDay, true);
  assert.equal(candidates[1].start, "");
  assert.equal(candidates[1].end, "");
  assert(candidates[0].needsReview);
  assert.equal(candidates[1].needsReview, false, "explicit all-day date and title are complete, but still require a user checkbox confirmation");
  assert.equal(isImportEventReady(candidates[1]), true);
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

test("does not assign two detached OCR clocks as a time range", () => {
  const { candidates } = extractCalendarCandidates({ lines:[
    line("2026年11月12日", 20),
    line("14:00 15 30 研究室ミーティング", 80),
    line("18:0019:00 夕食", 150),
  ] });
  assert.equal(candidates.length, 2);
  assert(candidates.every(candidate => candidate.start === '' && candidate.end === '' && candidate.needsReview));
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
