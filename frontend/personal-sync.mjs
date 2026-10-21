const clone = value => JSON.parse(JSON.stringify(value));

function eventInput(event, date) {
  const {id,title,start='',end='',allDay=false,note='',version,deleted,createdAt,updatedAt,extra,date:ignoredDate,...other}=event;
  return {date,title,start:allDay?'':start,end:allDay?'':end,allDay:Boolean(allDay),note,extra:{...other,...(extra||{})}};
}

export function createPersonalSync({storage,key,state,requestJson,onChange=()=>{},onStatus=()=>{},isCurrent=()=>true,makeId=()=>crypto.randomUUID()}) {
  // v2 intentionally leaves every v1 metadata key untouched and never reads its migration or write queue.
  const metaKey=`${key}-personal-sync-v2`,backupKey=`${key}-personal-backup-v2`;
  let meta=null,ready=false,active=false,working=null,inFlight=null,lastStatus='',rerun=false;

  function read() {const raw=storage.getItem(metaKey);return raw ? JSON.parse(raw):null;}
  function persist() {
    try {storage.setItem(metaKey,JSON.stringify(meta));}
    catch {meta=read() || meta;throw new Error('端末の保存領域が不足しています。バックアップを保存し、空き容量を確認してください。');}
  }
  function status(message) {lastStatus=message;if(isCurrent()) onStatus(message,conflicts());}
  function conflicts() {return clone((meta?.queue||[]).filter(op=>op.conflict).map(op=>({...op,event:(meta.queue||[]).filter(item=>item.id===op.id).at(-1)?.event??op.event})));}
  function publish() {
    if (!meta || !isCurrent()) return;
    const records={...meta.records};
    for(const op of meta.queue) {
      if(op.action==='delete') delete records[op.id];
      else records[op.id]={...op.event,id:op.id,version:op.version||0};
    }
    const events={};
    for(const row of Object.values(records)) {
      if(row.deleted) continue;
      const {date,...event}=row;
      (events[date] ||= []).push({...event.extra,...event});
    }
    state.events=events;onChange();
  }
  function takeArchiveSnapshot() {
    if(storage.getItem(backupKey)) return;
    // Preserve the full pre-cutover local record plus a directly readable event snapshot.
    storage.setItem(backupKey,JSON.stringify({savedAt:new Date().toISOString(),originalState:storage.getItem(key),events:clone(state.events||{})}));
  }
  function mergeEventMaps(...maps) {
    const merged={},seen=new Map();
    for(const map of maps) for(const [date,entries] of Object.entries(map||{})) {
      if(!Array.isArray(entries)) continue;
      const rows=(merged[date] ||= []);
      let keys=seen.get(date);if(!keys){keys=new Set();seen.set(date,keys);}
      for(const event of entries) {
        const fingerprint=JSON.stringify(event);
        if(keys.has(fingerprint)) continue;
        keys.add(fingerprint);rows.push(event);
      }
    }
    return merged;
  }
  function freshMeta() {return {format:2,cursor:0,records:{},queue:[],restoreQueue:[],active:true,results:{}};}

  async function initialize() {
    ready=false;active=false;
    const server=await requestJson('/api/personal/events/status',{method:'GET'});
    if(!isCurrent()) return {active:false};
    if(!server.active) {
      ready=true;
      status('個人予定の同期はまだ開始していません。端末内の予定はそのままです。');
      return {active:false};
    }
    takeArchiveSnapshot();
    const stored=read();
    meta=stored?.format===2 ? stored : freshMeta();
    meta.format=2;meta.restoreQueue ||= [];meta.queue ||= [];meta.records ||= {};meta.results ||= {};
    meta.active=true;active=true;ready=true;
    // This device has opted in elsewhere. Do not show its legacy local calendar as cloud data.
    if(stored?.format!==2) {persist();state.events={};onChange();}
    await sync();
    return {active:true};
  }

  function queue(action,id,event,date,baseVersion) {
    if(!ready || !active) throw new Error('新しいカレンダー同期を開始してから予定を保存してください。');
    id=String(id);
    const previous=meta.queue.filter(op=>op.id===id).at(-1);
    if(meta.queue.some(op=>op.id===id && op.conflict)) throw new Error('この予定には競合があります。同期欄で内容を確認してください。');
    const value=action==='delete'?null:eventInput(event,date);
    if(previous && previous.operationId!==inFlight && !previous.sent) {
      previous.event=value;
      if(action==='delete' && previous.action==='create') {meta.queue=meta.queue.filter(op=>op!==previous);delete meta.records[id];}
      else if(action==='delete') previous.action='delete';
      persist();publish();status('未同期の変更があります');return;
    }
    meta.queue.push({operationId:makeId(),action,id,event:value,version:baseVersion??meta.records[id]?.version??0,dependsOn:previous?.operationId||null});
    persist();publish();status('未同期の変更があります');
  }

  async function pull() {
    let more=true;
    while(more && isCurrent()) {
      let result;
      try {result=await requestJson(`/api/personal/events/sync?cursor=${meta.cursor}`,{method:'GET'});}
      catch(error) {
        if(error.data?.resetCursor) {
          const snapshot=await requestJson('/api/personal/events',{method:'GET'});
          storage.setItem(`${metaKey}-before-cursor-reset-${Date.now()}`,JSON.stringify(meta));
          meta.records=Object.fromEntries(snapshot.events.map(event=>[event.id,event]));meta.cursor=0;persist();continue;
        }
        throw error;
      }
      if(!isCurrent()) return;
      for(const event of result.events) {
        const existing=meta.records[event.id];
        if(!existing || event.version>=existing.version) meta.records[event.id]=event;
      }
      meta.cursor=result.cursor;more=result.hasMore;persist();publish();
    }
  }

  async function run() {
    if(!ready || !active || !isCurrent()) return;
    status('同期中…');
    try {
      await pull();
      if(!isCurrent()) return;
      for(const item of [...meta.restoreQueue]) {
        const result=await requestJson('/api/personal/events/import',{payload:{sourceId:item.sourceId,event:item.event,restoreConfirmed:true}});
        if(!isCurrent()) return;
        delete meta.records[item.localId];
        meta.records[result.event.id]=result.event;
        meta.restoreQueue=meta.restoreQueue.filter(row=>row.operationId!==item.operationId);
        meta.migrationConflicts ||= result.migrationConflict;persist();publish();
      }
      let wrote=false;
      for(const op of [...meta.queue]) {
        if(op.conflict || !meta.queue.some(item=>item.operationId===op.operationId)) continue;
        if(op.dependsOn) {
          if(meta.results[op.dependsOn]) op.version=meta.results[op.dependsOn];
          else if(meta.queue.some(item=>item.operationId===op.dependsOn)) continue;
        }
        inFlight=op.operationId;op.sent=true;persist();
        try {
          const result=await requestJson(`/api/personal/events/${op.action}`,{payload:{syncProtocol:2,id:op.id,operationId:op.operationId,version:op.version,event:op.event}});
          if(!isCurrent()) return;
          const cached=meta.records[result.event.id];
          if(!cached || result.event.version>=cached.version) meta.records[result.event.id]=result.event;
          meta.results[op.operationId]=result.event.version;wrote=true;
          meta.queue=meta.queue.filter(item=>item.operationId!==op.operationId);
        } catch(error) {
          if(!isCurrent()) return;
          if(error.status===409 && error.data?.conflict) {op.conflict=true;op.remote=error.data.event;meta.records[op.id]=error.data.event;}
          else if(error.status===404) {op.conflict=true;op.remote=null;}
          else throw error;
        } finally {inFlight=null;persist();publish();}
      }
      if(wrote) await pull();
      const needed=new Set(meta.queue.map(op=>op.dependsOn).filter(Boolean));
      for(const id of Object.keys(meta.results)) if(!needed.has(id)) delete meta.results[id];
      persist();
      status(conflicts().length ? '別端末との競合があります。変更内容は端末に保管されています。' : meta.queue.length ? '未同期の変更があります' : meta.migrationConflicts ? '同期完了。同じIDで内容が異なる復元予定は両方保管しました。' : '同期完了');
    } catch(error) {status(`同期失敗・オフライン：${error.message} 未同期の予定は端末に保管されています。`);}
  }

  function sync() {
    if(!active || !ready) return Promise.resolve();
    if(working) {rerun=true;return working;}
    const task=run();working=task.finally(()=>{working=null;if(rerun && isCurrent()){rerun=false;void sync();}});return working;
  }

  async function startFresh() {
    if(!ready) {
      await requestJson('/api/personal/events/status',{method:'GET'});
      if(!isCurrent()) return;
      ready=true;
    }
    if(active) return sync();
    takeArchiveSnapshot();
    const result=await requestJson('/api/personal/events/activate',{payload:{freshStart:true}});
    if(!isCurrent()) return;
    if(!result.active) throw new Error('同期を開始できませんでした。もう一度お試しください。');
    const stored=read();
    meta=stored?.format===2 && stored.active ? stored : freshMeta();
    meta.format=2;meta.active=true;meta.restoreQueue ||= [];meta.queue ||= [];meta.records ||= {};meta.results ||= {};
    active=true;ready=true;
    // A new account has no imported event rows. Existing rows can exist only if another device won a race;
    // pull them below rather than sending this device's old local data.
    if(stored?.format!==2) state.events={};
    persist();publish();
    await sync();
  }

  function resolve(operationId,choice) {
    const op=meta?.queue.find(item=>item.operationId===operationId && item.conflict);
    if(!op) return;
    const latest=meta.queue.filter(item=>item.id===op.id).at(-1);
    meta.queue=meta.queue.filter(item=>item.id!==op.id);
    if(choice==='copy' && latest.event) queue('create',makeId(),latest.event,latest.event.date,0);
    else if(choice==='delete' && op.remote && !op.remote.deleted) queue('delete',op.id,null,null,op.remote.version);
    persist();publish();status('未同期の変更があります');void sync();
  }

  // This method is called only after an explicit restore confirmation in the UI.
  function restore(events) {
    if(!ready || !active) throw new Error('先に新しいカレンダー同期を開始してください。');
    const archiveKey=`${backupKey}-restore-${makeId()}`;
    storage.setItem(archiveKey,JSON.stringify({savedAt:new Date().toISOString(),events:clone(events)}));
    const additions=[];
    for(const [date,entries] of Object.entries(events)) {
      if(!Array.isArray(entries)) throw new Error('復元する予定の形式を確認してください。バックアップは保管されています。');
      for(const event of entries) {
        const localId=makeId(),sourceId=String(event.id || `restore:${localId}`),input=eventInput(event,date);
        if([...meta.restoreQueue,...additions].some(item=>item.sourceId===sourceId && JSON.stringify(item.event)===JSON.stringify(input))) continue;
        additions.push({operationId:makeId(),localId,sourceId,event:input});
      }
    }
    for(const item of additions) {meta.records[item.localId]={...item.event,id:item.localId,version:0};meta.restoreQueue.push(item);}
    persist();publish();return additions.length;
  }

  // Legacy import may transfer shifts/budget/etc., but its old events are archived locally only.
  function archiveLegacy(events) {
    if(!events || typeof events!=='object' || Array.isArray(events)) return;
    const archivesKey=`${backupKey}-legacy-archives`;
    let archives=[];
    try {archives=JSON.parse(storage.getItem(archivesKey)||'[]');} catch {}
    if(!Array.isArray(archives)) archives=[];
    archives.push({savedAt:new Date().toISOString(),events:clone(events)});
    storage.setItem(archivesKey,JSON.stringify(archives));
  }

  function backup() {
    let snapshot=null;
    try {snapshot=JSON.parse(storage.getItem(backupKey)||'null');} catch {}
    let legacyArchives=[];
    try {legacyArchives=JSON.parse(storage.getItem(`${backupKey}-legacy-archives`)||'[]');} catch {}
    const archiveEvents=mergeEventMaps(snapshot?.events || (!active ? clone(state.events||{}) : {}),...(Array.isArray(legacyArchives)?legacyArchives.map(item=>item?.events):[]));
    return JSON.stringify({savedAt:new Date().toISOString(),originalState:JSON.stringify({events:archiveEvents}),archiveEvents:clone(archiveEvents),events:active?clone(state.events||{}):{}});
  }

  return {initialize,startFresh,queue,sync,resolve,restore,archiveLegacy,backup,status:()=>lastStatus,isActive:()=>active};
}
