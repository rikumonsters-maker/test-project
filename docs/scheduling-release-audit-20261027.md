# 日程調整・グループ終了 リリース監査と実行手順

2026-10-27 のローカル監査。ここに記す本番操作は**未実行**。公開時はコミット、Worker version、D1 ID、journal、設定を再確認する。

## 監査結果

- 比較基準 `origin/main=4030edfd`、機能開始コミット `1ea2fc5`。本番Worker は監査時点で 0015 対応版 `c23288bc-2db3-4a6a-949c-ebe8b1b9c9ca` が 100%。本番D1 ID は `142e6c05-b703-4825-828b-b6dd702c38bd`。先行する読み取り確認ではjournalは0015まで（0011は意図的に欠番）だったが、2026-10-27の再確認ではCloudflare D1 APIが7403を返した。本番を変更していない。
- 旧WorkerのPush claimは `schedule_id` と日程調整の状態を検査しない。新しい通知行が見えると、中止・期限切れ通知を旧形式で送る恐れがある。旧Workerの共有予定編集は `management_version` を増やすため、これだけでは旧更新を区別できない。
- 0018 に `delivery_guard_version` と `scheduling_write_version`、対応トリガーを追加した。新WorkerはPush claim・再試行および日程確定済み共有予定の編集・中止でマーカーを増やす。旧Workerの同じ更新はD1で拒否される。旧Workerの募集更新は既存の `management_version` ガードで拒否される。終了済みグループの更新、参加、通知作成は0018のDBガードで拒否される。
- 0018は既にローカルコミット済みだが本番未適用であり、差分を0018に統合した。0019に分割すると保護なしの0018を一度適用する段階が生じる。既存ローカルjournalへの自動再適用には依存せず、新規D1で確認した。
- mainコードの `GROUP_ACCESS_PAUSED=true` は認証後のグループ/共有APIを503にし、Cronを止める。認証と個人予定APIは使用できる。**個人リマインダーのCronも一時停止する**。予定開始前に再開できれば遅延配送されるが、停止中に予定開始を過ぎたものは送られない可能性がある。
- 橋渡し版を100%にしても旧リクエストの終了証明にはならない。0018のDBトリガーが、後着する旧Workerの危険な書き込みを拒否する。外部Pushサービスに既に渡った送信は取り消せず、送信直前のDB再確認と運用監視で残余リスクを抑える。

## ローカル検証

- 別の空D1に現行の0015相当までを構築し、**0011を入れず**0016、0017、変更後の0018を順にWranglerで適用した。journalに各1件、`PRAGMA foreign_key_check` 0件、0014a/0015と0018のトリガーを確認。
- 合成した既存グループ、メンバー、共有予定、募集、個人予定の保持と0017の管理者補完を確認。日程調整と投票の保持、閉鎖後の共有予定・募集・日程調整の保持、通知キューの無効化をテストで確認。
- 旧Workerと同じ `management_version` 更新を伴う共有予定編集、旧Push claim、旧募集更新は拒否。新Workerの予定編集とPush claimは成功。Push claim直後の中止競合では送信前の状態再確認をテスト。
- main由来の橋渡し復旧設定と、0018対応の復旧設定は別々にdry-run済み。前者は0016前から使用可能。後者は0018後だけに使用する。
- 最終のFrontendテスト38/38、Backendテスト98/98、TypeScript型チェック、両Worker dry-runは成功。Vercelの実機画面や本番の認証済み操作は行っていない。

## 段階別公開手順と停止条件

1. **直前照合。** 対象コミットのハッシュ、PR差分、テスト、`wrangler.production.jsonc` のWorker名・D1 binding/ID・互換日付/flag・assets・Cron・CORS・Cookie認証・Secret**名**を照合。現行Worker versionと配信割合、Vercel Productionと正式URLを記録。不一致なら停止。
2. **バックアップ。** 本番D1をGit管理外の保護された場所へSQL exportし、サイズ、ハッシュ、隔離D1への復元、外部キー整合性を検証。Time Travel bookmarkを記録。復元できなければ停止。DB全体の自動巻戻しは行わない。
3. **本番D1の基準値。** `d1_migrations`、共有予定・募集・グループ・メンバー・個人予定・Pushキューの件数、`PRAGMA foreign_key_check`、0014a/0015トリガーを読み取り専用で取得。0011未適用、0016～0018未適用、ID完全一致が条件。個人の内容は出力しない。差異があれば停止。
4. **橋渡し版の配信。** 現行mainの0015対応ソースから `GROUP_ACCESS_PAUSED=true` の復旧設定でビルドした橋渡しWorkerを配信し、100%と認証後グループAPIの503、認証・個人APIの応答、Cron停止を確認。新しいデータを作るテストは行わない。橋渡し失敗ならmigrationへ進まない。個人リマインダー停止期間に開始する予定がある場合は公開時間を変更する。
5. **migration。** 専用の `backend/wrangler.production-0016.review.jsonc`、0017、0018を**順番に**使用する。各設定の `migrations_dir` には対象SQL 1件だけを配置し、元SQLとのSHA-256一致と `migrations list` の対象1件を毎回確認する。0011は含めない。各適用後journal、件数、外部キー、保護トリガーを確認。いずれか失敗なら橋渡しを維持して停止。0018適用後は旧Worker・橋渡し版へ戻さない。
6. **新Worker。** 同じ対象コミットの `backend/wrangler.production.jsonc` でビルド・デプロイ。migrationレビュー設定はWorker deployに使わない。version ID、100%配信、binding、Cron、assets、Secret名を照合。失敗時は**0018対応コード**の `wrangler.production.recovery.jsonc` を使いグループAPIとCronを止める。旧Workerへのロールバックは禁止。
7. **APIとD1の確認。** 正式URL経由の認証/既存API応答、家計簿、シフト、個人予定、グループ、共有予定、日程調整の認可を読み取り中心に確認。終了済み・退出済み権限と個人情報非公開を確認。件数、FK、journal、PushキューとCronログの異常を監視。認証済みの実操作を行えない項目は未確認として残す。データ減少、権限異常、重大例外で停止し復旧版へ切替。
8. **Frontend。** Workerが正常な場合だけfeatureの公開対象をPR化し、CI/Preview、差分、Vercel設定を確認してmainへマージ。Vercel Production READY、反映コミット、正式URL、Service Worker更新、静的ファイルの配信を確認。Frontend失敗時にWorkerを旧版へ戻さない。
9. **iPhone実機。** 個人予定、既存共有予定、共通空き時間、推薦順位、○△×投票、最終確認、確定、通知履歴、グループ終了確認とエラー表示、キャッシュ更新を本人のテスト用データで確認。友人や本番の既存データを無断変更しない。
10. **監視・復旧。** Worker/Vercelログ、Cron成功、Push失敗/再試行、件数・FKを監視。0018後の障害は0018対応復旧版で隔離し、原因修正後に新Workerへ再公開。Time TravelやSQL復元は影響範囲と権限の調査後に別途判断し、全DBを自動的に巻き戻さない。

先に対象featureコミットの `backend/` で、バックアップとbookmarkを取得する（今回未実行）。`$secureBackupPath` はGit管理外の保護済み保存先へ事前に設定し、隔離D1で復元を検証する：

```powershell
npx wrangler d1 export money-app-shared --remote --config wrangler.production.jsonc --output $secureBackupPath
npx wrangler d1 time-travel info money-app-shared --remote --config wrangler.production.jsonc
```

橋渡し版は検証済みの `origin/main` 隔離コピーの `backend/` から、**0016適用前に**次を実行する（今回未実行）：

```powershell
npx wrangler deploy --config wrangler.production.recovery.jsonc
```

その後、対象featureコミットの `backend/` で、各ゲートを満たした担当者だけが使うコマンド例（今回未実行）：

```powershell
foreach ($number in @('0016','0017','0018')) {
  $review = "wrangler.production-$number.review.jsonc"
  npx wrangler d1 migrations list money-app-shared --remote --config $review
  # 一覧が当該SQL 1件だけであり、件数・FK・トリガーのゲートを満たす場合だけ次を実行する。
  npx wrangler d1 migrations apply money-app-shared --remote --config $review
}
# 0018後の新Workerは対象コミットのソースから本番用設定を使う。
npx wrangler deploy --config wrangler.production.jsonc
```

ループは説明用であり、**実運用では各migrationの直後に検証してから次へ進む**。0018適用後の緊急停止用deployは0018対応コミットの `wrangler.production.recovery.jsonc` を使う。SQL exportの復元試験先は本番と異なるD1 IDにする。

## 残余リスクとGO条件

- 橋渡し中の個人リマインダー停止と、外部Pushサービスへの送信直前の競合は完全には排除できない。公開窓の個人リマインダー到来件数を内容なしで事前確認し、影響が避けられない場合は開始しない。
- 新Workerと旧Workerの完全な同時実行を本番で再現したわけではない。100%表示を安全の根拠にせず、DBガードと段階別チェックを必須とする。
- **現時点の本番公開判定はNO-GO。** 独立D1・テスト・dry-runは成功したが、D1 API 7403のため直前journal、件数、外部キーを確認できない。OAuthのアカウントIDと権限表示、APIトークン環境変数の不在を確認した。認証復旧後に読み取り専用のD1直前照合を再実行し、上記停止条件を満たしてから段階的公開を判断する。iPhone実機、認証済みAPI、本番ログの最終確認は公開後に残る。
