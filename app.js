const API_BASE = "https://cloudflare-api.rikumonsters-api.workers.dev";
const STORAGE_KEY = "money-app-v2";
const CATEGORIES = ["食費", "交通", "娯楽", "買い物", "交際費", "固定費", "その他"];
const money = new Intl.NumberFormat("ja-JP", { maximumFractionDigits:0 });
const monthLabel = new Intl.DateTimeFormat("ja-JP", { year:"numeric", month:"long" });
const dateLabel = new Intl.DateTimeFormat("ja-JP", { year:"numeric", month:"long", day:"numeric", weekday:"short" });
const shortDateLabel = new Intl.DateTimeFormat("ja-JP", { month:"long", day:"numeric" });
const $ = (id) => document.getElementById(id);
const emptyBudget = { fixed:"", saving:"", spent:"" };

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      shifts:saved.shifts && typeof saved.shifts === "object" ? saved.shifts : {},
      events:saved.events && typeof saved.events === "object" ? saved.events : {},
      expenses:saved.expenses && typeof saved.expenses === "object" ? saved.expenses : {},
      hourly:saved.hourly ?? "",
      manualIncome:saved.manualIncome ?? "",
      incomeMode:saved.incomeMode === "manual" ? "manual" : "auto",
      budget:{ ...emptyBudget, ...(saved.budget || {}) },
    };
  } catch {
    return { shifts:{}, events:{}, expenses:{}, hourly:"", manualIncome:"", incomeMode:"auto", budget:{ ...emptyBudget } };
  }
}

const state = loadState();
const today = new Date();
const currentMonth = new Date(today.getFullYear(), today.getMonth(), 1);
const view = {
  shiftMonth:new Date(currentMonth),
  budgetMonth:new Date(currentMonth),
  agendaMonth:new Date(currentMonth),
  shiftDate:dateKey(today),
  expenseDate:dateKey(today),
  agendaDate:dateKey(today),
  editingExpenseId:null,
  editingEventId:null,
  editingEventDate:null,
  wageEstimate:null,
  wageTimer:null,
  budgetTimer:null,
  wageRequest:0,
  budgetRequest:0,
};

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
}
function parseDate(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}
function formatMoney(value) {
  return `¥${money.format(Math.round(value || 0))}`;
}
function formatHours(minutes) {
  return `${(minutes / 60).toFixed(2).replace(/\.0+$|(?<=\.[0-9])0$/, "")}時間`;
}
function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function monthPrefix(month) {
  return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2,"0")}-`;
}
function shiftMinutes(shift) {
  const [startHour, startMinute] = shift.start.split(":").map(Number);
  const [endHour, endMinute] = shift.end.split(":").map(Number);
  const start = startHour * 60 + startMinute;
  let end = endHour * 60 + endMinute;
  if (end <= start) end += 24 * 60;
  return Math.max(0, end - start - Number(shift.breakMinutes || 0));
}
function shiftsForMonth(month) {
  const prefix = monthPrefix(month);
  return Object.entries(state.shifts).filter(([key]) => key.startsWith(prefix));
}
function expensesForMonth(month) {
  const prefix = monthPrefix(month);
  return Object.entries(state.expenses)
    .filter(([key]) => key.startsWith(prefix))
    .flatMap(([date, expenses]) => (Array.isArray(expenses) ? expenses : []).map((expense) => ({ ...expense, date })));
}
function expenseTotal(expenses) {
  return expenses.reduce((total, expense) => total + Number(expense.amount || 0), 0);
}
function status(element, type, icon, headingText, message) {
  element.className = `status ${type}`;
  const iconNode = document.createElement("span");
  const content = document.createElement("div");
  const heading = document.createElement("strong");
  const text = document.createElement("p");
  iconNode.textContent = icon;
  heading.textContent = headingText;
  text.textContent = message;
  content.append(heading, text);
  element.replaceChildren(iconNode, content);
}
async function postJson(path, payload) {
  const response = await fetch(`${API_BASE}${path}`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}
function changeMonth(month, offset) {
  return new Date(month.getFullYear(), month.getMonth() + offset, 1);
}
function renderMonthCalendar({ calendarId, month, selectedDate, mode, onSelect }) {
  const calendar = $(calendarId);
  calendar.querySelectorAll(".calendar-day").forEach((cell) => cell.remove());
  const labelId = calendar.dataset.monthLabel;
  $(labelId).textContent = monthLabel.format(month);
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = firstDay.getDay();
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Math.ceil((offset + count) / 7) * 7;

  for (let index = 0; index < cells; index += 1) {
    const date = new Date(month.getFullYear(), month.getMonth(), index - offset + 1);
    const key = dateKey(date);
    const cell = document.createElement("button");
    const number = document.createElement("span");
    cell.type = "button";
    cell.className = "day calendar-day";
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("aria-pressed", String(key === selectedDate));
    if (date.getMonth() !== month.getMonth()) cell.classList.add("outside");
    if (key === selectedDate) cell.classList.add("selected");
    if (key === dateKey(today)) cell.classList.add("today");
    number.className = "day-number";
    number.textContent = String(date.getDate());
    cell.append(number);

    const value = calendarValue(mode, key);
    if (Array.isArray(value)) {
      for (const entry of value) {
        const detail = document.createElement("span");
        detail.className = `day-value ${entry.type === "shift" ? "calendar-shift" : "calendar-event"}`;
        detail.textContent = entry.label;
        cell.append(detail);
      }
      if (value.length) cell.classList.add("has-entry");
    } else if (value) {
      cell.classList.add("has-entry");
      const detail = document.createElement("span");
      detail.className = "day-value";
      detail.textContent = value;
      cell.append(detail);
    }
    const accessibleValue = Array.isArray(value) ? value.map((entry) => entry.label).join("、") : value;
    cell.setAttribute("aria-label", `${dateLabel.format(date)}${accessibleValue ? `、${accessibleValue}` : ""}`);
    cell.addEventListener("click", () => onSelect(key, date));
    calendar.append(cell);
  }
}
function calendarValue(mode, key) {
  if (mode === "expense") {
    const items = Array.isArray(state.expenses[key]) ? state.expenses[key] : [];
    const total = expenseTotal(items);
    return total ? formatMoney(total) : "";
  }
  if (mode === "agenda") return agendaEntries(key);
  const shift = state.shifts[key];
  return shift ? `${shift.start}-${shift.end}` : "";
}
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
function renderShiftCalendar() {
  renderMonthCalendar({
    calendarId:"shift-calendar",
    month:view.shiftMonth,
    selectedDate:view.shiftDate,
    mode:"shift",
    onSelect:(key, date) => {
      view.shiftDate = key;
      if (date.getMonth() !== view.shiftMonth.getMonth()) {
        view.shiftMonth = new Date(date.getFullYear(), date.getMonth(), 1);
        scheduleWage();
      }
      renderShiftCalendar();
      renderShiftForm();
      renderShiftSummary();
    },
  });
}
function renderShiftForm() {
  const shift = state.shifts[view.shiftDate];
  $("shift-date").textContent = dateLabel.format(parseDate(view.shiftDate));
  $("shift-start").value = shift?.start || "";
  $("shift-end").value = shift?.end || "";
  $("shift-start-picker").value = shift?.start || "";
  $("shift-end-picker").value = shift?.end || "";
  $("shift-break").value = shift?.breakMinutes ?? 0;
  $("save-shift").textContent = shift ? "変更を保存" : "シフトを登録";
  $("delete-shift").hidden = !shift;
  $("shift-error").textContent = "";
  $("shift-error").hidden = true;
}
function renderShiftSummary() {
  const totalMinutes = shiftsForMonth(view.shiftMonth).reduce((total, [, shift]) => total + shiftMinutes(shift), 0);
  const shift = state.shifts[view.shiftDate];
  $("shift-hours").textContent = formatHours(totalMinutes);
  $("shift-day-label").textContent = `${parseDate(view.shiftDate).getDate()}日の給料`;
  $("shift-day-wage").textContent = shift && state.hourly !== ""
    ? formatMoney(shiftMinutes(shift) / 60 * Number(state.hourly))
    : "—";
  $("shift-month-wage").textContent = view.wageEstimate === null ? "—" : formatMoney(view.wageEstimate);
}
async function calculateWage() {
  const request = ++view.wageRequest;
  const hourly = $("hourly").value;
  const minutes = shiftsForMonth(view.shiftMonth).reduce((total, [, shift]) => total + shiftMinutes(shift), 0);
  if (hourly === "") {
    view.wageEstimate = null;
    $("income").value = state.incomeMode === "manual" ? state.manualIncome : "";
    renderShiftSummary();
    status($("wage-status"), "", "💡", "時給を入力してください", "シフトから月の予想給料を計算します。");
    scheduleBudget();
    return;
  }
  status($("wage-status"), "", "⏳", "計算中です", "勤務時間と時給から計算しています。");
  try {
    const result = await postJson("/api/wage", { hourly:Number(hourly), hours:minutes / 60 });
    if (request !== view.wageRequest) return;
    view.wageEstimate = Number(result.wage);
    if (state.incomeMode === "auto") $("income").value = String(Math.round(view.wageEstimate));
    renderShiftSummary();
    status($("wage-status"), "safe", "✓", "予想給料を計算しました", "今月のシフト合計を反映しています。");
    scheduleBudget();
  } catch (error) {
    if (request !== view.wageRequest) return;
    status($("wage-status"), "error", "!", "予想給料を取得できません", "通信状況を確認して、もう一度お試しください。");
    console.error("Wage calculation failed:", error);
  }
}
function scheduleWage() {
  clearTimeout(view.wageTimer);
  view.wageTimer = setTimeout(calculateWage, 300);
}
function renderBudgetCalendar() {
  $("expense-month-total-label").textContent = `${view.budgetMonth.getMonth() + 1}月の支出合計`;
  $("expense-month-total").textContent = formatMoney(expenseTotal(expensesForMonth(view.budgetMonth)));
  renderMonthCalendar({
    calendarId:"expense-calendar",
    month:view.budgetMonth,
    selectedDate:view.expenseDate,
    mode:"expense",
    onSelect:(key, date) => {
      view.expenseDate = key;
      if (date.getMonth() !== view.budgetMonth.getMonth()) view.budgetMonth = new Date(date.getFullYear(), date.getMonth(), 1);
      resetExpenseForm();
      renderBudgetCalendar();
      renderExpenseDay();
      scheduleBudget();
    },
  });
}
function renderExpenseDay() {
  const expenses = Array.isArray(state.expenses[view.expenseDate]) ? state.expenses[view.expenseDate] : [];
  $("expense-date").textContent = dateLabel.format(parseDate(view.expenseDate));
  $("expense-day-total").textContent = formatMoney(expenseTotal(expenses));
  const list = $("expense-list");
  list.replaceChildren();
  if (expenses.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "この日の支出はありません。";
    list.append(empty);
    return;
  }
  for (const expense of expenses) {
    const row = document.createElement("li");
    row.className = "expense-item";
    const main = document.createElement("div");
    main.className = "expense-main";
    const note = document.createElement("span");
    note.className = "expense-note";
    note.textContent = expense.note || expense.category;
    const category = document.createElement("span");
    category.className = "expense-category";
    category.textContent = expense.category;
    const amount = document.createElement("span");
    amount.className = "expense-amount";
    amount.textContent = formatMoney(expense.amount);
    const actions = document.createElement("div");
    actions.className = "expense-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "編集";
    edit.setAttribute("aria-label", `${expense.note || expense.category}を編集`);
    edit.addEventListener("click", () => editExpense(expense));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-expense";
    remove.textContent = "削除";
    remove.setAttribute("aria-label", `${expense.note || expense.category}を削除`);
    remove.addEventListener("click", () => deleteExpense(expense.id));
    main.append(note, category);
    actions.append(edit, remove);
    row.append(main, amount, actions);
    list.append(row);
  }
}
function editExpense(expense) {
  view.editingExpenseId = expense.id;
  $("expense-amount").value = expense.amount;
  $("expense-category").value = expense.category;
  $("expense-note").value = expense.note || "";
  $("save-expense").textContent = "変更を保存";
  $("expense-form-title").textContent = "支出を編集";
  $("cancel-expense-edit").hidden = false;
  $("expense-amount").focus();
}
function resetExpenseForm() {
  view.editingExpenseId = null;
  $("expense-form").reset();
  $("expense-category").value = CATEGORIES[0];
  $("save-expense").textContent = "支出を追加";
  $("expense-form-title").textContent = "支出を追加";
  $("cancel-expense-edit").hidden = true;
}
function addOrUpdateExpense(event) {
  event.preventDefault();
  const amount = Number($("expense-amount").value);
  const category = $("expense-category").value;
  const note = $("expense-note").value.trim();
  if (!Number.isSafeInteger(amount) || amount < 1 || !CATEGORIES.includes(category)) return;
  const expenses = Array.isArray(state.expenses[view.expenseDate]) ? state.expenses[view.expenseDate] : [];
  if (view.editingExpenseId) {
    const index = expenses.findIndex((expense) => expense.id === view.editingExpenseId);
    if (index >= 0) expenses[index] = { ...expenses[index], amount, category, note };
  } else {
    expenses.push({ id:makeId(), amount, category, note });
  }
  state.expenses[view.expenseDate] = expenses;
  saveState();
  resetExpenseForm();
  renderBudgetCalendar();
  renderExpenseDay();
  scheduleBudget();
}
function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function deleteExpense(id) {
  const remaining = (state.expenses[view.expenseDate] || []).filter((expense) => expense.id !== id);
  if (remaining.length) state.expenses[view.expenseDate] = remaining;
  else delete state.expenses[view.expenseDate];
  if (view.editingExpenseId === id) resetExpenseForm();
  saveState();
  renderBudgetCalendar();
  renderExpenseDay();
  scheduleBudget();
}
function budgetReady() {
  const income = state.incomeMode === "manual" ? state.manualIncome : view.wageEstimate;
  return income !== "" && income !== null && $("fixed").value !== "" && $("saving").value !== "";
}
async function calculateBudget() {
  const request = ++view.budgetRequest;
  const expenses = expensesForMonth(view.budgetMonth);
  const spent = expenseTotal(expenses);
  $("expense-month-total-label").textContent = `${view.budgetMonth.getMonth() + 1}月の支出合計`;
  $("expense-month-total").textContent = formatMoney(spent);
  if (!budgetReady()) {
    $("remaining").textContent = "—";
    $("daily").textContent = "—";
    status($("budget-status"), "", "i", "予算を計算できます", "収入見込み・固定費・目標貯金額を入力してください。");
    return;
  }
  const income = state.incomeMode === "manual" ? Number(state.manualIncome) : Number(view.wageEstimate);
  status($("budget-status"), "", "…", "計算中です", "支出を反映しています。");
  try {
    const result = await postJson("/api/budget", {
      income,
      fixed:Number($("fixed").value),
      saving:Number($("saving").value),
      spent,
    });
    if (request !== view.budgetRequest) return;
    $("remaining").textContent = money.format(result.remaining);
    $("daily").textContent = money.format(result.daily);
    const labels = {
      safe:["✓", "順調です"],
      caution:["!", "支出ペースに注意"],
      danger:["!", "予算を超えています"],
    };
    const [icon, title] = labels[result.status] || ["i", "計算結果"];
    status($("budget-status"), result.status, icon, title, result.message || "予算を確認してください。");
  } catch (error) {
    if (request !== view.budgetRequest) return;
    status($("budget-status"), "error", "!", "予算を取得できません", "通信状況を確認して、もう一度お試しください。");
    console.error("Budget calculation failed:", error);
  }
}
function scheduleBudget() {
  clearTimeout(view.budgetTimer);
  view.budgetTimer = setTimeout(calculateBudget, 250);
}
function renderAgenda() {
  renderMonthCalendar({
    calendarId:"agenda-calendar",
    month:view.agendaMonth,
    selectedDate:view.agendaDate,
    mode:"agenda",
    onSelect:(key, date) => {
      view.agendaDate = key;
      if (date.getMonth() !== view.agendaMonth.getMonth() || date.getFullYear() !== view.agendaMonth.getFullYear()) {
        view.agendaMonth = new Date(date.getFullYear(), date.getMonth(), 1);
      }
      resetEventForm();
      renderAgenda();
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
    edit.addEventListener("click", () => editPersonalEvent(selectedDate, event));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "action-button danger";
    remove.textContent = "削除";
    remove.addEventListener("click", () => deletePersonalEvent(selectedDate, event.id));
    actions.append(edit, remove);
    item.append(details, actions);
    eventList.append(item);
  }
}
function appendEmptyState(container, text) {
  const empty = document.createElement("p");
  empty.className = "empty-state";
  empty.textContent = text;
  container.append(empty);
}
function syncEventTimeFields() {
  const allDay = $("event-all-day").checked;
  $("event-time-fields").hidden = allDay;
  $("event-start").required = !allDay;
  $("event-end").required = !allDay;
}
function resetEventForm() {
  view.editingEventId = null;
  view.editingEventDate = null;
  $("event-form").reset();
  $("event-date").value = view.agendaDate;
  $("event-form-title").textContent = "個人予定を追加";
  $("save-event").textContent = "予定を追加";
  $("cancel-event-edit").hidden = true;
  $("event-error").hidden = true;
  $("event-error").textContent = "";
  syncEventTimeFields();
}
function editPersonalEvent(date, event) {
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
  syncEventTimeFields();
  $("event-title").focus();
}
function addOrUpdatePersonalEvent(event) {
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
  view.agendaMonth = new Date(parseDate(date).getFullYear(), parseDate(date).getMonth(), 1);
  saveState();
  renderAgenda();
  resetEventForm();
}
function deletePersonalEvent(date, id) {
  const remaining = (state.events[date] || []).filter((event) => event.id !== id);
  if (remaining.length) state.events[date] = remaining;
  else delete state.events[date];
  if (view.editingEventId === id) resetEventForm();
  saveState();
  renderAgenda();
}
function setActivePage(pageName) {
  document.querySelectorAll(".page-panel").forEach((panel) => {
    panel.hidden = panel.id !== `page-${pageName}`;
  });
  document.querySelectorAll(".nav-button").forEach((button) => {
    if (button.dataset.page === pageName) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (pageName === "calendar") renderAgenda();
  if (pageName === "budget") {
    renderBudgetCalendar();
    renderExpenseDay();
    scheduleBudget();
  }
  window.scrollTo({ top:0, behavior:"instant" });
}

for (const [fieldId, pickerId] of [
  ["shift-start", "shift-start-picker"],
  ["shift-end", "shift-end-picker"],
  ["event-start", "event-start-picker"],
  ["event-end", "event-end-picker"],
]) {
  const field = $(fieldId);
  const picker = $(pickerId);
  field.addEventListener("input", () => {
    const digits = field.value.replace(/\D/g, "").slice(0, 4);
    if (digits.length > 2) field.value = `${digits.slice(0, 2)}:${digits.slice(2)}`;
    if (/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(field.value)) picker.value = field.value;
  });
  picker.addEventListener("input", () => { field.value = picker.value; });
  picker.addEventListener("change", () => { field.value = picker.value; });
}
$("shift-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const start = $("shift-start").value;
  const end = $("shift-end").value;
  const breakMinutes = Number($("shift-break").value);
  const validTime = (value) => /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
  const shift = { start, end, breakMinutes };
  if (!validTime(start) || !validTime(end) || !Number.isInteger(breakMinutes) || breakMinutes < 0 || shiftMinutes(shift) <= 0) {
    $("shift-error").textContent = "出勤・退勤時間と勤務時間内の休憩を入力してください。";
    $("shift-error").hidden = false;
    return;
  }
  state.shifts[view.shiftDate] = shift;
  saveState();
  renderShiftCalendar();
  renderShiftForm();
  renderShiftSummary();
  renderAgenda();
  scheduleWage();
});
$("delete-shift").addEventListener("click", () => {
  delete state.shifts[view.shiftDate];
  saveState();
  renderShiftCalendar();
  renderShiftForm();
  renderShiftSummary();
  renderAgenda();
  scheduleWage();
});
$("shift-previous").addEventListener("click", () => {
  view.shiftMonth = changeMonth(view.shiftMonth, -1);
  view.shiftDate = dateKey(view.shiftMonth);
  renderShiftCalendar(); renderShiftForm(); renderShiftSummary(); scheduleWage();
});
$("shift-next").addEventListener("click", () => {
  view.shiftMonth = changeMonth(view.shiftMonth, 1);
  view.shiftDate = dateKey(view.shiftMonth);
  renderShiftCalendar(); renderShiftForm(); renderShiftSummary(); scheduleWage();
});
$("expense-previous").addEventListener("click", () => {
  view.budgetMonth = changeMonth(view.budgetMonth, -1);
  view.expenseDate = dateKey(view.budgetMonth);
  resetExpenseForm();
  renderBudgetCalendar(); renderExpenseDay(); scheduleBudget();
});
$("expense-next").addEventListener("click", () => {
  view.budgetMonth = changeMonth(view.budgetMonth, 1);
  view.expenseDate = dateKey(view.budgetMonth);
  resetExpenseForm();
  renderBudgetCalendar(); renderExpenseDay(); scheduleBudget();
});
$("agenda-previous").addEventListener("click", () => {
  view.agendaMonth = changeMonth(view.agendaMonth, -1);
  view.agendaDate = dateKey(view.agendaMonth);
  resetEventForm();
  renderAgenda();
});
$("agenda-next").addEventListener("click", () => {
  view.agendaMonth = changeMonth(view.agendaMonth, 1);
  view.agendaDate = dateKey(view.agendaMonth);
  resetEventForm();
  renderAgenda();
});
$("expense-form").addEventListener("submit", addOrUpdateExpense);
$("cancel-expense-edit").addEventListener("click", resetExpenseForm);
$("event-form").addEventListener("submit", addOrUpdatePersonalEvent);
$("cancel-event-edit").addEventListener("click", resetEventForm);
$("event-all-day").addEventListener("change", syncEventTimeFields);
$("budget-form").addEventListener("submit", (event) => event.preventDefault());
$("hourly").addEventListener("input", (event) => {
  state.hourly = event.target.value;
  saveState();
  renderShiftSummary();
  scheduleWage();
});
$("auto-income").addEventListener("click", () => {
  state.incomeMode = "auto";
  $("income").disabled = true;
  $("income").value = view.wageEstimate === null ? "" : String(Math.round(view.wageEstimate));
  $("auto-income").setAttribute("aria-pressed", "true");
  $("manual-income").setAttribute("aria-pressed", "false");
  saveState();
  scheduleBudget();
});
$("manual-income").addEventListener("click", () => {
  state.incomeMode = "manual";
  $("income").disabled = false;
  $("income").value = state.manualIncome;
  $("auto-income").setAttribute("aria-pressed", "false");
  $("manual-income").setAttribute("aria-pressed", "true");
  saveState();
  scheduleBudget();
});
$("budget-form").addEventListener("input", (event) => {
  const { id, value } = event.target;
  if (id === "income" && state.incomeMode === "manual") state.manualIncome = value;
  if (id === "fixed" || id === "saving") state.budget[id] = value;
  saveState();
  scheduleBudget();
});
document.querySelectorAll(".nav-button").forEach((button) => {
  button.addEventListener("click", () => setActivePage(button.dataset.page));
});

$("hourly").value = state.hourly;
$("fixed").value = state.budget.fixed;
$("saving").value = state.budget.saving;
$("income").disabled = state.incomeMode !== "manual";
$("income").value = state.incomeMode === "manual" ? state.manualIncome : "";
$("manual-income").setAttribute("aria-pressed", String(state.incomeMode === "manual"));
$("auto-income").setAttribute("aria-pressed", String(state.incomeMode !== "manual"));
$("expense-category").value = CATEGORIES[0];
renderShiftCalendar();
renderShiftForm();
renderShiftSummary();
renderBudgetCalendar();
renderExpenseDay();
renderAgenda();
resetEventForm();
calculateWage();
