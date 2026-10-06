import { initShift } from "./shift.js";
import { initBudget } from "./budget.js";
import { initCalendar } from "./calendar.js";
import { initShared } from "./shared.js";
import { initProfile } from "./profile.js";
import QrScanner from "./vendor/qr-scanner.min.js";
import qrcode from "./vendor/qrcode-generator.js";
import { LEGACY_STORAGE_KEY, userStorageKey, readStoredState, savePersonalState } from "./storage.mjs";
import { API_BASE } from "./config.mjs";

const CATEGORIES = ["食費", "交通", "娯楽", "買い物", "交際費", "固定費", "その他"];
const money = new Intl.NumberFormat("ja-JP", { maximumFractionDigits:0 });
const monthLabel = new Intl.DateTimeFormat("ja-JP", { year:"numeric", month:"long" });
const dateLabel = new Intl.DateTimeFormat("ja-JP", { year:"numeric", month:"long", day:"numeric", weekday:"short" });
const $ = (id) => document.getElementById(id);
const emptyBudget = { fixed:"", saving:"", spent:"" };

let activeStorageKey = null;
let currentUser = null;
function emptyState() {
  return { shifts:{}, events:{}, expenses:{}, hourly:"", manualIncome:"", incomeMode:"auto", budget:{ ...emptyBudget }, groups:[], pendingGroupMonths:{} };
}
function loadState(key) {
  try {
    const saved = readStoredState(localStorage, key);
    const pendingGroupMonths = saved.pendingGroupMonths && typeof saved.pendingGroupMonths === "object" ? saved.pendingGroupMonths : {};
    if (key === LEGACY_STORAGE_KEY && !Array.isArray(saved.groups) && saved.shared?.groupId) {
      const pending = (pendingGroupMonths[saved.shared.groupId] ||= {});
      for (const key of [...Object.keys(saved.shifts || {}), ...Object.keys(saved.events || {})]) {
        if (/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(key)) pending[key.slice(0, 7)] = 1;
      }
    }
    return {
      shifts:saved.shifts && typeof saved.shifts === "object" ? saved.shifts : {},
      events:saved.events && typeof saved.events === "object" ? saved.events : {},
      expenses:saved.expenses && typeof saved.expenses === "object" ? saved.expenses : {},
      hourly:saved.hourly ?? "",
      manualIncome:saved.manualIncome ?? "",
      incomeMode:saved.incomeMode === "manual" ? "manual" : "auto",
      budget:{ ...emptyBudget, ...(saved.budget || {}) },
      groups:[],
      pendingGroupMonths,
    };
  } catch {
    return emptyState();
  }
}

const state = emptyState();
const today = new Date();
const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
const view = {
  shiftMonth:new Date(firstOfMonth),
  budgetMonth:new Date(firstOfMonth),
  agendaMonth:new Date(firstOfMonth),
  groupMonth:new Date(firstOfMonth),
  shiftDate:dateKey(today),
  expenseDate:dateKey(today),
  agendaDate:dateKey(today),
  groupDate:dateKey(today),
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
  if (!activeStorageKey) return;
  savePersonalState(localStorage, activeStorageKey, state);
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
    credentials:"include",
    headers:{ "Content-Type":"application/json" },
    body:payload === undefined ? undefined : JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !path.startsWith("/api/auth/")) void confirmSession();
  if (!response.ok) {
    const error = new Error(data.error || `通信に失敗しました（${response.status}）`);
    error.status = response.status;
    throw error;
  }
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
function renderMonthCalendar({ calendarId, month, selectedDate, mode, onSelect, getEntries, maxEntries = Infinity }) {
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
      for (const entry of value.slice(0, maxEntries)) {
        const detail = document.createElement("span");
        detail.className = `day-value ${entry.type === "busy" ? "calendar-busy" : entry.type === "wish" ? "calendar-wish" : entry.type === "tentative" ? "calendar-tentative" : entry.type === "shift" ? "calendar-shift" : "calendar-event"}`;
        detail.textContent = entry.label;
        if (entry.ariaLabel) detail.title = entry.ariaLabel;
        cell.append(detail);
      }
      if (value.length > maxEntries) {
        const more = document.createElement("span");
        more.className = "calendar-more";
        more.textContent = `ほか${value.length - maxEntries}件`;
        cell.append(more);
      }
      if (value.length) cell.classList.add("has-entry");
    } else if (value) {
      cell.classList.add("has-entry");
      const detail = document.createElement("span");
      detail.className = "day-value";
      detail.textContent = value;
      cell.append(detail);
    }
    const accessibleValue = Array.isArray(value) ? value.map((entry) => entry.ariaLabel || entry.label).join("、") : value;
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
  QrScanner,
  qrcode,
  makeId,
  bindTimeInput,
  renderMonthCalendar,
};

const shift = initShift(app);
const budget = initBudget(app);
const shared = initShared(app);
app.shared = shared;
const calendar = initCalendar(app);
app.scheduleBudget = budget.schedule;
let profile = null;

let activeMyView = "calendar";

function setMyView(viewName) {
  activeMyView = viewName;
  document.querySelectorAll("[data-my-view]").forEach((button) => {
    const isActive = button.dataset.myView === viewName;
    button.setAttribute("aria-selected", String(isActive));
  });
  $("page-calendar").hidden = viewName !== "calendar";
  $("page-budget").hidden = viewName !== "budget";
  if (viewName === "calendar") calendar.render();
  if (viewName === "budget") budget.refresh();
}

function setActivePage(pageName) {
  document.querySelectorAll(".page-panel").forEach((panel) => {
    panel.hidden = panel.id !== `page-${pageName}`;
  });
  document.querySelectorAll(".nav-button").forEach((button) => {
    if (button.dataset.page === pageName) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (pageName === "my") setMyView(activeMyView);
  if (pageName === "group") shared.showHome();
  if (pageName === "profile") void profile?.refresh();
  window.scrollTo({ top:0, behavior:"instant" });
}

function authError(message = "") {
  $("auth-error").textContent = message;
  $("auth-error").hidden = !message;
}
function showAuth(mode = "login") {
  document.body.classList.add("auth-mode");
  $("auth-shell").hidden = false;
  $("app-root").hidden = true;
  document.querySelector(".page-nav").hidden = true;
  $("auth-loading").hidden = true;
  $("login-form").hidden = mode !== "login";
  $("register-form").hidden = mode !== "register";
  authError();
}
function showExpiredSession() {
  currentUser = null;
  activeStorageKey = null;
  showAuth();
  authError("ログインの有効期限が切れました。再度ログインしてください。");
}
async function confirmSession() {
  try {
    await requestJson("/api/auth/me", { method:"GET" });
  } catch (error) {
    if (error.status === 401) showExpiredSession();
  }
}

async function importLegacy() {
  const error = $("legacy-error");
  error.hidden = true;
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) throw new Error("引き継ぐデータが見つかりません。");
    const legacy = JSON.parse(raw);
    const groups = Array.isArray(legacy.groups) ? legacy.groups : (legacy.shared?.groupId ? [legacy.shared] : []);
    for (const group of groups) {
      if (group.groupId && group.memberId && group.memberToken) {
        await requestJson("/api/groups/claim", { payload:{ groupId:group.groupId, memberId:group.memberId, memberToken:group.memberToken } });
      }
    }
    Object.assign(state, loadState(LEGACY_STORAGE_KEY));
    state.groups = (await requestJson("/api/groups/mine", { payload:{} })).groups || [];
    saveState();
    for (const group of groups) delete group.memberToken;
    if (legacy.shared) delete legacy.shared.memberToken;
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacy));
    location.reload();
  } catch (importError) {
    error.textContent = `引き継ぎできませんでした。${importError.message}`;
    error.hidden = false;
  }
}

async function startApp(user) {
  currentUser = user;
  activeStorageKey = userStorageKey(user.id);
  const alreadySaved = localStorage.getItem(activeStorageKey) !== null;
  Object.assign(state, loadState(activeStorageKey));
  state.groups = (await requestJson("/api/groups/mine", { payload:{} })).groups || [];
  $("account-name").textContent = user.displayName;
  $("account-icon").textContent = "🌿";
  try {
    const { profile:headerProfile } = await requestJson("/api/profile", { method:"GET" });
    $("account-icon").textContent = headerProfile.profileIcon || "🌿";
  } catch { /* The account button remains available if profile loading fails. */ }
  document.body.classList.remove("auth-mode");
  $("auth-shell").hidden = true;
  $("app-root").hidden = false;
  document.querySelector(".page-nav").hidden = false;
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.addEventListener("click", () => setActivePage(button.dataset.page));
  });
  document.querySelectorAll("[data-my-view]").forEach((button) => {
    button.addEventListener("click", () => setMyView(button.dataset.myView));
  });
  shift.init();
  budget.init();
  shared.init();
  calendar.init();
  if (!profile) profile = initProfile({
    requestJson,
    onNameChange:(name, icon) => {
      currentUser.displayName = name;
      $("account-name").textContent = name;
      $("account-icon").textContent = icon || "🌿";
    },
    onLogout:() => {
      currentUser = null;
      activeStorageKey = null;
      Object.assign(state, emptyState());
      $("app-root").hidden = true;
      document.querySelector(".page-nav").hidden = true;
      location.reload();
    },
  });
  shift.calculateWage();
  const dismissKey = `daysync-legacy-dismissed-${user.id}`;
  $("legacy-import").hidden = alreadySaved || !localStorage.getItem(LEGACY_STORAGE_KEY) || localStorage.getItem(dismissKey) === "1";
  $("import-legacy").addEventListener("click", () => void importLegacy());
  $("dismiss-legacy").addEventListener("click", () => { localStorage.setItem(dismissKey, "1"); $("legacy-import").hidden = true; });
  const inviteFromUrl = new URLSearchParams(window.location.search).get("invite");
  if (inviteFromUrl?.trim()) {
    $("group-invite-code").value = inviteFromUrl.trim().slice(0, 40);
    setActivePage("group");
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("invite");
    window.history.replaceState(window.history.state, "", cleanUrl);
    $("group-invite-code").focus({ preventScroll:true });
  } else {
    const groupFromUrl = new URLSearchParams(window.location.search).get("group");
    if (groupFromUrl && state.groups.some((group) => group.groupId === groupFromUrl)) {
      setActivePage("group");
      shared.openCalendar(groupFromUrl);
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("group");
      window.history.replaceState(window.history.state, "", cleanUrl);
    }
  }
}

$("account-open").addEventListener("click", () => setActivePage("profile"));

$("show-register").addEventListener("click", () => showAuth("register"));
$("show-login").addEventListener("click", () => showAuth("login"));
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  authError();
  const button = $("login-form").querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await requestJson("/api/auth/login", { payload:{ email:$("login-email").value, password:$("login-password").value } });
    location.reload();
  } catch (error) { authError(error.message); button.disabled = false; }
});
$("register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  authError();
  if ($("register-password").value !== $("register-confirm").value) return authError("確認用パスワードが一致しません。");
  const button = $("register-form").querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await requestJson("/api/auth/register", { payload:{ displayName:$("register-name").value, email:$("register-email").value, password:$("register-password").value, passwordConfirm:$("register-confirm").value } });
    location.reload();
  } catch (error) { authError(error.message); button.disabled = false; }
});
requestJson("/api/auth/me", { method:"GET" })
  .then(({ user }) => startApp(user))
  .catch((error) => { showAuth(); if (error.status !== 401) authError(`ログイン状態を確認できませんでした。${error.message}`); });
