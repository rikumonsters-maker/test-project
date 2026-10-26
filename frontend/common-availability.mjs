const validDate = value => {
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date=new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0,10)===value;
};
const dateNumber = value => Date.parse(`${value}T00:00:00Z`);
const localDate = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const addDays = (value, days) => localDate(new Date(Number(value.slice(0,4)),Number(value.slice(5,7))-1,Number(value.slice(8,10))+days));

export function validateCommonAvailability({userIds,startDate,endDate,durationMinutes}) {
  if (!Array.isArray(userIds) || userIds.length<2 || userIds.length>20) return 'メンバーを2〜20人選択してください。';
  if (!validDate(startDate) || !validDate(endDate) || dateNumber(endDate)<dateNumber(startDate) ||
      dateNumber(endDate)-dateNumber(startDate)>13*86400000) return '期間は開始日から14日以内にしてください。';
  if (!Number.isInteger(durationMinutes) || durationMinutes<60 || durationMinutes>360 || durationMinutes%30)
    return '必要時間は1〜6時間を30分単位で選択してください。';
  return null;
}

export function initCommonAvailability({$,requestJson,activeGroup}) {
  const dialog=$('common-availability-dialog');
  const form=$('common-availability-form');
  const results=$('common-availability-results');
  const status=$('common-availability-status');
  const error=$('common-availability-error');
  const submit=$('common-availability-submit');
  const names=new Map();
  let generation=0;
  let openedGroupId=null;

  function setError(message='') { error.textContent=message; error.hidden=!message; }
  function close() { if (dialog.open) dialog.close(); }
  function render(data) {
    results.replaceChildren();
    const count=data.days.reduce((n,day)=>n+day.slots.length,0);
    status.textContent=count ? `${count}件の候補が見つかりました。予定の最新状態は参加者に確認してください。` : '条件に合う候補はありません。';
    let first=true;
    for (const day of data.days) {
      if (!day.slots.length) continue;
      const section=document.createElement('details');
      section.className='common-availability-day';
      section.open=first; first=false;
      const summary=document.createElement('summary');
      summary.textContent=`${day.date}　${day.slots.length}件${day.unconfirmedUserIds.length?'・要確認':''}`;
      section.append(summary);
      if (day.unconfirmedUserIds.length) {
        const caution=document.createElement('p');
        caution.className='common-availability-caution';
        caution.textContent=`空き時間が未確認: ${day.unconfirmedUserIds.map(id=>names.get(id)||'選択メンバー').join('、')}。本人に確認してください。`;
        section.append(caution);
      }
      const list=document.createElement('ul');
      list.className='common-availability-slots';
      for (const slot of day.slots) {
        const row=document.createElement('li');
        row.textContent=`${slot.start}〜${slot.end}　${slot.needsConfirmation?'要確認':'登録済み予定では空き候補'}`;
        list.append(row);
      }
      section.append(list);
      results.append(section);
    }
  }

  async function open() {
    const group=activeGroup();
    if (!group) return;
    openedGroupId=group.groupId;
    const current=++generation;
    names.clear();
    $('common-availability-members').replaceChildren();
    setError('');
    results.replaceChildren();
    status.textContent='メンバーを読み込んでいます…';
    const start=localDate(new Date());
    $('common-availability-start').value=start;
    $('common-availability-end').value=addDays(start,6);
    $('common-availability-end').max=addDays(start,13);
    if (!dialog.open) dialog.showModal();
    try {
      const data=await requestJson('/api/groups/members/list',{payload:{groupId:group.groupId}});
      if (current!==generation || activeGroup()?.groupId!==group.groupId) return;
      const fieldset=$('common-availability-members');
      const legend=document.createElement('legend');
      legend.textContent='メンバーを2人以上選択';
      fieldset.append(legend);
      for (const member of data.members || []) {
        if (!member.userId) continue;
        names.set(member.userId,member.memberName);
        const label=document.createElement('label');
        label.className='participant-choice common-availability-choice';
        const box=document.createElement('input');
        box.type='checkbox'; box.value=member.userId; box.checked=names.size<=20;
        label.append(box,document.createTextNode(member.memberName));
        fieldset.append(label);
      }
      status.textContent='期間と必要時間を選んで検索してください。';
      if (names.size<2) setError('検索にはグループ内のアカウント登録済みメンバーが2人以上必要です。');
    } catch (cause) {
      if (current===generation) { status.textContent=''; results.replaceChildren(); setError(cause.message || 'メンバーを読み込めませんでした。'); }
    }
  }

  const duration=$('common-availability-duration');
  for (let minutes=60;minutes<=360;minutes+=30) {
    const option=document.createElement('option');
    option.value=String(minutes);
    option.textContent=`${Math.floor(minutes/60)}時間${minutes%60?'30分':''}`;
    duration.append(option);
  }
  $('common-availability-open').addEventListener('click',()=>void open());
  $('common-availability-close').addEventListener('click',close);
  dialog.addEventListener('close',()=>{ generation++; openedGroupId=null; });
  $('common-availability-start').addEventListener('change',()=>{
    const start=$('common-availability-start').value;
    if (validDate(start)) $('common-availability-end').max=addDays(start,13);
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const group=activeGroup();
    if (!group || group.groupId!==openedGroupId) return;
    const payload={groupId:group.groupId,
      userIds:[...$('common-availability-members').querySelectorAll('input:checked')].map(box=>box.value),
      startDate:$('common-availability-start').value,endDate:$('common-availability-end').value,
      durationMinutes:Number(duration.value)};
    const message=validateCommonAvailability(payload);
    setError(message || '');
    if (message) return;
    const current=++generation;
    submit.disabled=true;
    results.replaceChildren();
    status.textContent='候補を探しています…';
    try {
      const data=await requestJson('/api/shared/availability/search',{payload});
      if (current===generation && activeGroup()?.groupId===group.groupId) render(data);
    } catch (cause) {
      if (current===generation) { status.textContent=''; results.replaceChildren(); setError(cause.message || '候補を検索できませんでした。'); }
    } finally { submit.disabled=false; }
  });
  return {close};
}
