export function initShared(app) {
  const { $, state, view, parseDate, requestJson, saveState, renderMonthCalendar, changeMonth, dateLabel } = app;
  let activeGroupId = null;
  let eventsByDate = {};
  let loadedMonths = new Set();
  let loadingMonths = new Set();
  let loadGeneration = 0;
  let syncing = false;

  function memberships() {
    return state.groups.filter((group) => group && group.groupId && group.memberId && group.memberToken);
  }
  function activeGroup() {
    return memberships().find((group) => group.groupId === activeGroupId) || null;
  }
  function credentials(group) {
    return { groupId:group.groupId, memberId:group.memberId, memberToken:group.memberToken };
  }
  function monthKey(month) {
    return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
  }
  function setError(message = "", id = "group-error") {
    const element = $(id);
    element.textContent = message;
    element.hidden = !message;
  }
  function setStatus(message, type = "") {
    const element = $("group-status");
    element.className = `status ${type}`.trim();
    element.textContent = message;
  }
  function resetCache() {
    loadGeneration += 1;
    eventsByDate = {};
    loadedMonths = new Set();
    loadingMonths = new Set();
  }
  function showHome() {
    $("group-home").hidden = false;
    $("group-calendar-view").hidden = true;
    activeGroupId = null;
    resetCache();
    renderGroups();
  }
  function groupCard(group) {
    const card = document.createElement("article");
    card.className = "card";
    const heading = document.createElement("h3");
    heading.className = "group-name";
    const name = document.createElement("button");
    name.type = "button";
    name.className = "group-name-button";
    name.textContent = group.groupName;
    name.setAttribute("aria-label", `${group.groupName}の共有カレンダーを表示`);
    name.addEventListener("click", () => openCalendar(group.groupId));
    heading.append(name);
    const member = document.createElement("p");
    member.className = "group-member";
    member.textContent = `${group.memberName} として参加中`;
    const label = document.createElement("label");
    label.textContent = "招待コード";
    const copyField = document.createElement("span");
    copyField.className = "copy-field";
    const code = document.createElement("input");
    code.type = "text";
    code.readOnly = true;
    code.value = group.inviteCode || "";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "action-button";
    copy.textContent = "コピー";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.value);
        setStatus("招待コードをコピーしました。", "safe");
      } catch {
        code.select();
        setStatus("招待コードを選択しました。コピーしてください。", "caution");
      }
    });
    copyField.append(code, copy);
    label.append(copyField);
    const actions = document.createElement("div");
    actions.className = "actions";
    const leave = document.createElement("button");
    leave.type = "button";
    leave.className = "action-button danger";
    leave.textContent = "グループから退出";
    leave.addEventListener("click", () => void leaveGroup(group));
    actions.append(leave);
    card.append(heading, member, label, actions);
    return card;
  }
  function renderGroups() {
    const list = $("group-list");
    list.replaceChildren();
    const groups = memberships();
    if (!groups.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state card";
      empty.textContent = "参加中のグループはありません。";
      list.append(empty);
    } else {
      groups.forEach((group) => list.append(groupCard(group)));
    }
  }
  function appendEmptyState(container, text) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = text;
    container.append(empty);
  }
  function eventsForDate(key) {
    return Array.isArray(eventsByDate[key]) ? eventsByDate[key] : [];
  }
  async function loadMonth(month = view.groupMonth) {
    const group = activeGroup();
    if (!group) return;
    const key = monthKey(month);
    if (loadedMonths.has(key) || loadingMonths.has(key)) return;
    const generation = loadGeneration;
    loadingMonths.add(key);
    renderSelectedDate();
    try {
      const data = await requestJson("/api/shared/events/list", { payload:{ ...credentials(group), month:key } });
      if (generation !== loadGeneration || activeGroupId !== group.groupId) return;
      for (const event of data.events || []) {
        (eventsByDate[event.eventDate] ||= []).push(event);
      }
      loadedMonths.add(key);
      setError("", "group-calendar-error");
      renderCalendar();
    } catch (error) {
      if (generation === loadGeneration) setError(`共有予定を読み込めませんでした。${error.message}`, "group-calendar-error");
    } finally {
      if (generation === loadGeneration) {
        loadingMonths.delete(key);
        renderSelectedDate();
      }
    }
  }
  async function loadGroupMembers(group) {
    const container = $("group-members");
    const generation = loadGeneration;
    container.replaceChildren();
    appendEmptyState(container, "メンバーを読み込んでいます…");
    setError("", "group-members-error");
    try {
      const data = await requestJson("/api/groups/members/list", { payload:credentials(group) });
      if (generation !== loadGeneration || activeGroupId !== group.groupId) return;
      container.replaceChildren();
      for (const member of data.members || []) {
        const item = document.createElement("li");
        item.textContent = `${member.memberName}${member.memberId === group.memberId ? "（あなた）" : ""}`;
        container.append(item);
      }
      if (!container.childElementCount) appendEmptyState(container, "メンバー情報がありません。");
    } catch (error) {
      if (generation === loadGeneration && activeGroupId === group.groupId) {
        container.replaceChildren();
        setError(error.message || "メンバー情報を読み込めませんでした。", "group-members-error");
      }
    }
  }
  function renderCalendar() {
    if (!activeGroup() || $("group-calendar-view").hidden) return;
    void loadMonth(view.groupMonth);
    renderMonthCalendar({
      calendarId:"group-calendar",
      month:view.groupMonth,
      selectedDate:view.groupDate,
      getEntries:(key) => eventsForDate(key).map((event) => ({
        type:event.sourceType === "shift" ? "shift" : "event",
        label:event.sourceType === "shift" ? `${event.createdByName} ${event.start}-${event.end} シフト` : `${event.createdByName} ${event.allDay ? "終日 " : `${event.start} `}${event.title}`,
      })),
      onSelect:(key, date) => {
        view.groupDate = key;
        if (date.getMonth() !== view.groupMonth.getMonth() || date.getFullYear() !== view.groupMonth.getFullYear()) {
          view.groupMonth = new Date(date.getFullYear(), date.getMonth(), 1);
        }
        renderCalendar();
      },
    });
    renderSelectedDate();
  }
  function renderSelectedDate() {
    const container = $("group-shared-events");
    container.replaceChildren();
    $("group-date").textContent = dateLabel.format(parseDate(view.groupDate));
    const events = eventsForDate(view.groupDate);
    if (!events.length) appendEmptyState(container, loadingMonths.has(monthKey(view.groupMonth)) ? "共有予定を読み込んでいます…" : "この日の共有予定はありません。");
    for (const event of events) {
      const item = document.createElement("div");
      item.className = `agenda-item ${event.sourceType === "shift" ? "agenda-shift" : "agenda-shared"}`;
      const details = document.createElement("div");
      details.className = "agenda-event-details";
      const title = document.createElement("strong");
      title.textContent = event.sourceType === "shift" ? "シフト" : event.title;
      const time = document.createElement("span");
      time.textContent = event.allDay ? "終日" : `${event.start}-${event.end}`;
      const author = document.createElement("span");
      author.className = "agenda-event-note";
      author.textContent = `${event.createdByName}の${event.sourceType === "shift" ? "シフト" : event.sourceType === "personal" ? "個人予定" : "共有予定"}`;
      details.append(title, time, author);
      if (event.note) {
        const note = document.createElement("span");
        note.className = "agenda-event-note";
        note.textContent = event.note;
        details.append(note);
      }
      item.append(details);
      container.append(item);
    }
  }
  async function refreshCurrentMonth() {
    if (!activeGroup()) return;
    resetCache();
    renderCalendar();
  }
  function openCalendar(groupId) {
    const group = memberships().find((item) => item.groupId === groupId);
    if (!group) return;
    activeGroupId = groupId;
    resetCache();
    $("group-calendar-name").textContent = `${group.groupName}の共有カレンダー`;
    $("group-home").hidden = true;
    $("group-calendar-view").hidden = false;
    setError("", "group-calendar-error");
    renderCalendar();
    void loadGroupMembers(group);
    window.scrollTo({ top:0, behavior:"instant" });
  }
  function monthsWithData() {
    const months = new Set();
    for (const key of [...Object.keys(state.shifts), ...Object.keys(state.events)]) {
      if (/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(key)) months.add(key.slice(0, 7));
    }
    return [...months];
  }
  function entriesForMonth(month) {
    const validTime = (value) => typeof value === "string" && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
    const entries = [];
    for (const [key, shift] of Object.entries(state.shifts)) {
      if (!key.startsWith(`${month}-`) || !shift || !validTime(shift.start) || !validTime(shift.end)) continue;
      entries.push({ sourceType:"shift", sourceId:key, eventDate:key, title:"シフト", start:shift.start, end:shift.end, allDay:false, note:"" });
    }
    for (const [key, events] of Object.entries(state.events)) {
      if (!key.startsWith(`${month}-`) || !Array.isArray(events)) continue;
      events.forEach((event, index) => {
        if (!event || typeof event.title !== "string" || !event.title.trim() || (!event.allDay && (!validTime(event.start) || !validTime(event.end)))) return;
        entries.push({ sourceType:"personal", sourceId:String(event.id || `${key}-${index}`), eventDate:key, title:event.title.slice(0, 80), start:event.allDay ? "" : event.start, end:event.allDay ? "" : event.end, allDay:Boolean(event.allDay), note:String(event.note || "").slice(0, 160) });
      });
    }
    return entries;
  }
  function markDirty(month) {
    for (const group of memberships()) {
      const pending = (state.pendingGroupMonths[group.groupId] ||= {});
      pending[month] = (Number(pending[month]) || 0) + 1;
    }
    saveState();
    void flushPending();
  }
  async function flushPending() {
    if (syncing) return;
    syncing = true;
    let failed = false;
    try {
      while (true) {
        const group = memberships().find((item) => Object.keys(state.pendingGroupMonths[item.groupId] || {}).length);
        if (!group) break;
        const [month, revision] = Object.entries(state.pendingGroupMonths[group.groupId])[0];
        try {
          await requestJson("/api/shared/calendar/sync", { payload:{ ...credentials(group), month, entries:entriesForMonth(month) } });
          if (state.pendingGroupMonths[group.groupId]?.[month] === revision) delete state.pendingGroupMonths[group.groupId][month];
          saveState();
          if (activeGroupId === group.groupId && month === monthKey(view.groupMonth)) void refreshCurrentMonth();
          setStatus("シフトと個人予定は参加中のグループへ自動共有されます。", "safe");
        } catch (error) {
          setStatus(`予定を同期できませんでした。次回起動時に再試行します。${error.message}`, "error");
          failed = true;
          break;
        }
      }
    } finally {
      syncing = false;
      if (!failed && memberships().some((group) => Object.keys(state.pendingGroupMonths[group.groupId] || {}).length)) void flushPending();
    }
  }
  async function submitGroup(event, path, fields) {
    event.preventDefault();
    setError();
    const payload = fields();
    if (path.endsWith("/join") && memberships().some((group) => group.inviteCode === payload.inviteCode)) {
      setError("このグループにはすでに参加しています。");
      return;
    }
    try {
      const data = await requestJson(path, { payload });
      state.groups.push(data.membership);
      const pending = (state.pendingGroupMonths[data.membership.groupId] ||= {});
      for (const month of monthsWithData()) pending[month] = 1;
      saveState();
      renderGroups();
      setStatus(`${data.membership.groupName}に参加しました。`, "safe");
      void flushPending();
    } catch (error) {
      setError(error.message || "グループを設定できませんでした。");
    }
  }
  async function leaveGroup(group) {
    if (!window.confirm(`${group.groupName}から退出しますか？共有済みのあなたの予定もグループから削除されます。`)) return;
    try {
      await requestJson("/api/groups/leave", { payload:credentials(group) });
      state.groups = state.groups.filter((item) => item.groupId !== group.groupId);
      delete state.pendingGroupMonths[group.groupId];
      saveState();
      renderGroups();
      setStatus(`${group.groupName}から退出しました。`, "safe");
    } catch (error) {
      setError(error.message || "グループから退出できませんでした。");
    }
  }
  function init() {
    $("create-group-form").addEventListener("submit", (event) => void submitGroup(event, "/api/groups/create", () => ({ name:$("group-name").value.trim(), memberName:$("group-member-name").value.trim() })));
    $("join-group-form").addEventListener("submit", (event) => void submitGroup(event, "/api/groups/join", () => ({ inviteCode:$("group-invite-code").value.trim().toUpperCase(), memberName:$("join-member-name").value.trim() })));
    $("back-to-groups").addEventListener("click", showHome);
    $("group-previous").addEventListener("click", () => { view.groupMonth = changeMonth(view.groupMonth, -1); view.groupDate = app.dateKey(view.groupMonth); renderCalendar(); });
    $("group-next").addEventListener("click", () => { view.groupMonth = changeMonth(view.groupMonth, 1); view.groupDate = app.dateKey(view.groupMonth); renderCalendar(); });
    $("refresh-group-events").addEventListener("click", () => void refreshCurrentMonth());
    showHome();
    void flushPending();
  }
  return { init, showHome, markDirty };
}
