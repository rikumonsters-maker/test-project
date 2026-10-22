import { MAX_REMINDER_COUNT, MAX_REMINDER_MINUTES } from "./reminders.mjs";

export function initReminderControls(root) {
  const none = root.querySelector("[data-reminder-none]");
  const error = root.querySelector("[data-reminder-error]");
  const choices = () => [...root.querySelectorAll("input[data-reminder-offset]")];
  const selected = () => choices().filter((input) => input.checked).map((input) => Number(input.value));

  function updateNone() {
    const values = selected();
    none.checked = values.length === 0;
    error.hidden = true;
    error.textContent = "";
  }

  for (const input of choices()) input.addEventListener("change", updateNone);
  none.addEventListener("change", () => {
    if (!none.checked) return;
    for (const input of choices()) input.checked = false;
    root.querySelector("[data-reminder-custom-options]").replaceChildren();
    updateNone();
  });
  root.querySelector("[data-reminder-custom-add]").addEventListener("click", () => {
    const field = root.querySelector("[data-reminder-custom-input]");
    const value = Number(field.value);
    const values = selected();
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REMINDER_MINUTES) {
      error.textContent = "1〜10080分の整数を入力してください。";
      error.hidden = false;
      field.focus();
      return;
    }
    if (values.includes(value)) {
      error.textContent = "同じ通知タイミングは追加済みです。";
      error.hidden = false;
      return;
    }
    if (values.length >= MAX_REMINDER_COUNT) {
      error.textContent = "通知タイミングは最大8件まで選べます。";
      error.hidden = false;
      return;
    }
    const label = document.createElement("label");
    label.className = "reminder-choice reminder-custom-choice";
    label.dataset.customOption = "true";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(value);
    checkbox.dataset.reminderOffset = "true";
    checkbox.checked = true;
    checkbox.addEventListener("change", updateNone);
    const text = document.createElement("span");
    text.textContent = `${value}分前`;
    label.append(checkbox, text);
    root.querySelector("[data-reminder-custom-options]").append(label);
    field.value = "";
    updateNone();
  });

  function set(offsetMinutes = []) {
    const values = new Set(offsetMinutes);
    for (const input of choices()) input.checked = false;
    root.querySelector("[data-reminder-custom-options]").replaceChildren();
    for (const value of values) {
      const preset = root.querySelector(`input[data-reminder-offset][value="${value}"]`);
      if (preset) { preset.checked = true; continue; }
      const label = document.createElement("label");
      label.className = "reminder-choice reminder-custom-choice";
      label.dataset.customOption = "true";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = String(value);
      checkbox.dataset.reminderOffset = "true";
      checkbox.checked = true;
      checkbox.addEventListener("change", updateNone);
      const text = document.createElement("span");
      text.textContent = `${value}分前`;
      label.append(checkbox, text);
      root.querySelector("[data-reminder-custom-options]").append(label);
    }
    root.querySelector("[data-reminder-custom-input]").value = "";
    updateNone();
  }

  return { set, selected };
}
