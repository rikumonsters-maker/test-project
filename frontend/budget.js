import { EXPENSE_CATEGORIES, expenseBreakdown, expenseTrend, incomeForecast, shiftIncomeForMonth } from "./budget-charts.mjs";

export function initBudget(app) {
  const { $, state, view, formatMoney, changeMonth, status, postJson, renderMonthCalendar, makeId } = app;
  const expenseTotal = (expenses) => expenses.reduce((total, expense) => total + Number(expense.amount || 0), 0);
  const chartColors = ["#16876a", "#4379c0", "#a15bb0", "#d48635", "#c95874", "#789042", "#747e8a"];
  const svgNS = "http://www.w3.org/2000/svg";
  let selectedCategory = null;

  function renderCharts() {
    if (!$('expense-donut') || $('page-budget')?.hidden || $('page-money')?.hidden || $('app-root')?.hidden) return;
    const { amounts, total, count } = expenseBreakdown(state.expenses, view.budgetMonth);
    const donut = $('expense-donut');
    donut.replaceChildren();
    donut.setAttribute('aria-label', `${view.budgetMonth.getMonth()+1}月の記録済み支出 ${formatMoney(total)}`);
    const track = document.createElementNS(svgNS, 'circle');
    track.setAttribute('cx','64'); track.setAttribute('cy','64'); track.setAttribute('r','46');
    track.setAttribute('fill','none'); track.setAttribute('stroke','var(--line)'); track.setAttribute('stroke-width','19');
    donut.append(track);
    let offset = 0;
    EXPENSE_CATEGORIES.forEach((category, index) => {
      const amount = amounts[category];
      if (!amount || !total) return;
      const segment = document.createElementNS(svgNS, 'circle');
      segment.setAttribute('cx','64'); segment.setAttribute('cy','64'); segment.setAttribute('r','46');
      segment.setAttribute('fill','none'); segment.setAttribute('stroke',chartColors[index]); segment.setAttribute('stroke-width','19');
      segment.setAttribute('stroke-dasharray',`${amount / total * 100} ${100 - amount / total * 100}`);
      segment.setAttribute('stroke-dashoffset',String(-offset));
      segment.setAttribute('pathLength','100'); segment.setAttribute('transform','rotate(-90 64 64)');
      donut.append(segment); offset += amount / total * 100;
    });
    $('expense-donut-total').textContent = formatMoney(total);
    const list = $('expense-category-chart-list'); list.replaceChildren();
    EXPENSE_CATEGORIES.forEach((category,index) => {
      const item = document.createElement('li');
      const button = document.createElement('button'); button.type='button'; button.className='chart-category';
      button.setAttribute('aria-pressed',String(selectedCategory===category));
      const label = document.createElement('span'); label.className='chart-category-name';
      const swatch = document.createElement('i'); swatch.className='chart-swatch'; swatch.style.backgroundColor=chartColors[index]; swatch.setAttribute('aria-hidden','true');
      label.append(swatch,document.createTextNode(category));
      const value = document.createElement('strong'); value.textContent=`${formatMoney(amounts[category])} · ${total ? (amounts[category]/total*100).toFixed(1) : '0.0'}%`;
      button.append(label,value);
      button.addEventListener('click',()=>{selectedCategory=category; list.querySelectorAll('button').forEach(node=>node.setAttribute('aria-pressed',String(node===button)));});
      item.append(button); list.append(item);
    });
    $('expense-chart-empty').hidden = count > 0;
    const trend = expenseTrend(state.expenses,view.budgetMonth);
    const max = Math.max(1,...trend.map(entry=>entry.total));
    const bars = $('expense-trend-bars'); bars.replaceChildren();
    for (const entry of trend) {
      const item = document.createElement('li'); item.className='chart-month';
      const label = document.createElement('span'); label.className='chart-month-label'; label.textContent=`${entry.month.getFullYear()}年${entry.month.getMonth()+1}月`;
      const bar = document.createElement('span'); bar.className='chart-month-bar';
      const fill = document.createElement('span'); fill.className='chart-month-fill'; fill.style.width=`${entry.total/max*100}%`; bar.append(fill);
      const value = document.createElement('strong'); value.textContent=entry.count ? formatMoney(entry.total) : '記録なし';
      item.append(label,bar,value); bars.append(item);
    }
    const income = incomeForecast(state,view.budgetMonth);
    const comparison = $('expense-income-comparison');
    const forecast = $('expense-income-forecast');
    forecast.textContent=income===null ? '未設定' : formatMoney(income);
    $('expense-income-spent').textContent=formatMoney(total);
    const denominator=Math.max(1,income||0,total);
    $('expense-income-bar').style.width=`${income===null?0:income/denominator*100}%`;
    $('expense-spent-bar').style.width=`${total/denominator*100}%`;
    comparison.hidden = income===null;
    $('expense-income-note').textContent = income===null
      ? '表示月の収入見込みを比較できません。過去月の収入実績は保存していません。'
      : '収入は見込み額、支出は記録済みの金額です。固定費の設定額と貯金目標は支出に加えていません。';
  }

  function renderCalendar() {
    if (state.incomeMode === 'auto' && $('income')) {
      const estimate=shiftIncomeForMonth(state.shifts,state.hourly,view.budgetMonth);
      $('income').value=estimate===null?'':String(Math.round(estimate));
    }
    $("expense-month-total-label").textContent = `${view.budgetMonth.getMonth() + 1}月の支出合計`;
    $("expense-month-total").textContent = formatMoney(expenseBreakdown(state.expenses,view.budgetMonth).total);
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
    resetExpenseForm(); renderCalendar(); renderDay(); renderCharts(); schedule();
  }
  function deleteExpense(id) {
    const remaining = (state.expenses[view.expenseDate] || []).filter((expense) => expense.id !== id);
    if (remaining.length) state.expenses[view.expenseDate] = remaining;
    else delete state.expenses[view.expenseDate];
    if (view.editingExpenseId === id) resetExpenseForm();
    app.saveState(); renderCalendar(); renderDay(); renderCharts(); schedule();
  }
  function budgetReady() {
    const income = incomeForecast(state,view.budgetMonth);
    return income !== null && $("fixed").value !== "" && $("saving").value !== "";
  }
  async function calculate() {
    const request = ++view.budgetRequest;
    const spent = expenseBreakdown(state.expenses,view.budgetMonth).total;
    $("expense-month-total-label").textContent = `${view.budgetMonth.getMonth() + 1}月の支出合計`;
    $("expense-month-total").textContent = formatMoney(spent);
    if (!budgetReady()) {
      $("remaining").textContent = "—";
      $("daily").textContent = "—";
      const current=new Date();
      const otherMonth=view.budgetMonth.getFullYear()!==current.getFullYear() || view.budgetMonth.getMonth()!==current.getMonth();
      status($("budget-status"), "", "i", otherMonth ? "表示月の収入見込みを比較できません" : "予算を計算できます",
        otherMonth ? "現在の収入見込みを別の月の収入として扱わないため、残額は表示しません。" : "収入見込み・固定費・目標貯金額を入力してください。");
      return;
    }
    const income = incomeForecast(state,view.budgetMonth);
    status($("budget-status"), "", "…", "計算中です", "支出を反映しています。");
    try {
      const result = await postJson("/api/budget", {
        income,
        fixed:Number($("fixed").value),
        saving:Number($("saving").value),
        spent,
        month:app.monthPrefix(view.budgetMonth).slice(0, 7),
        today:app.dateKey(new Date()),
      });
      if (request !== view.budgetRequest) return;
      $("remaining").textContent = app.money.format(result.remaining);
      $("daily").textContent = result.daily === null ? "—" : app.money.format(result.daily);
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
    view.budgetRequest++;
    renderCharts();
    view.budgetTimer = setTimeout(calculate, 250);
  }
  function refresh() {
    renderCalendar(); renderDay(); renderCharts(); schedule();
  }
  function init() {
    window.addEventListener('daysync:logout', () => {
      selectedCategory=null;
      clearTimeout(view.budgetTimer);
      view.budgetRequest++;
      $('expense-donut')?.replaceChildren();
      $('expense-category-chart-list')?.replaceChildren();
      $('expense-trend-bars')?.replaceChildren();
      if ($('expense-donut-total')) $('expense-donut-total').textContent='¥0';
      if ($('expense-income-forecast')) $('expense-income-forecast').textContent='未設定';
      if ($('expense-income-spent')) $('expense-income-spent').textContent='¥0';
    });
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
      const estimate=shiftIncomeForMonth(state.shifts,state.hourly,view.budgetMonth);
      $("income").value = estimate===null ? "" : String(Math.round(estimate));
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
