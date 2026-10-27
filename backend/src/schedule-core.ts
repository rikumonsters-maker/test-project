import type { SessionUser } from './auth';

export type Body=Record<string,unknown>;
export type ScheduleMember={id:string;user_id:string;group_id:string};
export type ScheduleRow={id:string;group_id:string;created_by_user_id:string;created_by_member_id:string;
  manager_member_id:string;source_wish_id:string|null;title:string;description:string;response_deadline:string;
  minimum_participants:number;require_all:number;state:'open'|'confirmed'|'cancelled';
  confirmed_event_id:string|null;version:number;created_at:string;updated_at:string};
export type OptionInput={date:string;start:string;end:string};

export function json(data:unknown,status=200):Response {
  return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
}
export function text(value:unknown,max:number):string|null {
  if (typeof value!=='string') return null;
  const trimmed=value.trim();
  return trimmed.length>0&&[...trimmed].length<=max?trimmed:null;
}
export function optionalText(value:unknown,max:number):string|null {
  if (value===undefined||value===null) return '';
  return typeof value==='string'&&[...value.trim()].length<=max?value.trim():null;
}
export function validDate(value:unknown):value is string {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date=new Date(value+'T00:00:00Z');
  return !Number.isNaN(date.getTime())&&date.toISOString().slice(0,10)===value;
}
export function validTime(value:unknown):value is string {
  return typeof value==='string'&&/^(?:[01][0-9]|2[0-3]):(?:00|30)$/.test(value);
}
export function optionInput(value:unknown):OptionInput|null {
  if (!value||typeof value!=='object'||Array.isArray(value)) return null;
  const row=value as Record<string,unknown>;
  if(!validDate(row.date)||!validTime(row.start)||!validTime(row.end)) return null;
  const start=Number(row.start.slice(0,2))*60+Number(row.start.slice(3));
  const end=Number(row.end.slice(0,2))*60+Number(row.end.slice(3));
  if(start<540||end>1320||end-start<60||end-start>360) return null;
  return {date:row.date,start:row.start,end:row.end};
}
export function userIds(value:unknown,min=1,max=20):string[]|null {
  if(!Array.isArray(value)||value.length<min||value.length>max||
    value.some(id=>!text(id,64))||new Set(value).size!==value.length) return null;
  return value as string[];
}
export function deadline(value:unknown):string|null {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const at=Date.parse(value);
  return Number.isFinite(at)&&at>Date.now()&&at<Date.now()+366*86400000?value:null;
}
export async function activeMember(db:D1Database,groupId:unknown,user:SessionUser):Promise<ScheduleMember|null> {
  const id=text(groupId,64);
  if(!id) return null;
  return db.prepare('SELECT id,user_id,group_id FROM active_group_members WHERE group_id=?1 AND user_id=?2')
    .bind(id,user.id).first<ScheduleMember>();
}
export async function activeParticipants(db:D1Database,groupId:string,ids:string[]):Promise<Map<string,string>> {
  const rows=await db.prepare(`SELECT user_id,id FROM active_group_members WHERE group_id=? AND user_id IN (${ids.map(()=>'?').join(',')})`)
    .bind(groupId,...ids).all<{user_id:string;id:string}>();
  return new Map(rows.results.map(row=>[row.user_id,row.id]));
}
export async function schedule(db:D1Database,groupId:string,id:unknown):Promise<ScheduleRow|null> {
  const scheduleId=text(id,64);
  if(!scheduleId) return null;
  return db.prepare('SELECT * FROM group_schedules WHERE id=?1 AND group_id=?2')
    .bind(scheduleId,groupId).first<ScheduleRow>();
}
