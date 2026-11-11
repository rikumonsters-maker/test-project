// All Worker requests are answered locally; unknown or external requests fail closed.
import { tokyoToday } from '../wish-expiry.mjs';
const user={id:'00000000-0000-4000-8000-000000000001',displayName:'テスト利用者'};
const group={groupId:'synthetic-group-a',memberId:'member-a',memberName:'テスト利用者',groupName:'合成グループ',inviteCode:'MP-SYNTHETIC'};
const members=[{memberId:'member-a',userId:user.id,memberName:user.displayName},
  {memberId:'member-b',userId:'00000000-0000-4000-8000-000000000002',memberName:'田中'}];
const privateMarkers=['私的タイトルSECRET','私的メモSECRET','勤務先SECRET','給与SECRET','家計簿SECRET'];
const date=tokyoToday();

export function syntheticApi({legacyEnabled=false,acknowledged=false,includeExpired=false,extraBusyMember=false,anonymousBusy=false,personalSyncActive=false,syncFailures=0,groupErrorPath='',frontendOrigin='http://127.0.0.1:5517',groups=[group],availabilityMode='success',holdAvailability=false,wishReactable=false}={}) {
  let releaseAvailability;
  const availabilityGate=holdAvailability?new Promise(resolve=>{releaseAvailability=resolve;}):Promise.resolve();
  const state={legacyEnabled,acknowledged,personalSyncActive,syncFailuresRemaining:syncFailures,groupErrorPath,requests:[],outside:[],groups,availabilityPending:0,releaseAvailability:()=>releaseAvailability?.()};
  const event=()=>({id:'anonymous-busy',sourceType:'busy',eventDate:date,start:'13:00',end:'15:00',
    title:'予定あり',busyDisplayName:'田中'});
  async function attach(context) {
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin===frontendOrigin && !url.pathname.startsWith('/api/')) return route.continue();
      if(url.origin!=='http://127.0.0.1:8787'||!url.pathname.startsWith('/api/')) {
        state.outside.push(url.origin+url.pathname);return route.abort();
      }
      const path=url.pathname;
      if(request.method()==='OPTIONS') return route.fulfill({status:204,headers:{
        'Access-Control-Allow-Origin':frontendOrigin,
        'Access-Control-Allow-Credentials':'true',
        'Access-Control-Allow-Headers':'content-type',
        'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
      }});
      let body={};try{body=request.postDataJSON()||{};}catch{}
      state.requests.push({path,method:request.method(),body});
      let status=200,data={};
      if(path==='/api/auth/me') data={user};
      else if(path===groupErrorPath) {status=422;data={error:'合成テストのグループエラーです。'};}
      else if(path==='/api/groups/create') data={membership:{groupId:'synthetic-created-group',memberId:'created-member',memberName:body.memberName,
        groupName:body.name,inviteCode:'MP-CREATED',memberCount:1}};
      else if(path==='/api/groups/join') data={membership:{groupId:'synthetic-joined-group',memberId:'joined-member',memberName:body.memberName,
        groupName:'招待参加グループ',inviteCode:body.inviteCode,memberCount:2}};
      else if(path==='/api/personal/events/status') data={active:personalSyncActive};
      else if(path==='/api/personal/events/sync'&&state.syncFailuresRemaining>0) {
        state.syncFailuresRemaining-=1;status=503;data={error:'合成テストの一時的な同期エラーです。'};
      }
      else if(path==='/api/personal/events/sync') data={events:[],cursor:Number(url.searchParams.get('cursor')||0),hasMore:false};
      else if(path==='/api/personal/events') data={events:[]};
      else if(path==='/api/personal/events/import') {
        const input=body.event||{};
        data={event:{...input,id:`restored-${body.sourceId}`,version:1,deleted:false},migrationConflict:false};
      }
      else if(path==='/api/groups/mine') data={groups};
      else if(path==='/api/profile') data={profile:{displayName:user.displayName,profileIcon:'🌿',email:'synthetic@example.invalid'}};
      else if(path==='/api/push/config') data={publicKey:'synthetic-public-key'};
      else if(path==='/api/notifications/count') data={count:0};
      else if(path==='/api/shared/named-busy/notice') {
        data={acknowledged:true,policy:'group',requiresAcknowledgement:false};
      }
      else if(path==='/api/shared/named-busy/setting') data={enabled:true,policy:'group',configurable:false};
      else if(path==='/api/shared/named-busy/update') {
        status=409;data={error:'名前表示の切替設定は終了しました。画面を更新してください',code:'NAMED_BUSY_POLICY_CHANGED'};
      }
      else if(path==='/api/shared/named-busy/timeline') data={members:members.map(m=>({name:m.memberName,
        sharing:true,status:'confirmed',
        busy:m.userId==='00000000-0000-4000-8000-000000000002'&&body.date===date?[{start:'13:00',end:'15:00'}]:[],tentative:[]}))};
      else if(path==='/api/groups/members/list') data={members};
      else if(path==='/api/groups/wishes/list') data={wishes:Array.from({length:4},(_,i)=>({id:`synthetic-wish-${i}`,wishDate:includeExpired&&i===0?'2020-01-01':date,
        message:`合成の遊びたい日 ${i+1}`,ownerName:'テスト利用者',userId:wishReactable&&i===0?'00000000-0000-4000-8000-000000000003':user.id,isOwn:!wishReactable||i!==0,
        managementState:'open',isAllDay:false,start:'18:00',end:'20:00',interestedUsers:[]}))};
      else if(['/api/groups/wishes/create','/api/groups/wishes/update','/api/groups/wishes/delete','/api/groups/wishes/react','/api/groups/wishes/unreact'].includes(path)) data={};
      else if(path==='/api/shared/events/list') data={events:[event(),...(extraBusyMember?[{
        id:'second-busy',sourceType:'busy',eventDate:date,start:'13:00',end:'15:00',title:'予定あり',
        busyDisplayName:'佐藤',
      }]:[]),...(anonymousBusy?[{id:'other-group-busy',sourceType:'busy',eventDate:date,start:'18:00',end:'20:00',title:'予定あり'}]:[])]};
      else if(path==='/api/shared/availability/search') {
        if(holdAvailability){state.availabilityPending+=1;await availabilityGate;state.availabilityPending-=1;}
        if(availabilityMode==='error'){status=503;data={error:'Synthetic availability failure'};}
        else if(availabilityMode==='empty') data={days:[],recommendations:[]};
        else data={days:[{date,unconfirmedUserIds:[],slots:[{start:'16:00',end:'18:00',registeredClearCount:2,hardConflictCount:0,tentativeConflictCount:0,unconfirmedCount:0,needsConfirmation:false}]}],
        recommendations:[{date,start:'16:00',end:'18:00',registeredClearCount:2,hardConflictCount:0,tentativeConflictCount:0,unconfirmedCount:0,reason:'登録済み予定との競合なし'}]};
      }
      else {status=501;data={error:`Synthetic API has no fixture for ${path}`};}
      try { await route.fulfill({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':frontendOrigin,'Access-Control-Allow-Credentials':'true'},body:JSON.stringify(data)}); }
      catch (error) { if (!request.failure()) throw error; }
    });
  }
  return {state,attach,privateMarkers,group,date};
}
