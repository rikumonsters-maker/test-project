type TimedRow = { user_id:string; event_date:string; starts_at:string; ends_at:string; all_day:number; source_type?:string; status?:string };
export type Interval = [number, number];
export type BusyDays = Map<string, Map<string, Interval[]>>;

const clock = (value:string) => /^\d{2}:\d{2}$/.test(value)
  ? Number(value.slice(0,2))*60 + Number(value.slice(3)) : NaN;
export const formatMinute = (minute:number) => `${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
export const nextDate = (date:string, days=1) => new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);

function add(days:BusyDays, userId:string, date:string, interval:Interval, first:string, last:string) {
  if (date<first || date>last || !Number.isFinite(interval[0]) || !Number.isFinite(interval[1]) || interval[1]<=interval[0]) return;
  let byDate=days.get(userId);
  if (!byDate) { byDate=new Map(); days.set(userId,byDate); }
  const entries=byDate.get(date) || [];
  entries.push(interval);
  byDate.set(date,entries);
}

export function mergeIntervals(intervals:Interval[]):Interval[] {
  const merged:Interval[]=[];
  for (const [start,end] of [...intervals].sort((a,b)=>a[0]-b[0])) {
    const last=merged.at(-1);
    if (last && start<=last[1]) last[1]=Math.max(last[1],end);
    else merged.push([start,end]);
  }
  return merged;
}

export function freeIntervals(busy:Interval[], windowStart=540, windowEnd=1320):Interval[] {
  const free:Interval[]=[];
  let cursor=windowStart;
  for (const [start,end] of mergeIntervals(busy)) {
    if (start>cursor && cursor<windowEnd) free.push([cursor,Math.min(start,windowEnd)]);
    cursor=Math.max(cursor,end);
    if (cursor>=windowEnd) break;
  }
  if (cursor<windowEnd) free.push([cursor,windowEnd]);
  return free.filter(([start,end])=>end>start);
}

export function candidateSlots(days:BusyDays, userIds:string[], date:string, durationMinutes:number,
  windowStart=540,windowEnd=1320,notBefore=0):Interval[] {
  const allBusy=mergeIntervals(userIds.flatMap(id=>days.get(id)?.get(date) || []));
  const slots:Interval[]=[];
  for (const [freeStart,freeEnd] of freeIntervals(allBusy,windowStart,windowEnd)) {
    for (let start=Math.ceil(Math.max(freeStart,notBefore)/30)*30;start+durationMinutes<=freeEnd;start+=30)
      slots.push([start,start+durationMinutes]);
  }
  return slots;
}

// Read only time columns. Neither private event text nor shift pay reaches this module.
export async function loadAvailabilityDays(db:D1Database, groupId:string, userIds:string[], first:string, last:string):Promise<{hard:BusyDays;tentative:BusyDays}> {
  const slots=userIds.map(()=>'?').join(',');
  const [automatic,shared,personal]=await Promise.all([
    db.prepare(`SELECT DISTINCT m.user_id,e.event_date,e.source_type,e.starts_at,e.ends_at,e.all_day
      FROM member_calendar_entries e JOIN active_group_members m ON m.id=e.member_id
      WHERE m.user_id IN (${slots}) AND e.event_date BETWEEN ? AND ?
      AND (e.source_type<>'personal' OR NOT EXISTS
        (SELECT 1 FROM personal_sync_users s WHERE s.user_id=m.user_id))`)
      .bind(...userIds,nextDate(first,-1),last).all<TimedRow>(),
    db.prepare(`SELECT DISTINCT target.user_id,e.event_date,e.starts_at,e.ends_at,e.all_day,e.status
      FROM shared_events e JOIN group_members creator ON creator.id=e.created_by_member_id
      JOIN active_group_members target ON target.group_id=? AND target.user_id IN (${slots})
      WHERE e.event_date BETWEEN ? AND ? AND e.cancelled_at IS NULL
      AND e.status IN ('confirmed','tentative') AND (e.group_id=?
        OR (creator.left_at IS NULL AND creator.user_id=target.user_id)
        OR EXISTS (SELECT 1 FROM shared_event_participants p WHERE p.event_id=e.id
          AND p.user_id=target.user_id AND p.revoked_at IS NULL))`)
      .bind(groupId,...userIds,first,last,groupId).all<TimedRow>(),
    db.prepare(`SELECT e.user_id,e.event_date,e.starts_at,e.ends_at,e.all_day
      FROM personal_events e JOIN personal_sync_users s ON s.user_id=e.user_id
      WHERE e.user_id IN (${slots}) AND e.event_date BETWEEN ? AND ? AND e.deleted=0`)
      .bind(...userIds,first,last).all<TimedRow>(),
  ]);
  const hard:BusyDays=new Map(),tentative:BusyDays=new Map();
  for (const row of automatic.results || []) {
    if (row.all_day) { add(hard,row.user_id,row.event_date,[0,1440],first,last); continue; }
    const start=clock(row.starts_at),end=clock(row.ends_at);
    if (row.source_type==='shift' && end<=start) {
      add(hard,row.user_id,row.event_date,[start,1440],first,last);
      add(hard,row.user_id,nextDate(row.event_date),[0,end],first,last);
    } else add(hard,row.user_id,row.event_date,[start,end],first,last);
  }
  for (const row of shared.results || []) {
    add(row.status==='tentative'?tentative:hard,row.user_id,row.event_date,
      row.all_day?[0,1440]:[clock(row.starts_at),clock(row.ends_at)],first,last);
  }
  for (const row of personal.results || []) {
    add(hard,row.user_id,row.event_date,row.all_day?[0,1440]:[clock(row.starts_at),clock(row.ends_at)],first,last);
  }
  for (const days of [hard,tentative]) for (const byDate of days.values())
    for (const [date,intervals] of byDate) byDate.set(date,mergeIntervals(intervals));
  return {hard,tentative};
}

export async function loadBusyDays(db:D1Database, groupId:string, userIds:string[], first:string, last:string):Promise<BusyDays> {
  return combineBusyDays(await loadAvailabilityDays(db,groupId,userIds,first,last));
}

export function combineBusyDays({hard,tentative}:{hard:BusyDays;tentative:BusyDays}):BusyDays {
  const combined:BusyDays=new Map([...hard].map(([id,byDate])=>[id,new Map([...byDate].map(([date,intervals])=>[date,[...intervals]]))]));
  for (const [userId,byDate] of tentative) {
    let target=combined.get(userId);
    if (!target) { target=new Map(); combined.set(userId,target); }
    for (const [date,intervals] of byDate) target.set(date,mergeIntervals([...(target.get(date)||[]),...intervals]));
  }
  return combined;
}

const overlaps=(intervals:Interval[],start:number,end:number)=>intervals.some(([a,b])=>a<end&&b>start);
export type RankedSlot={date:string;start:string;end:string;hardConflictCount:number;tentativeConflictCount:number;
  unconfirmedCount:number;registeredClearCount:number;meetsMinimum:boolean;allRegisteredClear:boolean;reason:string};

export function rankAvailability(hard:BusyDays,tentative:BusyDays,userIds:string[],dates:string[],
  durationMinutes:number,minimumParticipants:number,unknownByDate:Map<string,Set<string>>,limit=5,
  windowStart=540,windowEnd=1320,notBeforeDate='',notBeforeMinute=0):RankedSlot[] {
  const ranked:RankedSlot[]=[];
  for (const date of dates) for (let start=windowStart;start+durationMinutes<=windowEnd;start+=30) {
    if (notBeforeDate && (date<notBeforeDate || (date===notBeforeDate && start<notBeforeMinute))) continue;
    const end=start+durationMinutes;
    let hardCount=0,tentativeCount=0,unknownCount=0,clearCount=0;
    for (const id of userIds) {
      const unknown=Boolean(unknownByDate.get(date)?.has(id));
      if(unknown) unknownCount++;
      if (overlaps(hard.get(id)?.get(date)||[],start,end)) { hardCount++; continue; }
      if (overlaps(tentative.get(id)?.get(date)||[],start,end)) { tentativeCount++; continue; }
      if (!unknown) clearCount++;
    }
    const meetsMinimum=clearCount>=minimumParticipants;
    const reason=hardCount===0&&tentativeCount===0&&unknownCount===0
      ? '全員の登録済み予定に競合がありません。参加可否の回答は別途必要です。'
      : `登録済み予定の競合${hardCount}人、仮予定${tentativeCount}人、未確認${unknownCount}人。参加可否の回答は別途必要です。`;
    ranked.push({date,start:formatMinute(start),end:formatMinute(end),hardConflictCount:hardCount,
      tentativeConflictCount:tentativeCount,unconfirmedCount:unknownCount,registeredClearCount:clearCount,
      meetsMinimum,allRegisteredClear:clearCount===userIds.length,reason});
  }
  ranked.sort((a,b)=>Number(b.allRegisteredClear)-Number(a.allRegisteredClear)
    || Number(b.meetsMinimum)-Number(a.meetsMinimum)
    || a.hardConflictCount-b.hardConflictCount
    || a.tentativeConflictCount-b.tentativeConflictCount
    || a.unconfirmedCount-b.unconfirmedCount
    || b.registeredClearCount-a.registeredClearCount
    || a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  return ranked.slice(0,limit);
}

export async function unconfirmedByMonth(db:D1Database, groupId:string, memberIds:Map<string,string>, months:string[]):Promise<Map<string,Set<string>>> {
  const userIds=[...memberIds.keys()];
  const ids=userIds.map(()=>'?').join(',');
  const monthSlots=months.map(()=>'?').join(',');
  const [personal,shift]=await Promise.all([
    db.prepare(`SELECT user_id FROM personal_sync_users WHERE user_id IN (${ids})`).bind(...userIds).all<{user_id:string}>(),
    db.prepare(`SELECT m.user_id,c.month FROM group_calendar_sync_coverage c
      JOIN active_group_members m ON m.id=c.member_id AND m.group_id=c.group_id
      WHERE c.group_id=? AND m.user_id IN (${ids}) AND c.month IN (${monthSlots})`)
      .bind(groupId,...userIds,...months).all<{user_id:string;month:string}>(),
  ]);
  const syncedPersonal=new Set((personal.results || []).map(row=>row.user_id));
  const syncedShift=new Set((shift.results || []).map(row=>row.user_id+'|'+row.month));
  return new Map(months.map(month=>[month,new Set(userIds.filter(id=>
    !syncedPersonal.has(id) || !syncedShift.has(id+'|'+month)))]));
}
