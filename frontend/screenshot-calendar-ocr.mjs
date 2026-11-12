const OCR_CONFIDENCE_REVIEW_THRESHOLD = 80;
const FULL_DATE_PATTERNS = [
  /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/,
  /(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})/,
];
const YEARLESS_DATE_PATTERNS = [
  /(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
  /(\d{1,2})\s*[./-]\s*(\d{1,2})/,
];
const CLOCK = "(?:[01]?\\d|2[0-3]):[0-5]\\d";
const MERIDIEM = "(?:午前|午後|AM|PM)";
const RANGE_PATTERN = new RegExp(`(?:(${MERIDIEM})\\s*)?(${CLOCK})\\s*(?:〜|～|~|−|–|—|-|から|to)\\s*(?:(${MERIDIEM})\\s*)?(${CLOCK})`, "i");
const CLOCK_PAIR_PATTERN = new RegExp(`(?:(${MERIDIEM})\\s*)?(${CLOCK})\\s*(?:(${MERIDIEM})\\s*)?(${CLOCK})`, "i");
const SPACED_END_PATTERN = new RegExp(`(?:(${MERIDIEM})\\s*)?(${CLOCK})\\s*(?:〜|～|~|−|–|—|-|から|to|へ)?\\s*(?:(${MERIDIEM})\\s*)?([01]?\\d|2[0-3])\\s+([0-5]\\d)`, "i");
const SINGLE_TIME_PATTERN = new RegExp(`(?:(${MERIDIEM})\\s*)?(${CLOCK})`, "i");

function normalizeLine(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/(\d{1,2})\s*時(?:\s*(\d{1,2})\s*分?)?/g, (_, hour, minute) => `${hour}:${String(minute || "00").padStart(2, "0")}`)
    .replace(/[\t\u00A0]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function validDateParts(year, month, day) {
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value ? value : "";
}

function findDate(text) {
  for (const pattern of FULL_DATE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return { value:validDateParts(match[1], match[2], match[3]), yearKnown:true, text:match[0] };
  }
  for (const pattern of YEARLESS_DATE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      // A range such as 18:00-19:00 contains the substring "00-19".
      // Do not mistake clock minutes for a yearless date.
      const before = text[match.index - 1] || "";
      const after = text[match.index + match[0].length] || "";
      if (before === ":" || after === ":") continue;
      return { value:"", yearKnown:false, text:match[0] };
    }
  }
  return null;
}

function normalizeClock(clock, meridiem = "") {
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(clock || "");
  if (!match) return "";
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const period = String(meridiem || "").toUpperCase();
  if ((period === "午後" || period === "午前" || period === "AM" || period === "PM") && (hour < 1 || hour > 12)) return "";
  if ((period === "午後" || period === "PM") && hour < 12) hour += 12;
  if ((period === "午前" || period === "AM") && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function timeFromLine(text) {
  const range = RANGE_PATTERN.exec(text);
  if (range) {
    return {
      start:normalizeClock(range[2], range[1]),
      end:normalizeClock(range[4], range[3]),
      text:range[0],
      explicitEnd:true,
    };
  }
  const clockPair = CLOCK_PAIR_PATTERN.exec(text);
  if (clockPair) {
    return {
      start:"",
      end:"",
      text:clockPair[0],
      explicitEnd:false,
      inferredPair:true,
    };
  }
  // OCR models sometimes omit the colon in the second clock (for example,
  // "14:00 15 30"). Retain a title for review, but leave both clocks empty:
  // proximity is not evidence of a start/end relationship.
  const spacedEnd = SPACED_END_PATTERN.exec(text);
  if (spacedEnd) {
    return {
      start:"",
      end:"",
      text:spacedEnd[0],
      explicitEnd:false,
      inferredPair:true,
    };
  }
  const single = SINGLE_TIME_PATTERN.exec(text);
  if (!single) return null;
  return { start:normalizeClock(single[2], single[1]), end:"", text:single[0], explicitEnd:false };
}

function cleanTitle(text, date, time, allDay) {
  let title = text;
  if (date?.text) title = title.replace(date.text, " ");
  if (time?.text) title = title.replace(time.text, " ");
  if (allDay) title = title.replace(/終日/, " ");
  return title
    .replace(/[（(]\s*[日月火水木金土](?:曜日)?\s*[）)]/gu, " ")
    .replace(/[\s:：,，、・|｜/\\~〜～–—-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function flattenOcrLines(data) {
  if (Array.isArray(data?.lines)) return data.lines;
  const lines = [];
  for (const block of data?.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) lines.push({ ...line, _paragraph:paragraph });
    }
  }
  if (lines.length) return lines;
  return String(data?.text || "").split(/\r?\n/).filter(Boolean).map((text) => ({ text, confidence:0, bbox:null }));
}

function orderLines(lines) {
  return lines.map((line, index) => ({ ...line, _index:index }))
    .sort((left, right) => {
      const leftY = Number(left.bbox?.y0 ?? left._index);
      const rightY = Number(right.bbox?.y0 ?? right._index);
      if (Math.abs(leftY - rightY) > 5) return leftY - rightY;
      return Number(left.bbox?.x0 || 0) - Number(right.bbox?.x0 || 0) || left._index - right._index;
    });
}

function canInheritDate(dateHeader, line, pageWidth) {
  if (!dateHeader || !dateHeader.value || !line.bbox || !dateHeader.bbox) return false;
  const yDistance = Number(line.bbox.y0) - Number(dateHeader.bbox.y0);
  const lineHeight = Math.max(1, Number(line.bbox.y1) - Number(line.bbox.y0));
  const maxDistance = Math.min(360, Math.max(120, lineHeight * 6));
  if (yDistance < 0 || yDistance > maxDistance) return false;
  const xTolerance = Math.max(36, pageWidth * 0.08);
  return Math.abs(Number(line.bbox.x0) - Number(dateHeader.bbox.x0)) <= xTolerance;
}

function getExistingEvents(eventsByDate = {}) {
  return Object.entries(eventsByDate).flatMap(([date, events]) =>
    Array.isArray(events) ? events.map((event) => ({ ...event, date })) : []);
}

function normalizeTitle(title) {
  return String(title || "").normalize("NFKC").trim().toLocaleLowerCase("ja-JP").replace(/\s+/g, " ");
}

export function eventFingerprint(event) {
  const date = String(event?.date || "");
  const title = normalizeTitle(event?.title);
  const allDay = Boolean(event?.allDay);
  if (!date || !title || (!allDay && (!event?.start || !event?.end))) return "";
  return [date, title, allDay ? "all-day" : String(event.start), allDay ? "" : String(event.end), allDay ? "1" : "0"].join("\u001f");
}

export function isImportEventReady(event) {
  const date = String(event?.date || "");
  const title = String(event?.title || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !validDateParts(...date.split("-"))) return false;
  if (!title) return false;
  if (event.allDay) return true;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(event.start || "")
    && /^([01]\d|2[0-3]):[0-5]\d$/.test(event.end || "")
    && event.end > event.start;
}

export function markImportDuplicates(candidates, existingEvents = []) {
  const seen = new Set(existingEvents.map(eventFingerprint).filter(Boolean));
  return candidates.map((candidate) => {
    const fingerprint = eventFingerprint(candidate);
    const duplicate = Boolean(fingerprint && seen.has(fingerprint));
    if (fingerprint) seen.add(fingerprint);
    return { ...candidate, duplicate };
  });
}

export function extractCalendarCandidates(data, { confidenceThreshold = OCR_CONFIDENCE_REVIEW_THRESHOLD } = {}) {
  const lines = orderLines(flattenOcrLines(data));
  const ticks = lines.filter(line => line.bbox && new RegExp(`^${CLOCK}$`).test(normalizeLine(line.text)));
  const axisColumns = ticks.filter(tick => ticks.filter(other =>
    Math.abs(other.bbox.x0 - tick.bbox.x0) <= 12).length >= 3).map(tick => tick.bbox.x0);
  // Separate-line titles are supported only within one OCR paragraph, tightly
  // aligned with an explicit range. Single clocks must never claim a title.
  const consumed = new Set();
  for (const line of lines) {
    const text = normalizeLine(line.text);
    const range = RANGE_PATTERN.exec(text);
    if (!range || text !== range[0] || !line._paragraph || !line.bbox) continue;
    const height = line.bbox.y1 - line.bbox.y0;
    const neighbours = lines.filter(other => other !== line && other._paragraph === line._paragraph
      && other.bbox && !consumed.has(other)
      && Math.abs(other.bbox.x0 - line.bbox.x0) <= 12
      && other.bbox.y0 >= line.bbox.y1 && other.bbox.y0 - line.bbox.y1 <= height
      && !findDate(normalizeLine(other.text)) && !timeFromLine(normalizeLine(other.text))
      && /[\p{L}]/u.test(other.text));
    if (neighbours.length === 1) {
      line.text = `${text} ${normalizeLine(neighbours[0].text)}`;
      line.confidence = Math.min(Number(line.confidence || 0), Number(neighbours[0].confidence || 0));
      consumed.add(neighbours[0]);
    }
  }
  const pageWidth = Math.max(0, ...lines.map((line) => Number(line.bbox?.x1 || 0)));
  let dateHeader = null;
  const candidates = [];
  let ignoredLineCount = 0;

  for (const line of lines) {
    if (consumed.has(line)) continue;
    const text = normalizeLine(line.text);
    if (!text) continue;
    const lineDate = findDate(text);
    const time = timeFromLine(text);
    const explicitAllDay = /終日/.test(text);

    if (lineDate && !time && !explicitAllDay) {
      dateHeader = { ...lineDate, bbox:line.bbox || null, confidence:Number(line.confidence || 0) };
      continue;
    }

    if (!time && !explicitAllDay) {
      ignoredLineCount += 1;
      continue;
    }

    const inheritedDate = !lineDate && canInheritDate(dateHeader, line, pageWidth) ? dateHeader : null;
    const resolvedDate = lineDate?.yearKnown ? lineDate.value : inheritedDate?.value || "";
    const confidenceParts = [Number(line.confidence || 0)];
    if (inheritedDate) confidenceParts.push(inheritedDate.confidence);
    const confidence = Math.round(Math.min(...confidenceParts));
    const title = cleanTitle(text, lineDate, time, explicitAllDay);
    // A clock is not an event. Never manufacture an empty review card from
    // time-axis ticks, status-bar clocks or a detached pair of OCR clock tokens.
    // Likewise do not assign nearby axis times to title-only rows.
    if (!/[\p{L}]/u.test(title) || /(?:\d{1,2}:\d{2})/.test(title)
      || (time && !time.explicitEnd && line.bbox && axisColumns.some(x => Math.abs(x - line.bbox.x0) <= 12))
      || /^(?:[日月火水木金土](?:曜日)?|追加|予定を追加|新規作成|検索|今日|現在時刻|設定|戻る|カレンダー)$/u.test(title)) {
      ignoredLineCount += 1;
      continue;
    }
    // A very wide gap inside an OCR line can be two unrelated columns (for
    // example a left time axis and a card title). Reject rather than infer.
    const words = (line.words || []).filter(word => word.text?.trim() && word.bbox);
    const height = Math.max(1, Number(line.bbox?.y1) - Number(line.bbox?.y0));
    if (words.some((word, index) => index > 0
      && Number(word.bbox.x0) - Number(words[index - 1].bbox.x1) > Math.max(48, height * 3))) {
      ignoredLineCount += 1;
      continue;
    }
    const allDay = explicitAllDay && !time;
    const conflictingAllDayAndTime = explicitAllDay && Boolean(time);
    const event = {
      title,
      date:resolvedDate,
      start:conflictingAllDayAndTime ? time.start : allDay ? "" : time?.start || "",
      end:conflictingAllDayAndTime ? time.end : allDay ? "" : time?.end || "",
      allDay,
      confidence,
      needsReview:false,
      reasons:[],
      bbox:line.bbox || null,
      sourceText:text,
    };
    if (!title) event.reasons.push("予定名を同じ行から確認できません");
    if (!resolvedDate) event.reasons.push(lineDate && !lineDate.yearKnown || dateHeader && !dateHeader.yearKnown
      ? "年を含む日付を確認してください"
      : "日付を確認してください");
    if (!allDay && !event.start) event.reasons.push("開始時刻を確認してください");
    if (!allDay && event.start && !event.end) event.reasons.push("終了時刻は読み取れません。手入力してください");
    if (time?.inferredPair) event.reasons.push("開始・終了時刻の区切りが画像から明確に読めなかったため確認してください");
    if (event.start && event.end && event.end <= event.start) event.reasons.push("開始・終了時刻の順序を確認してください");
    if (conflictingAllDayAndTime) event.reasons.push("終日表示と時刻の両方が見つかりました");
    if (confidence < confidenceThreshold) event.reasons.push(`OCR信頼度が低めです（${confidence}%）`);
    event.needsReview = event.reasons.length > 0;
    candidates.push(event);
  }

  return { candidates, ignoredLineCount, unsupportedLayout:candidates.length === 0 };
}

export { OCR_CONFIDENCE_REVIEW_THRESHOLD };
