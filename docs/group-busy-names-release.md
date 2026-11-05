# Group busy names: release gates for PR #20

## Policy and announcement

At 2026-11-06 18:00 JST (09:00 UTC), every active member of a group can see another active
member's display name and busy time in that group. Before this instant the
server retains the historical ON/OFF and notice-acknowledgement gates for all
named-busy responses and the cached Frontend setting API. After this instant
the old named-busy OFF value and notice acknowledgement do not gate the result.
The switch uses server time at each API request and needs no second deploy. Personal calendar sync
consent remains separate. Other-group events are anonymous; personal titles,
notes, workplaces, pay and budget data are not returned.

Before changing the production Worker, notify existing affected users through
an established channel that reaches users who have not opened the current app
or still have an old tab. Use this text:

> 共有カレンダーの表示方法が変わります。同じグループのメンバーには、あなたの表示名と予定が入っている時間帯が表示されます。予定の内容、勤務先、給与、家計簿は共有されません。個人予定の同期に関する設定は変わりません。

Record the channel, dispatch time, audience, delivery result and effective
time without including private event data. An in-app message displayed only
after a visit does not establish pre-release delivery. The new group join
explanation is useful for future members but does not notify existing members.
No per-user consent, acknowledgement or ON/OFF setting is required. If a
suitable announcement channel or evidence of dispatch is unavailable, stop
before the Worker deployment and report NO-GO.

## Release sequence

1. Confirm the exact PR HEAD and all four CI jobs, Preview, D1 schema through
   0020, current Worker configuration, backup and recovery Worker. Do not run
   any migration; 0011 remains intentionally unapplied.
2. The five existing members were sent the announcement on 2026-11-05 JST,
   explicitly promising no change before 2026-11-06 18:00 JST. Do not send
   additional mail. Verify the record of delivery and the exact cutoff.
3. Deploy the new Backend first. Before the cutoff, check that legacy OFF
   remains anonymous, legacy ON remains named, old setting GET/POST works,
   and the old Frontend remains compatible. After the cutoff, check
   same-group names, other-group anonymity, detail redaction, and 409 on
   old ON/OFF updates. A cached old tab may still show the obsolete toggle;
   its update must not claim success after the cutoff. Monitor
   Cron and Worker errors. Stop on unexpected API, privacy or data changes.
4. Confirm PR HEAD and protected checks again. Change Draft to Ready and merge
   through branch protection only after separate release authorization.
5. Confirm Vercel Production READY at the merge SHA and official domain, then
   perform read-only smoke checks and monitor errors. Refresh or reopen cached
   tabs to obtain the new UI. Check iPhone Safari and PWA separately.

## Recovery

Do not restore a Worker that is incompatible with the current D1 schema.
If the new Frontend fails, keep a compatible Worker and consider the last
healthy Frontend deployment. If the Backend or privacy behavior fails, stop
the rollout and decide on a compatible recovery Worker after inspecting the
effect of already disclosed names. Do not automatically restore D1 or alter
existing users' data.
