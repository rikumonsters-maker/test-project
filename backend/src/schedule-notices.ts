import type { PushEnv } from './push';

export type ScheduleNoticeKind='schedule_started'|'schedule_option_added'|'schedule_deadline'|
  'schedule_reminder'|'schedule_confirmed'|'schedule_changed'|'schedule_cancelled';

export const scheduleMessages:Record<ScheduleNoticeKind,string>={
  schedule_started:'新しい日程調整が始まりました',
  schedule_option_added:'日程調整に候補日時が追加されました',
  schedule_deadline:'日程調整の回答期限が近づいています',
  schedule_reminder:'日程調整に未回答の候補があります',
  schedule_confirmed:'日程調整から共有予定が確定しました',
  schedule_changed:'日程調整の候補または予定が変更されました',
  schedule_cancelled:'日程調整がキャンセルされました',
};

export function schedulePath(groupId:string,scheduleId:string):string {
  return '/?'+new URLSearchParams({group:groupId,scheduleId}).toString();
}

// The inbox write is independent of Push permission. Dedupe keys survive Cron
// retries and a recipient must still be an active member when rows are made.
export async function queueScheduleNotice(env:PushEnv,groupId:string,scheduleId:string,
  recipientUserIds:string[],kind:ScheduleNoticeKind,dedupeKey:string):Promise<void> {
  const ids=[...new Set(recipientUserIds)];
  if (!ids.length) return;
  const markers=ids.map(()=>'?').join(',');
  const now=new Date().toISOString();
  const path=schedulePath(groupId,scheduleId);
  await env.DB.prepare(`INSERT OR IGNORE INTO in_app_notifications
    (id,user_id,group_id,kind,target_path,dedupe_key,created_at,schedule_id,schedule_kind)
    SELECT lower(hex(randomblob(16))),m.user_id,?1,'group_event_updated',?2,?3,?4,?5,?6
    FROM active_group_members m JOIN group_schedules plan ON plan.id=?5 AND plan.group_id=m.group_id
    WHERE m.group_id=?1 AND m.user_id IN (${markers}) AND
      (plan.manager_member_id=m.id OR EXISTS(SELECT 1 FROM group_schedule_participants p
        WHERE p.schedule_id=plan.id AND p.member_id=m.id))
      AND ((?6='schedule_confirmed' AND plan.state='confirmed')
        OR (?6='schedule_cancelled' AND plan.state='cancelled')
        OR (?6 NOT IN ('schedule_confirmed','schedule_cancelled') AND plan.state='open'))
      AND (?6 NOT IN ('schedule_deadline','schedule_reminder') OR plan.response_deadline>?4)`)
    .bind(groupId,path,dedupeKey,now,scheduleId,kind,...ids).run();
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return;
  await env.DB.prepare(`INSERT OR IGNORE INTO push_deliveries
    (id,subscription_id,group_id,kind,body,created_at,next_attempt_at,scope,recipient_user_id,
      target_path,dedupe_key,schedule_id)
    SELECT lower(hex(randomblob(16))),s.id,?1,?2,?3,?4,?4,'group',s.user_id,?5,?6||':'||s.id,?7
    FROM push_subscriptions s JOIN active_group_members m ON m.user_id=s.user_id
    JOIN group_schedules plan ON plan.id=?7 AND plan.group_id=m.group_id
    WHERE m.group_id=?1 AND s.user_id IN (${markers}) AND
      (plan.manager_member_id=m.id OR EXISTS(SELECT 1 FROM group_schedule_participants p
        WHERE p.schedule_id=plan.id AND p.member_id=m.id))
      AND ((?2='schedule_confirmed' AND plan.state='confirmed')
        OR (?2='schedule_cancelled' AND plan.state='cancelled')
        OR (?2 NOT IN ('schedule_confirmed','schedule_cancelled') AND plan.state='open'))
      AND (?2 NOT IN ('schedule_deadline','schedule_reminder') OR plan.response_deadline>?4)`)
    .bind(groupId,kind,scheduleMessages[kind],now,path,dedupeKey,scheduleId,...ids).run();
}
