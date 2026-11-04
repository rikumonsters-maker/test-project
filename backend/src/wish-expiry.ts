export function tokyoToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function isTokyoCleanupTick(scheduledTime: number): boolean {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone:'Asia/Tokyo', hour:'2-digit', minute:'2-digit', hourCycle:'h23',
  }).format(scheduledTime) === '00:05';
}

// Only an untouched proposal can be removed. Reactions, events and schedules
// are retained as history, including cancelled or revoked records.
export async function removeUnreferencedExpiredWishes(db: D1Database, today = tokyoToday()): Promise<void> {
  await db.prepare(`DELETE FROM group_availability_wishes
    WHERE wish_date < ?1 AND management_state='open'
      AND manager_member_id=(SELECT id FROM active_group_members
        WHERE group_id=group_availability_wishes.group_id AND user_id=group_availability_wishes.user_id)
      AND NOT EXISTS(SELECT 1 FROM group_availability_reactions r WHERE r.wish_id=group_availability_wishes.id)
      AND NOT EXISTS(SELECT 1 FROM shared_events e WHERE e.wish_id=group_availability_wishes.id)
      AND NOT EXISTS(SELECT 1 FROM group_schedules s WHERE s.source_wish_id=group_availability_wishes.id)
      AND NOT EXISTS(SELECT 1 FROM in_app_notifications n
        WHERE n.group_id=group_availability_wishes.group_id AND instr(n.target_path,group_availability_wishes.id)>0)
      AND NOT EXISTS(SELECT 1 FROM push_deliveries d
        WHERE d.group_id=group_availability_wishes.group_id AND instr(COALESCE(d.target_path,''),group_availability_wishes.id)>0)`)
    .bind(today).run();
}
