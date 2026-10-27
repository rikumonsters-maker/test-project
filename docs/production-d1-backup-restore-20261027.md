# 本番D1 SQLバックアップ・隔離復元検証（2026-10-27）

本レポートにSQL本文、実データ行、認証情報は含めない。作業は本番D1の読み取り・exportと、Git管理外の隔離ローカルD1だけで実施した。本番migration、Worker、Vercelは変更していない。

## 対象とexport

- Cloudflare OAuthのアカウントと `money-app-shared` のID `142e6c05-b703-4825-828b-b6dd702c38bd` を直前に照合。
- 本番journalは0001～0010、0012、0013、0014、0014a、0015。0011と0016～0018は未適用。Time Travel bookmarkを取得し、Git管理外の `pre-export-bookmark.json` に記録した（値は本レポートに記載しない）。
- [Cloudflareのexport仕様](https://developers.cloudflare.com/d1/best-practices/import-export-data/)ではexport中に他のDB要求がブロックされる。利用者が現在の短時間停止を許容した後、Wrangler正式の `d1 export --remote` で全スキーマ・全データを取得。export後の本番D1読み取りと外部キー確認は成功。
- SQL作成時刻：2026-10-27 00:50:50 UTC（09:50:50 JST）。元SQLは60,235 bytes、SHA-256 `43A1843E4017CEEBD94D5689BDC6C90E2250ECA3C229538E72FE491226E0FFF4`。UTF-8で読め、テーブル定義、INSERT、migration journal、共有・個人予定テーブルを含むことを確認。
- 保存先：`C:\Users\hp\Documents\DaySync-Production-D1-Backup-20261027\money-app-shared-20261027T005044Z.sql.dpapi`（Git管理外）。DPAPI暗号化後60,454 bytes、SHA-256 `21024CCF9181F1F614D43865E850E36716673C9024E351638A50520EF8BF1AFB`。フォルダACLは本人とSYSTEMのみ。EFSはこのPCで非対応。

## 隔離復元

Wranglerの元export SQLをそのまま新規ローカルD1へ実行すると、`users`作成前に参照する行があり、`no such table: main.users` で失敗した。[Cloudflareに報告済みのexport順序問題](https://github.com/cloudflare/workers-sdk/issues/5683)と同種の現象である。**元SQLは変更していない。** Git管理外の `make-local-restore.mjs` が、元SQLをSQLiteメモリDBに読み込み、全テーブルを作成した後、外部キーの依存順にデータを並べる復元専用SQLを生成した。このSQLもDPAPIで別途保全した。

`wrangler d1 execute --local --persist-to` で復元専用SQLを、本番IDと異なるIDを持つ新規ローカルD1へ取り込んだ。復元DBは独立した `pristine-state-v3` のスナップショットとして保全し、migrationを適用していない。暗号化済みファイルは同フォルダの `pristine-state-v3.zip.dpapi`。元ZIP内の9ファイルすべてについて作業コピーとのSHA-256一致、DPAPI復号後のZIP全体のハッシュ一致を確認した。

| 件数 | export直前の本番 | 復元DB | 0018後の別DB |
|---|---:|---:|---:|
| グループ | 13 | 13 | 13 |
| メンバー計 / 有効 / 退出済み | 12 / 11 / 1 | 12 / 11 / 1 | 12 / 11 / 1 |
| 共有予定 | 2 | 2 | 2 |
| 募集 | 2 | 2 | 2 |
| 個人予定 | 12 | 12 | 12 |
| アカウント | 5 | 5 | 5 |
| Push購読 / 未送信 | 2 / 0 | 2 / 0 | 2 / 0 |
| アプリ内通知 / リマインダー | 9 / 1 | 9 / 1 | 9 / 1 |
| カレンダー記録 / 募集反応 | 11 / 3 | 11 / 3 | 11 / 3 |
| 外部キー違反 | 0 | 0 | 0 |

復元DBのjournalは本番と同じ15件。0014a・0015の保護トリガー、`active_group_members`ビューを確認した。SQLite `integrity_check` は `ok`。実データ行を出力せずに、migration journalと内部メタデータを除く既存18テーブルの元の列・全行をハッシュで照合した。

## 実データの隔離migrationリハーサル

同じ復元用SQLを**別ID・別永続化ディレクトリ**のローカルD1に取り込み、元の復元DBは変更せず、0016→0017→0018を各1件ずつWranglerで適用した。適用前に各SQLコピーのSHA-256一致と対象1件のみを確認した。

- 0016、0017、0018：順に成功。journalは18件となり、0011は入っていない。
- 0014a・0015の保護トリガー、0018の旧Worker Push取得・共有予定更新ガード、`active_group_members`ビュー、新Worker用テーブル・列を確認。
- 既存18テーブルの元の列・全行は元の復元DBと一致。外部キー違反0件、両DBのSQLite `integrity_check` は `ok`。日程調整・投票の新規テーブルは本番バックアップ時点で0件。
- 検証後の別DBも `rehearsal-state.zip.dpapi` に暗号化して保全。ZIP内9ファイルのハッシュとDPAPI復号後のハッシュを確認。

## 復元方法と残るリスク

Git管理外の `restore-dpapi.ps1` を**同じWindowsアカウント・ユーザープロファイル**で実行し、`.sql.dpapi` から一時SQLを復号する。復号スクリプトの出力SQLが元SQLのSHA-256と一致することを実測した。新しい空のローカルD1へは、`restore-reordered.sql.dpapi` を同様に復号してから `wrangler d1 execute --local --persist-to` で取り込む。復元先に本番D1のIDや `--remote` を使用しない。

- DPAPIはこのWindowsアカウントに依存する。PC、Windowsプロファイル、DPAPI鍵を失うと暗号化ファイルを復号できない。別媒体に保管する場合も、復号手段の計画が必要。
- EFSが非対応のため、exportと検証の間はACL制限フォルダに平文SQL・SQLite作業コピーが存在した。DPAPIコピーは検証済みだが、実行環境の自動安全審査が `Remove-Item` を「blocked by policy」で拒否したため、**平文のSQL、ZIP、隔離DB作業コピーは現時点で残っている**。本人とSYSTEMだけにACLを制限したフォルダから、検証済みの暗号化ファイル・スクリプト・設定・bookmarkを残して平文作業コピーだけを手動で整理する必要がある。削除後もストレージ上の残存を完全消去したとは証明できない。
- 元export SQLは順序の問題で直接インポートできない。復元専用SQLと生成スクリプトを暗号化バックアップと共に保持する必要がある。
- バックアップは取得時点のスナップショット。公開直前にもD1 ID、journal、件数、Time Travel、Worker設定を再確認する。橋渡しWorker中は個人リマインダーのCronも止まる。

バックアップの取得・復元・実データmigration検証は成功した。**本番公開準備ゲートは現時点でNO-GO**。平文作業コピーの手動整理と、暗号化済みファイルの存続確認を終えてから再判定する。本レポート作成時点で本番公開は開始していない。
