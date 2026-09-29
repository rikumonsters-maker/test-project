export function initBudget(app) {
  const { $, state, view, formatMoney, changeMonth, status, postJson, renderMonthCalendar, makeId } = app;
  const expensesForMonth = (month) => {
    const prefix = app.monthPrefix(month);
    return Object.entries(state.expenses)
      .filter(([key]) => key.startsWith(prefix))
      .flatMap(([date, expenses]) => (Array.isArray(expenses) ? expenses : []).map((expense) => ({ ...expense, date })));
  };
  const expenseTotal = (expenses) => expenses.reduce((total, expense) => total + Number(expense.amount || 0), 0);

  function renderCalendar() {
    $("expense-month-total-label").textContent = `${view.budgetMonth.getMonth() + 1}月の支出合計`;
    $("expense-month-total").textContent = formatMoney(expenseTotal(expensesForMonth(view.budgetMonth)));
    renderMonthCalendar({
      calendarId:"expense-calendar",
      month:view.budgetMonth,
      selectedDate:view.expenseDate,
      mode:"expense",
      onSelect:(key, date) => {
        view.expenseDate = key;
        if (date.getMonth() !== view.budgetMonth.getMonth() || date.getFullYear() !== view.budgetMonth.getFullYear()) {
          view.budgetMonth = new Date(date.getFullYear(), date.getMonth(), 1);
        }
        resetExpenseForm();
        renderCalendar(); renderDay(); schedule();
      },
    });
  }
  function renderDay() {
    const expenses = Array.isArray(state.expenses[view.expenseDate]) ? state.expenses[view.expenseDate] : [];
    $("expense-date").textContent = app.dateLabel.format(app.parseDate(view.expenseDate));
    $("expense-day-total").textContent = formatMoney(expenseTotal(expenses));
    const list = $("expense-list");
    list.replaceChildren();
    if (!expenses.length) {
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
    $("expense-category").value = app.CATEGORIES[0];
    $("save-expense").textContent = "支出を追加";
    $("expense-form-title").textContent = "支出を追加";
    $("cancel-expense-edit").hidden = true;
  }
  function submitExpense(event) {
    event.preventDefault();
    const amount = Number($("expense-amount").value);
    const category = $("expense-category").value;
    const note = $("expense-note").value.trim();
    if (!Number.isSafeInteger(amount) || amount < 1 || !app.CATEGORIES.includes(category)) return;
    const expenses = Array.isArray(state.expenses[view.expenseDate]) ? state.expenses[view.expenseDate] : [];
    if (view.editingExpenseId) {
      const index = expenses.findIndex((expense) => expense.id === view.editingExpenseId);
      if (index >= 0) expenses[index] = { ...expenses[index], amount, category, note };
    } else {
      expenses.push({ id:makeId(), amount, category, note });
    }
    state.expenses[view.expenseDate] = expenses;
    app.saveState();
    resetExpenseForm(); renderCalendar(); renderDay(); schedule();
  }
  function deleteExpense(id) {
    const remaining = (state.expenses[view.expenseDate] || []).filter((expense) => expense.id !== id);
    if (remaining.length) state.expenses[view.expenseDate] = remaining;
    else delete state.expenses[view.expenseDate];
    if (view.editingExpenseId === id) resetExpenseForm();
    app.saveState(); renderCalendar(); renderDay(); schedule();
  }
  function budgetReady() {
    const income = state.incomeMode === "manual" ? state.manualIncome : view.wageEstimate;
    return income !== "" && income !== null && $("fixed").value !== "" && $("saving").value !== "";
  }
  async function calculate() {
    const request = ++view.budgetRequest;
    const spent = expenseTotal(expensesForMonth(view.budgetMonth));
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
      $("remaining").textContent = app.money.format(result.remaining);
      $("daily").textContent = app.money.format(result.daily);
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
  function schedule() {
    clearTimeout(view.budgetTimer);
    view.budgetTimer = setTimeout(calculate, 250);
  }
  function refresh() {
    renderCalendar(); renderDay(); schedule();
  }
  function init() {
    $("expense-previous").addEventListener("click", () => {
      view.budgetMonth = changeMonth(view.budgetMonth, -1);
      view.expenseDate = app.dateKey(view.budgetMonth);
      resetExpenseForm(); renderCalendar(); renderDay(); schedule();
    });
    $("expense-next").addEventListener("click", () => {
      view.budgetMonth = changeMonth(view.budgetMonth, 1);
      view.expenseDate = app.dateKey(view.budgetMonth);
      resetExpenseForm(); renderCalendar(); renderDay(); schedule();
    });
    $("expense-form").addEventListener("submit", submitExpense);
    $("cancel-expense-edit").addEventListener("click", resetExpenseForm);
    $("budget-form").addEventListener("submit", (event) => event.preventDefault());
    $("fixed").value = state.budget.fixed;
    $("saving").value = state.budget.saving;
    $("income").disabled = state.incomeMode !== "manual";
    $("income").value = state.incomeMode === "manual" ? state.manualIncome : "";
    $("manual-income").setAttribute("aria-pressed", String(state.incomeMode === "manual"));
    $("auto-income").setAttribute("aria-pressed", String(state.incomeMode !== "manual"));
    $("auto-income").addEventListener("click", () => {
      state.incomeMode = "auto";
      $("income").disabled = true;
      $("income").value = view.wageEstimate === null ? "" : String(Math.round(view.wageEstimate));
      $("auto-income").setAttribute("aria-pressed", "true");
      $("manual-income").setAttribute("aria-pressed", "false");
      app.saveState(); schedule();
    });
    $("manual-income").addEventListener("click", () => {
      state.incomeMode = "manual";
      $("income").disabled = false;
      $("income").value = state.manualIncome;
      $("auto-income").setAttribute("aria-pressed", "false");
      $("manual-income").setAttribute("aria-pressed", "true");
      app.saveState(); schedule();
    });
    $("budget-form").addEventListener("input", (event) => {
      const { id, value } = event.target;
      if (id === "income" && state.incomeMode === "manual") state.manualIncome = value;
      if (id === "fixed" || id === "saving") state.budget[id] = value;
      app.saveState(); schedule();
    });
    renderCalendar(); renderDay();
  }
  return { init, refresh, renderCalendar, renderDay, schedule, calculate };
}