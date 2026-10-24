# グループ退出時の共有予定保持

## Final review: old and new Worker transition

Migration 0015 also adds `group_members.departed_user_id`. A successful departure
atomically moves the account ID from `user_id` to `departed_user_id`, sets
`left_at`, rotates the legacy access token, and revokes group notifications and
participation. The historical member ID remains for shared-event foreign keys.
The pre-0015 Worker authorizes group access with `group_members.user_id`; a
departed account therefore cannot use its historical row even if an old
version receives a request. The new Worker uses `active_group_members`.
Migration triggers also reject stale reaction reactivation and shared reminder
inserts, including an old Worker's attempt after a former participant rejoins.

Deploy the leave-only bridge to 100% **before** applying 0015. Confirm that
new leave requests return 503 and that pre-bridge invocations have drained
before the migration. Do not infer this from the traffic percentage alone:
an invocation already running on the pre-bridge version can still delete a
shared event. If invocation drain cannot be established, pause the release.
After 0015, deploy the new Worker to 100%, verify the served version and
absence of bridge invocations, and only then allow departure requests.
Never roll back to the pre-0015 Worker after the first departure. The
0015-compatible emergency Worker pauses all group APIs and Cron while retaining
account and personal APIs; investigate and redeploy a corrected 0015-compatible
version instead of restoring historical member privileges.

An in-flight Push request already sent to the Push provider cannot be recalled.
The departure batch removes queued group deliveries and shared reminders; the
new Worker also checks active membership when claiming queued Push. A request
that passed its final check immediately before departure may still finish.

対象ブランチ: `fix/preserve-shared-events-on-leave-20261024`

基準: GitHub main `0fcafe6c8e41b2a2bc12fe8e00d5f1f3ad28755b`。
本変更ではProductionの変更・migration適用を行わない。

## 合意済み仕様

- 確定済み共有予定と作成者のメンバー行を保持する。退出は `left_at` による無効化。
- 在籍中の作成者がいる予定の管理権限は従来どおり作成者のみ。
- 作成者が退出した確定済み共有予定は、そのグループの現在のメンバー全員が編集・削除できる。
- 本人が作成した募集が1件でも残っている場合、本人作成の仮予定がある場合、最後のメンバーの場合は409で退出を拒否する。関連データを自動削除しない。
- 募集は確定済み予定に紐づくものも上記の拒否対象とする。募集の終了・引継ぎ・無人グループの扱いは未決定であり、本変更では実装しない。
- 他人の募集への「行きたい」や予定参加は、退出時に `revoked_at` を記録して無効化する。行は保持する。
- グループの通知履歴も退出時に無効化して保持する。再参加しても旧通知を表示しない。
- グループ分の未送信Pushと共有リマインド設定を取り消す。端末のPush購読、個人予定と個人リマインド、他グループの設定は維持する。
- グループ向けの旧シフト・旧個人予定ミラーは削除せず、退出済みメンバーの行を一覧・空き時間計算から除外する。
- 再参加は新しいメンバーIDで行う。旧トークン・旧メンバーIDを引き継がない。元作成者も、作成者特権ではなく他の現メンバーと同じ確定済み予定管理権限になる。
- 個人予定は本人以外には時間帯と「予定あり」だけを返す。退出中は元グループへの個人予定の時間帯共有も停止する。

## 実装と互換性

`0015_group_departures.sql` は0014まで適用済みのDBに適用する。
2026-10-24の本番D1 `d1_migrations` の読み取り結果は0001〜0010、0012〜0014の13件。0011は記録されておらず、今回のコードにも存在しない。Wranglerの本番未適用一覧は0015のみ。
`wrangler.production-0015.review.jsonc` はmigration確認・適用専用で、`migrations-0015-only` に0015の同一コピー1ファイルだけを持つ。Workerデプロイには使用しない。既存migrationの内容は変更しない。

- `group_members.left_at`、参加希望・予定参加・通知の `revoked_at` を追加。既存行はNULLのまま有効。
- `(group_id,user_id)` の一意制約を有効なメンバーだけに限定する。既存データを削除・再作成しない。
- `active_group_members` ビューを認可、一覧、通知、Cronの共通参照先にする。
- 共有予定の `created_by_member_id` 外部キーは変更しない。
- 退出処理はD1 batchのトランザクションで条件判定と取消処理を実行する。同時退出でも最後のメンバーは残す。
- 退出後の遅延INSERTはトリガーで拒否し、共有予定の編集・削除は書込時にも認可する。
- Pushの取得後も送信権の取得時に参加状態とリマインドの有効性を再確認する。
- APIの既存形式を維持し、共有予定一覧に `creatorLeft` と `canManage` を追加する。
- 409は最後のメンバー、本人作成の募集、本人作成の仮予定で理由を分ける。管理ダイアログの `role="alert"` にサーバーの理由を表示する。
- `GROUP_ACCESS_PAUSED=true` の復旧用設定ではグループAPI・共有リマインドAPI・Cronを一時停止する。認証や個人予定のAPIは継続する。

## ローカル検証

BackendのCloudflare Vitest環境内のローカルD1にmigrationを適用する。
既存データを0014の状態で作成してから0015を適用するテストと、`PRAGMA foreign_key_check` を含む。
本番DB・実ユーザー・実Push配信先は使用しない。

検証対象: 退出前後のAPI認可、確定予定保持、引継ぎ編集とリマインド時刻更新、削除権限、募集・仮予定・最終メンバーの退出拒否、同時退出、再参加、旧トークン拒否、通知・Cron除外、個人情報非公開、既存データ移行、UI保存・削除確認・権限エラー。

2026-10-24の結果:

- Frontend: 30件成功（変更前24件、6件追加）。
- Backend: 67件成功（変更前54件、13件追加）。
- `npm run typecheck`: 成功。
- Production設定を用いた `wrangler deploy --dry-run`: 成功。実デプロイなし。
- `git diff --check`: 成功。
- Frontendテスト時に既存のNode.jsモジュール形式警告あり。テスト失敗なし。

## 公開前に必要な運用準備

**旧Workerへ単純ロールバックしてはいけない。** 旧Workerは `left_at` を見ないため、退出済みの人にアクセス権を戻す危険がある。旧版の退出処理自体にも共有予定を削除する問題が残っている。

以下は将来、本番公開の承認を得た場合の実行順序。今回の作業では実行しない。

1. 正しいアカウント・D1 ID、Git commit、Worker version・配信割合、Secret名・Cron・assetsを再確認する。0015の原本と専用フォルダのSHA-256を照合する。本番D1のjournalと専用設定の `wrangler d1 migrations list money-app-shared --remote --config wrangler.production-0015.review.jsonc` が0015のみを示すことを再確認する。
2. 基準mainから隔離した作業ツリーを作り、`backend/recovery/prepare-leave-bridge.mjs` を実行する。スクリプトは旧Workerの `/api/groups/leave` の応答だけを503にする。既知の元コードと一致しなければ停止する。作業ツリーでテスト・型チェック・dry-runを行い、差分が退出APIの1行だけであることを確認してから、橋渡し版を100%配信する。退出が503になることを確認する。**この橋渡し版はmigration前専用であり、0015適用後に戻してはいけない。**
3. 専用設定で0015だけを適用し、journal、追加列・ビュー・トリガー、`PRAGMA foreign_key_check` を読み取り専用で確認する。0011を適用しない。migrationが失敗した場合は新Workerへ進まず、橋渡し版で退出を止めたまま調査する。
4. 新Workerを `wrangler.production.jsonc` で100%配信する。旧Workerの実行が終了したことを確認してから、退出を有効化する。新旧Workerを混在配信しない。Frontend公開前にAPI・プライバシー・Cronを検証する。
5. 障害時は、**0015対応コード**を `wrangler.production.recovery.jsonc` でデプロイして100%配信する。この設定は本番設定と `GROUP_ACCESS_PAUSED=true` 以外一致する。グループAPIとCronが503/停止、認証と個人予定APIが継続することを確認する。原因を修正して同じ0015対応の通常設定で再デプロイする。旧Worker versionや橋渡し版は復旧先にしない。

実際のコマンドでは各設定ファイルのある `backend/` から実行する。デプロイ前後に `wrangler deployments status` で100%配信を確認する。移行後に旧Workerが再び受信しないよう、トラフィック設定を確認する。復旧用WorkerはCronも止めるため、個人リマインドも一時的に遅れる。DB全体の巻き戻しは後続の正当な更新を失うため通常の復旧手段にしない。

移行専用設定で使用するコマンドは次のとおり。`apply` は今回実行しない。

```powershell
npx wrangler d1 migrations list money-app-shared --remote --config wrangler.production-0015.review.jsonc
npx wrangler d1 migrations apply money-app-shared --remote --config wrangler.production-0015.review.jsonc
```

橋渡し版は基準mainの別作業ツリーに1行だけ変更して準備する。このブランチのソース全体を基準mainへ混入させない。使用前に差分が退出APIの1行だけであることを確認する。

```powershell
git worktree add --detach C:\Users\hp\Documents\Codex\DaySync-Leave-Bridge 0fcafe6c8e41b2a2bc12fe8e00d5f1f3ad28755b
node C:\Users\hp\Documents\Codex\DaySync\backend\recovery\prepare-leave-bridge.mjs C:\Users\hp\Documents\Codex\DaySync-Leave-Bridge
git -C C:\Users\hp\Documents\Codex\DaySync-Leave-Bridge diff --check
git -C C:\Users\hp\Documents\Codex\DaySync-Leave-Bridge diff -- backend/src/shared.ts
```

橋渡し版のテスト・dry-runと差分レビューが終わった場合だけ、将来の公開承認の範囲で本番に配信する。新Worker側で問題が発生した場合の復旧用コマンドは `npx wrangler deploy --config wrangler.production.recovery.jsonc`。配信割合100%と503応答を確認してから原因を修正する。復旧設定のdry-runと設定差分の照合はローカルで成功している。

## 残る制約

- 配信サービスへすでに送信されたPush、端末にすでに表示された通知、退出前に取得済みのデータは回収できない。
- 募集の終了・引継ぎや無人グループの扱いは引き続き仕様決定が必要。退出を通すために募集を自動削除しない。
- 共有予定の同時編集は従来どおり後の更新が優先される。複数人が同時編集する競合制御は別途必要。
- iPhone実機でのダイアログ、キーボード、長いタイトル、退出エラー表示は本番公開前に手動確認する。
