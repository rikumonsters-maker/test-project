import { initFormDialog } from "./form-dialog.mjs";
import { extractCalendarCandidates, isImportEventReady, markImportDuplicates } from "./screenshot-calendar-ocr.mjs";

const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_000_000;
const SUPPORTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function getEvents(eventsByDate = {}) {
  return Object.entries(eventsByDate).flatMap(([date, events]) =>
    Array.isArray(events) ? events.map((event) => ({ ...event, date })) : []);
}

async function validateImage(file) {
  if (!SUPPORTED_TYPES.has(file.type)) throw new Error("JPEG、PNG、WebP画像を選んでください。HEIC画像は端末でJPEGまたはPNGに変換してください。");
  if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) throw new Error("画像は24MB以下のものを選んでください。");
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    try {
      if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) throw new Error("画像の解像度が大きすぎます。画面の必要な範囲を切り抜いてください。");
    } finally { bitmap.close(); }
    return;
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (image.naturalWidth * image.naturalHeight > MAX_IMAGE_PIXELS) throw new Error("画像の解像度が大きすぎます。画面の必要な範囲を切り抜いてください。");
  } finally { URL.revokeObjectURL(url); }
}

export function initScreenshotCalendarImport({ app, addEvents, onCalendarImportComplete = null }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $("screenshot-import-dialog");
  if (!dialog) return null;
  const form = $("screenshot-import-form");
  const input = $("screenshot-import-file");
  const list = $("screenshot-import-review-list");
  const status = $("screenshot-import-status");
  const resultStatus = $("screenshot-import-result");
  const progress = $("screenshot-import-progress");
  const cancelOcr = $("screenshot-import-cancel-ocr");
  const submit = $("screenshot-import-register");
  const selectedCount = $("screenshot-import-selected-count");
  let candidates = [];
  let worker = null;
  let runId = 0;
  let processing = false;
  let source = "profile";
  let pendingCalendarCompletion = null;

  function setStatus(message, kind = "info") {
    status.textContent = message;
    status.dataset.kind = kind;
    status.hidden = !message;
  }

  function eventFromCard(card) {
    const allDay = card.querySelector("[data-field=allDay]").checked;
    return {
      title:card.querySelector("[data-field=title]").value.trim(),
      date:card.querySelector("[data-field=date]").value,
      start:allDay ? "" : card.querySelector("[data-field=start]").value,
      end:allDay ? "" : card.querySelector("[data-field=end]").value,
      allDay,
    };
  }

  function refreshRegisterState() {
    const cards = [...list.querySelectorAll("[data-candidate-index]")];
    let selected = 0;
    let valid = true;
    for (const card of cards) {
      const check = card.querySelector("[data-field=selected]");
      const event = eventFromCard(card);
      const ready = isImportEventReady(event);
      const complete = Boolean(event.title && event.date && (event.allDay || (event.start && event.end)));
      const message = card.querySelector("[data-role=validation]");
      message.textContent = ready ? "入力内容を確認してください。" : "日付・タイトル・開始／終了時刻（または終日）を確認してください。";
      message.hidden = ready;
      check.disabled = !complete;
      if (check.checked) {
        selected += 1;
        if (!ready) valid = false;
      }
    }
    selectedCount.textContent = `${selected}件を登録対象に選択`;
    submit.disabled = processing || selected === 0 || !valid;
  }

  function makeLabel(text, control) {
    const label = document.createElement("label");
    label.className = "screenshot-import-field";
    label.append(document.createTextNode(text), control);
    return label;
  }

  function renderCandidates() {
    list.replaceChildren();
    candidates.forEach((candidate, index) => {
      const card = document.createElement("article");
      card.className = "screenshot-import-candidate";
      card.dataset.candidateIndex = String(index);
      const heading = document.createElement("div");
      heading.className = "screenshot-import-candidate-heading";
      const selected = document.createElement("input");
      selected.type = "checkbox";
      selected.dataset.field = "selected";
      selected.id = `screenshot-import-select-${index}`;
      selected.checked = false;
      const selectLabel = document.createElement("label");
      selectLabel.htmlFor = selected.id;
      selectLabel.textContent = "この予定を登録対象にする（内容を確認済み）";
      heading.append(selected, selectLabel);

      const stateLabel = document.createElement("span");
      stateLabel.className = candidate.needsReview || candidate.confidence < 80 ? "screenshot-import-badge needs-review" : "screenshot-import-badge";
      stateLabel.textContent = candidate.needsReview || candidate.confidence < 80 ? "要確認" : "読取候補・確認必須";

      const title = document.createElement("input");
      title.type = "text"; title.maxLength = 120; title.required = true; title.value = candidate.title || ""; title.dataset.field = "title";
      const date = document.createElement("input");
      date.type = "date"; date.required = true; date.value = candidate.date || ""; date.dataset.field = "date";
      const start = document.createElement("input");
      start.type = "time"; start.value = candidate.start || ""; start.dataset.field = "start";
      const end = document.createElement("input");
      end.type = "time"; end.value = candidate.end || ""; end.dataset.field = "end";
      const allDay = document.createElement("input");
      allDay.type = "checkbox"; allDay.checked = Boolean(candidate.allDay); allDay.dataset.field = "allDay";
      start.disabled = allDay.checked;
      end.disabled = allDay.checked;
      const timeFields = document.createElement("div");
      timeFields.className = "screenshot-import-time-fields";
      timeFields.append(makeLabel("開始", start), makeLabel("終了", end));
      timeFields.hidden = allDay.checked;
      const allDayLabel = document.createElement("label");
      allDayLabel.className = "screenshot-import-all-day";
      allDayLabel.append(allDay, document.createTextNode("終日"));
      const fieldGrid = document.createElement("div");
      fieldGrid.className = "screenshot-import-fields";
      fieldGrid.append(makeLabel("予定名", title), makeLabel("日付", date), timeFields, allDayLabel);
      const meta = document.createElement("p");
      meta.className = "screenshot-import-meta";
      meta.textContent = `OCR信頼度の目安：${Number.isFinite(candidate.confidence) ? candidate.confidence : 0}%`;
      const reasons = document.createElement("p");
      reasons.className = "screenshot-import-reasons";
      reasons.textContent = candidate.reasons?.join("。") || "画像から読んだ内容です。登録前に必ず確認してください。";
      const validation = document.createElement("p");
      validation.className = "screenshot-import-validation";
      validation.dataset.role = "validation";
      validation.setAttribute("role", "status");
      validation.hidden = true;
      const duplicate = document.createElement("p");
      duplicate.className = "screenshot-import-duplicate";
      duplicate.textContent = candidate.duplicate ? "既存予定またはこの画像内の予定と重複する可能性があります。初期選択されていません。" : "";
      duplicate.hidden = !candidate.duplicate;
      card.append(heading, stateLabel, fieldGrid, meta, reasons, validation, duplicate);
      list.append(card);
    });
    refreshRegisterState();
  }

  function refreshDuplicates() {
    const current = getEvents(app.state.events || {});
    const currentCandidates = candidates.map((candidate, index) => {
      const card = list.querySelector(`[data-candidate-index="${index}"]`);
      return card ? { ...candidate, ...eventFromCard(card) } : candidate;
    });
    const updated = markImportDuplicates(currentCandidates, current);
    updated.forEach((next, index) => {
      const card = list.querySelector(`[data-candidate-index="${index}"]`);
      if (!card) return;
      if (next.duplicate && !candidates[index].duplicate) card.querySelector("[data-field=selected]").checked = false;
      candidates[index] = { ...candidates[index], ...eventFromCard(card), duplicate:next.duplicate };
      const notice = card.querySelector(".screenshot-import-duplicate");
      notice.hidden = !next.duplicate;
      notice.textContent = next.duplicate ? "既存予定またはこの画像内の予定と重複する可能性があります。初期選択されていません。選択すると別の予定として追加します。" : "";
    });
    refreshRegisterState();
  }

  function setBusy(value) {
    processing = value;
    progress.hidden = !value;
    cancelOcr.hidden = !value;
    input.disabled = value;
    refreshRegisterState();
  }

  async function terminateWorker() {
    const current = worker;
    worker = null;
    if (current) {
      try { await current.terminate(); } catch { /* Worker resources are always released best-effort. */ }
    }
  }

  async function cancelCurrent(announce = true) {
    runId += 1;
    // Cancellation must release the picker even while createWorker is pending.
    // The late worker is terminated by the runId check in runOcr.
    input.value = "";
    const pendingWorker = worker;
    worker = null;
    if (pendingWorker) {
      try { await pendingWorker.terminate(); } catch { /* Ignore termination races. */ }
    }
    setBusy(false);
    if (announce) setStatus("OCRをキャンセルしました。予定は登録されていません。");
  }

  async function runOcr(file) {
    const currentRun = ++runId;
    await terminateWorker();
    candidates = [];
    list.replaceChildren();
    setStatus("");
    setBusy(true);
    let localWorker = null;
    try {
      await validateImage(file);
      if (currentRun !== runId) return;
      setStatus("この端末内で日本語OCRを準備しています。初回は日本語データの読み込みに時間がかかる場合があります。");
      const tesseract = await import("./vendor/tesseract/tesseract.esm.min.js");
      if (currentRun !== runId) return;
      const { createWorker, OEM, PSM } = tesseract.default;
      const base = new URL("./vendor/tesseract/", import.meta.url);
      localWorker = await createWorker("jpn", OEM.LSTM_ONLY, {
        workerPath:new URL("worker.min.js", base).href,
        langPath:new URL("lang/", base).href,
        // The scalar LSTM build is deliberately selected for iOS/Safari parity
        // and to avoid SIMD feature-detection differences between browsers.
        corePath:new URL("tesseract-core-lstm.wasm.js", base).href,
        gzip:true,
        logger:(entry) => {
          if (currentRun !== runId) return;
          if (entry.status === "loading language traineddata" || entry.status === "initializing api") {
            setStatus("日本語OCRデータを端末内で読み込み中です。");
          } else if (entry.status === "recognizing text") {
            setStatus("画像内の文字を端末内で読み取っています。");
            progress.value = Math.max(0, Math.min(1, Number(entry.progress) || 0));
          }
        },
      });
      if (currentRun !== runId) return;
      worker = localWorker;
      await localWorker.setParameters({ tessedit_pageseg_mode:PSM.SPARSE_TEXT, preserve_interword_spaces:"1" });
      const result = await localWorker.recognize(file, {}, { blocks:true });
      if (currentRun !== runId) return;
      const parsed = extractCalendarCandidates(result.data);
      const sanitized = parsed.candidates.map(({ sourceText, bbox, ...candidate }) => candidate);
      candidates = markImportDuplicates(sanitized, getEvents(app.state.events || {}));
      renderCandidates();
      const summary = ` 要確認 ${candidates.filter(candidate => candidate.needsReview).length}件・除外した行 ${parsed.ignoredLineCount}件。`;
      if (!candidates.length) setStatus(`予定候補0件。${summary}このレイアウトは自動認識できません。予定名と明記された日時が見える予定部分だけを端末内で切り抜いた画像、または予定一覧を選んでください。時刻目盛りから予定時間は推測しません。画像そのものとOCRの生テキストは保存されていません。`, "warning");
      else setStatus(`${candidates.length}件の候補を読み取りました。${summary}初期状態では未選択です。内容を編集・確認し、登録する予定にチェックしてください。`, "info");
    } catch (error) {
      if (currentRun === runId) setStatus(error?.message || "画像を読み取れませんでした。別の画像を選んでください。", "error");
    } finally {
      // A cancelled initialization may finish after the next run has begun.
      // Clean up only this run's worker, never the next run's active worker.
      if (worker === localWorker) worker = null;
      if (localWorker) {
        try { await localWorker.terminate(); } catch { /* Best-effort cleanup. */ }
      }
      if (currentRun === runId) setBusy(false);
    }
  }

  const dialogController = initFormDialog({
    dialog,
    form,
    closeButton:$("screenshot-import-close"),
    fallbackOpener:() => source === "calendar" ? $("open-event-dialog") : $("screenshot-import-open"),
    onClose:() => {
      void cancelCurrent(false);
      candidates = [];
      list.replaceChildren();
      input.value = "";
      progress.value = 0;
      setStatus("");
      setBusy(false);
    },
  });

  dialog.addEventListener("close", () => {
    const completed = pendingCalendarCompletion;
    pendingCalendarCompletion = null;
    if (completed) onCalendarImportComplete?.(completed);
  });

  function formatImportResult(outcome) {
    if (!outcome.queued) {
      return { message:`${outcome.count}件をこの端末の個人予定に追加しました。画像そのものとOCRの生テキストは保存していません。`, kind:"success" };
    }
    if (outcome.pendingCount === 0) {
      return { message:`${outcome.count}件の個人予定を同期先に保存しました。画像そのものとOCRの生テキストは保存していません。`, kind:"success" };
    }
    if (outcome.syncedCount > 0) {
      return { message:`${outcome.syncedCount}件は同期先に保存済み、${outcome.pendingCount}件は同期キューに残っています。同期状態を確認してください。`, kind:"caution" };
    }
    return { message:`${outcome.count}件を同期キューに追加しました。同期状態を確認してください。`, kind:"caution" };
  }

  function open({ source: requestedSource = "profile", trigger = $("screenshot-import-open") } = {}) {
    if (dialog.open) return false;
    source = requestedSource === "calendar" ? "calendar" : "profile";
    setStatus("");
    dialogController.open({ trigger, focus:input });
    return true;
  }

  $("screenshot-import-open").addEventListener("click", (event) => {
    open({ source:"profile", trigger:event.currentTarget });
  });
  $("screenshot-import-cancel").addEventListener("click", () => dialogController.close());
  $("screenshot-import-cancel-ocr").addEventListener("click", () => { void cancelCurrent(); });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    // Retain the picker reference until the browser has finished decoding it.
    // This avoids Safari/WebKit losing the backing file while its OCR worker
    // initializes; clear it afterward so the same image can be selected again.
    if (file) void runOcr(file).finally(() => {
      // An earlier cancelled run must not clear a newly selected image while
      // Safari is decoding that image.
      if (input.files?.[0] === file) input.value = "";
    });
  });
  list.addEventListener("input", (event) => {
    const card = event.target.closest("[data-candidate-index]");
    if (card && event.target.matches("[data-field=allDay]")) {
      card.querySelector(".screenshot-import-time-fields").hidden = event.target.checked;
      card.querySelector("[data-field=start]").disabled = event.target.checked;
      card.querySelector("[data-field=end]").disabled = event.target.checked;
    }
    refreshDuplicates();
  });
  list.addEventListener("change", refreshDuplicates);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    refreshDuplicates();
    const selectedCards = [...list.querySelectorAll("[data-candidate-index]")]
      .filter((card) => card.querySelector("[data-field=selected]").checked);
    const chosen = selectedCards.map((card) => eventFromCard(card));
    if (!chosen.length || chosen.some((item) => !isImportEventReady(item))) {
      setStatus("選択した予定に未確定の項目があります。日付・予定名・開始／終了時刻を確認してください。", "error");
      return;
    }
    const duplicateCount = selectedCards.filter((card) => card.querySelector(".screenshot-import-duplicate").hidden === false).length;
    const confirmation = duplicateCount
      ? `${chosen.length}件を個人予定に追加します。うち${duplicateCount}件は重複候補です。既存予定は変更せず、新しい予定として追加します。よろしいですか？`
      : `${chosen.length}件を個人予定に追加します。内容を確認済みですか？`;
    if (!window.confirm(confirmation)) return;
    submit.disabled = true;
    setStatus("確認した予定を保存しています。");
    try {
      refreshDuplicates();
      const latestChosen = [...list.querySelectorAll("[data-candidate-index]")]
        .filter((card) => card.querySelector("[data-field=selected]").checked)
        .map((card) => eventFromCard(card));
      if (!latestChosen.length || latestChosen.some((item) => !isImportEventReady(item))) {
        throw new Error("保存前の再確認で不完全な予定が見つかりました。内容を確認してください。");
      }
      const outcome = await addEvents(latestChosen);
      const syncActive = Boolean(app.personalSync?.isActive?.());
      if (syncActive) await app.personalSync.sync();
      const pendingCount = syncActive
        ? app.personalSync.pendingEventCount?.(outcome.eventIds) ?? outcome.count
        : 0;
      const result = formatImportResult({
        ...outcome,
        queued:syncActive,
        pendingCount,
        syncedCount:Math.max(0, outcome.count - pendingCount),
      });
      if (source === "calendar") pendingCalendarCompletion = result;
      else {
        resultStatus.textContent = result.message;
        resultStatus.className = result.kind === "caution" ? "status caution" : "status";
        resultStatus.hidden = false;
        resultStatus.dataset.kind = result.kind;
      }
      dialogController.close({ force:true });
    } catch (error) {
      setStatus(error?.message || "保存できませんでした。入力内容は画面に残っています。", "error");
      submit.disabled = false;
    }
  });

  return { open, cancel:cancelCurrent };
}
