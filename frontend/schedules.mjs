const make=(tag,text='',className='')=>{
  const node=document.createElement(tag);
  node.textContent=text;
  if(className) node.className=className;
  return node;
};
const button=(label,action,className='action-button')=>{
  const node=make('button',label,className); node.type='button'; node.addEventListener('click',action); return node;
};
const dateTime=value=>new Date(value).toLocaleString('ja-JP',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});

export function validateScheduleOption(option){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(option?.date||'')||
    !/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(option?.start||'')||
    !/^(?:[01]\d|2[0-3]):(?:00|30)$/.test(option?.end||''))return '候補日時を30分単位で指定してください。';
  const start=Number(option.start.slice(0,2))*60+Number(option.start.slice(3));
  const end=Number(option.end.slice(0,2))*60+Number(option.end.slice(3));
  if(start<540||end>1320||end-start<60||end-start>360)return '候補は9:00〜22:00の1〜6時間にしてください。';
  return null;
}
export function validateScheduleDraft({title,deadline,participantUserIds,minimumParticipants,requireAll,option}){
  if(typeof title!=='string'||!title.trim()||[...title.trim()].length>80)return 'タイトルを確認してください。';
  if(!Number.isFinite(Date.parse(deadline))||Date.parse(deadline)<=Date.now())return '未来の回答期限を指定してください。';
  if(!Array.isArray(participantUserIds)||participantUserIds.length<2||participantUserIds.length>20||
    new Set(participantUserIds).size!==participantUserIds.length)return '回答するメンバーを2〜20人選んでください。';
  if(!Number.isInteger(minimumParticipants)||minimumParticipants<1||minimumParticipants>participantUserIds.length||
    (requireAll&&minimumParticipants!==participantUserIds.length))return '最低参加人数を確認してください。';
  return validateScheduleOption(option);
}

export function initSchedules({$,requestJson,activeGroup,getCurrentUserId,onConfirmed}) {
  const dialog=$('schedules-dialog'),content=$('schedules-content'),status=$('schedules-status');
  let generation=0,groupId=null;
  const api=(path,payload={})=>requestJson('/api/groups/schedules/'+path,{payload:{groupId,...payload}});
  const message=(value='',error=false)=>{status.textContent=value;status.className=error?'status error':'status';status.hidden=!value;};
  const run=async(fn)=>{try { message('処理中…'); await fn(); message(''); } catch(error) { message(error.message||'操作できませんでした。画面を更新してください。',true); }};
  function close(){generation++;if(dialog.open) dialog.close();}
  function start(){groupId=activeGroup()?.groupId; if(!groupId)return false; generation++;content.replaceChildren();message('');if(!dialog.open)dialog.showModal();return true;}
  async function openList(){
    if(!start())return;
    const ticket=generation;
    await run(async()=>{
      const data=await api('list');if(ticket!==generation)return;
      content.append(make('h4','日程調整'));
      content.append(button('新しく日程調整を作成',()=>void openCreate()));
      const list=make('ul','','schedule-list');
      for(const plan of data.schedules||[]){
        const item=make('li');
        item.append(button(`${plan.title}・${plan.state==='open'?'回答受付中':plan.state==='confirmed'?'確定':'中止'}`,
          ()=>void openDetail(plan.id)));
        item.append(make('small',`回答期限 ${dateTime(plan.responseDeadline)}・候補${plan.optionCount}件`));
        list.append(item);
      }
      if(!list.childElementCount)content.append(make('p','日程調整はありません。'));
      else content.append(list);
    });
  }
  async function openCreate(prefill={}){
    if(!start())return;
    const ticket=generation;
    await run(async()=>{
      const data=await requestJson('/api/groups/members/list',{payload:{groupId}});
      if(ticket!==generation)return;
      const form=make('form');form.className='form-stack';
      form.append(make('h4',prefill.sourceWishId?'遊びたい日から日程調整':'日程調整を作成'));
      const title=make('input');title.required=true;title.maxLength=80;title.value=prefill.title||'';
      const description=make('textarea');description.maxLength=500;description.rows=2;
      const due=make('input');due.type='datetime-local';due.required=true;
      const defaultDue=new Date(Date.now()+3*86400000);defaultDue.setMinutes(defaultDue.getMinutes()-defaultDue.getTimezoneOffset());
      due.value=defaultDue.toISOString().slice(0,16);
      const field=make('fieldset');field.append(make('legend','回答するメンバー（自分を含め2人以上）'));
      const chosen=new Set(prefill.participantUserIds||[]),self=getCurrentUserId();
      for(const member of data.members||[]){
        if(!member.userId)continue;
        const label=make('label','','participant-choice');const box=make('input');box.type='checkbox';box.value=member.userId;
        box.checked=chosen.size?chosen.has(member.userId):true;
        if(member.userId===self){box.checked=true;box.disabled=true;}
        label.append(box,document.createTextNode(member.memberName));field.append(label);
      }
      const minimum=make('input');minimum.type='number';minimum.min='1';minimum.max='20';minimum.value=String(prefill.minimumParticipants||2);
      const all=make('input');all.type='checkbox';
      const optionDate=make('input');optionDate.type='date';optionDate.value=prefill.options?.[0]?.date||'';
      const startTime=make('input');startTime.type='time';startTime.step=1800;startTime.required=true;startTime.value=prefill.options?.[0]?.start||'18:00';
      const endTime=make('input');endTime.type='time';endTime.step=1800;endTime.required=true;endTime.value=prefill.options?.[0]?.end||'20:00';
      const label=(name,node)=>{const wrapper=make('label',name);wrapper.append(node);return wrapper;};
      form.append(label('タイトル',title),label('説明（任意）',description),label('回答期限',due),field,
        label('最低参加人数',minimum),label('全員参加を条件にする',all),
        make('p','候補日時を1〜10件登録できます。'),
        label('日付',optionDate),label('開始',startTime),label('終了',endTime));
      const options=[...(prefill.options||[]).slice(1)];
      const optionList=make('ul','','schedule-list');
      const renderOptions=()=>{
        optionList.replaceChildren();
        options.forEach((option,index)=>{
          const item=make('li',`${option.date} ${option.start}〜${option.end}`);
          item.append(button('取り消す',()=>{options.splice(index,1);renderOptions();}));optionList.append(item);
        });
      };renderOptions();
      form.append(button('この候補を追加',()=>{
        const option={date:optionDate.value,start:startTime.value,end:endTime.value};
        const error=validateScheduleOption(option);
        if(error){message(error,true);return;}
        if(options.length>=10||options.some(existing=>JSON.stringify(existing)===JSON.stringify(option))){
          message('候補は重複なしで10件までです。',true);return;
        }
        options.push(option);renderOptions();optionDate.value='';message('候補に追加しました。');
      }),optionList);
      const submit=make('button','日程調整を開始','action-button primary');submit.type='submit';
      form.append(submit,button('一覧へ戻る',()=>void openList()));
      form.addEventListener('submit',event=>{event.preventDefault();void run(async()=>{
        const ids=[...field.querySelectorAll('input:checked')].map(box=>box.value);
        if(self&&!ids.includes(self))ids.push(self);
        const count=all.checked?ids.length:Number(minimum.value);
        const current=optionDate.value?{date:optionDate.value,start:startTime.value,end:endTime.value}:null;
        const chosenOptions=[...options,...(current?[current]:[])];
        if(!chosenOptions.length||chosenOptions.length>10||chosenOptions.some(option=>validateScheduleOption(option))||
          new Set(chosenOptions.map(option=>JSON.stringify(option))).size!==chosenOptions.length){
          message('候補日時を重複なしで1〜10件指定してください。',true);return;
        }
        const error=validateScheduleDraft({title:title.value,deadline:due.value,participantUserIds:ids,
          minimumParticipants:count,requireAll:all.checked,option:chosenOptions[0]});
        if(error){message(error,true);return;}
        const result=await api('create',{title:title.value,description:description.value,
          responseDeadline:new Date(due.value).toISOString(),participantUserIds:ids,
          minimumParticipants:count,requireAll:all.checked,
          options:chosenOptions,
          sourceWishId:prefill.sourceWishId||undefined,clientRequestId:crypto.randomUUID()});
        void openDetail(result.id);
      });});
      content.append(form);
    });
  }
  async function openDetail(id){
    if(!start())return;
    const ticket=generation;
    await run(async()=>{
      const {schedule:plan}=await api('get',{scheduleId:id});if(ticket!==generation)return;
      content.append(make('h4',plan.title),make('p',plan.description||'説明なし'),
        make('p',`回答期限 ${dateTime(plan.responseDeadline)}・最低${plan.minimumParticipants}人${plan.requireAll?'・全員参加':''}`));
      const open=plan.state==='open',votable=open&&Date.parse(plan.responseDeadline)>Date.now();
      content.append(make('p',open?(votable?'回答受付中':'回答期限が終了しました。管理者は確定できます。'):
        plan.state==='confirmed'?'共有予定を確定済みです。':'キャンセル済みです。'));
      for(const option of plan.options){
        const section=make('section','','schedule-option');
        section.append(make('h5',`${option.date} ${option.start}〜${option.end}${option.cancelled?'（取り消し）':''}`),
          make('p',`○ ${option.yes}人 / △ ${option.maybe}人 / × ${option.no}人 / 未回答 ${option.unanswered}人`));
        if(votable&&!option.cancelled){
          const actions=make('div','','actions');
          for(const [value,label] of [['yes','○ 行ける'],['maybe','△ 未定'],['no','× 行けない']]){
            const control=button(label,()=>void run(async()=>{await api('vote',{scheduleId:id,optionId:option.id,response:value});void openDetail(id);}));
            control.setAttribute('aria-pressed',String(option.myVote===value));actions.append(control);
          }
          section.append(actions);
          if(option.myVote==='maybe'&&!option.myMaybeConfirmed)
            section.append(button('△の参加を最終確認する',()=>void run(async()=>{
              await api('vote/confirm-maybe',{scheduleId:id,optionId:option.id});void openDetail(id);
            })));
        }
        if(plan.canManage&&!option.cancelled){
          if(option.participants?.length){
            const list=make('ul','','schedule-votes');
            for(const person of option.participants)list.append(make('li',`${person.name}：${person.vote||'未回答'}${person.maybeConfirmed?'（△を確認済み）':''}`));
            section.append(list);
          }
          if(open){
            if(votable)section.append(button('この候補を取り消す',()=>void run(async()=>{
              await api('options/cancel',{scheduleId:id,optionId:option.id});void openDetail(id);
            }),'action-button danger'));
            const eligible=(option.participants||[]).filter(p=>p.vote==='yes'||(p.vote==='maybe'&&p.maybeConfirmed));
            if(eligible.length>=plan.minimumParticipants&&(!plan.requireAll||eligible.length===plan.participantCount)){
              const field=make('fieldset');field.append(make('legend','確定する参加者を最終確認'));
              for(const person of eligible){
                const label=make('label','','participant-choice');const box=make('input');
                box.type='checkbox';box.value=person.userId;box.checked=true;
                label.append(box,document.createTextNode(`${person.name}（${person.vote==='yes'?'○':'△・本人確認済み'}）`));field.append(label);
              }
              section.append(field,button('この候補を共有予定として確定',()=>void run(async()=>{
                const participantUserIds=[...field.querySelectorAll('input:checked')].map(input=>input.value);
                if(participantUserIds.length<plan.minimumParticipants||
                  (plan.requireAll&&participantUserIds.length!==plan.participantCount)){
                  message('参加者が最低人数または全員参加条件を満たしていません。',true);return;
                }
                if(!window.confirm('選択した参加者と日時で共有予定を確定しますか？'))return;
                await api('confirm',{scheduleId:id,optionId:option.id,participantUserIds,
                  acceptTentativeConflicts:$('schedules-accept-tentative').checked});
                onConfirmed?.();void openDetail(id);
              }),'action-button primary'));
            }
          }
        }
        content.append(section);
      }
      if(open&&plan.canManage){
        const tentative=make('input');tentative.type='checkbox';tentative.id='schedules-accept-tentative';
        const warning=make('label','仮予定との重複を確認して確定する');warning.className='checkbox-label';warning.append(tentative);
        content.append(warning);
        if(votable){
          const details=make('form');details.className='form-stack';details.append(make('h5','調整内容を編集'));
          const name=make('input');name.value=plan.title;name.required=true;name.maxLength=80;
          const description=make('textarea');description.value=plan.description;description.maxLength=500;
          const deadline=make('input');deadline.type='datetime-local';deadline.required=true;
          const deadlineDate=new Date(plan.responseDeadline);deadlineDate.setMinutes(deadlineDate.getMinutes()-deadlineDate.getTimezoneOffset());
          deadline.value=deadlineDate.toISOString().slice(0,16);
          for(const [label,node] of [['タイトル',name],['説明',description],['回答期限',deadline]]){
            const wrapper=make('label',label);wrapper.append(node);details.append(wrapper);
          }
          const save=make('button','変更を保存','action-button');save.type='submit';details.append(save);
          details.addEventListener('submit',event=>{event.preventDefault();void run(async()=>{
            await api('update',{scheduleId:id,title:name.value,description:description.value,
              responseDeadline:new Date(deadline.value).toISOString()});void openDetail(id);
          });});content.append(details);
          const form=make('form');form.className='form-stack';
          const date=make('input');date.type='date';date.required=true;
          const startTime=make('input');startTime.type='time';startTime.required=true;startTime.step=1800;
          const endTime=make('input');endTime.type='time';endTime.required=true;endTime.step=1800;
          const replace=make('select');replace.append(new Option('新しい候補を追加',''));
          for(const option of plan.options.filter(o=>!o.cancelled))replace.append(new Option(`${option.date} ${option.start}〜${option.end}を変更`,option.id));
          for(const [label,node] of [['変更対象',replace],['日付',date],['開始',startTime],['終了',endTime]]){
            const wrapper=make('label',label);wrapper.append(node);form.append(wrapper);
          }
          const submit=make('button','候補を保存','action-button');submit.type='submit';form.append(submit);
          form.addEventListener('submit',event=>{event.preventDefault();void run(async()=>{
            await api(replace.value?'options/replace':'options/add',{scheduleId:id,
              ...(replace.value?{optionId:replace.value}:{}),option:{date:date.value,start:startTime.value,end:endTime.value},
              clientRequestId:crypto.randomUUID()});void openDetail(id);
          });});
          content.append(form);
        }
        content.append(button('日程調整を中止',()=>void run(async()=>{
          if(!window.confirm('日程調整を中止しますか？履歴は残ります。'))return;
          await api('cancel',{scheduleId:id});void openDetail(id);
        }),'action-button danger'));
      }
      content.append(button('一覧へ戻る',()=>void openList()));
    });
  }
  $('schedules-open').addEventListener('click',()=>void openList());
  $('schedules-close').addEventListener('click',close);
  dialog.addEventListener('close',()=>{generation++;groupId=null;});
  return {close,openList,openCreate,openDetail};
}
