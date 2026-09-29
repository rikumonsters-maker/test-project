export function initShared(app) {
  const { $, state, view, dateKey, parseDate, requestJson, bindTimeInput, saveState } = app;
  let eventsByDate = {};
  let loadedMonths = new Set();
  let loadingMonths = new Set();
  let editingId = null;

  function activeGroup() {
    const group = state.shared;
    if (!group || !group.groupId || !group.memberId || !group.memberToken) return null;
    return group;
  }
  function credentials() {
    const group = activeGroup();
    return group ? { groupId:group.groupId, memberId:group.memberId, memberToken:group.memberToken } : null;
  }
  function monthKey(month) {
    return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
  }
  function setError(message = "") {
    const element = $("group-error");
    element.textContent = message;
    element.hidden = !message;
  }
  function setStatus(message, type = "") {
    const element = $("group-status");
    element.className = `status ${type}`.trim();
    element.textContent = message;
  }
  function timeIsValid(value) {
    return /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
  }
  function syncTimeFields() {
    const allDay = $("shared-event-all-day").checked;
    $("shared-event-time-fields").hidden = allDay;
    $("shared-event-start").required = !allDay;
    $("shared-event-end").required = !allDay;
  }
  function resetEventForm() {
    editingId = null;
    $("shared-event-form").reset();
    $("shared-event-date").value = view.agendaDate;
    $("shared-event-form-title").textContent = "共有予定を追加";
    $("save-shared-event").textContent = "共有予定を追加";
    $("cancel-shared-event-edit").hidden = true;
    $("shared-event-error").hidden = true;
    $("shared-event-error").textContent = "";
    syncTimeFields();
  }
  function renderGroup() {
    const group = activeGroup();
    $("group-setup").hidden = Boolean(group);
    $("group-active").hidden = !group;
    $("shared-event-card").hidden = !group;
    if (!group) {
      setStatus("グループを作成するか、招待コードで参加してください。");
      return;
    }
    $("active-group-name").textContent = group.groupName;
    $("active-group-member").textContent = `${group.memberName} として参加中`;
    $("active-group-code").value = group.inviteCode;
    setStatus("このグループの共有予定は、参加している端末間で同期されます。", "safe");
  }
  function eventsForDate(key) {
    return Array.isArray(eventsByDate[key]) ? eventsByDate[key] : [];
  }
  async function loadMonth(month = view.agendaMonth) {
    const group = activeGroup();
    if (!group) return;
    const key = monthKey(month);
    if (loadedMonths.has(key) || loadingMonths.has(key)) return;
    loadingMonths.add(key);
    renderSelectedDate();
    try {
      const data = await requestJson("/api/shared/events/list", {
        payload:{ ...credentials(), month:key },
      });
      if (!activeGroup() || activeGroup().groupId !== group.groupId) return;
      for (const event of data.events || []) {
        const records = eventsByDate[event.eventDate] || [];
        records.push(event);
        eventsByDate[event.eventDate] = records;
      }
      loadedMonths.add(key);
      setError();
      app.refreshAgenda?.();
    } catch (error) {
      setError(`共有予定を読み込めませんでした。${error.message}`);
    } finally {
      loadingMonths.delete(key);
      renderSelectedDate();
    }
  }
  function ensureMonth(month) {
    void loadMonth(month);
  }
  function appendEmptyState(container, text) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = text;
    container.append(empty);
  }
  function editEvent(event) {
    editingId = event.id;
    $("shared-event-title").value = event.title;
    $("shared-event-date").value = event.eventDate;
    $("shared-event-all-day").checked = Boolean(event.allDay);
    $("shared-event-start").value = event.start || "";
    $("shared-event-end").value = event.end || "";
    $("shared-event-start-picker").value = event.start || "";
    $("shared-event-end-picker").value = event.end || "";
    $("shared-event-note").value = event.note || "";
    $("shared-event-form-title").textContent = "共有予定を編集";
    $("save-shared-event").textContent = "変更を保存";
    $("cancel-shared-event-edit").hidden = false;
    $("shared-event-error").hidden = true;
    syncTimeFields();
    $("shared-event-title").focus();
  }
  function renderSelectedDate() {
    const container = $("agenda-shared-events");
    container.replaceChildren();
    const group = activeGroup();
    if (!group) {
      appendEmptyState(container, "グループに参加すると共有予定を表示できます。");
      return;
    }
    const events = eventsForDate(view.agendaDate);
    const isLoading = loadingMonths.has(monthKey(view.agendaMonth));
    if (!events.length) appendEmptyState(container, isLoading ? "共有予定を読み込んでいます…" : "この日の共有予定はありません。");
    for (const event of events) {
      const item = document.createElement("div");
      item.className = "agenda-item agenda-shared";
      const details = document.createElement("div");
      details.className = "agenda-event-details";
      const title = document.createElement("strong");
      title.textContent = event.title;
      const time = document.createElement("span");
      time.textContent = event.allDay ? "終日" : `${event.start}-${event.end}`;
      const author = document.createElement("span");
      author.className = "agenda-event-note";
      author.textContent = `登録: ${event.createdByName}`;
      details.append(title, time, author);
      if (event.note) {
        const note = document.createElement("span");
        note.className = "agenda-event-note";
        note.textContent = event.note;
        details.append(note);
      }
      item.append(details);
      if (event.createdByMemberId === group.memberId) {
        const actions = document.createElement("div");
        actions.className = "agenda-actions";
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "action-button";
        edit.textContent = "編集";
        edit.addEventListener("click", () => editEvent(event));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "action-button danger";
        remove.textContent = "削除";
        remove.addEventListener("click", () => void deleteEvent(event));
        actions.append(edit, remove);
        item.append(actions);
      }
      container.append(item);
    }
  }
  async function refreshCurrentMonth() {
    if (!activeGroup()) return;
    eventsByDate = {};
    loadedMonths = new Set();
    await loadMonth(view.agendaMonth);
  }
  async function submitGroup(event, path, fields) {
    event.preventDefault();
    setError();
    try {
      const data = await requestJson(path, { payload:fields() });
      state.shared = data.membership;
      eventsByDate = {};
      loadedMonths = new Set();
      saveState();
      renderGroup();
      resetEventForm();
      await loadMonth(view.agendaMonth);
    } catch (error) {
      setError(error.message || "グループを設定できませんでした。");
    }
  }
  function submitSharedEvent(event) {
    event.preventDefault();
    const title = $("shared-event-title").value.trim();
    const eventDate = $("shared-event-date").value;
    const allDay = $("shared-event-all-day").checked;
    const start = allDay ? "" : $("shared-event-start").value;
    const end = allDay ? "" : $("shared-event-end").value;
    const error = $("shared-event-error");
    if (!title || !eventDate || (!allDay && (!timeIsValid(start) || !timeIsValid(end) || end <= start))) {
      error.textContent = allDay ? "タイトルと日付を入力してください。" : "タイトル・日付と、開始時間より後の終了時間を入力してください。";
      error.hidden = false;
      return;
    }
    const payload = { ...credentials(), id:editingId, title, eventDate, allDay, start, end, note:$("shared-event-note").value.trim() };
    void requestJson(editingId ? "/api/shared/events/update" : "/api/shared/events/create", { payload })
      .then(async () => {
        view.agendaDate = eventDate;
        const date = parseDate(eventDate);
        view.agendaMonth = new Date(date.getFullYear(), date.getMonth(), 1);
        resetEventForm();
        await refreshCurrentMonth();
        app.refreshAgenda?.();
      })
      .catch((requestError) => {
        error.textContent = requestError.message || "共有予定を保存できませんでした。";
        error.hidden = false;
      });
  }
  async function deleteEvent(event) {
    try {
      await requestJson("/api/shared/events/delete", { payload:{ ...credentials(), id:event.id } });
      if (editingId === event.id) resetEventForm();
      await refreshCurrentMonth();
      app.refreshAgenda?.();
    } catch (error) {
      $("shared-event-error").textContent = error.message || "共有予定を削除できませんでした。";
      $("shared-event-error").hidden = false;
    }
  }
  function init() {
    bindTimeInput("shared-event-start", "shared-event-start-picker");
    bindTimeInput("shared-event-end", "shared-event-end-picker");
    $("shared-event-all-day").addEventListener("change", syncTimeFields);
    $("shared-event-form").addEventListener("submit", submitSharedEvent);
    $("cancel-shared-event-edit").addEventListener("click", resetEventForm);
    $("create-group-form").addEventListener("submit", (event) => void submitGroup(event, "/api/groups/create", () => ({ name:$("group-name").value.trim(), memberName:$("group-member-name").value.trim() })));
    $("join-group-form").addEventListener("submit", (event) => void submitGroup(event, "/api/groups/join", () => ({ inviteCode:$("group-invite-code").value.trim().toUpperCase(), memberName:$("join-member-name").value.trim() })));
    $("refresh-group-events").addEventListener("click", () => void refreshCurrentMonth());
    $("leave-group").addEventListener("click", () => {
      state.shared = null;
      eventsByDate = {};
      loadedMonths = new Set();
      saveState();
      renderGroup();
      resetEventForm();
      app.refreshAgenda?.();
    });
    $("copy-group-code").addEventListener("click", async () => {
      const code = $("active-group-code").value;
      try {
        await navigator.clipboard.writeText(code);
        setStatus("招待コードをコピーしました。", "safe");
      } catch {
        $("active-group-code").select();
        setStatus("招待コードを選択しました。コピーしてください。", "caution");
      }
    });
    renderGroup();
    resetEventForm();
  }
  return { init, ensureMonth, refreshMonth:refreshCurrentMonth, eventsForDate, renderSelectedDate, resetEventForm };
}
