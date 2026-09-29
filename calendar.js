export function initCalendar(app) {
  const { $, state, view, renderMonthCalendar, changeMonth, parseDate, makeId, saveState, dateLabel, bindTimeInput } = app;

  function agendaEntries(key) {
    const entries = [];
    const shift = state.shifts[key];
    if (shift) entries.push({ type:"shift", time:shift.start, label:`${shift.start}-${shift.end} バイト` });
    const events = Array.isArray(state.events[key]) ? state.events[key] : [];
    for (const event of events) {
      entries.push({
        type:"event",
        time:event.allDay ? "" : event.start,
        label:event.allDay ? `終日 ${event.title}` : `${event.start} ${event.title}`,
      });
    }
    return entries.sort((left, right) => left.time.localeCompare(right.time));
  }
  function appendEmptyState(container, text) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = text;
    container.append(empty);
  }
  function render() {
    renderMonthCalendar({
      calendarId:"agenda-calendar",
      month:view.agendaMonth,
      selectedDate:view.agendaDate,
      getEntries:agendaEntries,
      onSelect:(key, date) => {
        view.agendaDate = key;
        if (date.getMonth() !== view.agendaMonth.getMonth() || date.getFullYear() !== view.agendaMonth.getFullYear()) {
          view.agendaMonth = new Date(date.getFullYear(), date.getMonth(), 1);
        }
        resetForm(); render();
      },
    });
    const selectedDate = view.agendaDate;
    $("agenda-date").textContent = dateLabel.format(parseDate(selectedDate));
    const shiftList = $("agenda-shifts");
    shiftList.replaceChildren();
    const shift = state.shifts[selectedDate];
    if (shift) {
      const item = document.createElement("div");
      item.className = "agenda-item agenda-shift";
      const title = document.createElement("strong");
      title.textContent = "バイト";
      const time = document.createElement("span");
      time.textContent = `${shift.start}-${shift.end}`;
      item.append(title, time);
      shiftList.append(item);
    } else {
      appendEmptyState(shiftList, "この日のシフトはありません。");
    }
    const eventList = $("agenda-events");
    eventList.replaceChildren();
    const events = Array.isArray(state.events[selectedDate]) ? state.events[selectedDate] : [];
    if (!events.length) appendEmptyState(eventList, "個人予定はありません。");
    for (const event of events) {
      const item = document.createElement("div");
      item.className = "agenda-item agenda-personal";
      const details = document.createElement("div");
      details.className = "agenda-event-details";
      const title = document.createElement("strong");
      title.textContent = event.title;
      const time = document.createElement("span");
      time.textContent = event.allDay ? "終日" : `${event.start}-${event.end}`;
      details.append(title, time);
      if (event.note) {
        const note = document.createElement("span");
        note.className = "agenda-event-note";
        note.textContent = event.note;
        details.append(note);
      }
      const actions = document.createElement("div");
      actions.className = "agenda-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "action-button";
      edit.textContent = "編集";
      edit.addEventListener("click", () => editEvent(selectedDate, event));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "action-button danger";
      remove.textContent = "削除";
      remove.addEventListener("click", () => deleteEvent(selectedDate, event.id));
      actions.append(edit, remove);
      item.append(details, actions);
      eventList.append(item);
    }
  }
  function syncTimeFields() {
    const allDay = $("event-all-day").checked;
    $("event-time-fields").hidden = allDay;
    $("event-start").required = !allDay;
    $("event-end").required = !allDay;
  }
  function resetForm() {
    view.editingEventId = null;
    view.editingEventDate = null;
    $("event-form").reset();
    $("event-date").value = view.agendaDate;
    $("event-form-title").textContent = "個人予定を追加";
    $("save-event").textContent = "予定を追加";
    $("cancel-event-edit").hidden = true;
    $("event-error").hidden = true;
    $("event-error").textContent = "";
    syncTimeFields();
  }
  function editEvent(date, event) {
    view.editingEventId = event.id;
    view.editingEventDate = date;
    $("event-title").value = event.title;
    $("event-date").value = date;
    $("event-all-day").checked = Boolean(event.allDay);
    $("event-start").value = event.start || "";
    $("event-end").value = event.end || "";
    $("event-start-picker").value = event.start || "";
    $("event-end-picker").value = event.end || "";
    $("event-note").value = event.note || "";
    $("event-form-title").textContent = "個人予定を編集";
    $("save-event").textContent = "変更を保存";
    $("cancel-event-edit").hidden = false;
    $("event-error").hidden = true;
    syncTimeFields();
    $("event-title").focus();
  }
  function submitEvent(event) {
    event.preventDefault();
    const title = $("event-title").value.trim();
    const date = $("event-date").value;
    const allDay = $("event-all-day").checked;
    const start = allDay ? "" : $("event-start").value;
    const end = allDay ? "" : $("event-end").value;
    const validTime = (value) => /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
    if (!title || !date || (!allDay && (!validTime(start) || !validTime(end) || end <= start))) {
      $("event-error").textContent = allDay
        ? "タイトルと日付を入力してください。"
        : "タイトル・日付と、開始時間より後の終了時間を入力してください。";
      $("event-error").hidden = false;
      return;
    }
    const record = {
      id:view.editingEventId || makeId(),
      title,
      start,
      end,
      allDay,
      note:$("event-note").value.trim(),
    };
    if (view.editingEventId && view.editingEventDate) {
      const previous = (state.events[view.editingEventDate] || []).filter((item) => item.id !== view.editingEventId);
      if (previous.length) state.events[view.editingEventDate] = previous;
      else delete state.events[view.editingEventDate];
    }
    const destination = Array.isArray(state.events[date]) ? state.events[date] : [];
    destination.push(record);
    state.events[date] = destination;
    view.agendaDate = date;
    const selectedDate = parseDate(date);
    view.agendaMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
    saveState();
    app.shared?.markDirty(date.slice(0, 7));
    if (view.editingEventDate && view.editingEventDate !== date) app.shared?.markDirty(view.editingEventDate.slice(0, 7));
    render(); resetForm();
  }
  function deleteEvent(date, id) {
    const remaining = (state.events[date] || []).filter((event) => event.id !== id);
    if (remaining.length) state.events[date] = remaining;
    else delete state.events[date];
    if (view.editingEventId === id) resetForm();
    saveState(); app.shared?.markDirty(date.slice(0, 7)); render();
  }
  function init() {
    bindTimeInput("event-start", "event-start-picker");
    bindTimeInput("event-end", "event-end-picker");
    $("event-form").addEventListener("submit", submitEvent);
    $("cancel-event-edit").addEventListener("click", resetForm);
    $("event-all-day").addEventListener("change", syncTimeFields);
    $("agenda-previous").addEventListener("click", () => {
      view.agendaMonth = changeMonth(view.agendaMonth, -1);
      view.agendaDate = app.dateKey(view.agendaMonth);
      resetForm(); render();
    });
    $("agenda-next").addEventListener("click", () => {
      view.agendaMonth = changeMonth(view.agendaMonth, 1);
      view.agendaDate = app.dateKey(view.agendaMonth);
      resetForm(); render();
    });
    resetForm();
    render();
  }
  return { init, render };
}
