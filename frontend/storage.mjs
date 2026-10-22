export const LEGACY_STORAGE_KEY = 'money-app-v2';

export function userStorageKey(userId) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('ユーザーIDが正しくありません');
  return `daysync-user-${userId}`;
}

export function readStoredState(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function savePersonalState(storage, key, state) {
  const { groups, shared, ...personal } = state;
  storage.setItem(key, JSON.stringify(personal));
}

export function mergeLegacyNonEventState(current = {}, legacy = {}) {
  const shifts = { ...(legacy.shifts || {}), ...(current.shifts || {}) };
  const expenses = { ...(legacy.expenses || {}), ...(current.expenses || {}) };
  for (const [date, oldRows] of Object.entries(legacy.expenses || {})) {
    if (!Array.isArray(oldRows)) continue;
    const currentRows = current.expenses?.[date];
    if (!Array.isArray(currentRows) || !currentRows.length) { expenses[date] = oldRows; continue; }
    const ids = new Set(currentRows.map(row => row?.id).filter(Boolean));
    const additions = [];
    for (const row of oldRows) {
      if (row?.id && !ids.has(row.id)) { ids.add(row.id); additions.push(row); }
    }
    expenses[date] = [...currentRows,...additions];
  }
  const mergePending = (older = {}, newer = {}) => Object.fromEntries(
    [...new Set([...Object.keys(older),...Object.keys(newer)])]
      .map(groupId => [groupId,{ ...(older[groupId] || {}), ...(newer[groupId] || {}) }]),
  );
  const budget = Object.fromEntries(["fixed","saving","spent"].map(field => [field,current.budget?.[field] || legacy.budget?.[field] || ""]));
  return {
    ...legacy,
    ...current,
    events:current.events || {},
    shifts,
    expenses,
    hourly:current.hourly || legacy.hourly || "",
    manualIncome:current.manualIncome || legacy.manualIncome || "",
    incomeMode:current.incomeMode === "manual" || legacy.incomeMode === "manual" ? "manual" : "auto",
    theme:current.theme && current.theme !== "system" ? current.theme : legacy.theme,
    budget,
    pendingGroupMonths:mergePending(legacy.pendingGroupMonths,current.pendingGroupMonths),
    pendingGroupShiftMonths:mergePending(legacy.pendingGroupShiftMonths,current.pendingGroupShiftMonths),
  };
}
