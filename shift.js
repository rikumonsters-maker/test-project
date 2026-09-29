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
    return Object.entries(state.shifts).filter(([key]) => key.startsWith(prefix));
  }
  function renderCalendar() {
    renderMonthCalendar({
      calendarId:"shift-calendar",
      month:view.shiftMonth,
      selectedDate:view.shiftDate,
      mode:"shift",
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
      if (state.incomeMode === "auto") $("income").value = String(Math.round(view.wageEstimate));
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
    app.shared?.markDirty(view.shiftDate.slice(0, 7));
    renderCalendar(); renderForm(); renderSummary();
    app.refreshAgenda?.();
    scheduleWage();
  }
  function deleteShift() {
    delete state.shifts[view.shiftDate];
    app.saveState();
    app.shared?.markDirty(view.shiftDate.slice(0, 7));
    renderCalendar(); renderForm(); renderSummary();
    app.refreshAgenda?.();
    scheduleWage();
  }
  function init() {
    bindTimeInput("shift-start", "shift-start-picker");
    bindTimeInput("shift-end", "shift-end-picker");
    $("shift-form").addEventListener("submit", submitShift);
    $("delete-shift").addEventListener("click", deleteShift);
    $("shift-previous").addEventListener("click", () => {
      view.shiftMonth = changeMonth(view.shiftMonth, -1);
      view.shiftDate = dateKey(view.shiftMonth);
      renderCalendar(); renderForm(); renderSummary(); scheduleWage();
    });
    $("shift-next").addEventListener("click", () => {
      view.shiftMonth = changeMonth(view.shiftMonth, 1);
      view.shiftDate = dateKey(view.shiftMonth);
      renderCalendar(); renderForm(); renderSummary(); scheduleWage();
    });
    $("hourly").value = state.hourly;
    $("hourly").addEventListener("input", (event) => {
      state.hourly = event.target.value;
      app.saveState();
      renderSummary();
      scheduleWage();
    });
    renderCalendar(); renderForm(); renderSummary();
  }
  return { init, renderCalendar, renderForm, renderSummary, calculateWage, scheduleWage };
}
