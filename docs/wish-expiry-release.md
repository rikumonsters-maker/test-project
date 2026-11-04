# Shared busy labels and play-day expiry

> Historical PR #19 release record. PR #20 changes the named busy policy; use
> `docs/group-busy-names-release.md` for its release gates. The legacy OFF and
> acknowledgement statements below describe the policy before PR #20.

## Data policy

- Calendar and date detail show a name only when `/api/shared/events/list` supplies `busyDisplayName`. The existing notice and group authorization policy stays in the Worker. A legacy OFF member who has not acknowledged the notice remains anonymous. Matching a timeline interval never identifies an event owner.
- A wish is active through the end of its `wish_date` in Asia/Tokyo. Both the list API and the UI exclude older dates. Create, edit, reaction and conversion from an expired wish are rejected. Existing confirmed events and schedules remain available through their own APIs.
- The existing minute Cron runs a cleanup query only at 00:05 JST. It physically removes an expired, open proposal only when it has no reaction, shared event, schedule, inbox notice or queued Push referring to it, and the original owner still manages it. All other proposals and linked history remain in D1 but are absent from the wish list. The query is safe to repeat. No migration or new Cron Trigger is required.

## Release sequence

1. Confirm the Draft PR's exact HEAD, CI, local Worker and D1 tests, Worker configuration, and current production D1 schema (0020 applied; 0011 intentionally absent). Do not run a general migration apply.
2. Confirm the current encrypted backup and Time Travel bookmark. Record the current Worker version and settings. Obtain separate approval for a Worker deployment.
3. Deploy the new Worker first with `backend/wrangler.production.jsonc`. The old Frontend can continue to call the same APIs; it will receive only active wishes. Check authentication, list responses, old Frontend reads, Cron and error logs. Stop if data or API behavior is abnormal. Do not restore a Worker incompatible with the current D1 schema.
4. After the Worker is healthy, merge the PR through branch protection to let Vercel deploy the new Frontend. Confirm the Production deployment SHA, READY, official domain, Production Verify and static assets.
5. Check a consented and an anonymous busy event in the calendar, a wish on today's date, and a previously expired wish using synthetic or authorized read-only checks. Monitor the next 00:05 JST cleanup and confirm that linked history remains. Do not change user data as part of a smoke test.

## Limits

- A missed 00:05 Cron delays physical cleanup until a later day. API and UI expiry remain effective independently.
- Existing historical rows with references are intentionally retained. This preserves notifications, reactions, confirmed events and schedules.
- iPhone Safari and home-screen PWA need a separate device check after release.
