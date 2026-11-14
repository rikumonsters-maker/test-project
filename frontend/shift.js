import { shiftIncomeForMonth } from "./budget-charts.mjs";

export function initShift(app) {
  const { $, state, view, dateKey, parseDate, formatMoney, formatHours, changeMonth, status, postJson, renderMonthCalendar, bindTimeInput } = app;

  function shiftMinutes(shift) {
    const [startHour, startMinute] = shift.start.split(":").map(Number);
    const [endHour, endMinute] = shift.end.split(":").map(Number);
    const start = startHour * 60 + startMinute;
    let end = endHour * 60 + endMinute;
    if (end <= start) end += 24 * 60;
    return Math.max(0, end - start - Number(shift.breakMinutes || 0));
  }
  function shiftsForMonth(month) {
    const prefix = app.monthPrefix(month);
    return Object.entries(state.shifts)
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b));
  }
  function renderShiftList(monthShifts, hourlyNum) {
    const list = $("salary-shift-list");
    const empty = $("salary-shift-empty");
    if (!list || !empty) return;
    list.innerHTML = "";
    empty.hidden = monthShifts.length > 0;
    list.hidden = monthShifts.length === 0;
    for (const [key, shift] of monthShifts) {
      const mins = shiftMinutes(shift);
      const item = document.createElement("li");
      item.className = `expense-item salary-shift-item${key === view.shiftDate ? " is-selected" : ""}`;
      item.dataset.shiftDate = key;

      const main = document.createElement("div");
      main.className = "expense-main salary-shift-main";

      const dateTitle = document.createElement("span");
      dateTitle.className = "expense-note salary-shift-date";
      dateTitle.textContent = app.dateLabel.format(parseDate(key));

      const detail = document.createElement("span");
      detail.className = "expense-category salary-shift-time";
      const breakLabel = Number(shift.breakMinutes || 0) > 0 ? `（休憩${shift.breakMinutes}分）` : "";
      detail.textContent = `${shift.start}〜${shift.end}${breakLabel} · 実働${formatHours(mins)}`;

      main.append(dateTitle, detail);

      const amount = document.createElement("strong");
      amount.className = "expense-amount salary-shift-amount";
      amount.textContent = hourlyNum !== null ? formatMoney((mins / 60) * hourlyNum) : "時給未設定";

      item.append(main, amount);
      item.addEventListener("click", () => {
        view.shiftDate = key;
        renderCalendar();
        renderForm();
        renderSummary();
      });
      list.append(item);
    }
  }
  function hasValidHourly() {
    return state.hourly !== "" && state.hourly !== null && state.hourly !== undefined && Number.isFinite(Number(state.hourly)) && Number(state.hourly) >= 0;
  }
  function shiftCalendarEntries(key) {
    const shift = state.shifts[key];
    if (!shift) return [];
    const entries = [{ type:"shift-time", label:`${shift.start}-${shift.end}` }];
    if (hasValidHourly()) {
      const wage = (shiftMinutes(shift) / 60) * Number(state.hourly);
      entries.push({ type:"shift-wage", label:formatMoney(wage) });
    }
    return entries;
  }
  function renderCalendar() {
    renderMonthCalendar({
      calendarId:"shift-calendar",
      month:view.shiftMonth,
      selectedDate:view.shiftDate,
      mode:"shift",
      getEntries:shiftCalendarEntries,
      onSelect:(key, date) => {
        view.shiftDate = key;
        if (date.getMonth() !== view.shiftMonth.getMonth() || date.getFullYear() !== view.shiftMonth.getFullYear()) {
          view.shiftMonth = new Date(date.getFullYear(), date.getMonth(), 1);
          scheduleWage();
        }
        renderCalendar(); renderForm(); renderSummary();
      },
    });
  }
  function renderForm() {
    const shift = state.shifts[view.shiftDate];
    $("shift-date").textContent = app.dateLabel.format(parseDate(view.shiftDate));
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
  function renderSummary() {
    const monthShifts = shiftsForMonth(view.shiftMonth);
    const totalMinutes = monthShifts.reduce((total, [, shift]) => total + shiftMinutes(shift), 0);
    const shift = state.shifts[view.shiftDate];
    const hasHourly = state.hourly !== "" && state.hourly !== null && state.hourly !== undefined && Number.isFinite(Number(state.hourly)) && Number(state.hourly) >= 0;
    const hourlyNum = hasHourly ? Number(state.hourly) : null;
    view.wageEstimate = hasHourly ? (totalMinutes / 60) * hourlyNum : null;
    if (hasHourly && state.incomeMode === "auto") {
      $("income").value = String(Math.round(shiftIncomeForMonth(state.shifts, state.hourly, view.budgetMonth) || 0));
    }
    $("shift-hours").textContent = formatHours(totalMinutes);
    if ($("salary-month-label")) {
      $("salary-month-label").textContent = `${view.shiftMonth.getFullYear()}年${view.shiftMonth.getMonth() + 1}月`;
    }
    if ($("salary-hourly-value")) {
      $("salary-hourly-value").textContent = hasHourly ? `${formatMoney(hourlyNum)}/時` : "未設定";
    }
    if ($("salary-shift-count")) {
      $("salary-shift-count").textContent = `${monthShifts.length}件`;
    }
    $("shift-day-label").textContent = `${parseDate(view.shiftDate).getDate()}日の給料`;
    $("shift-day-wage").textContent = shift && hasHourly
      ? `${formatHours(shiftMinutes(shift))} / ${formatMoney((shiftMinutes(shift) / 60) * hourlyNum)}`
      : shift
        ? `${formatHours(shiftMinutes(shift))} / —`
        : "—";
    $("shift-month-wage").textContent = view.wageEstimate === null ? "—" : formatMoney(view.wageEstimate);
    renderShiftList(monthShifts, hourlyNum);
  }
  async function calculateWage() {
    const request = ++view.wageRequest;
    const hourly = $("hourly").value;
    const minutes = shiftsForMonth(view.shiftMonth).reduce((total, [, shift]) => total + shiftMinutes(shift), 0);
    if (hourly === "") {
      view.wageEstimate = null;
      $("income").value = state.incomeMode === "manual" ? state.manualIncome : "";
      renderSummary();
      status($("wage-status"), "", "💡", "時給を入力してください", "シフトから月の予想給料を計算します。");
      app.scheduleBudget?.();
      return;
    }
    status($("wage-status"), "", "⏳", "計算中です", "勤務時間と時給から計算しています。");
    try {
      const result = await postJson("/api/wage", { hourly:Number(hourly), hours:minutes / 60 });
      if (request !== view.wageRequest) return;
      view.wageEstimate = Number(result.wage);
      if (state.incomeMode === "auto") $("income").value = String(Math.round(shiftIncomeForMonth(state.shifts,state.hourly,view.budgetMonth) || 0));
      renderSummary();
      status($("wage-status"), "safe", "✓", "予想給料を計算しました", "今月のシフト合計を反映しています。");
      app.scheduleBudget?.();
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
  function submitShift(event) {
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
    app.saveState();
    app.shared?.markDirty(view.shiftDate.slice(0, 7), { shifts:true });
    renderCalendar(); renderForm(); renderSummary();
    app.refreshAgenda?.();
    scheduleWage();
  }
  function deleteShift() {
    delete state.shifts[view.shiftDate];
    app.saveState();
    app.shared?.markDirty(view.shiftDate.slice(0, 7), { shifts:true });
    renderCalendar(); renderForm(); renderSummary();
    app.refreshAgenda?.();
    scheduleWage();
  }
  function stepShiftMonth(delta) {
    view.shiftMonth = changeMonth(view.shiftMonth, delta);
    const monthShifts = shiftsForMonth(view.shiftMonth);
    view.shiftDate = monthShifts.length > 0 ? monthShifts[0][0] : dateKey(view.shiftMonth);
    renderCalendar(); renderForm(); renderSummary(); scheduleWage();
  }
  function init() {
    bindTimeInput("shift-start", "shift-start-picker");
    bindTimeInput("shift-end", "shift-end-picker");
    $("shift-form").addEventListener("submit", submitShift);
    $("delete-shift").addEventListener("click", deleteShift);
    $("shift-previous").addEventListener("click", () => stepShiftMonth(-1));
    $("shift-next").addEventListener("click", () => stepShiftMonth(1));
    $("salary-previous")?.addEventListener("click", () => stepShiftMonth(-1));
    $("salary-next")?.addEventListener("click", () => stepShiftMonth(1));
    $("hourly").value = state.hourly;
    $("hourly").addEventListener("input", (event) => {
      state.hourly = event.target.value;
      app.saveState();
      renderCalendar();
      renderSummary();
      scheduleWage();
    });
    renderCalendar(); renderForm(); renderSummary();
    if (state.hourly !== "") scheduleWage();
  }
  return { init, renderCalendar, renderForm, renderSummary, calculateWage, scheduleWage };
}
