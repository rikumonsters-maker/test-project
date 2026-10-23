# RC verification report

## Provenance and certainty

- RC build identifier: `DaySync-RC-20261010-1`.
- Backend source reference: Git HEAD `4bb9deb078da1c6bafbbea473ac2578117e2fb35`; the candidate snapshot includes the pre-existing uncommitted sync/privacy work described below.
- Frontend source reference: Git HEAD `073cdb4581a0d608bafba0f9be2c25308f35fe6a`; the candidate snapshot includes the pre-existing uncommitted sync work described below.
- Production reference: Worker `cloudflare-api`, version `76d558be-3652-45c9-8ed4-2f1e2acca20b`; production D1 was reported/apparently verified as migrations 0001–0010 applied, with 0011 and 0012 unapplied.
- The backend commit timestamp is close to the production version creation time and the public-origin annotation is consistent, but no full source-to-bundle mapping proves that the production Worker was built from this exact Git tree. This RC does not assert exact equality.
- The original frontend/backend working trees were only read and copied; they were not edited, reset, staged, committed, pushed, or discarded.

## Candidate changes and exclusions

Candidate source changes retained from the existing dirty trees:

- Frontend integration in `app.js`, `calendar.js`, and `shared.js`, the calendar styling in `style.css`, the personal-sync module/tests, and the existing per-user storage path.
- Backend personal-event API, privacy-safe shared-calendar projection, relevant auth/index integration, migration 0012, and personal-event tests.
- Supporting compatibility source for the existing auth, profile, groups, Push, wishes/tentative events, group icons, and shared calendar.

RC-only changes:

- Replaced misleading group onboarding/sync copy so it says personal events reveal only time plus “予定あり”, while shifts reveal time only; it explicitly says private titles/notes, workplace/pay details, and budgets are not shown to members.
- Removed the unfinished password-recovery and password-change UI/API routes from the RC copy. Added scope tests ensuring these routes and UI are absent.
- Replaced production/local source Wrangler settings in the copy with three local-only configurations. `wrangler.rc-0012.jsonc` uses `migrations-0012-only`, whose sole SQL file is 0012.
- Updated only the backend lockfile to patched, same-major versions of the vulnerable development/test toolchain.
- Added a JSON personal-backup importer for moving data across browser origins/devices. It validates before changing state, merges without replacing current plans, preserves an additional backup, and replays through the existing authenticated sync path.
- Corrected downloaded backups to contain both the current merged/offline-edited state and the immutable original pre-sync snapshot. The original local snapshot is never overwritten.

Migration 0008 is retained only as part of the already-existing D1 schema baseline used to model production; this RC contains no R2 binding or group-image route/implementation. Migration 0011, its table, and password-recovery source/tests are absent.

## Production compatibility assessment

The production bundle/version metadata inspected for the previous release preparation identifies the public Worker version and D1 binding. Static API/feature comparison and the RC test suite indicate that the RC retains the existing authentication/session and explicit credentialed-CORS behavior, group operations, profile, Push API, QR invitation UI, wishes/tentative events, preset icons, and shared calendar. The RC adds `/api/personal/events` and its sync/import operations. The production bundle did not expose these new personal-event routes, so it must be updated before the new frontend is released.

The production bundle’s exact source tree is not proven. Production smoke tests, real Worker settings/secrets, exact production CORS routing, and live Vercel rewrite behavior remain unverified in this RC.

## Migration 0012

`migrations/0012_personal_event_sync.sql` adds:

- `personal_events`, keyed by `(user_id,id)` with a user-scoped import uniqueness constraint and soft-delete/version fields.
- `personal_event_changes` for cursor-based deltas.
- `personal_event_operations` for idempotent mutation replay.
- `personal_sync_users` for activation state.
- A user/date index, a user/sequence change-log index, and insert/update triggers that append change records.
- Foreign keys from each table to `users(id)` with `ON DELETE CASCADE`.

The migration has no `DROP`, table rebuild, or data-clearing statements and depends on the existing `users` table from migration 0003. It does not depend on 0011. Applying 0001–0010 followed by the RC’s 0012-only Wrangler configuration succeeded against local D1. Local schema inspection confirmed the four tables, two triggers, date index, composite keys, and the `users(id)` foreign key with cascade behavior.

The RC’s D1 name is `daysync-rc-local` and its ID is the dummy UUID `00000000-0000-0000-0000-000000000001`. All migration scripts explicitly pass `--local`. There is no production ID or production Wrangler configuration in this repository.

## Sync and privacy behavior

- Personal events are stored in D1 by authenticated `user.id`; list, sync, import, create, update, and delete use the cookie-authenticated user, not a caller-supplied owner ID.
- The browser retains a pre-migration backup in user-keyed localStorage and does not clear the source event data when upload fails. New mutations are queued and replayed idempotently.
- Updates use versions and return conflicts rather than overwriting a newer server state. Deletions are tombstones, so stale devices cannot resurrect them. Sync is retried on startup, focus/visibility/online changes, and periodically.
- Legacy import retry uses the original identity plus full normalized content fingerprint. It does not guess based only on title/time. If two devices have different legacy IDs for the same event, both are retained; this avoids silent data loss but can leave duplicates for user review.
- Shared API responses redact other users’ personal event titles, notes, extra fields, user/member IDs, and source IDs. Other users’ shifts are reduced to time/busy data; availability returns busy/free intervals only. Same-group formal shared events retain their detail. Different-group events are projected as busy intervals. Budget data has no shared-calendar response path.

## Test evidence

- Backend: 40 tests passed across 3 files. `npm run typecheck` passed.
- Frontend: 16 Node tests passed, including backup-import validation/merge and preservation of the immutable original snapshot while exporting current offline edits.
- Backend `npm audit --audit-level=high`: 0 vulnerabilities after updating only the lockfile. The original six High findings were all in the development/test toolchain; none were runtime dependencies used by the shipped Worker. The affected dependency entries and practical conditions are:

  | Entry before fix | Finding / realistic condition | Scope and RC fix |
  | --- | --- | --- |
  | `@cloudflare/vitest-plugin` 1.2.8 | npm marked this dev-only test adapter because its dependency tree included affected Wrangler/Miniflare versions; no separate DaySync runtime bug. | Dev/test only; 1.4.0, still major 1. |
  | `wrangler` 4.141.0 | The CLI/test dependency tree inherited vulnerable Miniflare tooling; it is not bundled as Worker application code. | Dev/deploy tooling only; 4.149.0, still major 4. |
  | `miniflare` 5.20260925.0-alpha | Local Worker simulator dependency; contained vulnerable `sharp` and `undici` paths. Exploit requires unsafe input to be processed by the local test/tool process. | Dev/test only; 5.20261006.1-alpha. |
  | `sharp` 0.35.4 (`CVE-2026-96889`) | librsvg memory bug can lead to RCE on glibc Linux under runtime-specific conditions, notably decoding a suitable SVG. The RC does not use Sharp in its Worker runtime. | Dev tool transitive; 0.35.5. [Advisory](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w). |
  | `source-map-js` 1.2.1 (`CVE-2026-93749`) | An attacker-supplied indexed source map with an extreme section line offset can synchronously block the event loop. It matters if an untrusted map is processed by the toolchain. | Dev/test transitive; 1.2.2. [Advisory](https://github.com/advisories/ghsa-68fv-2mgg-jv7q). |
  | `undici` 7.29.0 (`CVE-2026-19534`, `CVE-2026-84961`) | A hostile WebSocket server can crash a client on an unrequested subprotocol; separately, `BalancedPool` can drop custom TLS verification callbacks. The latter requires use of `BalancedPool` with custom function-valued TLS/connector settings. DaySync does not use `undici`/`BalancedPool` in Worker code. | Dev/test transitive; 7.29.1. [WebSocket advisory](https://github.com/nodejs/undici/security/advisories/GHSA-rfgv-xxqx-mfg5), [TLS advisory](https://github.com/nodejs/undici/security/advisories/GHSA-w293-vg96-wgc3). |

  The six npm High entries are dependency-tree findings (plugin, Wrangler, Miniflare, Sharp, source-map-js, and Undici); Undici carries two advisories. Lockfile updates stayed within the existing major lines and did not use `npm audit fix --force`. The full test and typecheck suite passed after the update. The dependency clean result does not prove that the production Worker was built from these locked tool versions.

- Worker/D1: local migration sequence 0001–0010 and then the dedicated 0012-only configuration succeeded. Schema introspection passed for tables, indexes, triggers, and foreign keys.
- Sync tests cover separate device caches, add/edit/delete/delta propagation, idempotent replay, import retry, ambiguity preservation, offline edits, failed/lost responses, concurrent conflict handling, tombstones, account separation, and owner checks.
- Privacy tests assert private titles, notes, worksite/pay amounts, source event IDs, and user/member IDs are absent from other-member responses; they also exercise auth/owner/group membership checks, redacted availability, and overnight shifts. Same-group formal shared events retain details, while cross-group events return only busy/time information. No expense/budget route is exposed to group calendar responses.
- Local browser QA against the RC Worker (local D1 only): new registration/login, automatic session preservation after reload, authenticated profile, personal event create/edit/sync/delete across two browser origins acting as device caches, local sync failure/retry without data loss, private “予定あり” projection for another member, group calendar, theme switch, and backup/export/import controls rendered. The file-import parser and merge path passed unit tests; browser-runtime restrictions prevented an automated file-chooser upload in this session.
- Viewport checks: at 375px viewport width, document scroll width was 360px; at 1440px, document scroll width was 1425px. No horizontal overflow. Browser console error/warning count was 0 in both test contexts. The app frame intentionally has 15px right inset from browser viewport.
- Push configuration returned 503 because local VAPID secrets were not present; test-only generated VAPID keys cover Push code paths. Native iOS/PWA installation and live Push delivery were not tested.

### Device data migration procedure

Do this separately for every phone/PC, browser profile, and installed PWA context. `localStorage` is isolated by origin and browser profile; the old Vercel origin reported during earlier work was `https://test-project-nu-one-12.vercel.app`, while the canonical origin is `https://daysync-app.vercel.app`. Confirm any other origins actually used before release. Safari and its Home Screen web app must be treated as separate sources; on iOS, the installed web app may not share localStorage with the Safari tab. Do not clear site data, uninstall the PWA, log out of the only session that can still reach a source copy, or abandon the old URL until each source is backed up and checked.

For each source context, first use **移行前バックアップを保存** if that origin already has the button. The downloaded JSON includes current events (including pending/offline edits) plus the immutable pre-sync event snapshot. It excludes expenses, wage settings, and shifts; the broader on-device recovery snapshot remains local and untouched. If an older deployed origin has no button, while still on that exact origin use its browser developer console to inspect/export its own localStorage. The following snippet only reads that browser's localStorage and downloads the selected key's `events` map; it does not send data over the network or change stored data. Review the keys and date/count list before selecting, and run once per relevant key; do not merge keys from different accounts without confirming ownership:

```js
(() => {
  const candidates = Object.keys(localStorage)
    .filter(key => key === 'money-app-v2' || /^daysync-user-[0-9a-f-]{36}$/i.test(key))
    .map(key => ({ key, state: JSON.parse(localStorage.getItem(key) || '{}') }))
    .filter(item => item.state && item.state.events && typeof item.state.events === 'object');
  console.table(candidates.map(({key, state}) => ({
    key,
    dates: Object.keys(state.events).length,
    events: Object.values(state.events).reduce((sum, day) => sum + (Array.isArray(day) ? day.length : 0), 0)
  })));
  const key = prompt('上の一覧から、確認した予定のキーを正確に入力してください');
  const selected = candidates.find(item => item.key === key);
  if (!selected) { alert('キーが一致しません。保存データは変更していません。'); return; }
  const blob = new Blob([JSON.stringify({savedAt:new Date().toISOString(), events:selected.state.events}, null, 2)], {type:'application/json'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'daysync-personal-backup.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
})();
```

Keep one untouched JSON copy per device/context; check it is non-empty and the dates/count look right. Store it privately because personal schedule details are in it. If a device has not been backed up, stop before first sync on it; do not allow another device's empty/stale state to stand in for it.

After Worker and frontend are approved/released, open the new canonical URL on that same device/context, sign into the same account, save an additional fresh backup, then use **別URL・端末のバックアップを取り込む** to import that context's JSON. Import merges plans and preserves existing destination data; it never deletes the source copy. Wait for “同期完了”, export once more, and compare dates/counts. Repeat for every source. If import/sync fails, do not clear local storage or retry with another account; leave both source and downloaded JSON intact, restore connectivity, then retry. If the JSON is malformed, empty, or count mismatches, stop and recover from its original browser storage/backup before continuing. Re-import is idempotent for a matching source ID plus full normalized content; plans with different IDs are intentionally retained even when title/time look similar. Resolve apparent duplicates/competing edits manually only after the backups are verified.

### Production configuration and release gates

The RC contains no production credentials/config. `wrangler.rc-0012.jsonc` is intentionally local-only (`remote:false`) and has dummy D1 ID `00000000-0000-0000-0000-000000000001`; never deploy using it. Before any approved release, create a separate reviewed release checkout/config outside this RC, verify the live production D1 ID/binding and applied migration list read-only, set `migrations_dir` to a directory containing only `0012_personal_event_sync.sql`, and verify the resulting diff/config against the actual production target. Never put the production ID into the RC config. Stop if migration 0011 is present/unexpected, the account/Worker/database identity is ambiguous, 0001–0010 differ from the stated baseline, the 0012-only config resolves another migration, or a backup cannot be restored/verified. No production configuration was created or used here.

## Proposed production release sequence (approval required)

1. **D1 backup.** After explicit approval, read-only verify the production account, Worker binding, exact D1 identity, and migration list. Export a dated SQL backup to secure storage and record the latest D1 Time Travel bookmark if available. Verify the export is non-empty and can be inspected. Stop if target identity, backup, or restore approach is uncertain.
2. **Existing device backups.** Before any new frontend can trigger first sync, export from each old URL/new URL, device, browser profile, Safari tab, and Home Screen/PWA context as described above. Verify each JSON and count. Stop if any source device is inaccessible or not backed up; do not assume another device is complete.
3. **Migration 0012 only.** In a separate reviewed production config, verify the D1 binding points to the exact production D1 and `migrations_dir` contains only 0012. Re-read the migration contents and planned apply list; confirm 0011 is absent and 0001–0010 match. Apply only after approval, then read-only inspect `d1_migrations`, tables, triggers, indexes, and foreign keys. Stop on any unexpected change/error; do not run rollback/drop SQL.
4. **Worker deployment.** Build/deploy a reviewed Worker containing the RC API plus all currently required production compatibility features/secrets/bindings. Since exact source-to-production bundle identity is not proven, first reconcile production features/API/config with the candidate; stop if any production feature or CORS/origin/session behavior would be lost. Verify version and deployment health.
5. **API/privacy smoke test.** Before frontend rollout, check `/api/auth/me`, account-scoped personal event list/sync/import, unauthenticated rejection, owner isolation, group membership, same-group detail, cross-group busy-only projection, shifts without workplace/pay, and no expense data leakage. Inspect response JSON, not only the UI. Stop for any unexpected field, CORS/cookie issue, or non-2xx required endpoint.
6. **Frontend production release.** Only after Worker and privacy checks pass, release frontend. Do not rewrite Vercel access settings. Verify canonical URL, login/autologin/logout, and no API errors.
7. **PC/mobile sync.** Import backups from each source context one by one. Verify count/date ranges after sync; add/edit/delete on PC and confirm mobile, repeat in reverse. Keep JSON and old browser storage until all source/destination checks pass.
8. **Rollback/incident.** If Worker/API fails before frontend rollout, keep old frontend and roll Worker back to its prior version. If frontend is already live, first roll frontend back to a build that does not require the new endpoints, then roll Worker back if compatible. Do not drop 0012 or discard localStorage/backup files; the schema is additive and may contain new records. Prefer a forward fix. D1 point-in-time restore is a last resort only after an explicit approval because it can overwrite all database changes since that time; preserve post-backup records separately first.

No production operation has been performed by this RC task.

## Rollback and remaining risks

- If the Worker fails before the frontend is promoted, keep the old frontend and roll back the Worker version. If the frontend has already been promoted, first roll the frontend back to a version that does not call personal-event APIs, then roll back the Worker.
- Do not reverse 0012 by dropping its tables. The migration is additive, and new personal-event data may already have been written. Keep the schema/tables and fix forward; localStorage backups remain the recovery source for each migrating device.
- The exact production source-to-bundle mapping is still uncertain. The RC has only static compatibility evidence, not a production-equivalent secret/binding/runtime test. This is a release gate, not a proven match.
- Different legacy IDs for semantically identical events can create duplicates, which are intentionally preserved instead of silently merged.
- No real production D1 backup/restore rehearsal, Worker deploy, live CORS/cookie test, real Push delivery, native iOS/PWA test, or automated backup file-picker interaction was performed. Local UI layout and browser console checks were done at the requested sizes, but final physical-device verification remains required.
- Release can be considered only after production source/config compatibility is reconciled, all device backups are verified, and the user explicitly approves each production write/deploy stage. Do not proceed merely because the local tests passed.
