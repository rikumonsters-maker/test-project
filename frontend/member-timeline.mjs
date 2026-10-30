const minute=value=>Number(value.slice(0,2))*60+Number(value.slice(3));
export function timelineSegments(intervals,from=540,to=1320){
  return (intervals||[]).map(item=>({...item,a:Math.max(from,minute(item.start)),b:Math.min(to,minute(item.end))}))
    .filter(item=>item.b>item.a).sort((a,b)=>a.a-b.a).reduce((rows,item)=>{
      const last=rows.at(-1);
      if(last&&last.b>=item.a){last.b=Math.max(last.b,item.b);last.allDay ||= item.allDay;}
      else rows.push({a:item.a,b:item.b,allDay:!!item.allDay});
      return rows;
    },[]);
}
const time=n=>`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;

export function initMemberTimeline({$,requestJson,activeGroup,onConsentChanged}){
  const root=$('member-timeline'),details=$('member-timeline-details');
  let generation=0,groupId=null,date=null,loadedAt=0;
  const clear=()=>{generation++;groupId=null;date=null;loadedAt=0;root.replaceChildren();if(details)details.open=false;};
  async function show(nextDate,force=false){
    const group=activeGroup();if(!group||!nextDate){clear();return;}
    if(group.groupId!==groupId){generation++;groupId=group.groupId;
      loadedAt=0;root.replaceChildren();if(details)details.open=false;}
    const dateChanged=date!==nextDate;date=nextDate;
    if(!details?.open){generation++;loadedAt=0;root.replaceChildren();return;}
    if(!force&&!dateChanged&&Date.now()-loadedAt<30000)return;
    const current=++generation,requestedGroup=groupId,requestedDate=date;
    loadedAt=Date.now();
    root.textContent='読み込み中…';
    try{
      const data=await requestJson('/api/shared/named-busy/timeline',{payload:{groupId:requestedGroup,date:requestedDate}});
      if(current!==generation||!details.open||activeGroup()?.groupId!==requestedGroup||date!==requestedDate)return;
      loadedAt=Date.now();root.replaceChildren();
      for(const member of data.members||[]){
        const row=document.createElement('section');row.className='member-timeline-row';
        const name=document.createElement('strong');name.textContent=member.name;row.append(name);
        const label=document.createElement('p');
        if(!member.sharing)label.textContent='共有していない';
        else if(member.status==='unconfirmed')label.textContent='同期状況が未確認。表示された時間以外も空きとは限りません';
        else label.textContent='個人予定・シフト・参加登録のある共有予定の時間です。ほかの共有予定は一覧で確認してください';
        row.append(label);
        {
          const track=document.createElement('div');track.className='member-timeline-track';
          for(const [kind,items] of [['busy',member.busy],['tentative',member.tentative]]){
            for(const segment of timelineSegments(items)){
              const bar=document.createElement('span');bar.className=`member-timeline-bar ${kind}`;
              bar.style.left=`${(segment.a-540)/780*100}%`;bar.style.width=`${(segment.b-segment.a)/780*100}%`;
              bar.title=`${time(segment.a)}〜${time(segment.b)} ${kind==='tentative'?'仮予定':segment.allDay?'終日予定':'予定あり'}`;
              track.append(bar);
            }
          }
          row.append(track);
          const intervals=document.createElement('p');intervals.textContent=[
            ...timelineSegments(member.busy).map(s=>`${time(s.a)}〜${time(s.b)} ${s.allDay?'終日予定':'予定あり'}`),
            ...timelineSegments(member.tentative).map(s=>`${time(s.a)}〜${time(s.b)} 仮予定`),
          ].join(' / ')||'この表示に対象の予定なし（空き確定ではありません）';row.append(intervals);
        }
        root.append(row);
      }
    }catch(error){if(current===generation&&details.open){loadedAt=0;root.textContent=error?.message||'予定の時間帯を取得できませんでした';}}
  }
  details?.addEventListener?.('toggle',()=>{
    if(details.open){if(date)void show(date,true);}
    else{generation++;loadedAt=0;root.replaceChildren();}
  });
  if(typeof window!=='undefined'){
    window.addEventListener('daysync:logout',clear);
    window.addEventListener('daysync:availability-changed',()=>{if(date&&activeGroup()?.groupId===groupId)void show(date,true);});
  }
  return {show,clear};
}
