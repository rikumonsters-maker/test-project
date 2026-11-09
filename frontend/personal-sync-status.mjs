const ACTIONABLE_STATUS = /同期失敗|オフライン|未同期の変更|競合|保存領域が不足|同期状態を確認できません|復元予定は両方保管しました/;

export function personalSyncStatusKind(message) {
  const value = String(message || '').trim();
  if (!value || value === '同期完了' || value.startsWith('個人予定の同期はまだ開始していません。') || value === '予定の同期を準備しています…') {
    return 'hidden';
  }
  if (value === '同期中…') return 'progress';
  if (ACTIONABLE_STATUS.test(value)) return 'notice';
  return 'notice';
}

export function renderPersonalSyncStatus(container, status, message) {
  const kind = personalSyncStatusKind(message);
  container.hidden = kind === 'hidden';
  container.classList.toggle('is-progress', kind === 'progress');
  container.classList.toggle('is-notice', kind === 'notice');
  status.textContent = kind === 'hidden' ? '' : String(message || '');
  status.setAttribute('role', kind === 'notice' && /失敗|オフライン|不足|確認できません/.test(message) ? 'alert' : 'status');
  return kind;
}
