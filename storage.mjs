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
