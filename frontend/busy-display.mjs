// The server supplies busyDisplayName only after checking this membership's explicit consent.
// Never infer a name from matching times in the separate timeline response.
export function busyAgendaName(event){
  return typeof event?.busyDisplayName==='string'&&event.busyDisplayName.trim()
    ? `${event.busyDisplayName.trim()}　予定あり` : '予定あり';
}
