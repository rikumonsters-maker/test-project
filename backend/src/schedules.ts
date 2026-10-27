import type { SessionUser } from './auth';
import { loadAvailabilityDays } from './availability';
import { drainPushQueue,type PushEnv } from './push';
import { queueScheduleNotice,type ScheduleNoticeKind } from './schedule-notices';
import { activeScheduleUserIds,getSchedule,listSchedules } from './schedule-read';
import { activeMember,activeParticipants,deadline,json,optionInput,optionalText,schedule,text,userIds,
  type Body,type ScheduleMember,type ScheduleRow } from './schedule-core';

async function notice(env:PushEnv,ctx:ExecutionContext,plan:ScheduleRow,ids:string[],
  kind:ScheduleNoticeKind,key:string):Promise<void> {
  try {
    await queueScheduleNotice(env,plan.group_id,plan.id,ids,kind,key);
    ctx.waitUntil(drainPushQueue(env));
  } catch { console.warn('Schedule notification queue failed'); }
}
const optionTime=(value:string)=>Number(value.slice(0,2))*60+Number(value.slice(3));

async function create(env:PushEnv,ctx:ExecutionContext,member:ScheduleMember,user:SessionUser,body:Body):Promise<Response> {
  const title=text(body.title,80),description=optionalText(body.description,500),due=deadline(body.responseDeadline);
  const participants=userIds(body.participantUserIds,2,20);
  const rawOptions=body.options;
  const options=Array.isArray(rawOptions)&&rawOptions.length>=1&&rawOptions.length<=10
    ? rawOptions.map(optionInput):null;
  const minimum=body.minimumParticipants,all=body.requireAll===true;
  const requestId=text(body.clientRequestId,64);
  const sourceWishId=body.sourceWishId===undefined||body.sourceWishId===null?null:text(body.sourceWishId,64);
  if(!title||description===null||!due||!participants||!participants.includes(user.id)||!options||
    options.some(option=>!option)||new Set(options.map(option=>JSON.stringify(option))).size!==options.length||
    !Number.isInteger(minimum)||(minimum as number)<1||(minimum as number)>participants.length||
    (all&&minimum!==participants.length)||!requestId||
    (body.sourceWishId!==undefined&&body.sourceWishId!==null&&!sourceWishId))
    return json({error:'日程調整の入力内容を確認してください'},400);
  const memberIds=await activeParticipants(env.DB,member.group_id,participants);
  if(memberIds.size!==participants.length) return json({error:'退出済みまたはグループ外の参加候補がいます'},403);
  if(sourceWishId) {
    const wish=await env.DB.prepare(`SELECT w.id FROM group_availability_wishes w
      WHERE w.id=?1 AND w.group_id=?2 AND w.manager_member_id=?3 AND w.management_state='open'
      AND NOT EXISTS (SELECT 1 FROM shared_events e WHERE e.wish_id=w.id AND e.status='confirmed' AND e.cancelled_at IS NULL)`)
      .bind(sourceWishId,member.group_id,member.id).first();
    if(!wish) return json({error:'この遊びたい日から日程調整を開始できません'},409);
  }
  const id=crypto.randomUUID(),now=new Date().toISOString();
  const statements:D1PreparedStatement[]=[
    env.DB.prepare(`INSERT INTO group_schedules(id,group_id,created_by_user_id,created_by_member_id,
      manager_member_id,source_wish_id,title,description,response_deadline,minimum_participants,
      require_all,client_request_id,created_at,updated_at)
      VALUES(?1,?2,?3,?4,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12)`)
      .bind(id,member.group_id,user.id,member.id,sourceWishId,title,description,due,minimum,Number(all),requestId,now),
    ...participants.map(userId=>env.DB.prepare(`INSERT INTO group_schedule_participants(schedule_id,member_id,added_at)
      VALUES(?1,?2,?3)`).bind(id,memberIds.get(userId),now)),
    ...options.map(option=>env.DB.prepare(`INSERT INTO group_schedule_options
      (id,schedule_id,event_date,starts_at,ends_at,client_request_id,created_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7)`)
      .bind(crypto.randomUUID(),id,option!.date,option!.start,option!.end,crypto.randomUUID(),now)),
  ];
  if(sourceWishId) statements.push(env.DB.prepare(`UPDATE group_availability_wishes
    SET management_state='converted',management_version=management_version+1,updated_at=?1
    WHERE id=?2 AND group_id=?3 AND manager_member_id=?4 AND management_state='open'`)
    .bind(now,sourceWishId,member.group_id,member.id));
  try { await env.DB.batch(statements); }
  catch {
    const existing=await env.DB.prepare(`SELECT id FROM group_schedules
      WHERE group_id=?1 AND created_by_member_id=?2 AND client_request_id=?3`)
      .bind(member.group_id,member.id,requestId).first<{id:string}>();
    if(existing) return json({id:existing.id,replayed:true});
    return json({error:'日程調整を保存できませんでした。候補と状態を更新してください'},409);
  }
  const plan=await schedule(env.DB,member.group_id,id);
  if(plan) await notice(env,ctx,plan,participants.filter(id=>id!==user.id),'schedule_started','schedule-start:'+id);
  return json({id},201);
}

async function managedOpen(db:D1Database,member:ScheduleMember,id:unknown):Promise<ScheduleRow|Response> {
  const plan=await schedule(db,member.group_id,id);
  if(!plan) return json({error:'日程調整が見つかりません'},404);
  if(plan.manager_member_id!==member.id) return json({error:'現在の管理者だけが変更できます'},403);
  if(plan.state!=='open'||plan.response_deadline<=new Date().toISOString())
    return json({error:'回答期限が過ぎたか、日程調整が終了しています'},409);
  return plan;
}
const isResponse=(value:ScheduleRow|Response):value is Response=>value instanceof Response;

async function updateDetails(env:PushEnv,ctx:ExecutionContext,member:ScheduleMember,body:Body):Promise<Response> {
  const db=env.DB;
  const plan=await managedOpen(db,member,body.scheduleId);
  if(isResponse(plan)) return plan;
  const title=text(body.title,80),description=optionalText(body.description,500),due=deadline(body.responseDeadline);
  if(!title||description===null||!due) return json({error:'タイトル、説明、回答期限を確認してください'},400);
  const result=await db.prepare(`UPDATE group_schedules SET title=?1,description=?2,
    reminder_notified_at=CASE WHEN response_deadline<>?3 THEN NULL ELSE reminder_notified_at END,
    deadline_notified_at=CASE WHEN response_deadline<>?3 THEN NULL ELSE deadline_notified_at END,
    response_deadline=?3,
    version=version+1,updated_at=?4 WHERE id=?5 AND manager_member_id=?6 AND state='open'
    AND response_deadline>?4`).bind(title,description,due,new Date().toISOString(),plan.id,member.id).run();
  if(!result.meta.changes)return json({error:'日程調整の状態が変わりました'},409);
  await notice(env,ctx,plan,await activeScheduleUserIds(db,plan),'schedule_changed',
    'schedule-details:'+plan.id+':'+(plan.version+1));
  return json({ok:true});
}

async function addOption(env:PushEnv,ctx:ExecutionContext,member:ScheduleMember,body:Body):Promise<Response> {
  const plan=await managedOpen(env.DB,member,body.scheduleId);
  if(isResponse(plan)) return plan;
  const option=optionInput(body.option),requestId=text(body.clientRequestId,64);
  if(!option||!requestId) return json({error:'候補日時と操作IDを確認してください'},400);
  const id=crypto.randomUUID(),now=new Date().toISOString();
  try { await env.DB.batch([
    env.DB.prepare(`INSERT INTO group_schedule_options(id,schedule_id,event_date,starts_at,ends_at,client_request_id,created_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7)`).bind(id,plan.id,option.date,option.start,option.end,requestId,now),
    env.DB.prepare(`UPDATE group_schedules SET version=version+1,updated_at=?1
      WHERE id=?2 AND manager_member_id=?3 AND state='open' AND response_deadline>?1`)
      .bind(now,plan.id,member.id),
  ]); } catch {
    const old=await env.DB.prepare('SELECT id FROM group_schedule_options WHERE schedule_id=?1 AND client_request_id=?2')
      .bind(plan.id,requestId).first<{id:string}>();
    return old?json({id:old.id,replayed:true}):json({error:'候補日時を追加できませんでした'},409);
  }
  await notice(env,ctx,plan,await activeScheduleUserIds(env.DB,plan),'schedule_option_added','schedule-option:'+id);
  return json({id},201);
}

async function replaceOption(env:PushEnv,ctx:ExecutionContext,member:ScheduleMember,body:Body):Promise<Response> {
  const plan=await managedOpen(env.DB,member,body.scheduleId);
  if(isResponse(plan)) return plan;
  const oldId=text(body.optionId,64),option=optionInput(body.option),requestId=text(body.clientRequestId,64);
  if(!oldId||!option||!requestId) return json({error:'変更する候補日時を確認してください'},400);
  const id=crypto.randomUUID(),now=new Date().toISOString();
  try {
    const result=await env.DB.batch([
      env.DB.prepare(`UPDATE group_schedule_options SET cancelled_at=?1 WHERE id=?2 AND schedule_id=?3
        AND cancelled_at IS NULL AND EXISTS(SELECT 1 FROM group_schedules s WHERE s.id=?3
          AND s.manager_member_id=?4 AND s.state='open' AND s.response_deadline>?1)`)
        .bind(now,oldId,plan.id,member.id),
      env.DB.prepare(`INSERT INTO group_schedule_options(id,schedule_id,event_date,starts_at,ends_at,client_request_id,created_at)
        SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE EXISTS
        (SELECT 1 FROM group_schedule_options WHERE id=?8 AND schedule_id=?2 AND cancelled_at=?7)`)
        .bind(id,plan.id,option.date,option.start,option.end,requestId,now,oldId),
      env.DB.prepare(`UPDATE group_schedules SET version=version+1,updated_at=?1
        WHERE id=?2 AND manager_member_id=?3 AND state='open' AND EXISTS
        (SELECT 1 FROM group_schedule_options WHERE id=?4 AND schedule_id=?2 AND cancelled_at=?1)`)
        .bind(now,plan.id,member.id,oldId),
    ]);
    if(!result[0].meta.changes||!result[1].meta.changes) return json({error:'候補日時が既に変更されています'},409);
  } catch {
    const old=await env.DB.prepare('SELECT id FROM group_schedule_options WHERE schedule_id=?1 AND client_request_id=?2')
      .bind(plan.id,requestId).first<{id:string}>();
    return old?json({id:old.id,replayed:true}):json({error:'候補日時を変更できませんでした'},409);
  }
  await notice(env,ctx,plan,await activeScheduleUserIds(env.DB,plan),'schedule_changed','schedule-replace:'+id);
  return json({id},201);
}

async function cancelOption(env:PushEnv,ctx:ExecutionContext,member:ScheduleMember,body:Body):Promise<Response> {
  const plan=await managedOpen(env.DB,member,body.scheduleId);
  if(isResponse(plan)) return plan;
  const optionId=text(body.optionId,64);
  if(!optionId) return json({error:'候補日時を指定してください'},400);
  const now=new Date().toISOString();
  const result=await env.DB.batch([
    env.DB.prepare(`UPDATE group_schedule_options SET cancelled_at=?1 WHERE id=?2 AND schedule_id=?3
      AND cancelled_at IS NULL AND (SELECT COUNT(*) FROM group_schedule_options
        WHERE schedule_id=?3 AND cancelled_at IS NULL)>1 AND EXISTS
      (SELECT 1 FROM group_schedules s WHERE s.id=?3 AND s.manager_member_id=?4
        AND s.state='open' AND s.response_deadline>?1)`).bind(now,optionId,plan.id,member.id),
    env.DB.prepare(`UPDATE group_schedules SET version=version+1,updated_at=?1
      WHERE id=?2 AND manager_member_id=?3 AND state='open' AND EXISTS
      (SELECT 1 FROM group_schedule_options WHERE id=?4 AND schedule_id=?2 AND cancelled_at=?1)`)
      .bind(now,plan.id,member.id,optionId),
  ]);
  if(!result[0].meta.changes) return json({error:'最後の候補は取り消せません。候補または状態を確認してください'},409);
  await notice(env,ctx,plan,await activeScheduleUserIds(env.DB,plan),'schedule_changed','schedule-option-cancel:'+optionId);
  return json({ok:true});
}

async function vote(db:D1Database,member:ScheduleMember,body:Body):Promise<Response> {
  const plan=await schedule(db,member.group_id,body.scheduleId);
  const optionId=text(body.optionId,64),response=body.response;
  if(!plan||!optionId||!['yes','maybe','no'].includes(response as string))
    return json({error:'候補日時と回答を確認してください'},400);
  const now=new Date().toISOString();
  const allowed=`EXISTS(SELECT 1 FROM group_schedule_options o JOIN group_schedules s ON s.id=o.schedule_id
    JOIN group_schedule_participants p ON p.schedule_id=s.id AND p.member_id=?2
    JOIN active_group_members m ON m.id=p.member_id AND m.group_id=s.group_id
    WHERE o.id=?3 AND o.schedule_id=?4 AND o.cancelled_at IS NULL AND s.state='open'
      AND s.response_deadline>?5)`;
  const result=await db.batch([
    db.prepare(`UPDATE group_schedule_votes SET response=?1,
      maybe_confirmed_at=CASE WHEN response='maybe' AND ?1='maybe' THEN maybe_confirmed_at ELSE NULL END,
      updated_at=?5 WHERE member_id=?2 AND option_id=?3 AND ${allowed}`)
      .bind(response,member.id,optionId,plan.id,now),
    db.prepare(`INSERT OR IGNORE INTO group_schedule_votes(option_id,member_id,response,updated_at)
      SELECT ?3,?2,?1,?5 WHERE ${allowed}`)
      .bind(response,member.id,optionId,plan.id,now),
  ]);
  if(!result[0].meta.changes&&!result[1].meta.changes)
    return json({error:'回答期限が過ぎたか、この候補へ回答する権限がありません'},409);
  await db.prepare(`DELETE FROM push_deliveries WHERE kind='schedule_reminder' AND schedule_id=?1
    AND recipient_user_id=?2 AND NOT EXISTS(SELECT 1 FROM group_schedule_options o
      JOIN group_schedule_participants p ON p.schedule_id=o.schedule_id
      LEFT JOIN group_schedule_votes v ON v.option_id=o.id AND v.member_id=p.member_id
      WHERE o.schedule_id=?1 AND o.cancelled_at IS NULL AND p.member_id=?3 AND v.response IS NULL)`)
    .bind(plan.id,member.user_id,member.id).run();
  return json({ok:true,response});
}

async function confirmMaybe(db:D1Database,member:ScheduleMember,body:Body):Promise<Response> {
  const plan=await schedule(db,member.group_id,body.scheduleId),optionId=text(body.optionId,64);
  if(!plan||!optionId) return json({error:'候補日時を確認してください'},400);
  const now=new Date().toISOString();
  const result=await db.prepare(`UPDATE group_schedule_votes SET maybe_confirmed_at=?1,updated_at=?1
    WHERE option_id=?2 AND member_id=?3 AND response='maybe' AND EXISTS
    (SELECT 1 FROM group_schedule_options o JOIN group_schedules s ON s.id=o.schedule_id
      JOIN group_schedule_participants p ON p.schedule_id=s.id AND p.member_id=?3
      JOIN active_group_members m ON m.id=p.member_id AND m.group_id=s.group_id
      WHERE o.id=?2 AND o.schedule_id=?4 AND o.cancelled_at IS NULL AND s.state='open'
        AND s.response_deadline>?1)`).bind(now,optionId,member.id,plan.id).run();
  return result.meta.changes?json({ok:true}):json({error:'△の最終確認ができません。回答期限と状態を確認してください'},409);
}

async function confirm(env:PushEnv,ctx:ExecutionContext,member:ScheduleMember,body:Body):Promise<Response> {
  const plan=await schedule(env.DB,member.group_id,body.scheduleId);
  if(!plan) return json({error:'日程調整が見つかりません'},404);
  if(plan.manager_member_id!==member.id) return json({error:'現在の管理者だけが確定できます'},403);
  if(plan.state==='confirmed'&&plan.confirmed_event_id) return json({ok:true,eventId:plan.confirmed_event_id,replayed:true});
  // Voting closes at the deadline, but the manager may review and finalize
  // the recorded answers afterwards.
  if(plan.state!=='open') return json({error:'日程調整は既に終了しています'},409);
  const optionId=text(body.optionId,64),selected=userIds(body.participantUserIds,1,20);
  if(!optionId||!selected) return json({error:'候補日時と参加者を確認してください'},400);
  const option=await env.DB.prepare(`SELECT event_date,starts_at,ends_at FROM group_schedule_options
    WHERE id=?1 AND schedule_id=?2 AND cancelled_at IS NULL`)
    .bind(optionId,plan.id).first<{event_date:string;starts_at:string;ends_at:string}>();
  if(!option) return json({error:'候補日時が取り消されています'},409);
  const active=await activeParticipants(env.DB,member.group_id,selected);
  if(active.size!==selected.length) return json({error:'退出済みの参加者が含まれています'},409);
  const votes=await env.DB.prepare(`SELECT m.user_id,v.response,v.maybe_confirmed_at FROM group_schedule_votes v
    JOIN group_schedule_participants p ON p.member_id=v.member_id
    JOIN active_group_members m ON m.id=p.member_id AND m.group_id=?2
    WHERE p.schedule_id=?1 AND v.option_id=?3 AND m.user_id IN (${selected.map(()=>'?').join(',')})`)
    .bind(plan.id,member.group_id,optionId,...selected)
    .all<{user_id:string;response:string;maybe_confirmed_at:string|null}>();
  const eligible=new Set(votes.results.filter(v=>v.response==='yes'||
    (v.response==='maybe'&&v.maybe_confirmed_at)).map(v=>v.user_id));
  if(selected.some(id=>!eligible.has(id))) return json({error:'○または本人が最終確認した△の回答者だけを参加者にできます'},409);
  const allParticipants=await env.DB.prepare(`SELECT COUNT(*) AS total,
    (SELECT COUNT(*) FROM group_schedule_participants p JOIN active_group_members m
      ON m.id=p.member_id AND m.group_id=?2 WHERE p.schedule_id=?1) AS active
    FROM group_schedule_participants WHERE schedule_id=?1`)
    .bind(plan.id,member.group_id).first<{total:number;active:number}>();
  if(selected.length<plan.minimum_participants||
    (plan.require_all&&(selected.length!==Number(allParticipants?.total)||
      Number(allParticipants?.active)!==Number(allParticipants?.total))))
    return json({error:'最低参加人数または全員参加の条件を満たしていません'},409);
  const availability=await loadAvailabilityDays(env.DB,member.group_id,selected,option.event_date,option.event_date);
  const start=optionTime(option.starts_at),end=optionTime(option.ends_at);
  const overlaps=(a:number,b:number)=>a<end&&b>start;
  if(selected.some(id=>(availability.hard.get(id)?.get(option.event_date)||[]).some(([a,b])=>overlaps(a,b))))
    return json({error:'参加予定者の登録済み予定と競合しています。日時を再確認してください'},409);
  const tentative=selected.filter(id=>(availability.tentative.get(id)?.get(option.event_date)||[])
    .some(([a,b])=>overlaps(a,b)));
  if(tentative.length&&body.acceptTentativeConflicts!==true)
    return json({error:'仮予定との競合があります。確認のうえ明示的に続行してください',tentativeConflictUserIds:tentative},409);
  const now=new Date().toISOString(),markers=selected.map(()=>'?').join(',');
  const results=await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO shared_events
      (id,group_id,created_by_member_id,title,event_date,starts_at,ends_at,all_day,note,
        created_at,updated_at,status,schedule_plan_id)
      SELECT s.id,s.group_id,s.manager_member_id,s.title,o.event_date,o.starts_at,o.ends_at,0,'',?1,?1,'confirmed',s.id
      FROM group_schedules s JOIN group_schedule_options o ON o.schedule_id=s.id
      JOIN active_group_members manager ON manager.id=s.manager_member_id AND manager.group_id=s.group_id
      WHERE s.id=?2 AND s.group_id=?3 AND s.manager_member_id=?4 AND s.state='open'
        AND o.id=?5 AND o.cancelled_at IS NULL
        AND (SELECT COUNT(*) FROM group_schedule_participants p
          JOIN active_group_members m ON m.id=p.member_id AND m.group_id=s.group_id
          JOIN group_schedule_votes v ON v.member_id=p.member_id AND v.option_id=o.id
          WHERE p.schedule_id=s.id AND m.user_id IN (${markers})
            AND (v.response='yes' OR (v.response='maybe' AND v.maybe_confirmed_at IS NOT NULL)))=?${6+selected.length}
        AND (s.require_all=0 OR (SELECT COUNT(*) FROM group_schedule_participants p
          WHERE p.schedule_id=s.id)=?${6+selected.length})`)
      .bind(now,plan.id,member.group_id,member.id,optionId,...selected,selected.length),
    ...selected.map(userId=>env.DB.prepare(`INSERT OR IGNORE INTO shared_event_participants(event_id,user_id)
      SELECT s.id,?1 FROM group_schedules s JOIN shared_events e ON e.schedule_plan_id=s.id
      JOIN active_group_members m ON m.group_id=s.group_id AND m.user_id=?1
      WHERE s.id=?2 AND s.state='open' AND s.manager_member_id=?3`)
      .bind(userId,plan.id,member.id)),
    env.DB.prepare(`UPDATE shared_events SET cancelled_at=?1,management_version=management_version+1
      WHERE wish_id=?2 AND status='tentative' AND cancelled_at IS NULL AND EXISTS
      (SELECT 1 FROM shared_events e WHERE e.schedule_plan_id=?3)`)
      .bind(now,plan.source_wish_id,plan.id),
    env.DB.prepare(`UPDATE group_schedules SET state='confirmed',confirmed_event_id=?1,
      version=version+1,updated_at=?2 WHERE id=?1 AND group_id=?3 AND state='open'
      AND manager_member_id=?4 AND EXISTS(SELECT 1 FROM shared_events e WHERE e.schedule_plan_id=?1)`)
      .bind(plan.id,now,member.group_id,member.id),
  ]);
  const changed=results.at(-1)?.meta.changes;
  if(!changed) {
    const current=await schedule(env.DB,member.group_id,plan.id);
    return current?.state==='confirmed'&&current.confirmed_event_id
      ? json({ok:true,eventId:current.confirmed_event_id,replayed:true})
      : json({error:'投票、参加者または予定の状態が変わりました。再確認してください'},409);
  }
  await notice(env,ctx,plan,selected,'schedule_confirmed','schedule-confirmed:'+plan.id);
  return json({ok:true,eventId:plan.id});
}

async function cancel(env:PushEnv,ctx:ExecutionContext,member:ScheduleMember,body:Body):Promise<Response> {
  const plan=await schedule(env.DB,member.group_id,body.scheduleId);
  if(!plan) return json({error:'日程調整が見つかりません'},404);
  const orphan=plan.state==='confirmed' && Boolean(await env.DB.prepare(`SELECT 1 FROM shared_events e
    JOIN group_members creator ON creator.id=e.created_by_member_id
    WHERE e.schedule_plan_id=?1 AND e.group_id=?2 AND creator.left_at IS NOT NULL`)
    .bind(plan.id,member.group_id).first());
  if(plan.manager_member_id!==member.id&&!orphan)
    return json({error:'現在の管理者だけがキャンセルできます'},403);
  if(plan.state==='cancelled') return json({ok:true,replayed:true});
  const now=new Date().toISOString();
  const results=await env.DB.batch([
    env.DB.prepare(`UPDATE shared_events SET cancelled_at=?1,management_version=management_version+1,
      scheduling_write_version=scheduling_write_version+1
      WHERE schedule_plan_id=?2 AND group_id=?3 AND cancelled_at IS NULL
      AND EXISTS(SELECT 1 FROM active_group_members WHERE id=?4 AND group_id=?3)
      AND (created_by_member_id=?4 OR EXISTS(SELECT 1 FROM group_members creator
        WHERE creator.id=shared_events.created_by_member_id AND creator.left_at IS NOT NULL))`)
      .bind(now,plan.id,member.group_id,member.id),
    env.DB.prepare(`UPDATE shared_events SET cancelled_at=?1,management_version=management_version+1
      WHERE wish_id=?2 AND status='tentative' AND cancelled_at IS NULL
      AND EXISTS(SELECT 1 FROM active_group_members WHERE id=?4 AND group_id=?3)
      AND EXISTS(SELECT 1 FROM group_schedules s WHERE s.id=?5 AND s.group_id=?3
        AND (s.manager_member_id=?4 OR EXISTS(SELECT 1 FROM group_members creator
          WHERE creator.id=s.manager_member_id AND creator.left_at IS NOT NULL)))`)
      .bind(now,plan.source_wish_id,member.group_id,member.id,plan.id),
    env.DB.prepare(`UPDATE group_schedules SET state='cancelled',version=version+1,updated_at=?1
      WHERE id=?2 AND group_id=?3 AND state IN ('open','confirmed')
      AND EXISTS(SELECT 1 FROM active_group_members WHERE id=?4 AND group_id=?3)
      AND (manager_member_id=?4 OR (state='confirmed' AND EXISTS(
        SELECT 1 FROM shared_events e JOIN group_members creator ON creator.id=e.created_by_member_id
        WHERE e.schedule_plan_id=group_schedules.id AND creator.left_at IS NOT NULL)))`)
      .bind(now,plan.id,member.group_id,member.id),
  ]);
  if(!results[2].meta.changes) return json({error:'日程調整の状態が変わりました'},409);
  await notice(env,ctx,plan,await activeScheduleUserIds(env.DB,plan),'schedule_cancelled','schedule-cancelled:'+plan.id);
  return json({ok:true});
}

export async function handleScheduleRequest(env:PushEnv,ctx:ExecutionContext,path:string,body:Body,
  user:SessionUser):Promise<Response> {
  const member=await activeMember(env.DB,body.groupId,user);
  if(!member) return json({error:'グループへの参加情報を確認できません'},401);
  switch(path) {
    case '/api/groups/schedules/list': return listSchedules(env.DB,member);
    case '/api/groups/schedules/get': return getSchedule(env.DB,member,body.scheduleId);
    case '/api/groups/schedules/create': return create(env,ctx,member,user,body);
    case '/api/groups/schedules/update': return updateDetails(env,ctx,member,body);
    case '/api/groups/schedules/options/add': return addOption(env,ctx,member,body);
    case '/api/groups/schedules/options/replace': return replaceOption(env,ctx,member,body);
    case '/api/groups/schedules/options/cancel': return cancelOption(env,ctx,member,body);
    case '/api/groups/schedules/vote': return vote(env.DB,member,body);
    case '/api/groups/schedules/vote/confirm-maybe': return confirmMaybe(env.DB,member,body);
    case '/api/groups/schedules/confirm': return confirm(env,ctx,member,body);
    case '/api/groups/schedules/cancel': return cancel(env,ctx,member,body);
    default:return json({error:'APIが見つかりません'},404);
  }
}
