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

// This describes a server-provided start window. It does not compute or alter candidates.
export function availabilitySlotState(slot){
  if(!slot)return 'unavailable';
  if(slot.meetsMinimum===true)return 'candidate';
  if(slot.hardConflictCount||slot.tentativeConflictCount)return 'conflict';
  if(slot.unconfirmedCount||slot.needsConfirmation)return 'unconfirmed';
  if(slot.meetsMinimum===false)return 'insufficient';
  return 'candidate';
}

// Use the backend's already-ranked recommendations when available. This fallback only
// selects a summary from rows returned by the existing endpoint.
export function bestDailyCandidate(slots){
  return [...(slots||[])].filter(slot=>slot.meetsMinimum!==false).sort((a,b)=>
    Number(Boolean(b.allRegisteredClear))-Number(Boolean(a.allRegisteredClear))
    || Number(b.meetsMinimum!==false)-Number(a.meetsMinimum!==false)
    || (a.hardConflictCount||0)-(b.hardConflictCount||0)
    || (a.tentativeConflictCount||0)-(b.tentativeConflictCount||0)
    || (a.unconfirmedCount||0)-(b.unconfirmedCount||0)
    || (b.registeredClearCount||0)-(a.registeredClearCount||0)
    || a.start.localeCompare(b.start))[0]||null;
}

function countsText(slot,total){
  const conflicts=(slot.hardConflictCount||0)+(slot.tentativeConflictCount||0);
  const clear=slot.registeredClearCount||0,unconfirmed=slot.unconfirmedCount||0;
  return `空き候補 ${clear}${total?`/${total}`:''}人 · 競合 ${conflicts}人 · 未確認 ${unconfirmed}人`;
}

function appendLegend(section){
  const legend=document.createElement('ul');legend.className='availability-legend';legend.setAttribute('aria-label','時間ブロックの凡例');
  const items=[['candidate','空き候補'],['unconfirmed','未確認'],['conflict','競合あり'],['insufficient','必要人数に未達'],['unavailable','対象外・情報なし']];
  for(const [state,label] of items){
    const item=document.createElement('li');item.className='availability-legend-item';
    const swatch=document.createElement('span');swatch.className=`availability-block-swatch is-${state}`;swatch.setAttribute('aria-hidden','true');
    const text=document.createElement('span');text.textContent=label;item.append(swatch,text);legend.append(item);
  }
  section.append(legend);
}

function appendTimeBlocks(section,{day,visual,query}){
  const start=Number(query.windowStart),end=Number(query.windowEnd),duration=Number(query.durationMinutes)||0;
  const intervals=Math.max(0,Math.ceil((end-start)/30));
  const slotsByStart=new Map(visual.map(slot=>[minutes(slot.start),slot]));
  const axis=document.createElement('div');axis.className='availability-axis';axis.setAttribute('aria-hidden','true');
  for(const time of [start,Math.round((start+end)/2),end]){const tick=document.createElement('span');tick.textContent=clock(time);axis.append(tick);}
  section.append(axis);
  const blocks=document.createElement('ol');blocks.className='availability-block-grid';
  blocks.style.setProperty('--availability-block-count',String(intervals));
  blocks.setAttribute('aria-label',`${dayLabel(day.date)}の30分ごとの開始時刻。必要時間は${duration}分です`);
  for(let minute=start;minute<end;minute+=30){
    const slot=slotsByStart.get(minute),state=minute+duration>end?'unavailable':availabilitySlotState(slot);
    const block=document.createElement('li');block.className=`availability-block is-${state}`;
    const hasConflict=Boolean(slot&&(slot.hardConflictCount||slot.tentativeConflictCount));
    const hasUnconfirmed=Boolean(slot&&(slot.unconfirmedCount||slot.needsConfirmation));
    if(hasConflict)block.classList.add('has-conflict');
    if(hasUnconfirmed)block.classList.add('has-unconfirmed');
    const time=clock(minute),stateLabel={candidate:'最低参加人数を満たす空き候補',unconfirmed:'未確認',conflict:'予定あり・競合',insufficient:'必要人数に未達',unavailable:'対象外または情報なし'}[state];
    const attributes=[];
    if(hasConflict)attributes.push(`競合 ${(slot.hardConflictCount||0)+(slot.tentativeConflictCount||0)}人`);
    if(hasUnconfirmed)attributes.push(`未確認 ${slot.unconfirmedCount||0}人`);
    const label=`${time}開始: ${stateLabel}${attributes.length?`。${attributes.join('、')}`:''}`;
    block.setAttribute('aria-label',label);block.title=label;
    blocks.append(block);
  }
  section.append(blocks);
}

export function renderAvailabilityCards({data,query,recommendations,results,onSchedule}){
  recommendations.replaceChildren();results.replaceChildren();
  const total=Array.isArray(query.userIds)?query.userIds.length:0;
  const action=slot=>{const button=document.createElement('button');button.type='button';button.className='action-button';
    button.textContent='この日時で日程調整する';button.addEventListener('click',()=>onSchedule?.(slot));return button;};
  const title=document.createElement('h4');title.textContent='おすすめ日時';recommendations.append(title);
  for(const slot of (data.recommendations||[]).slice(0,5)){
    const card=document.createElement('article');card.className='availability-card';
    const heading=document.createElement('h5');heading.textContent=dayLabel(slot.date);card.append(heading);
    const hours=document.createElement('strong');hours.className='availability-card-time';hours.textContent=`${slot.start}〜${slot.end}`;card.append(hours);
    const detail=document.createElement('p');detail.className='availability-card-counts';detail.textContent=countsText(slot,total);
    card.append(detail,action(slot));recommendations.append(card);
  }
  if(!data.recommendations?.length){const empty=document.createElement('p');empty.textContent='条件に合うおすすめはありません';recommendations.append(empty);}
  for(const day of data.days||[]){
    const visual=day.timelineSlots||day.slots||[];
    const eligible=visual.filter(slot=>slot.meetsMinimum!==false);
    const recommended=(data.recommendations||[]).find(slot=>slot.date===day.date)||bestDailyCandidate(visual);
    const groups=groupCandidateSlots(eligible);
    const section=document.createElement('section');section.className='availability-day-card';
    const heading=document.createElement('h5');heading.textContent=dayLabel(day.date);section.append(heading);
    const summary=document.createElement('div');summary.className='availability-day-recommendation';
    const summaryLabel=document.createElement('span');summaryLabel.className='availability-day-recommendation-label';summaryLabel.textContent='おすすめ時間帯';summary.append(summaryLabel);
    if(recommended){
      const time=document.createElement('strong');time.className='availability-day-recommendation-time';time.textContent=`${recommended.start}〜${recommended.end}`;
      const detail=document.createElement('span');detail.className='availability-card-counts';detail.textContent=countsText(recommended,total);
      summary.append(time,detail);
    }else{
      const none=document.createElement('strong');none.className='availability-day-recommendation-none';none.textContent='条件に合う候補なし';summary.append(none);
    }
    section.append(summary);
    appendTimeBlocks(section,{day,visual,query});
    appendLegend(section);
    for(const group of groups){const row=document.createElement('div');row.className='availability-range';
      const first=group.slots[0];
      const label=document.createElement('span');label.textContent=`${group.start}〜${group.end}　${countsText(first,total)}`;row.append(label);
      const select=document.createElement('select');select.setAttribute('aria-label',`${dayLabel(day.date)}の開始時刻`);
      for(const slot of group.slots){const option=document.createElement('option');option.value=slot.start;option.textContent=`${slot.start}〜${slot.end}`;select.append(option);}
      const button=document.createElement('button');button.type='button';button.className='action-button';button.textContent='日程調整する';
      button.addEventListener('click',()=>onSchedule?.({...group.slots.find(slot=>slot.start===select.value),date:day.date}));
      row.append(select,button);section.append(row);
    }
    results.append(section);
  }
  if(!results.children.length)results.textContent='条件に合う空き時間はありません';
}
