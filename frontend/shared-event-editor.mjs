export function canManageSharedEvent(event) {
  return event?.sourceType === 'shared' && event.status === 'confirmed' && event.canManage === true;
}

export function initSharedEventEditor({ $, requestJson, activeGroup, onSaved }) {
  const dialog = $('shared-event-editor');
  const form = $('shared-event-edit-form');
  const status = $('shared-event-edit-status');
  let selected = null;
  let busy = false;
  const field = name => form.elements.namedItem(name);
  function setBusy(value) {
    busy = value;
    for (const element of form.elements) element.disabled = value;
  }
  function close() { if (!busy) { dialog.close(); selected = null; } }
  function updateTimes() {
    field('start').disabled = field('end').disabled = field('allDay').checked;
    field('start').required = field('end').required = !field('allDay').checked;
  }
  async function save(remove) {
    const group = activeGroup();
    if (busy || !selected || group?.groupId !== selected.groupId) return;
    if (remove && !window.confirm('この共有予定を削除しますか？グループ全員のカレンダーから削除されます。')) return;
    const payload = { groupId:group.groupId, id:selected.event.id };
    if (!remove) Object.assign(payload, {
      title:field('title').value, eventDate:field('eventDate').value,
      allDay:field('allDay').checked,
      start:field('allDay').checked ? '' : field('start').value,
      end:field('allDay').checked ? '' : field('end').value, note:field('note').value,
    });
    status.textContent = '';
    setBusy(true);
    try {
      await requestJson(`/api/shared/events/${remove ? 'delete' : 'update'}`, { payload });
      dialog.close(); selected = null;
      await onSaved();
    } catch (error) { status.textContent = error.message || '共有予定を保存できませんでした。'; }
    finally { setBusy(false); updateTimes(); }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void save(false); });
  $('shared-event-edit-delete').addEventListener('click', () => void save(true));
  $('shared-event-edit-close').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); else selected = null; });
  field('allDay').addEventListener('change', updateTimes);
  return {
    open(event) {
      const group = activeGroup();
      if (busy || !group || !canManageSharedEvent(event)) return;
      selected = { event, groupId:group.groupId };
      for (const name of ['title','eventDate','start','end','note']) field(name).value = event[name] || '';
      field('allDay').checked = Boolean(event.allDay);
      status.textContent = '';
      updateTimes();
      dialog.showModal();
      field('title').focus();
    },
  };
}
