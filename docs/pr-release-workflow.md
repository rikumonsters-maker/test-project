# DaySync PR と本番公開の運用

## 初回導入ゲート

この自動化が `main` に入る前に自動マージを有効化しない。初回導入時は、`main` の保護、必要な Check、GitHub Actions、Vercel の本番照合に使う読み取り専用トークンを確認してから、設定用 PR を人がレビューしてマージする。`--admin`、main への直接 push、チェックのスキップは禁止。

GitHub の `main` 保護には pull request 必須、管理者にも適用、最新 main への追従、少なくとも `day-sync-frontend`、`day-sync-backend`、`day-sync-security`、`Vercel` の成功を要求する。保護がない状態では `gh pr merge --auto` を呼ばない。

Vercel プロジェクト `test-project` の GitHub 連携を維持し、Production branch は `main`、Root Directory は `frontend` とする。Production 用の `VERCEL_READ_TOKEN` は GitHub Actions Secret としてのみ保存し、Vercel の Deployment とドメインを読み取れる最小権限にする。値をソース、コマンド引数、ログへ記録しない。

## 機能開発を終えたとき

1. 最新 main から `feature/...` を作り、機能を実装する。既存の未追跡アーカイブをステージしない。
2. 変更対象ファイルを明示して `scripts/new-draft-pr.ps1` を実行する。スクリプトは Frontend・Backend テスト、型チェック、Worker dry-run、パス検査、commit、feature branch push、Draft PR 作成、GitHub Checks と同じ SHA の Vercel Preview を確認する。失敗時は次の段階へ進まない。
3. PowerShell 内での例：`& .\scripts\new-draft-pr.ps1 -Paths @('frontend/budget.js','frontend/style.css') -Title '変更の題名' -Summary '変更内容' -Risks '公開上のリスク' -CommitMessage '変更を説明するコミット'`。事前確認だけなら `-ValidateOnly` を使う。
4. PR 本文と差分を確認する。Preview は本番 Worker に API を転送するため、本番データを変更する操作テストを行わない。iPhone 実機など自動化できない確認は未検証として記録する。

`DaySync Frontend Auto Merge` は、同じリポジトリの `feature/` にある明示的に opt-in した Draft PR だけを対象とする。Frontend 以外の差分があれば停止する。CI 3件、Vercel Check、対象 SHA の Preview deployment の成功、main の保護を確認して Ready にし、`gh pr merge --auto --match-head-commit` を設定する。PR の head が変われば停止する。GitHub の保護を迂回しない。

## Backend・D1 の変更

Backend、migration、Worker 設定、認証、プライバシー、通知、権限の変更は自動マージ対象外。まず本番 Worker・D1 と候補コードを照合し、旧 Frontend との互換性、migration の対象 SQL と順序、ロールバック可能性を確認する。D1 migration `0011` を意図せず適用しない。0018 非対応 Worker へ戻さない。データ削除、破壊的 migration、公開範囲の拡大、同意変更が必要なら公開を停止する。安全な Worker 先行公開などが確立した変更だけを、別途検証済みの手順で進める。

## マージ後

Vercel の既存 GitHub 連携に Production deploy を任せ、二重デプロイしない。`DaySync Production Verify` は merge commit の SHA を使って Vercel Production が READY、同じ SHA、正式ドメイン `daysync-app.vercel.app` へ割り当て済み、HTTP 200 を確認する。失敗したらチェックを失敗として記録し、追加 deploy や Worker rollback を自動実行しない。認証済みの画面操作、実機確認、ログ監視は別途行い、未実施なら未検証と報告する。

## 失敗時の停止条件

- テスト、型チェック、dry-run、秘密情報のパス検査の失敗
- PR head の変更、merge conflict、チェック失敗・未確認、Preview の不一致
- main 保護の欠落、GitHub/Vercel 権限不足
- Backend・D1 の互換性未証明、破壊的変更、権限・プライバシーの緩和
- Production の SHA、READY、正式ドメインの不一致

この仕組みは完全なセキュリティ監査の代替ではない。静的な秘密情報検査は既知パターンのみを検出する。GitHub の Secret Scanning と Push Protection も維持する。
