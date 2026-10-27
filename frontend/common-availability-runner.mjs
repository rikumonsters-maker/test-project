// The dialog owns this short-lived cache. Keys include the account and group.
export function createAvailabilityRunner({request,show,fail,loading,delay=400,ttl=150000,now=()=>Date.now()}) {
  const cache=new Map();
  let generation=0,timer=null,controller=null,visible=false,owner='',activeKey='';
  function cancel(){if(timer)clearTimeout(timer);timer=null;controller?.abort();controller=null;activeKey='';generation++;}
  function close(){visible=false;cancel();}
  function clear(){close();cache.clear();owner='';}
  function open(userId){if(owner!==userId)clear();owner=userId;visible=true;}
  function invalidate(groupId){
    for(const key of cache.keys())if(key.startsWith(`${owner}|${groupId}|`))cache.delete(key);
    cancel();
  }
  function run(payload,{immediate=false,force=false}={}){
    if(!visible)return;
    const key=`${owner}|${payload.groupId}|${JSON.stringify(payload)}`;
    if(!force&&activeKey===key&&(timer||controller))return;
    cancel();const id=generation;activeKey=key;
    const cached=cache.get(key);
    if(!force&&cached&&now()-cached.at<ttl){activeKey='';show(cached.data,payload);return;}
    loading();
    const execute=async()=>{
      controller=new AbortController();
      try{const data=await request(payload,controller.signal);
        if(!visible||id!==generation)return;
        cache.set(key,{at:now(),data});show(data,payload);
      }catch(error){if(visible&&id===generation&&error?.name!=='AbortError')fail(error);}
      finally{if(id===generation){controller=null;activeKey='';}}
    };
    if(immediate)void execute();else timer=setTimeout(()=>{timer=null;void execute();},delay);
  }
  return {open,close,clear,invalidate,run};
}
