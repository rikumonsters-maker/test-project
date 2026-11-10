# DaySync 開発ガイド

## 正式な構成

- `frontend/` は唯一の現行Frontendです。画面、スタイル、PWA、Service Worker、ブラウザー用モジュールはこのディレクトリを編集してください。
- `backend/` はCloudflare WorkerとD1のコードです。
- `scripts/`、`.github/`、`docs/` は安全検査、CI、リリース手順を管理します。
- Vercel ProductionのRoot Directoryは `frontend` です。`frontend/vercel.json` が `/api/*` を本番Workerへrewriteします。

リポジトリ直下にあった旧Frontend本体と重複アセットは、現行コード・CI・本番配信から参照されないことを確認して削除しました。Root Directoryを独立に返さないVercel API応答があったため、直下の `vercel.json` はAPI rewriteの保守用コピーとして残しています。

## 開発サーバー

Frontend依存を一度インストールします。

```powershell
npm.cmd --prefix frontend ci
```

どちらのディレクトリから起動しても同じ `frontend/` がポート5500で提供されます。

```powershell
# リポジトリ直下から
npm.cmd run dev

# または frontend/ から
Set-Location frontend
npm.cmd run dev
```

開発時は `http://localhost:5500` または `http://127.0.0.1:5500` を使用します。`PORT` 環境変数でポートを変更できます。認証・APIを確認する場合は別ターミナルでローカル専用WorkerとD1を起動してください。

```powershell
Set-Location backend
npm.cmd run dev
```

ローカルAPIはFrontendと同じホスト名の8787番を使います。localhostと127.0.0.1を混在させないでください。本番Workerや本番D1へ接続する開発設定は使わないでください。

## テスト・確認

```powershell
# Frontend単体テスト
Set-Location frontend
node --test

# Browser E2E（合成ユーザーと隔離したローカルWorker/D1）
npm.cmd ci
npm.cmd run test:e2e

# Backendテスト・型チェック
Set-Location ../backend
npm.cmd ci
npm.cmd test
npm.cmd run typecheck
npx.cmd wrangler deploy --dry-run --config wrangler.production.jsonc --outdir "$env:TEMP/daysync-worker-dry-run"

# PR安全性テスト（リポジトリ直下）
Set-Location ..
node --test scripts/*.test.mjs
```

Browser E2Eは専用のローカルD1を使用し、migration 0011を適用しません。実行前に `docs/isolated-browser-e2e.md` を確認してください。

## 旧起動方法との互換性

リポジトリ直下の `npm run dev` と `node dev-server.mjs` は、互換用ランチャーとして `frontend/dev-server.mjs` に委譲します。直下には旧画面を戻さず、今後のFrontend変更は `frontend/` のみで行ってください。
