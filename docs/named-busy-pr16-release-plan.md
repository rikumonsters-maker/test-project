# PR #16 公開ゲートと実行順序

この文書は公開手順の準備用。PR #16 は Draft のまま維持し、明示的な公開承認まで本番を変更しない。

## 直前ゲート

1. PR の base が `main`、head が承認対象 SHA、全必須チェックが成功し、自動マージ opt-in が無いことを確認する。
2. 本番 Worker の version と配信割合、D1 binding、Cron、assets、Secret **名**を確認する。D1 の名前 `money-app-shared` と ID `142e6c05-b703-4825-828b-b6dd702c38bd` を照合する。
3. 本番 migration journal を読み取りで確認し、0018 までの必要な migration が適用済み、0019 が未適用、0011 が意図どおり未適用であることを確認する。通常の migrations ディレクトリを一括適用しない。
4. 最新の SQL export を Git 管理外の保護された場所へ取得し、暗号化と隔離ローカル D1 への復元・件数・外部キー検証を行う。2026-10-27 の既存バックアップは取得後の更新を含まないため、公開直前の代替にはしない。Time Travel bookmark と基準件数を記録する。Time Travel は SQL バックアップと同等ではない。
5. 本番と分離した合成データで、375/390/430/768px と PC、ライト/ダーク、Tab/Enter/Space、同意 OFF→ON→OFF、グループ切替、日付切替を実ブラウザで確認する。Preview の `/api/*` は本番 Worker に転送されるため、新 API を Preview から試験しない。

いずれかが不一致・未確認なら停止する。

## 公開手順（段階ごとに停止条件を確認）

1. 0019 原本と `migrations-0019-only/0019_named_busy_sharing.sql` の SHA-256 が一致し、`wrangler.production-0019.review.jsonc` がこの1ファイルのみを対象にすることを確認する。0011 は対象に含めない。
2. 明示的な承認後に 0019 のみを本番 D1 へ適用する。journal、新テーブルの空状態、既存件数、外部キー整合性を確認し、異常なら Worker 公開に進まない。
3. 0019 対応の復旧用 Worker を利用可能にしたうえで、対象 PR の Backend を**本番用** `wrangler.production.jsonc` で dry-run、設定照合後に公開する。新 version 100%、既存 Frontend と既存 API、認可、匿名化、Cron を非破壊的に確認する。
4. Worker が正常な場合のみ PR を Ready にし、保護ルールに従って通常マージする。Vercel の GitHub 連携による自動 Production deploy を待ち、READY、配信 SHA、正式ドメインを確認する。追加の Vercel deploy は行わない。
5. Production Verify 成功後、iPhone Safari/PWA で予定一覧、折りたたみ、同意 ON/OFF、別グループ、空き時間、既存共有予定を本人が確認する。個人予定の内容を他人の画面・APIへ出さない。

## 異常時

- 0019 適用失敗: 次段階へ進まず、journal と既存データを確認する。DB 全体の自動巻き戻しはしない。
- 0019 適用後の Worker 障害: 0018 非対応 Worker へ戻さない。0019 対応の復旧用 Worker で新 API を停止しつつ既存 API を維持する。事前に互換性を証明できない旧 version へのロールバックは行わない。
- Frontend 障害: 新 Worker を維持し、直前の正常な Frontend deployment への復旧を検討する。
- データ異常: 書き込みを増やさず影響範囲を確定する。SQL バックアップと Time Travel は復旧候補として保持し、どちらも利用者の後続更新を失う可能性を評価してから別途判断する。
