function parseCssTime(value) {
  const input = String(value || "0s").trim();
  const amount = Number.parseFloat(input);
  if (!Number.isFinite(amount)) return 0;
  return input.endsWith("ms") ? amount : amount * 1000;
}

function parseCssTimeList(value) {
  return String(value || "0s").split(",").map(parseCssTime);
}

export function transitionEndDelayMs(duration, delay = "0s") {
  const durations = parseCssTimeList(duration);
  const delays = parseCssTimeList(delay);
  const propertyCount = Math.max(durations.length, delays.length);
  let longest = 0;
  for (let index = 0; index < propertyCount; index += 1) {
    longest = Math.max(longest, durations[index % durations.length] + delays[index % delays.length]);
  }
  return Math.max(0, Math.ceil(longest));
}

export function dialogExitDelayMs(dialog) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return 0;
  const panel = dialog.querySelector(".entry-dialog-panel, .group-add-dialog-panel")
    || (dialog.matches(".common-availability-dialog, .group-wish-dialog") ? dialog : null);
  if (!panel) return 0;
  const style = window.getComputedStyle(panel);
  return transitionEndDelayMs(style.transitionDuration, style.transitionDelay);
}
