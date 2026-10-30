# PR #16 公開ゲートと実行順序

この文書は2026-10-30時点の準備記録。PR #16はDraftのまま。Frontend公開には別途明示的なマージ承認が必要。

## 完了済みの本番段階

- D1 `money-app-shared` (`142e6c05-b703-4825-828b-b6dd702c38bd`) に**0019_named_busy_sharing.sqlを1件だけ適用済み**。journalは19件、0011は未適用、0018・0019は適用済み、外部キー違反は0件。0019を再適用しない。
- 2026-10-29のSQL exportをGit管理外でDPAPI暗号化し、SHA-256照合と隔離復元を検証済み。Time Travel bookmarkも取得済み。復元・Time Travelの実行は別途判断する。
- 0019対応Worker `cloudflare-api` version `aa1e80ce-31ca-4da6-8519-a3273872602d` を100%配信中。再デプロイしない。
- 旧Frontendから個人予定同期、共有予定一覧、通知件数の読み取りAPIを各2件、計6件すべてHTTP 200で確認。ログイン済みの主要画面も表示確認済み。
- Cron scheduledイベントはoutcome `ok`。確認された期間のWorkers Logsで重大な異常は報告されていないが、通知の実送信成功や観測期間外の正常性までは示さない。Consoleの表示範囲に赤いJavaScript例外やCORSエラーなし。Chrome Issuesの詳細とSafari/PWA実機は未確認。

## マージ直前ゲート

1. PRのbaseが`main`、headが承認対象SHA、Draft・Open、必須チェック成功、自動マージopt-inなしであることを確認する。ドキュメント更新などでheadが変わった場合は新しいSHAとチェックを照合する。
2. Workerの上記versionが100%配信中で、D1 binding、Cron、Secret名、assets、Routes、Observabilityに想定外の変化がないことを読み取り専用で確認する。
3. D1 journalで0011未適用、0018・0019適用済み、外部キー違反0件を読み取り専用で確認する。バックアップと復旧手段を保持する。
4. 旧Frontendとの互換性と個人予定の匿名化を確認する。実データを変更する試験はしない。

いずれかに不一致や重大な異常があればマージを停止する。**D1 migrationとWorker公開は既に完了しているため、この手順で繰り返さない。**

## 残る公開手順

1. ユーザーの明示的な承認後、PR #16をReadyにし、ブランチ保護に従って通常マージする。`--admin`や自動マージopt-inを使用しない。
2. VercelのGitHub連携による自動Production deployを待つ。READY、配信元のマージSHA、正式ドメイン、HTTP応答、Production Verifyを照合する。追加の手動deployはしない。
3. iPhone Safari/PWAで名前付き「予定あり」、未同意の匿名表示、同意ON/OFF、グループ・月・日付切替、折りたたみ、空き時間、既存共有予定を本人が確認する。通知・Cron・APIエラーを公開後も監視する。

## 異常時

- Frontend障害: 0019対応Workerを維持し、直前の正常なFrontend deploymentへの復旧を検討する。
- Worker障害: 0018/0019非対応Workerへ戻さない。0019対応の復旧用Workerの影響を確認し、使用には別途承認を得る。
- データ異常: 書き込みを増やさず影響範囲を確定する。SQLバックアップとTime Travelは復旧候補として保持し、後続更新への影響を評価してから別途判断する。自動復元しない。
