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
  const root=$('member-timeline'),toggle=$('member-timeline-consent');
  let generation=0,groupId=null,date=null,loadedAt=0;
  const clear=()=>{generation++;groupId=null;date=null;loadedAt=0;root.replaceChildren();toggle.checked=false;};
  async function show(nextDate,force=false){
    const group=activeGroup();if(!group||!nextDate){clear();return;}
    if(!force&&group.groupId===groupId&&nextDate===date&&Date.now()-loadedAt<30000)return;
    const current=++generation;groupId=group.groupId;date=nextDate;
    loadedAt=Date.now();
    root.textContent='読み込み中…';
    try{
      const [setting,data]=await Promise.all([
        requestJson('/api/shared/named-busy/setting',{payload:{groupId}}),
        requestJson('/api/shared/named-busy/timeline',{payload:{groupId,date}}),
      ]);
      if(current!==generation||activeGroup()?.groupId!==groupId)return;
      toggle.checked=setting.enabled===true;loadedAt=Date.now();root.replaceChildren();
      for(const member of data.members||[]){
        const row=document.createElement('section');row.className='member-timeline-row';
        const name=document.createElement('strong');name.textContent=member.name;row.append(name);
        const label=document.createElement('p');
        if(!member.sharing)label.textContent='共有していない';
        else if(member.status==='unconfirmed')label.textContent='同期状況が未確認。表示された時間以外も空きとは限りません';
        else label.textContent='登録済み予定に競合なしの時間も、参加の承諾とは別です';
        row.append(label);
        if(member.sharing){
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
          ].join(' / ')||'登録済み予定に競合なし';row.append(intervals);
        }
        root.append(row);
      }
    }catch(error){if(current===generation){loadedAt=0;root.textContent=error?.message||'予定の時間帯を取得できませんでした';}}
  }
  toggle?.addEventListener?.('change',async()=>{
    const next=toggle.checked,group=activeGroup();if(!group)return;
    generation++;root.textContent='共有設定を更新中…';
    toggle.disabled=true;
    try{
      await requestJson('/api/shared/named-busy/update',{payload:{groupId:group.groupId,enabled:next}});
      onConsentChanged?.();
      await show(date,true);
    }
    catch{toggle.checked=!next;root.textContent='共有設定を変更できませんでした';}
    finally{toggle.disabled=false;}
  });
  if(typeof window!=='undefined'){
    window.addEventListener('daysync:logout',clear);
    window.addEventListener('daysync:availability-changed',()=>{if(date&&activeGroup()?.groupId===groupId)void show(date,true);});
  }
  return {show,clear};
}
