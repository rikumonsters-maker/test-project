// All Worker requests are answered locally; unknown or external requests fail closed.
const user={id:'00000000-0000-4000-8000-000000000001',displayName:'テスト利用者'};
const group={groupId:'synthetic-group-a',memberId:'member-a',memberName:'テスト利用者',groupName:'合成グループ',inviteCode:'MP-SYNTHETIC'};
const members=[{memberId:'member-a',userId:user.id,memberName:user.displayName},
  {memberId:'member-b',userId:'00000000-0000-4000-8000-000000000002',memberName:'田中'}];
const privateMarkers=['私的タイトルSECRET','私的メモSECRET','勤務先SECRET','給与SECRET','家計簿SECRET'];
const date='2026-10-31';

export function syntheticApi({legacyEnabled=false,acknowledged=false}={}) {
  const state={legacyEnabled,acknowledged,requests:[],outside:[]};
  const named=()=>state.legacyEnabled||state.acknowledged;
  const event=()=>({id:'anonymous-busy',sourceType:'busy',eventDate:date,start:'13:00',end:'15:00',
    title:'予定あり',...(named()?{busyDisplayName:'田中'}:{})});
  async function attach(context) {
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin==='http://127.0.0.1:5517' && !url.pathname.startsWith('/api/')) return route.continue();
      if(url.origin!=='http://127.0.0.1:8787'||!url.pathname.startsWith('/api/')) {
        state.outside.push(url.origin+url.pathname);return route.abort();
      }
      const path=url.pathname;
      if(request.method()==='OPTIONS') return route.fulfill({status:204,headers:{
        'Access-Control-Allow-Origin':'http://127.0.0.1:5517',
        'Access-Control-Allow-Credentials':'true',
        'Access-Control-Allow-Headers':'content-type',
        'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
      }});
      let body={};try{body=request.postDataJSON()||{};}catch{}
      state.requests.push({path,method:request.method(),body});
      let status=200,data={};
      if(path==='/api/auth/me') data={user};
      else if(path==='/api/personal/events/status') data={active:false};
      else if(path==='/api/groups/mine') data={groups:[group]};
      else if(path==='/api/profile') data={profile:{displayName:user.displayName,profileIcon:'🌿',email:'synthetic@example.invalid'}};
      else if(path==='/api/notifications/count') data={count:0};
      else if(path==='/api/shared/named-busy/notice') {
        if(body.acknowledge===true) state.acknowledged=true;
        data={acknowledged:state.acknowledged,policy:'group-after-notice'};
      }
      else if(path==='/api/shared/named-busy/setting') data={enabled:named(),policy:state.acknowledged?'group':'legacy'};
      else if(path==='/api/shared/named-busy/update') {
        if(state.acknowledged && body.enabled===false){status=409;data={error:'表示方法が変更されました。画面を更新してください',code:'NAMED_BUSY_POLICY_CHANGED'};}
        else {state.legacyEnabled=body.enabled===true;data={enabled:named(),policy:'legacy'};}
      }
      else if(path==='/api/shared/named-busy/timeline') data={members:members.map(m=>({name:m.memberName,
        userId:m.userId,sharing:m.userId===user.id||named(),status:'confirmed',
        busy:m.userId==='00000000-0000-4000-8000-000000000002'&&named()&&body.date===date?[{start:'13:00',end:'15:00'}]:[],tentative:[]}))};
      else if(path==='/api/groups/members/list') data={members};
      else if(path==='/api/groups/wishes/list') data={wishes:Array.from({length:4},(_,i)=>({id:`synthetic-wish-${i}`,wishDate:date,
        message:`合成の遊びたい日 ${i+1}`,ownerName:'テスト利用者',userId:user.id,isOwn:true,
        managementState:'open',isAllDay:false,start:'18:00',end:'20:00',interestedUsers:[]}))};
      else if(path==='/api/shared/events/list') data={events:[event()]};
      else if(path==='/api/shared/availability/search') data={days:[{date,unconfirmedUserIds:[],slots:[{start:'16:00',end:'18:00',registeredClearCount:2,hardConflictCount:0,tentativeConflictCount:0,unconfirmedCount:0,needsConfirmation:false}]}],
        recommendations:[{date,start:'16:00',end:'18:00',registeredClearCount:2,hardConflictCount:0,tentativeConflictCount:0,unconfirmedCount:0,reason:'登録済み予定との競合なし'}]};
      else {status=501;data={error:`Synthetic API has no fixture for ${path}`};}
      await route.fulfill({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'http://127.0.0.1:5517','Access-Control-Allow-Credentials':'true'},body:JSON.stringify(data)});
    });
  }
  return {state,attach,privateMarkers,group,date};
}
