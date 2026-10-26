type TimedRow = { user_id:string; event_date:string; starts_at:string; ends_at:string; all_day:number; source_type?:string };
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

export function freeIntervals(busy:Interval[]):Interval[] {
  const free:Interval[]=[];
  let cursor=540; // Keep the existing availability hours: 09:00–22:00.
  for (const [start,end] of mergeIntervals(busy)) {
    if (start>cursor && cursor<1320) free.push([cursor,Math.min(start,1320)]);
    cursor=Math.max(cursor,end);
    if (cursor>=1320) break;
  }
  if (cursor<1320) free.push([cursor,1320]);
  return free.filter(([start,end])=>end>start);
}

export function candidateSlots(days:BusyDays, userIds:string[], date:string, durationMinutes:number):Interval[] {
  const allBusy=mergeIntervals(userIds.flatMap(id=>days.get(id)?.get(date) || []));
  const slots:Interval[]=[];
  for (const [freeStart,freeEnd] of freeIntervals(allBusy)) {
    for (let start=Math.ceil(freeStart/30)*30;start+durationMinutes<=freeEnd;start+=30)
      slots.push([start,start+durationMinutes]);
  }
  return slots;
}

// Read only time columns. Neither private event text nor shift pay reaches this module.
export async function loadBusyDays(db:D1Database, groupId:string, userIds:string[], first:string, last:string):Promise<BusyDays> {
  const slots=userIds.map(()=>'?').join(',');
  const [automatic,shared,personal]=await Promise.all([
    db.prepare(`SELECT DISTINCT m.user_id,e.event_date,e.source_type,e.starts_at,e.ends_at,e.all_day
      FROM member_calendar_entries e JOIN active_group_members m ON m.id=e.member_id
      WHERE m.user_id IN (${slots}) AND e.event_date BETWEEN ? AND ?
      AND (e.source_type<>'personal' OR NOT EXISTS
        (SELECT 1 FROM personal_sync_users s WHERE s.user_id=m.user_id))`)
      .bind(...userIds,nextDate(first,-1),last).all<TimedRow>(),
    db.prepare(`SELECT DISTINCT target.user_id,e.event_date,e.starts_at,e.ends_at,e.all_day
      FROM shared_events e JOIN group_members creator ON creator.id=e.created_by_member_id
      JOIN active_group_members target ON target.group_id=? AND target.user_id IN (${slots})
      WHERE e.event_date BETWEEN ? AND ? AND (e.group_id=?
        OR (creator.left_at IS NULL AND creator.user_id=target.user_id)
        OR EXISTS (SELECT 1 FROM shared_event_participants p WHERE p.event_id=e.id
          AND p.user_id=target.user_id AND p.revoked_at IS NULL))`)
      .bind(groupId,...userIds,first,last,groupId).all<TimedRow>(),
    db.prepare(`SELECT e.user_id,e.event_date,e.starts_at,e.ends_at,e.all_day
      FROM personal_events e JOIN personal_sync_users s ON s.user_id=e.user_id
      WHERE e.user_id IN (${slots}) AND e.event_date BETWEEN ? AND ? AND e.deleted=0`)
      .bind(...userIds,first,last).all<TimedRow>(),
  ]);
  const days:BusyDays=new Map();
  for (const row of automatic.results || []) {
    if (row.all_day) { add(days,row.user_id,row.event_date,[0,1440],first,last); continue; }
    const start=clock(row.starts_at),end=clock(row.ends_at);
    if (row.source_type==='shift' && end<=start) {
      add(days,row.user_id,row.event_date,[start,1440],first,last);
      add(days,row.user_id,nextDate(row.event_date),[0,end],first,last);
    } else add(days,row.user_id,row.event_date,[start,end],first,last);
  }
  for (const row of [...(shared.results || []),...(personal.results || [])]) {
    add(days,row.user_id,row.event_date,row.all_day?[0,1440]:[clock(row.starts_at),clock(row.ends_at)],first,last);
  }
  for (const byDate of days.values()) for (const [date,intervals] of byDate) byDate.set(date,mergeIntervals(intervals));
  return days;
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
