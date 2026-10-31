import { initShift } from "./shift.js";
import { initBudget } from "./budget.js";
import { initCalendar } from "./calendar.js";
import { createPersonalSync } from "./personal-sync.mjs";
import { activateMainPage, activateMoneyView } from "./navigation.mjs";
import { parsePersonalBackup } from "./backup-import.mjs";
import { initShared } from "./shared.js";
import { initProfile } from "./profile.js";
import QrScanner from "./vendor/qr-scanner.min.js";
import qrcode from "./vendor/qrcode-generator.js";
import { LEGACY_STORAGE_KEY, userStorageKey, readStoredState, savePersonalState, mergeLegacyNonEventState } from "./storage.mjs";
import { API_BASE } from "./config.mjs";
import { initTheme, normalizeTheme, setTheme } from "./theme.mjs";
import { initNotificationCenter } from "./notifications.mjs";

const CATEGORIES = ["食費", "交通", "娯楽", "買い物", "交際費", "固定費", "その他"];
const money = new Intl.NumberFormat("ja-JP", { maximumFractionDigits:0 });
const monthLabel = new Intl.DateTimeFormat("ja-JP", { year:"numeric", month:"long" });
const dateLabel = new Intl.DateTimeFormat("ja-JP", { year:"numeric", month:"long", day:"numeric", weekday:"short" });
const $ = (id) => document.getElementById(id);
const emptyBudget = { fixed:"", saving:"", spent:"" };

let activeStorageKey = null;
let currentUser = null;
let namedBusyNoticeGeneration = 0;
async function showNamedBusyNotice(userId) {
  const generation = ++namedBusyNoticeGeneration;
  const notice = $("named-busy-notice");
  const button = $("named-busy-notice-ack");
  const error = $("named-busy-notice-error");
  notice.hidden = false;
  button.disabled = true;
  error.hidden = true;
  try {
    const status = await requestJson("/api/shared/named-busy/notice", { payload:{} });
    if (generation !== namedBusyNoticeGeneration || currentUser?.id !== userId) return;
    notice.hidden = status.acknowledged === true;
    button.disabled = false;
  } catch {
    if (generation !== namedBusyNoticeGeneration || currentUser?.id !== userId) return;
    error.textContent = "お知らせの確認機能を読み込めません。後で再度お試しください。";
    error.hidden = false;
  }
}
$("named-busy-notice-ack")?.addEventListener("click", async () => {
  const userId = currentUser?.id;
  if (!userId) return;
  const button = $("named-busy-notice-ack");
  const error = $("named-busy-notice-error");
  button.disabled = true;
  error.hidden = true;
  try {
    const result = await requestJson("/api/shared/named-busy/notice", { payload:{ acknowledge:true } });
    if (currentUser?.id !== userId) return;
    if (result.acknowledged !== true) throw new Error("確認できませんでした");
    $("named-busy-notice").hidden = true;
    await shared.refreshPersonal();
    window.dispatchEvent(new Event("daysync:availability-changed"));
  } catch {
    if (currentUser?.id !== userId) return;
    error.textContent = "確認を保存できませんでした。通信状態を確認して再度お試しください。";
    error.hidden = false;
  } finally {
    if (currentUser?.id === userId) button.disabled = false;
  }
});
window.addEventListener("daysync:logout", () => {
  namedBusyNoticeGeneration++;
  $("named-busy-notice").hidden = true;
});
function emptyState() {
  return { shifts:{}, events:{}, expenses:{}, hourly:"", manualIncome:"", incomeMode:"auto", theme:"system", budget:{ ...emptyBudget }, groups:[], pendingGroupMonths:{}, pendingGroupShiftMonths:{} };
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
      theme:normalizeTheme(saved.theme),
      budget:{ ...emptyBudget, ...(saved.budget || {}) },
      groups:[],
      pendingGroupMonths,
      pendingGroupShiftMonths:saved.pendingGroupShiftMonths && typeof saved.pendingGroupShiftMonths === "object" ? saved.pendingGroupShiftMonths : {},
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
async function requestJson(path, { method = "POST", payload, signal } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    credentials:"include",
    signal,
    headers:{ "Content-Type":"application/json" },
    body:payload === undefined ? undefined : JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !path.startsWith("/api/auth/")) void confirmSession();
  if (!response.ok) {
    const error = new Error(data.error || `通信に失敗しました（${response.status}）`);
    error.status = response.status;
    error.data = data;
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
  getCurrentUserId:() => currentUser?.id,
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
let personalSync = null;
app.scheduleBudget = budget.schedule;
let profile = null;
let notificationCenter = null;

let activeMoneyView = "budget";

function setMoneyView(viewName) {
  if (!activateMoneyView(document,viewName,{onBudget:()=>budget.refresh(),onShift:()=>{shift.renderCalendar();shift.renderSummary();}})) return;
  activeMoneyView = viewName;
}

function setActivePage(pageName) {
  if (!activateMainPage(document,pageName,{
    onPlan:()=>{calendar.render();void personalSync?.sync();},
    onMoney:()=>setMoneyView(activeMoneyView),
    onProfile:()=>void profile?.refresh(),
  })) return;
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
  $("auth-notice").hidden = true;
  authError();
}
function showExpiredSession() {
  window.dispatchEvent(new Event("daysync:logout"));
  currentUser = null;
  activeStorageKey = null;
  setTheme("system");
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
    const importedState = loadState(LEGACY_STORAGE_KEY);
    app.personalSync?.archiveLegacy(importedState.events);
    const groups = Array.isArray(legacy.groups) ? legacy.groups : (legacy.shared?.groupId ? [legacy.shared] : []);
    for (const group of groups) {
      if (group.groupId && group.memberId && group.memberToken) {
        await requestJson("/api/groups/claim", { payload:{ groupId:group.groupId, memberId:group.memberId, memberToken:group.memberToken } });
      }
    }
    Object.assign(state, mergeLegacyNonEventState(state, importedState));
    state.groups = (await requestJson("/api/groups/mine", { payload:{} })).groups || [];
    saveState();
    for (const group of groups) delete group.memberToken;
    if (legacy.shared) delete legacy.shared.memberToken;
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacy));
    if (currentUser) localStorage.setItem("daysync-legacy-imported-" + currentUser.id, "1");
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
  const syncUserId = user.id;
  personalSync = createPersonalSync({ storage:localStorage, key:activeStorageKey, state, requestJson,
    isCurrent:() => currentUser?.id === syncUserId,
    onDataChange:() => window.dispatchEvent(new Event("daysync:availability-changed")),
    onChange:() => {
      try {saveState();} catch {$("personal-sync-status").textContent="端末の保存領域が不足しています。バックアップを保存してください。";}
      calendar.render();
    },
    onStatus:(message, conflicts) => {
      $("personal-sync-status").textContent = message;
      if(message.startsWith("同期完了")) void shared.refreshPersonal();
      const list = $("personal-sync-conflicts"); list.replaceChildren();
      for (const conflict of conflicts) {
        const item = document.createElement("div"); item.className = "sync-conflict";
        const text = document.createElement("p");
        text.textContent = `端末の変更：${conflict.action === "delete" ? "削除" : `${conflict.event.date} ${conflict.event.title}`} ／ サーバー：${conflict.remote?.deleted ? "削除済み" : conflict.remote ? `${conflict.remote.date} ${conflict.remote.title}` : "予定なし"}`;
        item.append(text);
        const choices = [["サーバーの内容を使う", "server"]];
        if(conflict.event) choices.push(["端末の変更を別の予定として保存", "copy"]);
        else if(conflict.remote && !conflict.remote.deleted) choices.push(["最新の予定を削除する", "delete"]);
        for(const [label,choice] of choices) {
          const button = document.createElement("button");button.type = "button";button.className = "action-button";button.textContent = label;
          button.addEventListener("click",()=> {if(window.confirm(`${label}。よろしいですか？`)) personalSync.resolve(conflict.operationId,choice);});
          item.append(button);
        }
        list.append(item);
      }
    },
  });
  let syncState = {active:false};
  try { syncState = await personalSync.initialize(); app.personalSync = personalSync; }
  catch(error) {
    $("personal-sync-status").textContent = `同期状態を確認できません。端末内の予定は変更していません。${error.message}`;
    app.personalSync = personalSync;
  }
  updatePersonalSyncChoice(user.id, syncState.active);
  setTheme(state.theme);
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
  void showNamedBusyNotice(user.id);
  document.querySelector(".page-nav").hidden = false;
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.addEventListener("click", () => setActivePage(button.dataset.page));
  });
  document.querySelectorAll("[data-money-view]").forEach((button) => {
    button.addEventListener("click", () => setMoneyView(button.dataset.moneyView));
    button.addEventListener("keydown", (event) => {
      if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? "budget" : event.key === "End" ? "shift" : activeMoneyView === "budget" ? "shift" : "budget";
      setMoneyView(next);
      $(next === "budget" ? "money-tab-budget" : "money-tab-shift").focus();
    });
  });
  shift.init();
  budget.init();
  shared.init();
  calendar.init();
  if (!notificationCenter) notificationCenter = initNotificationCenter({ requestJson });
  notificationCenter.start();
  if(syncState.active) void personalSync?.sync();
  if (!profile) profile = initProfile({
    requestJson,
    onNameChange:(name, icon) => {
      currentUser.displayName = name;
      $("account-name").textContent = name;
      $("account-icon").textContent = icon || "🌿";
    },
    onLogout:() => {
      window.dispatchEvent(new Event("daysync:logout"));
      notificationCenter?.stop();
      currentUser = null;
      activeStorageKey = null;
      setTheme("system");
      Object.assign(state, emptyState());
      $("app-root").hidden = true;
      document.querySelector(".page-nav").hidden = true;
      location.reload();
    },
  });
  shift.calculateWage();
  const dismissKey = `daysync-legacy-dismissed-${user.id}`;
  const importedLegacy = localStorage.getItem("daysync-legacy-imported-" + user.id) === "1";
  const newSyncMetadata = localStorage.getItem(`${activeStorageKey}-personal-sync-v2`) !== null;
  const canTransferLegacy = !alreadySaved || (newSyncMetadata && !importedLegacy);
  $("legacy-import").hidden = !canTransferLegacy || !localStorage.getItem(LEGACY_STORAGE_KEY) || localStorage.getItem(dismissKey) === "1";
  $("import-legacy").addEventListener("click", () => void importLegacy());
  $("dismiss-legacy").addEventListener("click", () => { localStorage.setItem(dismissKey, "1"); $("legacy-import").hidden = true; });
  setActivePage("my");
  const inviteFromUrl = new URLSearchParams(window.location.search).get("invite");
  const notificationParams = new URLSearchParams(window.location.search);
  const reminderKind = notificationParams.get("reminder");
  const reminderDate = notificationParams.get("date");
  const reminderEventId = notificationParams.get("eventId");
  const notificationWishId = notificationParams.get("wishId");
  const notificationScheduleId = notificationParams.get('scheduleId');
  if (inviteFromUrl?.trim()) {
    $("group-invite-code").value = inviteFromUrl.trim().slice(0, 40);
    setActivePage("group");
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("invite");
    window.history.replaceState(window.history.state, "", cleanUrl);
    $("group-invite-code").focus({ preventScroll:true });
  } else if (reminderKind === "personal" && /^\d{4}-\d{2}-\d{2}$/.test(reminderDate || "")) {
    view.agendaDate = reminderDate;
    view.agendaMonth = new Date(Number(reminderDate.slice(0, 4)), Number(reminderDate.slice(5, 7)) - 1, 1);
    view.reminderEventId = reminderEventId;
    setActivePage("my");
    calendar.render();
    const cleanUrl = new URL(window.location.href);
    for (const key of ["reminder", "date", "eventId"]) cleanUrl.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", cleanUrl);
  } else {
    const groupFromUrl = notificationParams.get("group");
    if (groupFromUrl && state.groups.some((group) => group.groupId === groupFromUrl)) {
      setActivePage("group");
      shared.openCalendar(groupFromUrl, { date:reminderDate,
        eventId:reminderKind === "shared" ? reminderEventId : null, wishId:notificationWishId,
        scheduleId:notificationScheduleId });
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("group");
      cleanUrl.searchParams.delete("reminder");
      cleanUrl.searchParams.delete("date");
      cleanUrl.searchParams.delete("eventId");
      cleanUrl.searchParams.delete("wishId");
      cleanUrl.searchParams.delete('scheduleId');
      window.history.replaceState(window.history.state, "", cleanUrl);
    }
  }
}

function updatePersonalSyncChoice(userId, active) {
  const gate = $("personal-sync-consent");
  const deferred = $("personal-sync-deferred");
  const management = $("personal-sync-management");
  const controls = $("personal-sync-controls");
  if (active) {
    gate.hidden = true; deferred.hidden = true; management.hidden = false; controls.hidden = false;
    $("personal-backup-archive-option").hidden = false;
    $("personal-backup-help").hidden = false;
    return;
  }
  management.hidden = true;
  controls.hidden = true;
  $("personal-backup-archive-option").hidden = true;
  $("personal-backup-help").hidden = true;
  const declined = localStorage.getItem("daysync-personal-sync-deferred-" + userId) === "1";
  gate.hidden = declined; deferred.hidden = !declined;
}

$("account-open").addEventListener("click", () => setActivePage("profile"));
async function beginPersonalSync(button) {
  if (!personalSync) return;
  $("personal-sync-consent").hidden = false;
  $("personal-sync-deferred").hidden = true;
  button.disabled = true;
  $("personal-sync-choice-status").hidden = false;
  $("personal-sync-choice-status").textContent = "端末内の旧予定はバックアップに保管し、新しい同期を準備しています…";
  try {
    await personalSync.startFresh();
    if (currentUser) localStorage.removeItem("daysync-personal-sync-deferred-" + currentUser.id);
    updatePersonalSyncChoice(currentUser?.id, true);
    $("personal-sync-status").textContent = personalSync.status() || "同期完了";
    void shared.refreshPersonal();
  } catch(error) {
    $("personal-sync-choice-status").textContent = `同期を開始できませんでした。端末内の予定は保管されています。${error.message}`;
    button.disabled = false;
  }
}
$("personal-sync-start").addEventListener("click", () => void beginPersonalSync($("personal-sync-start")));
$("personal-sync-start-deferred").addEventListener("click", () => void beginPersonalSync($("personal-sync-start-deferred")));
$("personal-sync-later").addEventListener("click", () => {
  if (currentUser) localStorage.setItem("daysync-personal-sync-deferred-" + currentUser.id, "1");
  updatePersonalSyncChoice(currentUser?.id, false);
  $("personal-sync-choice-status").textContent = "同期は開始していません。端末内の旧予定とグループ表示は変更していません。";
  $("personal-sync-choice-status").hidden = false;
});
$("personal-sync-retry").addEventListener("click", () => void personalSync?.sync());
$("personal-backup-export").addEventListener("click", () => {
  const backup = personalSync?.backup(); if(!backup) return;
  const url = URL.createObjectURL(new Blob([backup],{type:"application/json"}));
  const link = document.createElement("a");link.href=url;link.download="daysync-personal-backup.json";link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$("personal-backup-import-trigger").addEventListener("click", () => $("personal-backup-import-file").click());
$("personal-backup-import-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  const result = $("personal-backup-import-status");
  if (!file) return;
  result.hidden = false;
  result.className = "status";
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error("ファイルが大きすぎます。10MB以下のJSONバックアップを選んでください。");
    if (!app.personalSync?.isActive?.()) throw new Error("先に新しいカレンダー同期を開始してください。元のデータは変更されていません。");
    const includeArchive = $("personal-backup-import-archive").checked;
    $("personal-backup-import-archive").checked = false;
    const { events, count } = parsePersonalBackup(await file.text(), { includeArchive });
    if (!window.confirm(`${count}件の予定を現在の同期カレンダーに復元します。グループには時間帯と「予定あり」のみが表示されます。続けますか？`)) return;
    app.personalSync.restore(events);
    result.textContent = `${count}件の復元を受け付けました。端末のバックアップも保持しています。同期します…`;
    await app.personalSync.sync();
    result.textContent = `${count}件のバックアップを統合しました。同期状態は上の表示を確認してください。`;
  } catch (error) {
    result.className = "status error";
    result.textContent = `取り込めませんでした。${error.message}`;
  } finally {
    event.target.value = "";
  }
});
document.addEventListener("visibilitychange",()=> {if(!document.hidden && currentUser) void personalSync?.sync();});
window.addEventListener("online",()=> {if(currentUser) void personalSync?.sync();});
window.addEventListener("focus",()=> {if(currentUser) void personalSync?.sync();});
setInterval(()=> {if(!document.hidden && currentUser) void personalSync?.sync();},60000);
initTheme((theme) => {
  if (!activeStorageKey) return;
  state.theme = theme;
  saveState();
});

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
