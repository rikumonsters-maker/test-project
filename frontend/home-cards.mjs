export const HOME_LOOP_DURATION_SECONDS = 7.0;
export const HOME_LOOP_DURATION_MS = 7000;

export const HOME_CARD_SPECS = Object.freeze([
  {
    id: "personal",
    domId: "home-card-personal",
    title: "個人予定",
    subtitle: "カレンダー・予定管理",
    theme: "mint",
    quadrant: { x: -1, y: -1 },
    stack: { x: -7, y: -9, rotate: -3.6, scale: 0.92, zIndex: 4 },
    curveSign: 1,
    flightSpin: -7.5,
    iconWindow: [
      [2.50, 3.05],
      [2.85, 3.45],
      [3.25, 3.95],
    ],
    glossWindow: [4.00, 4.95],
  },
  {
    id: "shared",
    domId: "home-card-shared",
    title: "共有予定",
    subtitle: "グループ・空き時間",
    theme: "blue",
    quadrant: { x: 1, y: -1 },
    stack: { x: 5, y: -4, rotate: 2.8, scale: 0.90, zIndex: 3 },
    curveSign: -1,
    flightSpin: 7.5,
    iconWindow: [
      [2.54, 3.08],
      [2.88, 3.48],
      [3.28, 3.96],
    ],
    glossWindow: [4.12, 5.10],
  },
  {
    id: "shift",
    domId: "home-card-shift",
    title: "シフト",
    subtitle: "勤務時間・シフト登録",
    theme: "orange",
    quadrant: { x: -1, y: 1 },
    stack: { x: -4, y: 5, rotate: -2.0, scale: 0.88, zIndex: 2 },
    curveSign: -1,
    flightSpin: 6.8,
    iconWindow: [
      [2.56, 3.10],
      [2.92, 3.52],
      [3.30, 3.98],
    ],
    glossWindow: [4.24, 5.26],
  },
  {
    id: "salary",
    domId: "home-card-salary",
    title: "給与",
    subtitle: "見込み給料・給与管理",
    theme: "purple",
    quadrant: { x: 1, y: 1 },
    stack: { x: 8, y: 10, rotate: 4.4, scale: 0.86, zIndex: 1 },
    curveSign: 1,
    flightSpin: -6.8,
    iconWindow: [
      [2.60, 3.14],
      [2.95, 3.54],
      [3.32, 4.00],
    ],
    glossWindow: [4.36, 5.42],
  },
]);

function clamp01(value) {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function easeInOutCubic(t) {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function easeOutQuart(t) {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 4);
}

function easeBurstSpread(t) {
  const x = clamp01(t);
  // Energetic burst out of the stack that smoothly decelerates into the 2x2 slots
  return 1 - Math.pow(1 - x, 2.85);
}

function quadraticBezier(p0, pCtrl, p1, t) {
  const inv = 1 - t;
  return inv * inv * p0 + 2 * inv * t * pCtrl + t * t * p1;
}

export function normalizeLoopTime(timeSeconds) {
  if (!Number.isFinite(timeSeconds)) return 0;
  const mod = timeSeconds % HOME_LOOP_DURATION_SECONDS;
  return mod < 0 ? mod + HOME_LOOP_DURATION_SECONDS : mod;
}

const BASE_ICON_PREVIEW = Object.freeze([0.38, 0.14, 0.0]);

export function computeIconParts(timeSeconds, cardIndex = 0) {
  const t = normalizeLoopTime(timeSeconds);
  const spec = HOME_CARD_SPECS[cardIndex] || HOME_CARD_SPECS[0];
  if (t < 2.5) {
    return [...BASE_ICON_PREVIEW];
  }
  if (t <= 4.0) {
    return spec.iconWindow.map(([start, end], partIndex) => {
      const base = BASE_ICON_PREVIEW[partIndex];
      const raw = clamp01((t - start) / (end - start));
      const eased = easeOutQuart(raw);
      return base + (1 - base) * eased;
    });
  }
  if (t <= 5.5) {
    return [1, 1, 1];
  }
  const convergeProgress = easeInOutCubic((t - 5.5) / 1.5);
  return BASE_ICON_PREVIEW.map((base) => 1 + (base - 1) * convergeProgress);
}

export function computeGlossState(timeSeconds, cardIndex = 0) {
  const t = normalizeLoopTime(timeSeconds);
  const spec = HOME_CARD_SPECS[cardIndex] || HOME_CARD_SPECS[0];
  const [start, end] = spec.glossWindow;
  if (t < start || t > end) {
    return { active: false, progress: 0, opacity: 0, translateXPercent: -135 };
  }
  const progress = clamp01((t - start) / (end - start));
  const eased = easeInOutCubic(progress);
  // Smooth bell curve that starts and ends at 0 so gloss never pops or disappears abruptly
  const opacity = Math.sin(Math.PI * progress) * 0.72;
  const translateXPercent = -135 + 270 * eased;
  return {
    active: opacity > 0.01,
    progress,
    opacity: Number(opacity.toFixed(4)),
    translateXPercent: Number(translateXPercent.toFixed(2)),
  };
}

export function computeHomeCardFrame(timeSeconds, { dx = 88, dy = 92, expanded = false } = {}) {
  if (expanded) {
    return {
      timeSeconds: 4.5,
      phase: "expanded-static",
      isStacked: false,
      cards: HOME_CARD_SPECS.map((spec) => ({
        id: spec.id,
        x: 0,
        y: 0,
        rotate: 0,
        scale: 1,
        borderRadius: 60,
        zIndex: spec.stack.zIndex,
        iconParts: [1, 1, 1],
        gloss: { active: false, progress: 0, opacity: 0, translateXPercent: -135 },
      })),
    };
  }

  const t = normalizeLoopTime(timeSeconds);
  let phase = "stacked";
  if (t >= 1.0 && t < 2.5) phase = "spreading";
  else if (t >= 2.5 && t < 4.0) phase = "icon-assembly";
  else if (t >= 4.0 && t < 5.5) phase = "gloss";
  else if (t >= 5.5) phase = "converging";

  const isStacked = t < 1.0 || t >= 6.35;

  const cards = HOME_CARD_SPECS.map((spec, index) => {
    // Stacked center offset relative to the card's own 2x2 grid slot
    const startX = -spec.quadrant.x * dx + spec.stack.x;
    const startY = -spec.quadrant.y * dy + spec.stack.y;

    let x = startX;
    let y = startY;
    let rotate = spec.stack.rotate;
    let scale = spec.stack.scale;
    let borderRadius = 20;

    if (t < 1.0) {
      // Phase 1 (0.0s - 1.0s): Stacked in center with subtle breathing float that is 0 at t=0 and t=1
      const floatWave = Math.sin(Math.PI * t);
      x = startX + spec.quadrant.x * 1.5 * floatWave;
      y = startY + spec.quadrant.y * 1.5 * floatWave;
      rotate = spec.stack.rotate + spec.curveSign * 0.6 * floatWave;
      scale = spec.stack.scale + 0.01 * floatWave;
      borderRadius = 20;
    } else if (t < 2.5) {
      // Phase 2 (1.0s - 2.5s): Burst & spread along curved trajectory to 2x2 corners
      const raw = clamp01((t - 1.0) / 1.5);
      const p = easeBurstSpread(raw);
      const radiusEase = 1 - Math.pow(1 - raw, 2.2);
      // Perpendicular control point for curved trajectory
      const perpX = -startY * 0.36 * spec.curveSign;
      const perpY = startX * 0.36 * spec.curveSign;
      const ctrlX = startX * 0.45 + perpX;
      const ctrlY = startY * 0.45 + perpY;

      x = quadraticBezier(startX, ctrlX, 0, p);
      y = quadraticBezier(startY, ctrlY, 0, p);
      // Natural banking rotation along the curved arc
      const arcSpin = Math.sin(Math.PI * raw) * spec.flightSpin;
      rotate = spec.stack.rotate * (1 - p) + arcSpin;
      scale = spec.stack.scale + (1 - spec.stack.scale) * p;
      borderRadius = 20 + 40 * radiusEase;
    } else if (t < 5.5) {
      // Phase 3 (2.5s - 4.0s) & Phase 4 (4.0s - 5.5s): Expanded 2x2 grid, radius 60px
      x = 0;
      y = 0;
      rotate = 0;
      scale = 1;
      borderRadius = 60;
    } else {
      // Phase 5 (5.5s - 7.0s): Converge along curved trajectory back to center stack
      const raw = clamp01((t - 5.5) / 1.5);
      const q = 0.5 - 0.5 * Math.cos(Math.PI * raw);
      const perpX = -startY * 0.32 * spec.curveSign;
      const perpY = startX * 0.32 * spec.curveSign;
      const ctrlX = startX * 0.50 + perpX;
      const ctrlY = startY * 0.50 + perpY;

      x = quadraticBezier(0, ctrlX, startX, q);
      y = quadraticBezier(0, ctrlY, startY, q);
      const returnSpin = Math.sin(Math.PI * raw) * (-spec.flightSpin * 0.65);
      rotate = spec.stack.rotate * q + returnSpin;
      scale = 1 + (spec.stack.scale - 1) * q;
      borderRadius = 60 - 40 * q;
    }

    return {
      id: spec.id,
      x: Number(x.toFixed(3)),
      y: Number(y.toFixed(3)),
      rotate: Number(rotate.toFixed(3)),
      scale: Number(scale.toFixed(4)),
      borderRadius: Number(borderRadius.toFixed(2)),
      zIndex: spec.stack.zIndex,
      iconParts: computeIconParts(t, index),
      gloss: computeGlossState(t, index),
    };
  });

  return {
    timeSeconds: Number(t.toFixed(4)),
    phase,
    isStacked,
    cards,
  };
}

export function initHomeCards({ document, window = document.defaultView, onSelectCard }) {
  const section = document.getElementById("home-four-card-section");
  const stage = document.getElementById("home-card-stage");
  const expandButton = document.getElementById("home-expand-toggle");
  const stackOverlay = document.getElementById("home-stack-expand");
  if (!section || !stage) return null;

  const cardElements = HOME_CARD_SPECS.map((spec) => {
    const el = document.getElementById(spec.domId);
    const gloss = el?.querySelector(".home-card-gloss") || null;
    const parts = [1, 2, 3].map((part) => {
      const group = el?.querySelector(`[data-icon-part="${part}"]`) || null;
      const drawNodes = group ? Array.from(group.querySelectorAll(".icon-stroke-draw")) : [];
      return { group, drawNodes, lastProgress: -1 };
    });
    return { spec, el, gloss, parts, lastGlossOpacity: -1, lastGlossX: -999 };
  }).filter((item) => Boolean(item.el));

  let rafId = 0;
  let running = false;
  let expandedLocked = false;
  let manualTimeSeconds = null;
  let cycleOriginMs = 0;
  let cachedGeometry = { dx: 88, dy: 92 };
  let lastPhase = "";
  let lastStacked = "";
  let lastExpandedLocked = "";

  const reducedMotionQuery = window?.matchMedia?.("(prefers-reduced-motion: reduce)") || null;

  function isReducedMotion() {
    return Boolean(reducedMotionQuery?.matches);
  }

  function measureStageGeometry() {
    const first = cardElements[0]?.el;
    if (!first) return cachedGeometry;
    const stageWidth = stage.clientWidth || 360;
    const colGap = stageWidth >= 400 ? 18 : 14;
    const rowGap = colGap;
    const w = Math.max(120, (stageWidth - 12 - colGap) / 2);
    const h = w * 1.02;
    cachedGeometry = {
      dx: Number(((w + colGap) / 2).toFixed(2)),
      dy: Number(((h + rowGap) / 2).toFixed(2)),
    };
    return cachedGeometry;
  }

  function applyPartProgress(partEntry, progress, partIndex) {
    if (!partEntry || !partEntry.group) return;
    const p = clamp01(progress);
    const rounded = Math.round(p * 1000) / 1000;
    if (partEntry.lastProgress === rounded) return;
    partEntry.lastProgress = rounded;
    const { group, drawNodes } = partEntry;
    group.style.opacity = rounded.toFixed(3);
    const offsetY = (1 - rounded) * (partIndex === 1 ? 5 : partIndex === 2 ? 3 : 2);
    const scale = 0.82 + 0.18 * rounded;
    group.style.transform = `translate3d(0, ${offsetY.toFixed(2)}px, 0) scale(${scale.toFixed(3)})`;
    const dashOffset = ((1 - rounded) * 100).toFixed(2);
    for (let i = 0; i < drawNodes.length; i += 1) {
      drawNodes[i].style.strokeDashoffset = dashOffset;
    }
  }

  function renderFrame(timeSeconds) {
    const forceExpanded = isReducedMotion() || expandedLocked;
    const frame = computeHomeCardFrame(timeSeconds, {
      ...cachedGeometry,
      expanded: forceExpanded,
    });

    const stackedStr = String(frame.isStacked);
    const expandedStr = String(forceExpanded);
    if (lastPhase !== frame.phase) {
      lastPhase = frame.phase;
      stage.dataset.phase = frame.phase;
    }
    if (lastStacked !== stackedStr) {
      lastStacked = stackedStr;
      stage.dataset.stacked = stackedStr;
    }
    if (lastExpandedLocked !== expandedStr) {
      lastExpandedLocked = expandedStr;
      stage.dataset.expandedLocked = expandedStr;
      if (expandButton) {
        expandButton.setAttribute("aria-pressed", expandedStr);
        expandButton.textContent = forceExpanded ? "アニメーションを再開" : "4枚を展開して固定";
      }
    }
    const loopTimeStr = frame.timeSeconds.toFixed(1);
    if (stage.dataset.loopTime !== loopTimeStr) {
      stage.dataset.loopTime = loopTimeStr;
    }

    if (stackOverlay) {
      const shouldHideOverlay = !frame.isStacked || forceExpanded;
      if (stackOverlay.hidden !== shouldHideOverlay) {
        stackOverlay.hidden = shouldHideOverlay;
      }
    }

    for (let i = 0; i < cardElements.length; i += 1) {
      const cardItem = cardElements[i];
      const { el, gloss, parts } = cardItem;
      const state = frame.cards[i];
      const nextTransform = forceExpanded
        ? "none"
        : `translate3d(${state.x}px, ${state.y}px, 0) rotate(${state.rotate}deg) scale(${state.scale})`;
      if (cardItem.lastTransform !== nextTransform) {
        cardItem.lastTransform = nextTransform;
        el.style.transform = nextTransform;
      }
      const nextRadius = `${state.borderRadius}px`;
      if (cardItem.lastRadius !== nextRadius) {
        cardItem.lastRadius = nextRadius;
        el.style.borderRadius = nextRadius;
        el.dataset.cardRadius = String(Math.round(state.borderRadius));
      }
      const nextZ = String(forceExpanded ? 1 : state.zIndex);
      if (cardItem.lastZ !== nextZ) {
        cardItem.lastZ = nextZ;
        el.style.zIndex = nextZ;
      }

      for (let pIdx = 0; pIdx < parts.length; pIdx += 1) {
        applyPartProgress(parts[pIdx], state.iconParts[pIdx], pIdx);
      }

      if (gloss) {
        if (cardItem.lastGlossOpacity !== state.gloss.opacity) {
          cardItem.lastGlossOpacity = state.gloss.opacity;
          gloss.style.opacity = state.gloss.opacity.toFixed(3);
        }
        if (cardItem.lastGlossX !== state.gloss.translateXPercent) {
          cardItem.lastGlossX = state.gloss.translateXPercent;
          gloss.style.transform = `translate3d(${state.gloss.translateXPercent}%, 0, 0) rotate(-24deg)`;
        }
      }
    }
    return frame;
  }

  let lastTickMs = -100;

  function tick(nowMs) {
    if (!running) return;
    if (section.hidden || document.hidden || isReducedMotion() || expandedLocked || manualTimeSeconds !== null) {
      running = false;
      rafId = 0;
      return;
    }
    const deltaMs = nowMs - cycleOriginMs;
    // During the first 0.96s of the initial cycle, cards remain in the exact 0.0s stacked pose.
    // Skipping redundant DOM writes during this window keeps initial page load and immediate navigation ultra-fast.
    if (deltaMs >= 960 && nowMs - lastTickMs >= 24) {
      lastTickMs = nowMs;
      const elapsedSeconds = (deltaMs % HOME_LOOP_DURATION_MS) / 1000;
      renderFrame(elapsedSeconds);
    }
    rafId = window.requestAnimationFrame(tick);
  }

  function start({ resetLocks = false } = {}) {
    if (resetLocks) {
      expandedLocked = false;
      manualTimeSeconds = null;
    }
    measureStageGeometry();
    if (isReducedMotion() || expandedLocked) {
      stop();
      renderFrame(4.5);
      return;
    }
    if (manualTimeSeconds !== null) {
      renderFrame(manualTimeSeconds);
      return;
    }
    if (section.hidden || document.hidden) {
      stop();
      return;
    }
    if (running) return;
    running = true;
    const now = window.performance?.now?.() ?? Date.now();
    cycleOriginMs = now;
    lastTickMs = now;
    renderFrame(0);
    rafId = window.requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (rafId) {
      window.cancelAnimationFrame?.(rafId);
      rafId = 0;
    }
  }

  function expandImmediately() {
    expandedLocked = true;
    manualTimeSeconds = null;
    stop();
    measureStageGeometry();
    return renderFrame(4.5);
  }

  function resumeLoop() {
    expandedLocked = false;
    manualTimeSeconds = null;
    start();
  }

  function setAnimationTime(seconds) {
    stop();
    expandedLocked = false;
    manualTimeSeconds = normalizeLoopTime(seconds);
    measureStageGeometry();
    return renderFrame(manualTimeSeconds);
  }

  let pointerDownOnCard = false;

  for (const { spec, el } of cardElements) {
    el.addEventListener("pointerdown", () => {
      pointerDownOnCard = true;
    });
    el.addEventListener("mousedown", () => {
      pointerDownOnCard = true;
    });
    el.addEventListener("touchstart", () => {
      pointerDownOnCard = true;
    }, { passive: true });
    el.addEventListener("pointerup", () => {
      pointerDownOnCard = false;
    });
    el.addEventListener("pointercancel", () => {
      pointerDownOnCard = false;
    });
    el.addEventListener("mouseup", () => {
      pointerDownOnCard = false;
    });
    el.addEventListener("click", () => {
      pointerDownOnCard = false;
      stop();
      onSelectCard?.(spec.id);
    });
    el.addEventListener("focus", () => {
      // If a keyboard user focuses a card while stacked, expand immediately for clear visibility
      if (!pointerDownOnCard && stage.dataset.stacked === "true" && !expandedLocked) {
        expandImmediately();
      }
    });
  }

  stackOverlay?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    expandImmediately();
    cardElements[0]?.el?.focus?.({ preventScroll: true });
  });

  stage.addEventListener("click", (event) => {
    if (event.target === stage && stage.dataset.stacked === "true") {
      expandImmediately();
    }
  });

  expandButton?.addEventListener("click", () => {
    if (expandedLocked) resumeLoop();
    else expandImmediately();
  });

  window?.addEventListener?.("resize", () => {
    measureStageGeometry();
    if (!running) {
      renderFrame(manualTimeSeconds ?? 4.5);
    }
  }, { passive: true });

  reducedMotionQuery?.addEventListener?.("change", () => {
    if (isReducedMotion()) {
      stop();
      renderFrame(4.5);
    } else if (!section.hidden && !expandedLocked) {
      start();
    }
  });

  document.addEventListener?.("visibilitychange", () => {
    if (document.hidden) stop();
    else if (!section.hidden && !expandedLocked && manualTimeSeconds === null) start();
  });

  const controller = {
    start,
    stop,
    expandImmediately,
    resumeLoop,
    setAnimationTime,
    measureStageGeometry,
    getState: () => ({
      running,
      expandedLocked,
      manualTimeSeconds,
      phase: stage.dataset.phase,
      stacked: stage.dataset.stacked === "true",
    }),
  };

  if (window) {
    window.__daysyncHomeCards = controller;
  }

  measureStageGeometry();
  renderFrame(isReducedMotion() ? 4.5 : 0);
  return controller;
}
