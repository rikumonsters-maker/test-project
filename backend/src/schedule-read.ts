import type { ScheduleMember,ScheduleRow } from './schedule-core';
import { json,schedule,text } from './schedule-core';

export async function listSchedules(db:D1Database,member:ScheduleMember):Promise<Response> {
  const rows=await db.prepare(`SELECT s.id,s.title,s.description,s.response_deadline,s.minimum_participants,
    s.require_all,s.state,s.source_wish_id,s.confirmed_event_id,s.created_by_user_id,
    s.manager_member_id,s.updated_at,
    (SELECT COUNT(*) FROM group_schedule_options o WHERE o.schedule_id=s.id AND o.cancelled_at IS NULL) AS option_count
    FROM group_schedules s WHERE s.group_id=?1 AND (s.manager_member_id=?2 OR EXISTS
      (SELECT 1 FROM group_schedule_participants p WHERE p.schedule_id=s.id AND p.member_id=?2))
    ORDER BY s.updated_at DESC,s.id DESC LIMIT 50`).bind(member.group_id,member.id).all<{
      id:string;title:string;description:string;response_deadline:string;minimum_participants:number;
      require_all:number;state:string;source_wish_id:string|null;confirmed_event_id:string|null;
      created_by_user_id:string;manager_member_id:string;updated_at:string;option_count:number;
    }>();
  return json({schedules:rows.results.map(row=>({id:row.id,title:row.title,description:row.description,
    responseDeadline:row.response_deadline,minimumParticipants:row.minimum_participants,
    requireAll:Boolean(row.require_all),state:row.state,sourceWishId:row.source_wish_id,
    confirmedEventId:row.confirmed_event_id,creatorUserId:row.created_by_user_id,
    canManage:row.manager_member_id===member.id,optionCount:row.option_count,updatedAt:row.updated_at}))});
}

type VoteRow={option_id:string;event_date:string;starts_at:string;ends_at:string;cancelled_at:string|null;
  member_id:string;user_id:string;display_name:string;response:'yes'|'maybe'|'no'|null;
  maybe_confirmed_at:string|null};

export async function getSchedule(db:D1Database,member:ScheduleMember,id:unknown):Promise<Response> {
  const plan=await schedule(db,member.group_id,id);
  if(!plan) return json({error:'日程調整が見つかりません'},404);
  const manager=plan.manager_member_id===member.id;
  if(!manager && !await db.prepare('SELECT 1 FROM group_schedule_participants WHERE schedule_id=?1 AND member_id=?2')
    .bind(plan.id,member.id).first()) return json({error:'この日程調整を見る権限がありません'},403);
  const rows=await db.prepare(`SELECT o.id AS option_id,o.event_date,o.starts_at,o.ends_at,o.cancelled_at,
    m.id AS member_id,m.user_id,COALESCE(u.display_name,m.display_name) AS display_name,
    v.response,v.maybe_confirmed_at
    FROM group_schedule_options o JOIN group_schedule_participants p ON p.schedule_id=o.schedule_id
    JOIN active_group_members m ON m.id=p.member_id AND m.group_id=?2
    LEFT JOIN users u ON u.id=m.user_id
    LEFT JOIN group_schedule_votes v ON v.option_id=o.id AND v.member_id=m.id
    WHERE o.schedule_id=?1 ORDER BY o.event_date,o.starts_at,o.id,m.id`)
    .bind(plan.id,member.group_id).all<VoteRow>();
  const options=new Map<string,{id:string;date:string;start:string;end:string;cancelled:boolean;
    yes:number;maybe:number;no:number;unanswered:number;myVote:string|null;myMaybeConfirmed:boolean;
    participants:{memberId:string;userId:string;name:string;vote:string|null;maybeConfirmed:boolean}[]}>();
  for(const row of rows.results) {
    let option=options.get(row.option_id);
    if(!option) {
      option={id:row.option_id,date:row.event_date,start:row.starts_at,end:row.ends_at,
        cancelled:Boolean(row.cancelled_at),yes:0,maybe:0,no:0,unanswered:0,myVote:null,
        myMaybeConfirmed:false,participants:[]};
      options.set(row.option_id,option);
    }
    if(row.response==='yes') option.yes++;
    else if(row.response==='maybe') option.maybe++;
    else if(row.response==='no') option.no++;
    else option.unanswered++;
    if(row.member_id===member.id) {
      option.myVote=row.response;
      option.myMaybeConfirmed=Boolean(row.maybe_confirmed_at);
    }
    if(manager) option.participants.push({memberId:row.member_id,userId:row.user_id,
      name:row.display_name,vote:row.response,maybeConfirmed:Boolean(row.maybe_confirmed_at)});
  }
  const activeCount=await db.prepare(`SELECT COUNT(*) AS count FROM group_schedule_participants p
    JOIN active_group_members m ON m.id=p.member_id AND m.group_id=?2 WHERE p.schedule_id=?1`)
    .bind(plan.id,member.group_id).first<{count:number}>();
  return json({schedule:{id:plan.id,groupId:plan.group_id,title:plan.title,description:plan.description,
    creatorUserId:plan.created_by_user_id,managerMemberId:plan.manager_member_id,
    sourceWishId:plan.source_wish_id,responseDeadline:plan.response_deadline,
    minimumParticipants:plan.minimum_participants,requireAll:Boolean(plan.require_all),
    state:plan.state,confirmedEventId:plan.confirmed_event_id,canManage:manager,
    participantCount:Number(activeCount?.count||0),version:plan.version,
    options:[...options.values()].map(option=>({...option,
      participants:manager?option.participants:undefined}))}});
}

export async function activeScheduleUserIds(db:D1Database,plan:ScheduleRow):Promise<string[]> {
  const rows=await db.prepare(`SELECT m.user_id FROM group_schedule_participants p
    JOIN active_group_members m ON m.id=p.member_id AND m.group_id=?2 WHERE p.schedule_id=?1`)
    .bind(plan.id,plan.group_id).all<{user_id:string}>();
  return rows.results.map(row=>row.user_id);
}
