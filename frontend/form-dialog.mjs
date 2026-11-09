import { dialogExitDelayMs } from "./dialog-motion.mjs";

export function initFormDialog({ dialog, form, closeButton, fallbackOpener, onClose }) {
  let opener = null;
  let initialSnapshot = "";
  let closing = false;
  let closeTimer = null;

  function snapshot() {
    return JSON.stringify([...form.elements].map((control) => {
      const type = String(control.type || "").toLowerCase();
      return [control.id || control.name || "", type, type === "checkbox" || type === "radio" ? control.checked : control.value];
    }));
  }

  function isDirty() {
    return dialog.open && snapshot() !== initialSnapshot;
  }

  function open({ trigger = document.activeElement, focus = null } = {}) {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
    closing = false;
    if (!dialog.open) {
      opener = trigger instanceof HTMLElement && trigger !== document.body ? trigger : fallbackOpener?.() || null;
      dialog.showModal();
    }
    initialSnapshot = snapshot();
    requestAnimationFrame(() => {
      if (!dialog.open || closing) return;
      dialog.classList.add("is-visible");
      focus?.focus({ preventScroll:true });
    });
  }

  function close({ force = false } = {}) {
    if (!dialog.open || closing) return false;
    if (!force && isDirty() && !window.confirm("入力内容を破棄して閉じますか？")) return false;
    closing = true;
    dialog.classList.remove("is-visible");
    const delay = dialogExitDelayMs(dialog);
    if (!delay) {
      dialog.close();
      return true;
    }
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (dialog.open) dialog.close();
    }, delay);
    return true;
  }

  closeButton?.addEventListener("click", () => close());
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener("close", () => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
    closing = false;
    dialog.classList.remove("is-visible");
    const restore = opener;
    opener = null;
    if (restore?.isConnected && restore.getClientRects().length && !restore.disabled) restore.focus({ preventScroll:true });
    else fallbackOpener?.()?.focus({ preventScroll:true });
    initialSnapshot = "";
    onClose?.();
  });

  return { open, close, isDirty, isOpen:() => dialog.open };
}
