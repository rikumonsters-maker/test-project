function parseJson(value, label) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); }
  catch { throw new Error(`${label}のJSONを読み取れません。`); }
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function extractEvents(value, { includeArchive = false } = {}) {
  const root = parseJson(value, 'バックアップ');
  if (root && typeof root === 'object' && root.archiveEvents !== undefined) {
    const events = includeArchive ? root.archiveEvents : root.events;
    if (!events || typeof events !== 'object' || Array.isArray(events)) {
      throw new Error(includeArchive ? 'バックアップに復元できる旧予定がありません。' : 'バックアップに現在の同期予定がありません。旧予定を復元する場合は、切替前の旧予定を選択してください。');
    }
    const parsed=validateEvents(events);
    if (!parsed.count) {
      const archiveHasEvents=Object.values(root.archiveEvents||{}).some(entries=>Array.isArray(entries)&&entries.length>0);
      throw new Error(includeArchive || archiveHasEvents ? 'バックアップに復元できる旧予定がありません。旧予定を復元する場合は、切替前の旧予定を選択してください。' : 'バックアップに復元できる予定がありません。');
    }
    return parsed;
  }
  const candidates = [root];
  if (root && typeof root === 'object') {
    for (const key of ['originalState', 'state', 'data']) {
      if (root[key] !== undefined) {
        try { candidates.push(parseJson(root[key], 'バックアップ内の保存データ')); }
        catch { /* Try another recognized envelope; no data is changed by parsing. */ }
      }
    }
  }
  for (const candidate of candidates) {
    const events = candidate?.events;
    if (!events || typeof events !== 'object' || Array.isArray(events)) continue;
    const rows = Object.entries(events);
    if (!rows.length) continue;
    const {count}=validateEvents(events);
    if (count) return { events, count };
  }
  throw new Error('バックアップに取り込める個人予定が見つかりません。元のデータは変更されていません。');
}

function validateEvents(events) {
  if (!events || typeof events !== 'object' || Array.isArray(events)) throw new Error('バックアップの予定データ形式を確認できません。元のデータは変更されていません。');
  const rows = Object.entries(events);let count=0;
  for (const [date, entries] of rows) {
    if (!validDate(date) || !Array.isArray(entries)) throw new Error('バックアップの予定データ形式を確認できません。元のデータは変更されていません。');
    for (const event of entries) {
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.title !== 'string' || !event.title.trim()) throw new Error('バックアップに読み取れない予定があります。元のデータは変更されていません。');
      if (event.start !== undefined && typeof event.start !== 'string') throw new Error('開始時刻の形式を確認できません。元のデータは変更されていません。');
      if (event.end !== undefined && typeof event.end !== 'string') throw new Error('終了時刻の形式を確認できません。元のデータは変更されていません。');
      count++;
    }
  }
  return {events,count};
}

export function parsePersonalBackup(value, options) {
  return extractEvents(value, options);
}
