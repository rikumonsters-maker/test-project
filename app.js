import { initShift } from "./shift.js";
import { initBudget } from "./budget.js";
import { initCalendar } from "./calendar.js";
import { initShared } from "./shared.js";

const STORAGE_KEY = "money-app-v2";
const API_BASE = "https://cloudflare-api.rikumonsters-api.workers.dev";
const CATEGORIES = ["食費", "交通", "娯楽", "買い物", "交際費", "固定費", "その他"];
const money = new Intl.NumberFormat("ja-JP", { maximumFractionDigits:0 });
const monthLabel = new Intl.DateTimeFormat("ja-JP", { year:"numeric", month:"long" });
const dateLabel = new Intl.DateTimeFormat("ja-JP", { year:"numeric", month:"long", day:"numeric", weekday:"short" });
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
      shared:saved.shared && typeof saved.shared === "object" ? saved.shared : null,
    };
  } catch {
    return { shifts:{}, events:{}, expenses:{}, hourly:"", manualIncome:"", incomeMode:"auto", budget:{ ...emptyBudget }, shared:null };
  }
}

const state = loadState();
const today = new Date();
const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
const view = {
  shiftMonth:new Date(firstOfMonth),
  budgetMonth:new Date(firstOfMonth),
  agendaMonth:new Date(firstOfMonth),
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
function changeMonth(month, offset) {
  return new Date(month.getFullYear(), month.getMonth() + offset, 1);
}
function monthPrefix(month) {
  return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2,"0")}-`;
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
async function requestJson(path, { method = "POST", payload } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers:{ "Content-Type":"application/json" },
    body:payload === undefined ? undefined : JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `通信に失敗しました（${response.status}）`);
  return data;
}
async function postJson(path, payload) {
  return requestJson(path, { payload });
}
function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function bindTimeInput(fieldId, pickerId) {
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
function renderMonthCalendar({ calendarId, month, selectedDate, mode, onSelect, getEntries }) {
  const calendar = $(calendarId);
  calendar.querySelectorAll(".calendar-day").forEach((cell) => cell.remove());
  $(calendar.dataset.monthLabel).textContent = monthLabel.format(month);
  const offset = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
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

    const value = getEntries ? getEntries(key) : calendarValue(mode, key);
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
    const expenses = Array.isArray(state.expenses[key]) ? state.expenses[key] : [];
    const total = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
    return total ? formatMoney(total) : "";
  }
  const shift = state.shifts[key];
  return shift ? `${shift.start}-${shift.end}` : "";
}

const app = {
  $,
  state,
  view,
  CATEGORIES,
  money,
  dateLabel,
  emptyBudget,
  dateKey,
  parseDate,
  formatMoney,
  formatHours,
  saveState,
  changeMonth,
  monthPrefix,
  status,
  requestJson,
  postJson,
  makeId,
  bindTimeInput,
  renderMonthCalendar,
};

const shift = initShift(app);
const budget = initBudget(app);
const shared = initShared(app);
app.shared = shared;
const calendar = initCalendar(app);
app.refreshAgenda = calendar.render;
app.scheduleBudget = budget.schedule;

function setActivePage(pageName) {
  document.querySelectorAll(".page-panel").forEach((panel) => {
    panel.hidden = panel.id !== `page-${pageName}`;
  });
  document.querySelectorAll(".nav-button").forEach((button) => {
    if (button.dataset.page === pageName) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (pageName === "calendar") {
    void shared.refreshMonth();
    calendar.render();
  }
  if (pageName === "budget") budget.refresh();
  window.scrollTo({ top:0, behavior:"instant" });
}

document.querySelectorAll(".nav-button").forEach((button) => {
  button.addEventListener("click", () => setActivePage(button.dataset.page));
});

shift.init();
budget.init();
shared.init();
calendar.init();
shift.calculateWage();
