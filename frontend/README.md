# DaySync frontend

正式な公開URL: https://daysync-app.vercel.app/

正式Originは `config.mjs` の `PUBLIC_APP_ORIGIN` に集約しています。QR招待と通知タップはこのURLを使用し、API・manifest・PWAアイコンは相対パスを維持します。

旧URL https://test-project-nu-one-12.vercel.app/ も移行期間中は利用できます。Cookie・localStorage・Push購読・ホーム画面アプリはOriginごとに保存されるため、新URLでは一度ログインしてください。旧URLの個人データは削除されませんが、新URLへ自動コピーされません。既存の個人データを確認する際は旧URLを使用してください。

## ローカル認証の確認

VS Codeでターミナルを2つ開き、次を実行します。PowerShellでは `npm.cmd` を使用できます。

backend:

```powershell
cd backend
npm.cmd run db:local
npm.cmd run dev
```

frontend:

```powershell
cd frontend
npm.cmd run dev
```

`http://localhost:5500` または `http://127.0.0.1:5500` を開きます。
VS Code Live Serverの5500番も使用できます。`file://` では認証できません。

- frontendがlocalhostならAPIは `http://localhost:8787`、127.0.0.1なら `http://127.0.0.1:8787` です。ホストを混在させないでください。
- API設定は `config.mjs` に集約しています。Workerのポート変更時は `LOCAL_WORKER_PORT` と `backend/wrangler.local.jsonc` の `dev.port` を揃えます。
- CORSは開発用設定かつローカルHTTPのWorkerに限り、localhost / 127.0.0.1 の5500・3000・5173・8767番を明示的に許可します。frontendのポートを追加する場合は `backend/src/development.ts` の一覧を編集します。
- Cookieは開発用ローカルHTTPのみSecureなし。それ以外はSecureを付け、常にHttpOnly / SameSite=Laxです。全APIで `credentials: "include"` を維持しています。
- 本番はAPIの相対URL `/api/...` と既存の `vercel.json` のCloudflare Workerへのrewriteを使用します。本番へ直接クロスサイト接続する設定には変更しません。
- 開発用Workerは `wrangler.local.jsonc` と専用ローカルD1（`daysync-local`）を使用します。本番の `wrangler.jsonc`・DB・Workerには接続しません。

新規登録後は自動ログインします。再読み込み後もログインが維持され、上部のプロフィールリンクからログアウトできます。ログイン画面で再ログインして確認してください。
