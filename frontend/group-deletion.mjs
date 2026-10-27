export function createGroupDeletion({ $, requestJson, setError, onSuccess, onMemberChanged }) {
  const dialog=$('group-delete-dialog'),yes=$('group-delete-yes'),no=$('group-delete-no');
  let group=null,busy=false;
  function open(selected,groupName) {
    group=selected;
    $('group-delete-description').textContent=`グループ『${groupName}』を削除しますか？`;
    setError('', 'group-delete-error');
    dialog.showModal();
  }
  no.addEventListener('click',()=>{if(!busy)dialog.close();});
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  yes.addEventListener('click',async()=>{
    if(busy||!group)return;
    const selected=group;
    busy=true;yes.disabled=true;no.disabled=true;
    setError('', 'group-delete-error');
    try {
      await requestJson('/api/groups/delete',{payload:{groupId:selected.groupId}});
      dialog.close();
      onSuccess(selected);
      group=null;
    }catch(error){
      if(error.data?.code==='GROUP_MEMBER_COUNT_CHANGED'){
        dialog.close();
        onMemberChanged();
      }else setError(error.message || 'グループを削除できませんでした。','group-delete-error');
    }finally{busy=false;yes.disabled=false;no.disabled=false;}
  });
  return {open};
}
