// The server supplies busyDisplayName only for an active member of the same group.
// Never infer a name from matching times in the separate timeline response.
export function busyAgendaName(event){
  return typeof event?.busyDisplayName==='string'&&event.busyDisplayName.trim()
    ? `${displayName(event.busyDisplayName)}　予定あり` : '予定あり';
}

function displayName(name){
  const value=name.trim();
  return value==='メンバー'||value.endsWith('さん')?value:`${value}さん`;
}

export function busyCalendarLabel(event) {
  const name = typeof event?.busyDisplayName === 'string' && event.busyDisplayName.trim()
    ? displayName(event.busyDisplayName)
    : '予定あり';
  return `${name} ${event.allDay ? '終日' : `${event.start}〜${event.end}`}`;
}

export function busyCalendarAriaLabel(event) {
  return `${busyAgendaName(event)} ${event.allDay ? '終日' : `${event.start}から${event.end}`}`;
}
