import type { PushEnv } from './push';
import { queueScheduleNotice } from './schedule-notices';

type Due={id:string;group_id:string;response_deadline:string;deadline_notified_at:string|null;
  reminder_notified_at:string|null};

export async function drainScheduleNotices(env:PushEnv):Promise<void> {
  const now=new Date().toISOString();
  const inDay=new Date(Date.now()+24*3600000).toISOString();
  const inHour=new Date(Date.now()+3600000).toISOString();
  const rows=await env.DB.prepare(`SELECT s.id,s.group_id,s.response_deadline,s.deadline_notified_at,s.reminder_notified_at
    FROM group_schedules s JOIN groups g ON g.id=s.group_id AND g.closed_at IS NULL
    WHERE s.state='open' AND s.response_deadline>?1 AND s.response_deadline<=?2
    AND (s.reminder_notified_at IS NULL OR (s.response_deadline<=?3 AND s.deadline_notified_at IS NULL))
    ORDER BY s.response_deadline,s.id LIMIT 20`).bind(now,inDay,inHour).all<Due>();
  for(const plan of rows.results) {
    if(!plan.reminder_notified_at) {
      const unanswered=await env.DB.prepare(`SELECT m.user_id FROM group_schedule_participants p
        JOIN active_group_members m ON m.id=p.member_id AND m.group_id=?2
        WHERE p.schedule_id=?1 AND EXISTS(SELECT 1 FROM group_schedule_options o
          LEFT JOIN group_schedule_votes v ON v.option_id=o.id AND v.member_id=p.member_id
          WHERE o.schedule_id=p.schedule_id AND o.cancelled_at IS NULL AND v.response IS NULL)`)
        .bind(plan.id,plan.group_id).all<{user_id:string}>();
      await queueScheduleNotice(env,plan.group_id,plan.id,unanswered.results.map(row=>row.user_id),
        'schedule_reminder','schedule-reminder:'+plan.id+':'+plan.response_deadline);
      await env.DB.prepare(`UPDATE group_schedules SET reminder_notified_at=?1
        WHERE id=?2 AND state='open' AND reminder_notified_at IS NULL AND response_deadline>?1
        AND EXISTS(SELECT 1 FROM groups g WHERE g.id=group_schedules.group_id AND g.closed_at IS NULL)`)
        .bind(now,plan.id).run();
    }
    if(plan.response_deadline<=inHour&&!plan.deadline_notified_at) {
      const members=await env.DB.prepare(`SELECT m.user_id FROM group_schedule_participants p
        JOIN active_group_members m ON m.id=p.member_id AND m.group_id=?2 WHERE p.schedule_id=?1
        UNION SELECT m.user_id FROM group_schedules s JOIN active_group_members m
        ON m.id=s.manager_member_id AND m.group_id=s.group_id WHERE s.id=?1 AND s.group_id=?2`)
        .bind(plan.id,plan.group_id).all<{user_id:string}>();
      await queueScheduleNotice(env,plan.group_id,plan.id,members.results.map(row=>row.user_id),
        'schedule_deadline','schedule-deadline:'+plan.id+':'+plan.response_deadline);
      await env.DB.prepare(`UPDATE group_schedules SET deadline_notified_at=?1
        WHERE id=?2 AND state='open' AND deadline_notified_at IS NULL AND response_deadline>?1
        AND EXISTS(SELECT 1 FROM groups g WHERE g.id=group_schedules.group_id AND g.closed_at IS NULL)`)
        .bind(now,plan.id).run();
    }
  }
}
