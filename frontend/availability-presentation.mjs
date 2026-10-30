const minutes=value=>Number(value.slice(0,2))*60+Number(value.slice(3));
const clock=value=>`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
export const dayLabel=date=>new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',weekday:'short'}).format(new Date(`${date}T12:00:00+09:00`));

// Adjacent valid starts form one visible range, while each underlying start remains selectable.
export function groupCandidateSlots(slots){
  const sorted=[...(slots||[])].sort((a,b)=>a.start.localeCompare(b.start));
  const groups=[];
  for(const slot of sorted){
    const last=groups.at(-1),signature=`${slot.registeredClearCount}|${slot.hardConflictCount}|${slot.tentativeConflictCount}|${slot.unconfirmedCount}`;
    if(last&&last.signature===signature&&minutes(slot.start)===last.lastStart+30){
      last.end=slot.end;last.lastStart=minutes(slot.start);last.slots.push(slot);
    }else groups.push({start:slot.start,end:slot.end,lastStart:minutes(slot.start),signature,slots:[slot]});
  }
  return groups;
}

export function renderAvailabilityCards({data,query,recommendations,results,onSchedule}){
  recommendations.replaceChildren();results.replaceChildren();
  const action=slot=>{const button=document.createElement('button');button.type='button';button.className='action-button';
    button.textContent='この日時で日程調整する';button.addEventListener('click',()=>onSchedule?.(slot));return button;};
  const title=document.createElement('h4');title.textContent='おすすめ日時';recommendations.append(title);
  for(const slot of (data.recommendations||[]).slice(0,5)){
    const card=document.createElement('article');card.className='availability-card';
    const heading=document.createElement('h5');heading.textContent=dayLabel(slot.date);card.append(heading);
    const hours=document.createElement('strong');hours.className='availability-card-time';hours.textContent=`${slot.start}〜${slot.end}`;card.append(hours);
    const detail=document.createElement('p');detail.className='availability-card-counts';detail.textContent=`空き候補 ${slot.registeredClearCount}人 · 競合 ${slot.hardConflictCount+slot.tentativeConflictCount}人 · 未確認 ${slot.unconfirmedCount}人`;
    card.append(detail,action(slot));recommendations.append(card);
  }
  if(!data.recommendations?.length){const empty=document.createElement('p');empty.textContent='条件に合うおすすめはありません';recommendations.append(empty);}
  for(const day of data.days||[]){
    const visual=day.timelineSlots||day.slots||[];
    const groups=groupCandidateSlots(visual.filter(slot=>slot.meetsMinimum!==false));if(!visual.length)continue;
    const section=document.createElement('section');section.className='availability-day-card';
    const heading=document.createElement('h5');heading.textContent=dayLabel(day.date);section.append(heading);
    const axis=document.createElement('div');axis.className='availability-axis';axis.setAttribute('aria-hidden','true');
    for(const time of [query.windowStart,Math.round((query.windowStart+query.windowEnd)/2),query.windowEnd]){
      const tick=document.createElement('span');tick.textContent=clock(time);axis.append(tick);
    }section.append(axis);
    const legend=document.createElement('p');legend.className='availability-legend';legend.textContent='開始時刻ごとの状態（必要時間を確保）：空き候補 ●　競合 ■　未確認 ▧';section.append(legend);
    const track=document.createElement('div');track.className='availability-track';track.setAttribute('role','img');
    track.setAttribute('aria-label',`${dayLabel(day.date)}の時間帯。空き候補、競合、未確認を色と下の文字で表示`);
    for(const slot of visual){const bar=document.createElement('span');bar.className=`availability-bar ${slot.hardConflictCount||slot.tentativeConflictCount?'conflict':slot.unconfirmedCount||slot.needsConfirmation?'unconfirmed':'clear'}`;
      bar.style.left=`${Math.max(0,(minutes(slot.start)-query.windowStart)/(query.windowEnd-query.windowStart)*100)}%`;
      bar.style.width=`${30/(query.windowEnd-query.windowStart)*100}%`;
      bar.title=`${slot.start}〜${slot.end} ${slot.hardConflictCount||slot.tentativeConflictCount?'競合あり':slot.unconfirmedCount||slot.needsConfirmation?'未確認あり':'登録済み予定に競合なし'}`;track.append(bar);
    }section.append(track);
    for(const group of groups){const row=document.createElement('div');row.className='availability-range';
      const first=group.slots[0];
      const label=document.createElement('span');label.textContent=`${group.start}〜${group.end}　空き候補 ${first.registeredClearCount}人 · 競合 ${first.hardConflictCount+first.tentativeConflictCount}人 · 未確認 ${first.unconfirmedCount}人`;row.append(label);
      const select=document.createElement('select');select.setAttribute('aria-label',`${dayLabel(day.date)}の開始時刻`);
      for(const slot of group.slots){const option=document.createElement('option');option.value=slot.start;option.textContent=`${slot.start}〜${slot.end}`;select.append(option);}
      const button=document.createElement('button');button.type='button';button.className='action-button';button.textContent='日程調整する';
      button.addEventListener('click',()=>onSchedule?.({...group.slots.find(slot=>slot.start===select.value),date:day.date}));
      row.append(select,button);section.append(row);
    }results.append(section);
  }
  if(!results.children.length)results.textContent='条件に合う空き時間はありません';
}
