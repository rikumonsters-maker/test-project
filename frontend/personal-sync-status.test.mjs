import test from 'node:test';
import assert from 'node:assert/strict';
import { personalSyncStatusKind, renderPersonalSyncStatus } from './personal-sync-status.mjs';

test('normal sync and the redundant initial state are hidden', () => {
  for (const message of ['', '同期完了', '個人予定の同期はまだ開始していません。端末内の予定はそのままです。', '予定の同期を準備しています…']) {
    assert.equal(personalSyncStatusKind(message), 'hidden');
  }
});

test('progress is compact and actionable sync states remain visible', () => {
  assert.equal(personalSyncStatusKind('同期中…'), 'progress');
  for (const message of [
    '同期失敗・オフライン：通信できません 未同期の予定は端末に保管されています。',
    '未同期の変更があります',
    '別端末との競合があります。変更内容は端末に保管されています。',
    '端末の保存領域が不足しています。バックアップを保存してください。',
    '同期状態を確認できません。端末内の予定は変更していません。',
    '同期完了。同じIDで内容が異なる復元予定は両方保管しました。',
  ]) assert.equal(personalSyncStatusKind(message), 'notice');
});

test('rendering clears recovered warnings and promotes failures to an alert', () => {
  const classes = new Set();
  const container = { hidden:false, classList:{ toggle(name, force) { if (force) classes.add(name); else classes.delete(name); } } };
  const status = { textContent:'', role:'', setAttribute(name, value) { if (name === 'role') this.role = value; } };

  renderPersonalSyncStatus(container, status, '同期失敗・オフライン：通信できません');
  assert.equal(container.hidden, false);
  assert.equal(status.role, 'alert');
  assert.match(status.textContent, /同期失敗/);
  assert.ok(classes.has('is-notice'));

  renderPersonalSyncStatus(container, status, '同期完了');
  assert.equal(container.hidden, true);
  assert.equal(status.textContent, '');
  assert.ok(!classes.has('is-notice'));
});
