# DaySync 開発プロジェクト

FrontendとCloudflare Worker Backendの正式な統合開発フォルダ。GitHubの対応先は `rikumonsters-maker/test-project`。現在の本番FrontendはVercel、APIはCloudflare Workers、DBはD1で稼働している。本番への反映は、このローカル統合作業には含まれない。

## 構成

- `frontend/`: 静的Frontend。VercelのRoot Directoryは `frontend`。`vercel.json` が既存APIへのrewriteを保持する。
- `backend/src/`: Workerの実行コード。認証、個人予定の同意制同期、グループ共有、Push・リマインド、アプリ内通知を含む。
- `backend/migrations/`: 現行migration。0001〜0010と0012〜0014を含み、未公開パスワード再設定用の0011は含めない。
- `backend/wrangler.production.jsonc`: Workerの本番用設定。ローカルテストやdry-runで使う際も、deployは別途レビュー・承認して実施する。
- `backend/tools/`: オフラインWorker比較ツールと、インメモリSQLiteでのmigration構成チェック。
- `docs/legacy/`: 旧RCの検証記録、旧設計、未公開機能候補。実行・配信・migration対象外。判断理由は[旧成果物の整理](docs/legacy/README.md)を参照。
- `.local-legacy-archive/`: Git管理外の非公開アーカイブ。旧作業ツリー、Git履歴、ローカルDB等を保管。`frontend/` と `backend/public/` の外に置く。

## ローカル開発と検証

Node.js 24以降を使用する。PowerShellで `npm` の実行が制限される場合は `npm.cmd` を使う。

```powershell
cd frontend
npm.cmd ci
node --test
npm.cmd run dev
```

```powershell
cd backend
npm.cmd ci
npm.cmd test
npm.cmd run typecheck
node tools/verify-migration-layout.mjs
node tools/compare-worker-version.mjs --self-test
node tools/compare-worker-bundle-structure.mjs --self-test
node_modules/.bin/wrangler.cmd deploy --dry-run --config wrangler.production.jsonc --outdir .wrangler/dry-run
```

最後のコマンドはローカルのdry-runビルドのみ。本番WorkerへのdeployやD1 migration適用は行わない。比較ツールはローカルに保存したWorker version応答とdry-run成果物を引数で受け取り、ネットワーク接続やSecret値の取得をしない。

Frontendの個人予定同期は本人の同意後に新しい空のカレンダーから開始する。旧端末内予定を自動移行・自動再送信しない。旧パスワード再設定コードは非公開アーカイブに保管しただけで、現在のAPI・UI・migrationには接続していない。

本番設定・Secret・Cookie・データをローカル検証のために上書きしない。実機のPush到達性と実利用者データの確認はローカルテストだけでは代替できない。
