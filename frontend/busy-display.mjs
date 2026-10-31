// The server supplies busyDisplayName only for an active member of the same group.
// Never infer a name from matching times in the separate timeline response.
export function busyAgendaName(event){
  return typeof event?.busyDisplayName==='string'&&event.busyDisplayName.trim()
    ? `${event.busyDisplayName.trim()}${event.busyDisplayName.trim().endsWith('さん')?'':'さん'}　予定あり` : '予定あり';
}
