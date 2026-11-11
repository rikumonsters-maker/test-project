import { initReminderControls } from "./reminder-controls.mjs";
import { currentTimeZone, readReminderSettings, writeReminderSettings } from "./reminders.mjs";
import { initFormDialog } from "./form-dialog.mjs";
import { isImportEventReady } from "./screenshot-calendar-ocr.mjs";

export function initCalendar(app) {
  const { $, state, view, renderMonthCalendar, animateCalendarDetails, changeMonth, parseDate, makeId, saveState, dateLabel, bindTimeInput } = app;
  let eventDialog = null;
  let screenshotImporter = null;
  let screenshotTransitionPending = false;

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
  function render({ animateDetails = false } = {}) {
    renderMonthCalendar({
      calendarId:"agenda-calendar",
      month:view.agendaMonth,
      selectedDate:view.agendaDate,
      getEntries:agendaEntries,
      onSelect:(key, date) => {
        const dateChanged = view.agendaDate !== key;
        view.agendaDate = key;
        if (date.getMonth() !== view.agendaMonth.getMonth() || date.getFullYear() !== view.agendaMonth.getFullYear()) {
          view.agendaMonth = new Date(date.getFullYear(), date.getMonth(), 1);
        }
        resetForm(); render({ animateDetails:dateChanged });
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
      item.dataset.eventId = event.id || "";
      if (event.id === view.reminderEventId) item.classList.add("agenda-reminder-target");
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
      edit.addEventListener("click", () => editEvent(selectedDate, event, edit));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "action-button danger";
      remove.textContent = "削除";
      remove.addEventListener("click", () => deleteEvent(selectedDate, event.id));
      actions.append(edit, remove);
      item.append(details, actions);
      eventList.append(item);
    }
    if (view.reminderEventId) {
      const target = [...eventList.querySelectorAll("[data-event-id]")].find((item) => item.dataset.eventId === view.reminderEventId);
      if (target) {
        target.scrollIntoView({ behavior:"smooth", block:"center" });
        view.reminderEventId = null;
      }
    }
    if (animateDetails) {
      animateCalendarDetails($("agenda-events").closest(".calendar-details-panel"));
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
    view.editingEventExtra = {};
    $("event-form").reset();
    $("event-date").value = view.agendaDate;
    $("event-form-title").textContent = "個人予定を追加";
    $("save-event").textContent = "予定を追加";
    $("cancel-event-edit").hidden = true;
    $("event-screenshot-import-entry").hidden = !screenshotImporter;
    $("event-screenshot-import-divider").hidden = !screenshotImporter;
    $("event-error").hidden = true;
    $("event-error").textContent = "";
    syncTimeFields();
    reminderControls?.set([]);
    updateReminderSyncNote();
  }
  function editEvent(date, event, trigger) {
    view.editingEventVersion = event.version;
    view.editingEventExtra = event.extra || {};
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
    $("event-screenshot-import-entry").hidden = true;
    $("event-screenshot-import-divider").hidden = true;
    reminderControls.set(readReminderSettings(view.editingEventExtra).offsetMinutes);
    $("event-form-title").textContent = "個人予定を編集";
    $("save-event").textContent = "変更を保存";
    $("cancel-event-edit").hidden = false;
    $("event-error").hidden = true;
    syncTimeFields();
    updateReminderSyncNote();
    eventDialog.open({ trigger, focus:$('event-title') });
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
    const existingReminderSettings = readReminderSettings(view.editingEventExtra || {});
    let extra;
    try {
      extra = writeReminderSettings(view.editingEventExtra || {}, reminderControls.selected(),
        existingReminderSettings.timeZone || currentTimeZone());
    } catch (error) {
      $("event-error").textContent = error.message;
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
      extra,
    };
    if(app.personalSync?.isActive?.()) {
      try { app.personalSync.queue(view.editingEventId ? "update" : "create",record.id,record,date,view.editingEventVersion); }
      catch(error) { $("event-error").textContent = error.message; $("event-error").hidden = false;return; }
      view.agendaDate = date;view.agendaMonth = new Date(parseDate(date).getFullYear(),parseDate(date).getMonth(),1);
      render();resetForm();eventDialog?.close({ force:true });void app.personalSync.sync();return;
    }
    const changedDates = new Set([view.editingEventDate, date].filter(Boolean));
    const previousByDate = new Map([...changedDates].map((key) => [key,
      Array.isArray(state.events[key]) ? [...state.events[key]] : null]));
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
    try {
      saveState();
    } catch {
      for (const [key, previous] of previousByDate) {
        if (previous) state.events[key] = previous;
        else delete state.events[key];
      }
      $("event-error").textContent = "予定を保存できませんでした。入力内容は保持されています。";
      $("event-error").hidden = false;
      return;
    }
    app.shared?.markDirty(date.slice(0, 7));
    if (view.editingEventDate && view.editingEventDate !== date) app.shared?.markDirty(view.editingEventDate.slice(0, 7));
    render(); resetForm(); eventDialog?.close({ force:true });
  }
  function deleteEvent(date, id) {
    if(app.personalSync?.isActive?.()) {
      try {app.personalSync.queue("delete",id,null,null,(state.events[date]||[]).find(event=>event.id===id)?.version);}
      catch(error) {$("event-error").textContent=error.message;$("event-error").hidden=false;return;}
      if(view.editingEventId === id) resetForm();render();void app.personalSync.sync();return;
    }
    const remaining = (state.events[date] || []).filter((event) => event.id !== id);
    if (remaining.length) state.events[date] = remaining;
    else delete state.events[date];
    if (view.editingEventId === id) resetForm();
    saveState(); app.shared?.markDirty(date.slice(0, 7)); render();
  }
  function addImportedEvents(importedEvents) {
    if (!app.personalSyncReady) throw new Error("個人予定の同期状態を確認できません。データを変更せず、同期状態が表示されてから再度お試しください。");
    if (!Array.isArray(importedEvents) || !importedEvents.length || importedEvents.some((event) => !isImportEventReady(event))) {
      throw new Error("日付・予定名・時刻が確定していない予定は追加できません。");
    }
    const records = importedEvents.map((event) => ({
      id:makeId(), title:event.title.trim(), start:event.allDay ? "" : event.start, end:event.allDay ? "" : event.end,
      allDay:Boolean(event.allDay), note:"", extra:{},
    }));
    const dates = importedEvents.map((event) => event.date);
    if (app.personalSync?.isActive?.()) {
      app.personalSync.queueMany(records.map((record, index) => ({ ...record, date:dates[index] })));
    } else {
      const previous = state.events || {};
      const next = Object.fromEntries(Object.entries(previous).map(([date, events]) => [date, Array.isArray(events) ? [...events] : events]));
      records.forEach((record, index) => { (next[dates[index]] ||= []).push(record); });
      state.events = next;
      try { saveState(); }
      catch (error) { state.events = previous; throw error; }
      for (const month of new Set(dates.map((date) => date.slice(0, 7)))) app.shared?.markDirty(month);
    }
    const firstDate = dates[0];
    view.agendaDate = firstDate;
    const selectedDate = parseDate(firstDate);
    view.agendaMonth = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
    render();
    return { count:records.length, queued:Boolean(app.personalSync?.isActive?.()), eventIds:records.map((record) => record.id) };
  }
  function setScreenshotImporter(importer) {
    screenshotImporter = importer || null;
  }
  function showScreenshotImportResult({ message, kind = "success" } = {}) {
    const result = $("event-screenshot-import-result");
    if (!result || !message) return;
    result.textContent = message;
    result.className = kind === "error" ? "status error" : kind === "caution" ? "status caution" : "status";
    result.dataset.kind = kind;
    result.hidden = false;
  }
  function init() {
    reminderControls = initReminderControls($("personal-reminder-controls"));
    bindTimeInput("event-start", "event-start-picker");
    bindTimeInput("event-end", "event-end-picker");
    eventDialog = initFormDialog({
      dialog:$('event-dialog'),
      form:$('event-form'),
      closeButton:$('close-event-dialog'),
      fallbackOpener:()=>$('open-event-dialog'),
      onClose:resetForm,
    });
    $("event-dialog").addEventListener("close", () => {
      if (!screenshotTransitionPending) return;
      screenshotTransitionPending = false;
      const opened = screenshotImporter?.open?.({ source:"calendar", trigger:$('open-event-dialog') });
      if (!opened) showScreenshotImportResult({ message:"スクショ取り込み画面を開けませんでした。もう一度お試しください。", kind:"error" });
    });
    $("event-screenshot-import-open").addEventListener("click", () => {
      if (!screenshotImporter || view.editingEventId || screenshotTransitionPending || !eventDialog.isOpen()) return;
      screenshotTransitionPending = true;
      if (!eventDialog.close()) screenshotTransitionPending = false;
    });
    $('open-event-dialog').addEventListener('click', (event) => {
      $("event-screenshot-import-result").hidden = true;
      resetForm();
      eventDialog.open({ trigger:event.currentTarget, focus:$('event-title') });
    });
    $("event-form").addEventListener("submit", submitEvent);
    $("cancel-event-edit").addEventListener("click", () => eventDialog.close());
    $("event-all-day").addEventListener("change", syncTimeFields);
    $("agenda-previous").addEventListener("click", () => {
      const previousDate = view.agendaDate;
      view.agendaMonth = changeMonth(view.agendaMonth, -1);
      view.agendaDate = app.dateKey(view.agendaMonth);
      resetForm(); render({ animateDetails:previousDate !== view.agendaDate });
    });
    $("agenda-next").addEventListener("click", () => {
      const previousDate = view.agendaDate;
      view.agendaMonth = changeMonth(view.agendaMonth, 1);
      view.agendaDate = app.dateKey(view.agendaMonth);
      resetForm(); render({ animateDetails:previousDate !== view.agendaDate });
    });
    resetForm();
    render();
  }
  let reminderControls = null;
  function updateReminderSyncNote() {
    const note = $("personal-reminder-sync-note");
    if (!note) return;
    note.textContent = app.personalSync?.isActive?.()
      ? "個人予定の同期が有効です。予定と通知設定を同期先に保存し、通知を許可した端末へ送ります。"
      : "個人予定の同期が無効です。この端末だけに保存した通知設定からは、アプリ内通知もPush通知も送られません。通知を使うには個人予定の同期を開始してください。";
  }
  return { init, render, addImportedEvents, setScreenshotImporter, showScreenshotImportResult };
}
