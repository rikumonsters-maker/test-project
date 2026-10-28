# DaySync 開発プロジェクト

現在のPR作成、Frontend自動マージ、本番反映後の確認手順は [docs/pr-release-workflow.md](docs/pr-release-workflow.md) を参照してください。以下は初期統合時の記録であり、現行の本番設定を表すものではありません。

このフォルダは Frontend と Cloudflare Worker Backend を一緒に開発するための作業ツリーです。Git の基点は 2026-10-20 に確認した GitHub `main` の `945a7617a4ebca3bfd90170956ec26b11537ca74` です。統合作業は未コミットです。

## 構成

- `frontend/`: DaySync-Frontend-Release の未公開通知リマインド変更を含む静的 Frontend。`vercel.json` に既存 API rewrite を保持。
- `backend/`: DaySync-Notification-Work-20261013 の通知対応 Worker。`migrations/0013_push_reminders.sql` を保持。
- `backend/wrangler.production.jsonc`: 旧 RC から保全した本番用 Worker 設定。現行 Cloudflare 側との一致は、このローカル統合では検証していません。
- `backend/wrangler.rc-test.jsonc` と `wrangler.rc-baseline.jsonc`、`wrangler.rc-0012.jsonc`: ローカル開発・テスト用。

Temp の Backend は Git リポジトリではありません。元フォルダやその未コミット変更は編集していません。Secret、Cookie、トークンやローカル環境変数ファイルはコピーしていません。

## ローカル確認

Frontend: `cd frontend`, `npm ci`, `node --test`。開発サーバーは `npm run dev`。

Backend: `cd backend`, `npm ci`, `npm test`, `npm run typecheck`。Worker のビルド確認は `node_modules/.bin/wrangler.cmd deploy --dry-run --config wrangler.production.jsonc --outdir .wrangler/dry-run`。

## 将来の公開時に確認する設定

このリポジトリを GitHub に公開する場合、Vercel の Root Directory は `frontend` に合わせる必要があります。現在の本番設定は変更していません。Cloudflare Worker は `backend/wrangler.production.jsonc` を基準に現行の binding、互換設定、Secret 名、cron を本番と照合してください。migration 0013 はローカルに保全しただけで、本番 D1 には適用していません。
