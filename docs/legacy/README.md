# 旧開発成果物の保管（2026-10-23）

このディレクトリは履歴資料と未公開機能の候補です。ここにあるコード、テスト、SQLはアプリの実行・ビルド・migration適用対象ではありません。現行の正本は `frontend/`、`backend/src/`、`backend/migrations/` です。

## 取り込んだもの

- RCの `backup-import.test.mjs`、`personal-sync.test.mjs`、`rc-scope.test.mjs` を現行Frontendへ移植。最後のテストは `unreleased-feature-scope.test.mjs` に改名。
- RCの `storage.test.mjs` から、旧データ引継ぎ時に予定を移さずシフト・家計簿を守るテストを移植。
- RCのオフラインWorker比較スクリプト2件を `backend/tools/` に保全。入力パスを引数で渡す方式なので、現行のdry-run成果物にも使用できる。各スクリプトの `--self-test` は成功。
- `rc/RC-REPORT.md` は当時の検証記録として保管。記載された本番状態や未検証事項は現在の状態を証明しない。

## 実行コードへ取り込まなかったもの

- `money-app/PERSONAL_SYNC.md` と旧 `frontend/personal-sync.test.mjs` は、自動移行を前提とする旧設計。現行の「本人の同意後に空のカレンダーから開始し、旧予定を自動送信しない」仕様と矛盾する。
- パスワード再設定の未公開コード・テスト・0011 SQL・設計資料は `.local-legacy-archive/worktrees/money-app/` に非公開で保存した。現在のFrontend UI、Worker API、Secret設定には接続していない。`0011_password_recovery.sql` は **現行の `backend/migrations/` に置かない**。
- 旧RCの `wrangler.production-0012.review.jsonc`、money-appのローカルWrangler設定、編集設定、古い構成ファイルは非公開アーカイブの作業ツリースナップショットに保管した。現行のWorker設定へ上書きしない。
- 現行にも存在する認証、個人同期、共有、通知、家計簿などの旧ソースは重複移植しない。現行の本番仕様とテストを優先する。

## 非公開アーカイブ

`.local-legacy-archive/` はリポジトリ直下でGit除外済み。Vercel公開対象の `frontend/` とWorker静的配信対象の `backend/public/` の外にある。旧RCとmoney-appの作業ツリースナップショット、SHA-256マニフェスト、3つのGit bundle、未コミット追跡差分のパッチ、旧ローカルD1/R2/KV状態を保存した。SQLiteはWALを考慮したバックアップAPIでコピーし、コピー先の整合性を確認した。Secretや個人データの中身は文書・Gitへ転記していない。

このアーカイブはローカル端末上の保管であり、GitHubには含まれない。旧フォルダを削除する前に、アーカイブとその別媒体への保全、復元手順を改めて確認すること。`node_modules`、キャッシュ、観測ログ、dry-run成果物はコピーしていない。

## 0011の判断

旧0011は `users(id)` を参照する `password_reset_tokens` と、`auth_rate_limits`、索引を追加するだけのSQL。既存データを削除する文はない。依存する `users` は0003で作られる。0012〜0014とはテーブル名の衝突がなく、空のインメモリSQLiteで0011を0012の前・0014の後に置く両順序が成功し、外部キー違反もなかった。実データを持つD1での適用や認証フローの安全性は、この確認だけでは証明できない。

現在のWorkerにパスワード再設定APIはなく、Frontend UIもない。0011を今適用する必要はない。将来この機能を採用する場合は、実装・メール送信設定・セキュリティ・既存データへの影響を新たにレビューし、明示的な承認を得る。現行の既存D1には適用しない。検証コマンドは `node backend/tools/verify-migration-layout.mjs`（インメモリDBのみ）。非公開アーカイブのない環境では0011の順序確認をスキップする。
