// Use only trusted SQL identifiers/placeholders, never request values.
// A rejoined account has a new member ID and inherits no creator privilege.
export function canManageSharedEventSql(event: string, member: string): string {
  return `EXISTS (SELECT 1 FROM active_group_members actor
    JOIN group_members author ON author.id=${event}.created_by_member_id
    WHERE actor.id=${member} AND actor.group_id=${event}.group_id
    AND (author.id=actor.id OR (author.left_at IS NOT NULL AND ${event}.status='confirmed')))`;
}
