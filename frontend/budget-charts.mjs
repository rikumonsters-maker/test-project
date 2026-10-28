export const EXPENSE_CATEGORIES = ["食費", "交通", "娯楽", "買い物", "交際費", "固定費", "その他"];

export function monthlyExpenses(expensesByDate, month) {
  const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-`;
  return Object.entries(expensesByDate || {})
    .filter(([date]) => date.startsWith(key))
    .flatMap(([, entries]) => Array.isArray(entries) ? entries : []);
}

export function expenseBreakdown(expensesByDate, month) {
  const amounts = Object.fromEntries(EXPENSE_CATEGORIES.map(category => [category, 0]));
  let count = 0;
  for (const expense of monthlyExpenses(expensesByDate, month)) {
    const amount = Number(expense.amount);
    if (!Number.isFinite(amount) || amount < 0) continue;
    amounts[EXPENSE_CATEGORIES.includes(expense.category) ? expense.category : "その他"] += amount;
    count++;
  }
  const total = Object.values(amounts).reduce((sum, amount) => sum + amount, 0);
  return { amounts, total, count };
}

export function expenseTrend(expensesByDate, endingMonth) {
  return Array.from({ length:6 }, (_, index) => {
    const month = new Date(endingMonth.getFullYear(), endingMonth.getMonth() - 5 + index, 1);
    return { month, ...expenseBreakdown(expensesByDate, month) };
  });
}

export function shiftIncomeForMonth(shiftsByDate, hourly, month) {
  if (hourly === "" || hourly === null || hourly === undefined || !Number.isFinite(Number(hourly)) || Number(hourly) < 0) return null;
  const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-`;
  let minutes = 0;
  for (const [date, shift] of Object.entries(shiftsByDate || {})) {
    if (!date.startsWith(key) || !shift || !/^\d{2}:\d{2}$/.test(shift.start) || !/^\d{2}:\d{2}$/.test(shift.end)) continue;
    const start = Number(shift.start.slice(0,2))*60 + Number(shift.start.slice(3));
    let end = Number(shift.end.slice(0,2))*60 + Number(shift.end.slice(3));
    if (end <= start) end += 1440;
    minutes += Math.max(0, end - start - Number(shift.breakMinutes || 0));
  }
  return Number(hourly) * minutes / 60;
}

export function incomeForecast(state, month, today = new Date()) {
  if (month.getFullYear() !== today.getFullYear() || month.getMonth() !== today.getMonth()) return null;
  if (state.incomeMode === "manual") {
    return state.manualIncome === "" || state.manualIncome === null || !Number.isFinite(Number(state.manualIncome))
      ? null : Number(state.manualIncome);
  }
  return shiftIncomeForMonth(state.shifts, state.hourly, month);
}
