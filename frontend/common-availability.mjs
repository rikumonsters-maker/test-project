import {createAvailabilityRunner} from './common-availability-runner.mjs';
import {renderAvailabilityCards} from './availability-presentation.mjs';

const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
const addDays=(value,days)=>new Date(Date.parse(`${value}T00:00:00Z`)+days*86400000).toISOString().slice(0,10);
export const tokyoToday=(now=new Date())=>{
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const part=type=>parts.find(item=>item.type===type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};

export function validateCommonAvailability({userIds,startDate,endDate,durationMinutes,windowStart=540,windowEnd=1320}){
  if(!Array.isArray(userIds)||userIds.length<2||userIds.length>20)return 'メンバーを2〜20人選択してください。';
  if(!validDate(startDate)||!validDate(endDate)||endDate<startDate||Date.parse(endDate)-Date.parse(startDate)>13*86400000)return '期間は開始日から14日以内にしてください。';
  if(!Number.isInteger(durationMinutes)||durationMinutes<60||durationMinutes>360||durationMinutes%30)return '必要時間は1〜6時間を30分単位で選択してください。';
  if(!Number.isInteger(windowStart)||!Number.isInteger(windowEnd)||windowStart<0||windowEnd>1440||windowStart%30||windowEnd%30||windowEnd-windowStart<durationMinutes)return '検索時間帯は30分単位で、必要時間より長く指定してください。';
  return null;
}

export function initCommonAvailability({$,requestJson,activeGroup,getCurrentUserId,onSchedule}){
  const dialog=$('common-availability-dialog'),form=$('common-availability-form');
  const results=$('common-availability-results'),status=$('common-availability-status');
  const recommendations=$('common-availability-recommendations'),error=$('common-availability-error');
  const members=$('common-availability-members'),duration=$('common-availability-duration'),minimum=$('common-availability-minimum');
  const names=new Map();let openedGroupId=null,memberGeneration=0,lastSelection=null,openedDate='',dayTimer=null,memberController=null;
  function setError(message=''){error.textContent=message;error.hidden=!message;}
  function clearView(){results.replaceChildren();recommendations.replaceChildren();lastSelection=null;setError();}
  function close(){runner.close();memberController?.abort();memberController=null;memberGeneration++;openedGroupId=null;clearTimeout(dayTimer);dayTimer=null;if(dialog.open)dialog.close();}
  function scheduleNextDay(){clearTimeout(dayTimer);if(!dialog.open)return;
    dayTimer=setTimeout(()=>{if(dialog.open&&!document.hidden)calculate({immediate:true});scheduleNextDay();},
      Math.max(1000,Date.parse(`${tokyoToday()}T15:00:01Z`)-Date.now()));}
  function selectedIds(){return [...members.querySelectorAll('input:checked')].map(box=>box.value);}
  function updateMinimum(){const count=selectedIds().length,previous=Number(minimum.value)||count;minimum.replaceChildren();
    for(let n=1;n<=count;n++)minimum.append(new Option(`${n}人`,String(n)));minimum.value=String(Math.min(previous,count));}
  function payload(){const group=activeGroup();if(!group||group.groupId!==openedGroupId)return null;
    return {groupId:group.groupId,userIds:selectedIds(),startDate:$('common-availability-start').value,endDate:$('common-availability-end').value,
      durationMinutes:Number(duration.value),minimumParticipants:Number(minimum.value),windowStart:Number($('common-availability-window-start').value),
      windowEnd:Number($('common-availability-window-end').value),excludePast:true,
      timeBucket:Math.floor(Date.now()/1800000)};}
  function calculate({immediate=false,force=false}={}){
    if(!dialog.open||document.hidden)return;
    const date=tokyoToday();
    if(openedDate!==date){const start=$('common-availability-start'),end=$('common-availability-end');
      if(start.value===openedDate&&end.value===addDays(openedDate,6)){start.value=date;end.value=addDays(date,6);}
      openedDate=date;runner.invalidate(openedGroupId);}
    const query=payload();if(!query)return;const message=validateCommonAvailability(query);
    if(message||!Number.isInteger(query.minimumParticipants)||query.minimumParticipants<1||query.minimumParticipants>query.userIds.length){
      runner.invalidate(openedGroupId);clearView();status.textContent='';setError(message||'最低参加人数を確認してください。');return;}
    setError();runner.run(query,{immediate,force});
  }
  const runner=createAvailabilityRunner({request:(query,signal)=>requestJson('/api/shared/availability/search',{payload:query,signal}),
    loading:()=>{setError();status.textContent='候補を計算しています…';results.replaceChildren();recommendations.replaceChildren();},
    show:(data,query)=>{if(dialog.open&&activeGroup()?.groupId===query.groupId){lastSelection=query;renderCards(data,query);}},
    fail:cause=>{status.textContent='';clearView();setError(cause?.status===401||cause?.status===403?'このグループの空き時間を表示する権限がありません。':cause?.message||'候補を取得できませんでした。更新ボタンから再試行してください。');}});
  function render(data){
    results.replaceChildren();recommendations.replaceChildren();
    if(data.recommendations?.length){const title=document.createElement('h4');title.textContent='おすすめ日時（投票前の候補）';recommendations.append(title);
      const list=document.createElement('ol');list.className='common-availability-ranked';
      for(const slot of data.recommendations.slice(0,5)){const item=document.createElement('li'),heading=document.createElement('strong');
        heading.textContent=`${slot.date} ${slot.start}〜${slot.end}　登録済み予定と競合しない ${slot.registeredClearCount}人${slot.unconfirmedCount?'・未確認 '+slot.unconfirmedCount+'人':''}`;
        const reason=document.createElement('p');reason.textContent=slot.reason;item.append(heading,reason);
        if(onSchedule){const button=document.createElement('button');button.type='button';button.className='action-button';button.textContent='この日時で日程調整を始める';
          button.addEventListener('click',()=>{const selection=lastSelection;close();onSchedule({participantUserIds:selection?.userIds||[],minimumParticipants:selection?.minimumParticipants||2,options:[{date:slot.date,start:slot.start,end:slot.end}]});});item.append(button);}
        list.append(item);}recommendations.append(list);}
    const count=(data.days||[]).reduce((n,day)=>n+day.slots.length,0);
    status.textContent=count?`${count}件の候補があります。参加可否は本人に確認してください。`:'条件に合う候補はありません。';
    let first=true;
    for(const day of data.days||[]){if(!day.slots.length)continue;const section=document.createElement('details');section.className='common-availability-day';section.open=first;first=false;
      const summary=document.createElement('summary');summary.textContent=`${day.date}　${day.slots.length}件${day.unconfirmedUserIds.length?'・要確認':''}`;section.append(summary);
      if(day.unconfirmedUserIds.length){const caution=document.createElement('p');caution.className='common-availability-caution';caution.textContent=`空き時間が未確認: ${day.unconfirmedUserIds.map(id=>names.get(id)||'選択メンバー').join('、')}。本人に確認してください。`;section.append(caution);}
      const list=document.createElement('ul');list.className='common-availability-slots';for(const slot of day.slots){const row=document.createElement('li');row.textContent=`${slot.start}〜${slot.end}　${slot.needsConfirmation?'要確認':'登録済み予定では空き候補'}`;list.append(row);}section.append(list);results.append(section);}
  }
  function renderCards(data,query){
    renderAvailabilityCards({data,query,recommendations,results,onSchedule:slot=>{
      const selection=lastSelection;close();onSchedule?.({participantUserIds:selection?.userIds||[],
        minimumParticipants:selection?.minimumParticipants||2,
        options:[{date:slot.date,start:slot.start,end:slot.end}]});
    }});
    status.textContent=(data.days||[]).some(day=>day.slots?.length)?'登録済み予定の空き候補です。参加の承諾は本人に確認してください。':'条件に合う候補はありません。';
  }
  async function open(){const group=activeGroup();if(!group)return;runner.close();memberController?.abort();memberController=new AbortController();openedGroupId=group.groupId;runner.open(getCurrentUserId());
    const current=++memberGeneration;names.clear();members.replaceChildren();clearView();openedDate=tokyoToday();
    $('common-availability-start').value=openedDate;$('common-availability-end').value=addDays(openedDate,6);$('common-availability-end').max=addDays(openedDate,13);
    duration.value='120';$('common-availability-window-start').value='540';$('common-availability-window-end').value='1320';
    status.textContent='読み込み中…';if(!dialog.open)dialog.showModal();scheduleNextDay();
    try{const data=await requestJson('/api/groups/members/list',{payload:{groupId:group.groupId},signal:memberController.signal});
      if(current!==memberGeneration||!dialog.open||activeGroup()?.groupId!==group.groupId)return;
      const legend=document.createElement('legend');legend.textContent='メンバーを2人以上選択';members.append(legend);
      for(const member of data.members||[]){if(!member.userId)continue;names.set(member.userId,member.memberName);
        const label=document.createElement('label');label.className='participant-choice common-availability-choice';const box=document.createElement('input');
        box.type='checkbox';box.value=member.userId;box.checked=names.size<=20;label.append(box,document.createTextNode(member.memberName));members.append(label);}
      updateMinimum();calculate({immediate:true});
    }catch(cause){if(current===memberGeneration&&cause?.name!=='AbortError'){status.textContent='';setError(cause?.message||'メンバーを読み込めませんでした。');}}}
  for(let minutes=60;minutes<=360;minutes+=30){const option=document.createElement('option');option.value=String(minutes);option.textContent=`${Math.floor(minutes/60)}時間${minutes%60?'30分':''}`;duration.append(option);}
  $('common-availability-open').addEventListener('click',()=>void open());$('common-availability-close').addEventListener('click',close);
  $('common-availability-refresh').addEventListener('click',()=>calculate({immediate:true,force:true}));dialog.addEventListener('close',close);
  members.addEventListener('change',()=>{updateMinimum();calculate();});
  for(const id of ['common-availability-start','common-availability-end','common-availability-duration','common-availability-minimum','common-availability-window-start','common-availability-window-end'])
    $(id).addEventListener('change',()=>{if(id==='common-availability-start'&&validDate($(id).value))$('common-availability-end').max=addDays($(id).value,13);calculate();});
  form.addEventListener('submit',event=>event.preventDefault());
  window.addEventListener('daysync:availability-changed',event=>{const groupId=event.detail?.groupId||openedGroupId;if(groupId)runner.invalidate(groupId);if(dialog.open&&groupId===openedGroupId)calculate();});
  window.addEventListener('daysync:logout',()=>{close();runner.clear();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)runner.close();else if(dialog.open){runner.open(getCurrentUserId());calculate({immediate:true});}});
  window.addEventListener('focus',()=>{if(dialog.open&&!document.hidden)calculate({immediate:true});});
  return {close,invalidate:groupId=>{runner.invalidate(groupId);if(dialog.open&&groupId===openedGroupId)calculate();}};
}
