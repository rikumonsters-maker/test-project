import { createInviteUrl } from './config.mjs';

const GROUP_ICONS = [
  { id:"friends", label:"\u53cb\u9054", paths:["M8 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM16 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20a5.5 5.5 0 0 1 11 0M10.5 20a5.5 5.5 0 0 1 11 0"] },
  { id:"university", label:"\u5927\u5b66", paths:["m3 9 9-5 9 5-9 5-9-5Z","M5 10.2V18M9.7 12.8V18M14.3 12.8V18M19 10.2V18M3 20h18M5 18h14"] },
  { id:"work", label:"\u30d0\u30a4\u30c8", paths:["M3 8h18v12H3z","M8 8V5h8v3","M3 13h18M10 12v2h4v-2"] },
  { id:"club", label:"\u30b5\u30fc\u30af\u30eb", paths:["M12 3 14.8 8.7 21 9.6l-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"] },
  { id:"game", label:"\u30b2\u30fc\u30e0", paths:["M7 9h10a4 4 0 0 1 3.8 2.8l1.1 3.7a2.5 2.5 0 0 1-4.1 2.5l-2.1-1.8h-3.4l-2.1 1.8a2.5 2.5 0 0 1-4.1-2.5l1.1-3.7A4 4 0 0 1 7 9Z","M8 12v4M6 14h4M16.5 13.2h.01M18.5 15.2h.01"] },
  { id:"food", label:"\u3054\u98ef", paths:["M4 13h16a8 8 0 0 1-16 0Z","M6 13c0-3.3 2.7-6 6-6s6 2.7 6 6","M8 4v3M12 3v3M16 4v3"] },
  { id:"karaoke", label:"\u30ab\u30e9\u30aa\u30b1", paths:["M12 3v11.5a3.5 3.5 0 1 1-2.2-3.3M12 6l7-2v3l-7 2","M16 19c1.2-.5 2-1.2 2-2.2 0-.9-.7-1.4-1.5-1.8"] },
  { id:"bowling", label:"\u30dc\u30a6\u30ea\u30f3\u30b0", paths:["M7 3c-1 2-1 4 0 6l-1 4h4l-1-4c1-2 1-4 0-6ZM14 3c-1 2-1 4 0 6l-1 4h4l-1-4c1-2 1-4 0-6Z","M9 18a3 3 0 1 0 6 0 3 3 0 0 0-6 0ZM11 17.5h.01M13 18.5h.01"] },
  { id:"travel", label:"\u65c5\u884c", paths:["m3 11 18-5-7 13-2.3-5.7L3 11Z","m11.7 13.3 3.8-3.8","M5 7 3.5 5.5M19 18.5l-1.5-1.5"] },
  { id:"sports", label:"\u30b9\u30dd\u30fc\u30c4", paths:["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z","M5.6 5.6c4.6 2.2 7.1 6.2 7.8 12.8M18.4 5.6c-4.6 2.2-7.1 6.2-7.8 12.8M3 12h18"] },
  { id:"study", label:"\u52c9\u5f37", paths:["M3.5 5.5A3.5 3.5 0 0 1 7 4h5v16H7a3.5 3.5 0 0 0-3.5 1V5.5ZM20.5 5.5A3.5 3.5 0 0 0 17 4h-5v16h5a3.5 3.5 0 0 1 3.5 1V5.5Z","M6 8h3M6 11h3M15 8h3M15 11h3"] },
  { id:"other", label:"\u305d\u306e\u4ed6", paths:["M12 3.5 14.4 8.4 19.8 9.2l-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8L12 3.5Z","M12 8v4M12 15h.01"] },
];

const GROUP_ICON_COLORS = [
  { id:"green", label:"\u7dd1" }, { id:"blue", label:"\u9752" }, { id:"lightblue", label:"\u6c34\u8272" },
  { id:"purple", label:"\u7d2b" }, { id:"pink", label:"\u30d4\u30f3\u30af" }, { id:"orange", label:"\u30aa\u30ec\u30f3\u30b8" }, { id:"gray", label:"\u30b0\u30ec\u30fc" },
];
const SVG_NS = "http://www.w3.org/2000/svg";

export function initShared(app) {
  const { $, state, view, parseDate, requestJson, saveState, renderMonthCalendar, changeMonth, dateLabel, QrScanner, qrcode } = app;
  let activeGroupId = null;
  let selectedGroupId = null;
  let managedGroupId = null;
  let selectedIconId = "friends";
  let selectedIconColorId = "green"
  let inviteScanner = null;
  let inviteScanHandled = false;
  let scannerGeneration = 0;
  let eventsByDate = {};
  let loadedMonths = new Set();
  let loadingMonths = new Set();
  let monthPromises = new Map();
  let loadGeneration = 0;
  let syncing = false;
  let convertedWishId = null;
  let selectedWish = null;
  let memberExpiryTimer = null;
  let wishes = [];
  let editingWishId = null;
  let wishRequestId = 0;

  function memberships() {
    return state.groups.filter((group) => group && group.groupId && group.memberId);
  }
  function activeGroup() {
    return memberships().find((group) => group.groupId === activeGroupId) || null;
  }
  function credentials(group) {
    return { groupId:group.groupId };
  }
  function monthKey(month) {
    return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
  }
  function setError(message = "", id = "group-error") {
    const element = $(id);
    element.textContent = message;
    element.hidden = !message;
  }
  function setStatus(message, type = "") {
    const element = $("group-status");
    element.className = `status ${type}`.trim();
    element.textContent = message;
  }
  function resetCache() {
    loadGeneration += 1;
    eventsByDate = {};
    loadedMonths = new Set();
    loadingMonths = new Set();
    monthPromises = new Map();
    if (memberExpiryTimer) clearTimeout(memberExpiryTimer);
    memberExpiryTimer = null;
  }
  function showHome() {
    closeGroupManagement();
    closeStatusInvite();
    closeWishEditor();
    $("group-home").hidden = false;
    $("group-calendar-view").hidden = true;
    activeGroupId = null;
    wishes = [];
    wishRequestId += 1;
    resetCache();
    renderGroups();
  }
  function groupCard(group) {
    const card = document.createElement("article");
    card.className = "card";
    const heading = document.createElement("h3");
    heading.className = "group-name";
    const name = document.createElement("button");
    name.type = "button";
    name.className = "group-name-button";
    const nameText = document.createElement("span");
    nameText.className = "group-name-text";
    nameText.textContent = group.groupName;
    name.append(nameText);
    name.setAttribute("aria-label", `${group.groupName}の共有カレンダーを表示`);
    name.setAttribute("aria-pressed", String(group.groupId === selectedGroupId));
    name.addEventListener("click", () => openCalendar(group.groupId));
    const avatar = groupIcon(group, "group-card-image");
    name.prepend(avatar);
    const manage = document.createElement("button");
    manage.type = "button";
    manage.className = "group-manage-button";
    manage.dataset.groupId = group.groupId;
    manage.textContent = "⋯";
    manage.setAttribute("aria-label", `${group.groupName}の管理`);
    manage.setAttribute("aria-haspopup", "dialog");
    manage.addEventListener("click", () => openGroupManagement(group));
    heading.append(name, manage);
    const member = document.createElement("p");
    member.className = "group-member";
    member.textContent = `${group.memberName} として参加中`;
    const label = document.createElement("label");
    label.textContent = "招待コード";
    const copyField = document.createElement("span");
    copyField.className = "copy-field";
    const code = document.createElement("input");
    code.type = "text";
    code.readOnly = true;
    code.value = group.inviteCode || "";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "action-button";
    copy.textContent = "コピー";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.value);
        setStatus("招待コードをコピーしました。", "safe");
      } catch {
        code.select();
        setStatus("招待コードを選択しました。コピーしてください。", "caution");
      }
    });
    copyField.append(code, copy);
    label.append(copyField);
    const showQr = document.createElement("button");
    showQr.type = "button";
    showQr.className = "action-button qr-show-button";
    showQr.textContent = "QRコードを表示";
    showQr.disabled = !group.inviteCode;
    showQr.addEventListener("click", () => showInviteQr(group));
    card.append(heading, member, label, showQr);
    return card;
  }
  function openGroupManagement(group) {
    managedGroupId = group.groupId;
    $("group-manage-name").textContent = group.groupName;
    setRenameMode(false);
    closeIconPicker();
    setError("", "group-icon-error");
    $("group-icon-status").hidden = true;
    setImageBusy(false);
    $("group-manage-dialog").showModal();
  }
  function closeGroupManagement() {
    const dialog = $("group-manage-dialog");
    if (dialog.open) dialog.close();
  }
  function setImageBusy(busy) {
    ["group-rename-open", "group-rename-save", "group-rename-cancel", "group-icon-change", "group-icon-save", "group-icon-cancel", "group-manage-leave"].forEach(id => { $(id).disabled = busy; });
    document.querySelectorAll("#group-icon-options button, #group-icon-colors button").forEach(button => { button.disabled = busy; });
  }
  function createGroupIconSvg(iconId, className = "") {
    const icon = GROUP_ICONS.find(item => item.id === iconId) || GROUP_ICONS.find(item => item.id === "friends");
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    for (const d of icon.paths) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }
  function groupIcon(group, className = "") {
    const icon = document.createElement("span");
    icon.className = "group-icon " + className;
    icon.dataset.iconColor = group.groupIconColor || "green";
    icon.dataset.iconId = group.groupIcon || "friends";
    icon.setAttribute("aria-hidden", "true");
    icon.append(createGroupIconSvg(group.groupIcon || "friends", "group-icon-svg"));
    return icon;
  }
  function updateGroupIcon(group) {
    $("group-calendar-icon").replaceWith(Object.assign(groupIcon(group), { id:"group-calendar-icon" }));
  }
  function openIconPicker() {
    const group = memberships().find(item => item.groupId === managedGroupId);
    if (!group) return;
    selectedIconId = GROUP_ICONS.some(item => item.id === group.groupIcon) ? group.groupIcon : "friends";
    selectedIconColorId = GROUP_ICON_COLORS.some(item => item.id === group.groupIconColor) ? group.groupIconColor : "green";
    $("group-manage-actions").hidden = true;
    $("group-icon-picker").hidden = false;
    setError("", "group-icon-error");
    $("group-icon-status").hidden = true;
    renderIconPicker();
    $("group-icon-options").querySelector(`[data-icon-id="${selectedIconId}"]`)?.focus({ preventScroll:true });
  }
  function closeIconPicker(restoreFocus = false) {
    const picker = $("group-icon-picker");
    if (!picker) return;
    picker.hidden = true;
    if ($("group-manage-actions")) $("group-manage-actions").hidden = false;
    if (restoreFocus && $("group-manage-dialog").open) $("group-icon-change").focus({ preventScroll:true });
  }
  function renderIconPicker() {
    const icons = $("group-icon-options");
    icons.replaceChildren();
    for (const item of GROUP_ICONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "group-icon-option";
      button.dataset.iconId = item.id;
      button.setAttribute("aria-pressed", String(item.id === selectedIconId));
      button.setAttribute("aria-label", item.label);
      const preview = document.createElement("span");
      preview.className = "group-icon group-icon-picker-preview";
      preview.dataset.iconColor = selectedIconColorId;
      preview.append(createGroupIconSvg(item.id, "group-icon-svg"));
      const label = document.createElement("span");
      label.textContent = item.label;
      button.append(preview, label);
      button.addEventListener("click", () => {
        selectedIconId = item.id;
        for (const option of icons.querySelectorAll("[data-icon-id]")) option.setAttribute("aria-pressed", String(option.dataset.iconId === selectedIconId));
      });
      icons.append(button);
    }
    const colors = $("group-icon-colors");
    colors.replaceChildren();
    for (const item of GROUP_ICON_COLORS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "group-icon-color-option";
      button.dataset.iconColor = item.id;
      button.setAttribute("aria-label", item.label);
      button.setAttribute("aria-pressed", String(item.id === selectedIconColorId));
      const swatch = document.createElement("span");
      swatch.className = "group-icon-color-swatch";
      swatch.dataset.iconColor = item.id;
      swatch.setAttribute("aria-hidden", "true");
      button.append(swatch);
      button.addEventListener("click", () => {
        selectedIconColorId = item.id;
        for (const option of colors.querySelectorAll("button[data-icon-color]")) option.setAttribute("aria-pressed", String(option.dataset.iconColor === selectedIconColorId));
        for (const preview of icons.querySelectorAll(".group-icon-picker-preview")) preview.dataset.iconColor = selectedIconColorId;
      });
      colors.append(button);
    }
  }
  async function saveGroupIcon() {
    const group = memberships().find(item => item.groupId === managedGroupId);
    if (!group) return;
    setError("", "group-icon-error");
    $("group-icon-status").hidden = true;
    setImageBusy(true);
    try {
      const result = await requestJson("/api/groups/icon", { payload:{ groupId:group.groupId, groupIcon:selectedIconId, groupIconColor:selectedIconColorId } });
      group.groupIcon = result.groupIcon;
      group.groupIconColor = result.groupIconColor;
      saveState();
      renderGroups();
      if (activeGroupId === group.groupId) updateGroupIcon(group);
      closeIconPicker(true);
      $("group-icon-status").textContent = "グループアイコンを保存しました。";
      $("group-icon-status").hidden = false;
    } catch (error) {
      setError(error.message || "グループアイコンを保存できませんでした。", "group-icon-error");
    } finally { setImageBusy(false); }
  }
  function showInviteQr(group) {
    const url = createInviteUrl(group.inviteCode);
    const qr = qrcode(0, "M");
    qr.addData(url.href);
    qr.make();
    $("group-invite-qr-name").textContent = group.groupName;
    $("group-invite-qr-image").src = qr.createDataURL(6, 8);
    $("group-invite-qr-url").textContent = url.href;
    const dialog = $("group-invite-qr-dialog");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }
  function closeInviteQr() {
    const dialog = $("group-invite-qr-dialog");
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
  }
  function inviteCodeFromQr(value) {
    try {
      const url = new URL(value, window.location.origin);
      return url.searchParams.get("invite")?.trim().slice(0, 40) || null;
    } catch {
      return null;
    }
  }
  function stopInviteScanner(hidePanel = true) {
    scannerGeneration += 1;
    if (inviteScanner) {
      inviteScanner.destroy();
      inviteScanner = null;
    }
    const video = $("invite-qr-video");
    if (video.srcObject) {
      video.srcObject.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    }
    $("open-invite-qr-scanner").disabled = false;
    if (hidePanel) $("invite-qr-scanner").hidden = true;
  }
  function scannerErrorMessage(error) {
    const detail = `${error.name || ""} ${error.message || ""}`;
    if (/NotAllowedError|PermissionDeniedError|permission denied/i.test(detail)) return "カメラへのアクセスが許可されませんでした。ブラウザーの設定を確認してください。";
    if (/NotFoundError|camera not found|no camera/i.test(detail)) return "利用できるカメラが見つかりません。招待コードを入力してください。";
    if (!window.isSecureContext) return "QR読み取りにはHTTPS接続が必要です。招待コードを入力してください。";
    return error.message || "カメラを起動できませんでした。招待コードを入力してください。";
  }
  async function startInviteScanner() {
    const generation = ++scannerGeneration;
    const panel = $("invite-qr-scanner");
    const error = $("invite-qr-error");
    const video = $("invite-qr-video");
    $("open-invite-qr-scanner").disabled = true;
    panel.hidden = false;
    error.hidden = true;
    error.textContent = "";
    inviteScanHandled = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      error.textContent = "この環境ではカメラを利用できません。招待コードを入力してください。";
      error.hidden = false;
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio:false, video:{ facingMode:{ ideal:"environment" } } });
      if (generation !== scannerGeneration) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      video.srcObject = stream;
      inviteScanner = new QrScanner(video, (result) => {
        if (inviteScanHandled) return;
        const inviteCode = inviteCodeFromQr(result.data);
        if (!inviteCode) {
          error.textContent = "招待コードを含むQRコードを読み取ってください。";
          error.hidden = false;
          return;
        }
        inviteScanHandled = true;
        $("group-invite-code").value = inviteCode;
        stopInviteScanner();
        if (window.confirm("このグループに参加しますか？")) $("join-group-form").requestSubmit();
      }, { returnDetailedScanResult:true, maxScansPerSecond:12 });
      await inviteScanner.start();
    } catch (cameraError) {
      if (generation !== scannerGeneration) return;
      stopInviteScanner(false);
      error.textContent = scannerErrorMessage(cameraError);
      error.hidden = false;
    }
  }
  function renderGroups() {
    const list = $("group-list");
    list.replaceChildren();
    const groups = memberships();
    if (!groups.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state card";
      empty.textContent = "参加中のグループはありません。";
      list.append(empty);
    } else {
      groups.forEach((group) => list.append(groupCard(group)));
    }
  }
  function setRenameMode(editing) {
    $("group-manage-actions").hidden = editing;
    $("group-rename-form").hidden = !editing;
    setError("", "group-rename-error");
    if (editing) {
      const group = memberships().find(item => item.groupId === managedGroupId);
      if (!group) return;
      $("group-rename-input").value = group.groupName;
      $("group-rename-input").focus({ preventScroll:true });
    }
  }
  async function saveGroupName(event) {
    event.preventDefault();
    const group = memberships().find(item => item.groupId === managedGroupId);
    if (!group) return;
    const name = $("group-rename-input").value.trim();
    if (!name) return setError("グループ名を入力してください。", "group-rename-error");
    if (name.length > 60) return setError("グループ名は60文字以内で入力してください。", "group-rename-error");
    setImageBusy(true);
    try {
      const result = await requestJson("/api/groups/rename", { payload:{ groupId:group.groupId, name } });
      group.groupName = result.groupName || name;
      renderGroups();
      if (selectedGroupId === group.groupId) $("group-calendar-name").textContent = group.groupName;
      $("group-manage-name").textContent = group.groupName;
      setRenameMode(false);
      $("group-icon-status").textContent = "グループ名を変更しました。";
      $("group-icon-status").hidden = false;
    } catch {
      setError("グループ名を変更できませんでした。", "group-rename-error");
    } finally { setImageBusy(false); }
  }
  function appendEmptyState(container, text) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = text;
    container.append(empty);
  }
  function wishesForDate(key) {
    return wishes.filter((wish) => wish.wishDate === key);
  }
  function wishTime(wish) {
    return wish.isAllDay ? "終日・時間未定" : `${wish.start}〜${wish.end || ""}`;
  }
  function closeWishEditor() {
    const dialog = $("group-wish-dialog");
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
    editingWishId = null;
  }
  function openWishEditor(wish = null) {
    editingWishId = wish?.id || null;
    $("group-wish-title").textContent = wish ? "遊びたい日を編集" : "遊びたい日を追加";
    $("group-wish-date").value = wish?.wishDate || view.groupDate;
    $("group-wish-all-day").checked = wish?.isAllDay ?? true;
    $("group-wish-start").value = wish?.start || "";
    $("group-wish-end").value = wish?.end || "";
    $("group-wish-message").value = wish?.message || "";
    updateWishTimeState();
    setError("", "group-wish-form-error");
    const dialog = $("group-wish-dialog");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }
  function updateWishTimeState() {
    const allDay = $("group-wish-all-day").checked;
    $("group-wish-times").hidden = allDay;
    $("group-wish-start").required = !allDay;
  }
  function renderWishes() {
    const list = $("group-wishes-list");
    list.replaceChildren();
    if (!wishes.length) return appendEmptyState(list, "まだ遊びたい日の投稿はありません。");
    for (const wish of wishes) {
      const card = document.createElement("div");
      card.className = "group-wish-card";
      const header = document.createElement("div");
      header.className = "group-wish-header";
      const date = document.createElement("strong");
      date.textContent = `${wish.wishDate.slice(5).replace("-", "/")} ${wishTime(wish)}`;
      const identity = document.createElement("span");
      identity.className = "group-wish-owner";
      const icon = document.createElement("span");
      icon.className = "group-member-icon";
      icon.textContent = wish.ownerIcon || "🌿";
      icon.setAttribute("aria-hidden", "true");
      identity.append(icon, document.createTextNode(wish.ownerName));
      header.append(date, identity);
      card.append(header);
      if (wish.message) {
        const message = document.createElement("p");
        message.className = "group-wish-message";
        message.textContent = `「${wish.message}」`;
        card.append(message);
      }
      const people = document.createElement("div");
      people.className = "group-wish-people";
      people.setAttribute("aria-label", "行きたい人");
      const interested = wish.interestedUsers || [];
      people.title = interested.map((person) => person.displayName).join("、");
      for (const person of interested.slice(0, 3)) {
        const chip = document.createElement("span");
        chip.className = "group-wish-person";
        const icon = document.createElement("span");
        icon.className = "group-wish-person-icon";
        icon.textContent = person.profileIcon || "🌿";
        icon.setAttribute("aria-hidden", "true");
        chip.append(icon, document.createTextNode(person.displayName));
        people.append(chip);
      }
      const summary = document.createElement("span");
      summary.className = "group-wish-count";
      summary.textContent = interested.length > 3 ? `ほか${interested.length - 3}人が行きたい` : interested.length ? "が行きたい" : "まだ反応はありません";
      people.append(summary);
      card.append(people);
      const status = document.createElement("div");
      status.className = "group-wish-state-row";
      const badge = document.createElement("span");
      badge.className = `group-state-label ${wish.eventStatus === "confirmed" ? "is-confirmed" : wish.eventStatus === "tentative" ? "is-tentative" : "is-pending"}`;
      badge.textContent = wish.eventStatus === "confirmed" ? "確定" : wish.eventStatus === "tentative" ? "仮予定" : "調整中";
      status.append(badge);
      if (wish.eventStatus === "tentative" && wish.participantsInsufficient) {
        const note = document.createElement("span");
        note.className = "group-wish-count";
        note.textContent = "参加者不足";
        status.append(note);
      }
      card.append(status);
      const actions = document.createElement("div");
      actions.className = "group-wish-actions";
      if (wish.isOwn) {
        if (wish.eventStatus === "tentative" && !wish.participantsInsufficient) {
          const convert = document.createElement("button");
          convert.type = "button";
          convert.className = "action-button";
          convert.textContent = "共有予定にする";
          convert.addEventListener("click", () => openWishConversion(wish));
          actions.append(convert);
        }
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "action-button";
        edit.textContent = "編集";
        edit.addEventListener("click", () => openWishEditor(wish));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "action-button danger";
        remove.textContent = "削除";
        remove.addEventListener("click", () => void deleteWish(wish));
        actions.append(edit, remove);
      } else {
        const react = document.createElement("button");
        react.type = "button";
        react.className = `action-button ${wish.reacted ? "wish-reacted" : ""}`;
        react.textContent = wish.reacted ? "✓ 行きたい" : "行きたい";
        react.setAttribute("aria-label", wish.reacted ? "行きたいの反応を解除" : "私も行きたい");
        react.title = wish.reacted ? "クリックで反応を解除" : "私も行きたい";
        react.setAttribute("aria-pressed", String(wish.reacted));
        react.addEventListener("click", () => void toggleWishReaction(wish, react));
        actions.append(react);
      }
      if (wish.interestedUsers?.length) {
        const availability = document.createElement("button");
        availability.type = "button";
        availability.className = "action-button";
        availability.textContent = "空き時間";
        availability.addEventListener("click", () => openWishConversion(wish, true));
        actions.append(availability);
      }
      card.append(actions);
      list.append(card);
    }
  }
  async function loadWishes() {
    const group = activeGroup();
    if (!group) return;
    const ticket = ++wishRequestId;
    try {
      const data = await requestJson("/api/groups/wishes/list", { payload:credentials(group) });
      if (ticket !== wishRequestId || activeGroupId !== group.groupId) return;
      wishes = data.wishes || [];
      setError("", "group-wishes-error");
      renderWishes();
      renderCalendar();
    } catch (error) {
      if (ticket === wishRequestId && activeGroupId === group.groupId) setError(error.message || "遊びたい日を読み込めませんでした。", "group-wishes-error");
    }
  }
  async function toggleWishReaction(wish, button) {
    const group = activeGroup();
    if (!group) return;
    button.disabled = true;
    try {
      await requestJson(wish.reacted ? "/api/groups/wishes/unreact" : "/api/groups/wishes/react", {
        payload:{ ...credentials(group), wishId:wish.id },
      });
      await Promise.all([loadWishes(), refreshCurrentMonth()]);
    } catch (error) { setError(error.message || "反応を変更できませんでした。", "group-wishes-error"); }
    finally { button.disabled = false; }
  }
  async function deleteWish(wish) {
    const group = activeGroup();
    if (!group || !window.confirm("この遊びたい日を削除しますか？")) return;
    try {
      await requestJson("/api/groups/wishes/delete", { payload:{ ...credentials(group), wishId:wish.id } });
      await Promise.all([loadWishes(), refreshCurrentMonth()]);
    } catch (error) { setError(error.message || "遊びたい日を削除できませんでした。", "group-wishes-error"); }
  }
  function eventsForDate(key) {
    return Array.isArray(eventsByDate[key]) ? eventsByDate[key] : [];
  }
  async function loadMonth(month = view.groupMonth) {
    const group = activeGroup();
    if (!group) return;
    const key = monthKey(month);
    if (loadedMonths.has(key)) return;
    if (loadingMonths.has(key)) return monthPromises.get(key);
    const generation = loadGeneration;
    const promises = monthPromises;
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    promises.set(key, done);
    loadingMonths.add(key);
    renderSelectedDate();
    try {
      const data = await requestJson("/api/shared/events/list", { payload:{ ...credentials(group), month:key } });
      if (generation !== loadGeneration || activeGroupId !== group.groupId) return;
      for (const event of data.events || []) {
        (eventsByDate[event.eventDate] ||= []).push(event);
      }
      loadedMonths.add(key);
      setError("", "group-calendar-error");
      renderCalendar();
    } catch (error) {
      if (generation === loadGeneration) setError(`共有予定を読み込めませんでした。${error.message}`, "group-calendar-error");
    } finally {
      if (generation === loadGeneration) {
        loadingMonths.delete(key);
        renderSelectedDate();
      }
      promises.delete(key);
      resolveDone();
    }
  }
  async function loadGroupMembers(group) {
    const container = $("group-members");
    const generation = loadGeneration;
    if (memberExpiryTimer) clearTimeout(memberExpiryTimer);
    memberExpiryTimer = null;
    container.replaceChildren();
    appendEmptyState(container, "メンバーを読み込んでいます…");
    setError("", "group-members-error");
    try {
      const data = await requestJson("/api/groups/members/list", { payload:credentials(group) });
      if (generation !== loadGeneration || activeGroupId !== group.groupId) return;
      container.replaceChildren();
      const statusList = $("group-status-list");
      statusList.replaceChildren();
      const now = Date.now();
      let nextExpiry = Infinity;
      for (const member of data.members || []) {
        const item = document.createElement("li");
        const identity = document.createElement("div");
        identity.className = "group-member-identity";
        const icon = document.createElement("span");
        icon.className = "group-member-icon";
        icon.textContent = member.profileIcon || "🌿";
        icon.setAttribute("aria-hidden", "true");
        const name = document.createElement("strong");
        name.textContent = `${member.memberName}${member.memberId === group.memberId ? "（あなた）" : ""}`;
        identity.append(icon, name);
        item.append(identity);
        const expiry = Date.parse(member.statusExpiresAt || "");
        if (member.statusMessage && expiry > now) {
          const message = document.createElement("p");
          message.className = "member-status-message";
          message.textContent = `「${member.statusMessage}」`;
          item.append(message);
          const statusCard = document.createElement("div");
          statusCard.className = "group-status-card";
          statusCard.append(identity.cloneNode(true), message.cloneNode(true));
          statusList.append(statusCard);
          nextExpiry = Math.min(nextExpiry, expiry);
        }
        container.append(item);
      }
      $("group-status-section").hidden = !statusList.childElementCount;
      if (Number.isFinite(nextExpiry)) memberExpiryTimer = setTimeout(() => {
        if (activeGroupId === group.groupId) void loadGroupMembers(group);
      }, Math.max(1, nextExpiry - Date.now() + 20));
      if (!container.childElementCount) appendEmptyState(container, "メンバー情報がありません。");
    } catch (error) {
      if (generation === loadGeneration && activeGroupId === group.groupId) {
        container.replaceChildren();
        $("group-status-section").hidden = true;
        setError(error.message || "メンバー情報を読み込めませんでした。", "group-members-error");
      }
    }
  }
  function showInviteStep(step) {
    $("group-status-invite-actions").hidden = step !== "actions";
    $("group-status-event-form").hidden = step !== "event";
    $("group-status-availability-view").hidden = step !== "availability";
    setError("", "group-status-invite-error");
  }
  function updateEventTimeState() {
    const allDay = $("group-status-event-all-day").checked;
    $("group-status-event-times").hidden = allDay;
    $("group-status-event-start").required = !allDay;
    $("group-status-event-end").required = !allDay;
  }
  function openWishConversion(wish, availabilityOnly = false) {
    selectedWish = wish;
    convertedWishId = wish.id;
    $("group-status-invite-title").textContent = "共有予定にする";
    $("group-status-invite-message").textContent = `${wish.ownerName}さんの遊びたい日：${wish.wishDate}${wish.message ? `「${wish.message}」` : ""}`;
    $("group-status-event-title").value = wish.message || "みんなで遊ぶ";
    $("group-status-event-date").value = wish.wishDate;
    $("group-status-event-all-day").checked = wish.isAllDay;
    $("group-status-event-start").value = wish.start;
    $("group-status-event-end").value = wish.end;
    $("group-status-availability-date").value = wish.wishDate;
    const choices = $("group-status-event-participants");
    choices.replaceChildren();
    const legend = document.createElement("legend");
    legend.textContent = "参加者";
    choices.append(legend);
    const memberSelect = $("group-status-availability-member");
    memberSelect.replaceChildren();
    for (const person of wish.interestedUsers || []) {
      const label = document.createElement("label");
      label.className = "participant-choice";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = person.userId;
      checkbox.checked = true;
      checkbox.disabled = person.userId === wish.userId;
      label.append(checkbox, document.createTextNode(person.displayName));
      choices.append(label);
      const option = document.createElement("option");
      option.value = person.userId;
      option.textContent = person.displayName;
      memberSelect.append(option);
    }
    updateEventTimeState();
    $("group-status-create").hidden = !wish.isOwn || wish.eventStatus !== "tentative" || wish.participantsInsufficient;
    showInviteStep(availabilityOnly ? "availability" : "actions");
    const dialog = $("group-status-invite-dialog");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    if (availabilityOnly) void renderAvailability();
  }
  function closeStatusInvite() {
    const dialog = $("group-status-invite-dialog");
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
    selectedWish = null;
    convertedWishId = null;
  }
  async function renderAvailability() {
    const group = activeGroup();
    const wish = selectedWish;
    const date = $("group-status-availability-date").value;
    const userId = $("group-status-availability-member").value;
    const list = $("group-status-busy-list");
    list.replaceChildren();
    if (!group || !wish || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !userId) return;
    appendEmptyState(list, "空き時間を読み込んでいます…");
    try {
      const data = await requestJson("/api/shared/availability", { payload:{ ...credentials(group), date, userId } });
      if (activeGroupId !== group.groupId || selectedWish !== wish) return;
      list.replaceChildren();
      const heading = document.createElement("strong");
      heading.textContent = "空いている時間（9:00〜22:00）";
      list.append(heading);
      if (!data.free?.length) appendEmptyState(list, "空いている時間は見つかりませんでした。");
      for (const slot of data.free || []) {
        const row = document.createElement("p");
        row.className = "availability-entry";
        row.textContent = `${slot.start}〜${slot.end} 空き`;
        list.append(row);
      }
      for (const slot of data.busy || []) {
        const row = document.createElement("p");
        row.className = "availability-entry";
        row.textContent = `${slot.start}〜${slot.end} 予定あり`;
        list.append(row);
      }
    } catch (error) {
      list.replaceChildren();
      appendEmptyState(list, error.message || "空き時間を読み込めませんでした。");
    }
  }
  function renderCalendar() {
    if (!activeGroup() || $("group-calendar-view").hidden) return;
    void loadMonth(view.groupMonth);
    renderMonthCalendar({
      calendarId:"group-calendar",
      month:view.groupMonth,
      selectedDate:view.groupDate,
      getEntries:(key) => [
        ...eventsForDate(key).map((event) => ({
          type:event.sourceType === "busy" ? "busy" : event.sourceType === "shift" ? "shift" : event.status === "tentative" ? "tentative" : "event",
          label:event.sourceType === "busy" ? `${event.allDay ? "終日" : `${event.start}〜${event.end}`} 予定あり` :
            `${event.createdByName} ${event.status === "tentative" ? "仮予定" : event.allDay ? "終日" : `${event.start}-${event.end}`}`,
          ariaLabel:event.sourceType === "busy" ? `予定あり ${event.allDay ? "終日" : `${event.start}-${event.end}`}` :
            `${event.createdByName} ${event.status === "tentative" ? "仮予定 " : ""}${event.sourceType === "shift" ? "シフト" : event.title} ${event.allDay ? "終日" : `${event.start}-${event.end}`}`,
        })),
        ...wishesForDate(key).filter((wish) => !wish.eventStatus).map((wish) => ({
          type:"wish", label:`✦ ${wish.ownerName} ${wish.isAllDay ? "終日" : `${wish.start}〜`} 遊びたい`,
        })),
      ],
      maxEntries:3,
      onSelect:(key, date) => {
        view.groupDate = key;
        if (date.getMonth() !== view.groupMonth.getMonth() || date.getFullYear() !== view.groupMonth.getFullYear()) {
          view.groupMonth = new Date(date.getFullYear(), date.getMonth(), 1);
        }
        renderCalendar();
      },
    });
    renderSelectedDate();
  }
  function renderSelectedDate() {
    const container = $("group-shared-events");
    container.replaceChildren();
    $("group-date").textContent = dateLabel.format(parseDate(view.groupDate));
    const events = eventsForDate(view.groupDate);
    const pendingWishes = wishesForDate(view.groupDate).filter((wish) => !wish.eventStatus);
    if (!events.length && !pendingWishes.length) appendEmptyState(container, loadingMonths.has(monthKey(view.groupMonth)) ? "共有予定を読み込んでいます…" : "この日の共有予定はありません。");
    const sections = [
      { title:"共有予定", matches:event => event.sourceType !== "busy" && event.sourceType !== "shift" && event.status !== "tentative" },
      { title:"仮予定", matches:event => event.sourceType !== "busy" && event.sourceType !== "shift" && event.status === "tentative" },
      { title:"シフト", matches:event => event.sourceType === "shift" },
      { title:"予定あり", matches:event => event.sourceType === "busy" },
    ];
    for (const section of sections) {
      const entries = events.filter(section.matches);
      if (!entries.length) continue;
      const heading = document.createElement("h4");
      heading.className = "group-detail-title";
      heading.textContent = section.title;
      container.append(heading);
      for (const event of entries) {
        const item = document.createElement("div");
        item.className = `agenda-item ${event.sourceType === "busy" ? "agenda-busy" : event.sourceType === "shift" ? "agenda-shift" : event.status === "tentative" ? "agenda-tentative" : "agenda-shared"}`;
        const details = document.createElement("div");
        details.className = "agenda-event-details";
        const title = document.createElement("strong");
        title.textContent = event.sourceType === "shift" ? "シフト" : event.sourceType === "busy" ? "予定あり" : event.title;
        const time = document.createElement("span");
        time.textContent = event.allDay ? "終日" : `${event.start}-${event.end}`;
        const author = document.createElement("span");
        author.className = "agenda-event-note";
        if (event.sourceType !== "busy") author.textContent = `${event.createdByName}の${event.sourceType === "shift" ? "シフト" : event.sourceType === "personal" ? "個人予定" : "共有予定"}`;
        details.append(title, time);
        if (event.sourceType !== "busy") details.append(author);
        if (event.note && event.sourceType !== "busy") {
          const note = document.createElement("span");
          note.className = "agenda-event-note";
          note.textContent = event.note;
          details.append(note);
        }
        item.append(details);
        container.append(item);
      }
    }
    if (pendingWishes.length) {
      const heading = document.createElement("h4");
      heading.className = "group-detail-title";
      heading.textContent = "遊びたい日";
      container.append(heading);
      for (const wish of pendingWishes) {
        const item = document.createElement("div");
        item.className = "agenda-item agenda-tentative";
        const details = document.createElement("div");
        details.className = "agenda-event-details";
        const title = document.createElement("strong");
        title.textContent = wish.message || "遊びたい日";
        const time = document.createElement("span");
        time.textContent = `${wish.ownerName}・${wishTime(wish)}`;
        details.append(title, time);
        item.append(details);
        container.append(item);
      }
    }
  }
  async function refreshCurrentMonth() {
    if (!activeGroup()) return;
    resetCache();
    renderCalendar();
  }
  function openCalendar(groupId) {
    const group = memberships().find((item) => item.groupId === groupId);
    if (!group) return;
    activeGroupId = groupId;
    selectedGroupId = groupId;
    resetCache();
    wishes = [];
    renderWishes();
    $("group-calendar-name").textContent = group.groupName;
    updateGroupIcon(group);
    $("group-home").hidden = true;
    $("group-calendar-view").hidden = false;
    setError("", "group-calendar-error");
    $("group-calendar-status").hidden = true;
    renderCalendar();
    void loadGroupMembers(group);
    void loadWishes();
    window.scrollTo({ top:0, behavior:"instant" });
  }
  function monthsWithData() {
    const months = new Set();
    for (const key of [...Object.keys(state.shifts), ...Object.keys(state.events)]) {
      if (/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(key)) months.add(key.slice(0, 7));
    }
    return [...months];
  }
  function entriesForMonth(month) {
    const validTime = (value) => typeof value === "string" && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
    const entries = [];
    for (const [key, shift] of Object.entries(state.shifts)) {
      if (!key.startsWith(`${month}-`) || !shift || !validTime(shift.start) || !validTime(shift.end)) continue;
      entries.push({ sourceType:"shift", sourceId:key, eventDate:key, title:"シフト", start:shift.start, end:shift.end, allDay:false, note:"" });
    }
    for (const [key, events] of Object.entries(state.events)) {
      if (!key.startsWith(`${month}-`) || !Array.isArray(events)) continue;
      events.forEach((event, index) => {
        if (!event || typeof event.title !== "string" || !event.title.trim() || (!event.allDay && (!validTime(event.start) || !validTime(event.end)))) return;
        entries.push({ sourceType:"personal", sourceId:String(event.id || `${key}-${index}`), eventDate:key, title:event.title.slice(0, 80), start:event.allDay ? "" : event.start, end:event.allDay ? "" : event.end, allDay:Boolean(event.allDay), note:String(event.note || "").slice(0, 160) });
      });
    }
    return entries;
  }
  function markDirty(month) {
    for (const group of memberships()) {
      const pending = (state.pendingGroupMonths[group.groupId] ||= {});
      pending[month] = (Number(pending[month]) || 0) + 1;
    }
    saveState();
    void flushPending();
  }
  async function flushPending() {
    if (syncing) return;
    syncing = true;
    let failed = false;
    try {
      while (true) {
        const group = memberships().find((item) => Object.keys(state.pendingGroupMonths[item.groupId] || {}).length);
        if (!group) break;
        const [month, revision] = Object.entries(state.pendingGroupMonths[group.groupId])[0];
        try {
          await requestJson("/api/shared/calendar/sync", { payload:{ ...credentials(group), month, entries:entriesForMonth(month) } });
          if (state.pendingGroupMonths[group.groupId]?.[month] === revision) delete state.pendingGroupMonths[group.groupId][month];
          saveState();
          if (activeGroupId === group.groupId && month === monthKey(view.groupMonth)) void refreshCurrentMonth();
          setStatus("シフトと個人予定は参加中のグループへ自動共有されます。", "safe");
        } catch (error) {
          setStatus(`予定を同期できませんでした。次回起動時に再試行します。${error.message}`, "error");
          failed = true;
          break;
        }
      }
    } finally {
      syncing = false;
      if (!failed && memberships().some((group) => Object.keys(state.pendingGroupMonths[group.groupId] || {}).length)) void flushPending();
    }
  }
  async function submitGroup(event, path, fields) {
    event.preventDefault();
    setError();
    const payload = fields();
    if (path.endsWith("/join") && memberships().some((group) => group.inviteCode === payload.inviteCode)) {
      setError("このグループにはすでに参加しています。");
      return;
    }
    try {
      const data = await requestJson(path, { payload });
      state.groups.push(data.membership);
      const pending = (state.pendingGroupMonths[data.membership.groupId] ||= {});
      for (const month of monthsWithData()) pending[month] = 1;
      saveState();
      renderGroups();
      setStatus(`${data.membership.groupName}に参加しました。`, "safe");
      void flushPending();
    } catch (error) {
      setError(error.message || "グループを設定できませんでした。");
    }
  }
  async function leaveGroup(group) {
    if (!window.confirm(`${group.groupName}から退出しますか？共有済みのあなたの予定もグループから削除されます。`)) return;
    setError("", "group-icon-error");
    setImageBusy(true);
    try {
      await requestJson("/api/groups/leave", { payload:credentials(group) });
      state.groups = state.groups.filter((item) => item.groupId !== group.groupId);
      delete state.pendingGroupMonths[group.groupId];
      saveState();
      closeGroupManagement();
      renderGroups();
      setStatus(`${group.groupName}から退出しました。`, "safe");
    } catch (error) {
      setError(error.message || "グループから退出できませんでした。", managedGroupId === group.groupId ? "group-icon-error" : "group-error");
    } finally { if (managedGroupId === group.groupId) setImageBusy(false); }
  }
  function init() {
    $("create-group-form").addEventListener("submit", (event) => void submitGroup(event, "/api/groups/create", () => ({ name:$("group-name").value.trim(), memberName:$("group-member-name").value.trim() })));
    $("join-group-form").addEventListener("submit", (event) => void submitGroup(event, "/api/groups/join", () => ({ inviteCode:$("group-invite-code").value.trim().toUpperCase(), memberName:$("join-member-name").value.trim() })));
    $("back-to-groups").addEventListener("click", showHome);
    $("group-previous").addEventListener("click", () => { view.groupMonth = changeMonth(view.groupMonth, -1); view.groupDate = app.dateKey(view.groupMonth); renderCalendar(); });
    $("group-next").addEventListener("click", () => { view.groupMonth = changeMonth(view.groupMonth, 1); view.groupDate = app.dateKey(view.groupMonth); renderCalendar(); });
    $("refresh-group-events").addEventListener("click", () => {
      void refreshCurrentMonth();
      if (activeGroup()) { void loadGroupMembers(activeGroup()); void loadWishes(); }
    });
    $("add-group-wish").addEventListener("click", () => openWishEditor());
    $("group-icon-change").addEventListener("click", openIconPicker);
    $("group-icon-save").addEventListener("click", () => void saveGroupIcon());
    $("group-icon-cancel").addEventListener("click", () => closeIconPicker(true));
    $("group-rename-open").addEventListener("click", () => setRenameMode(true));
    $("group-rename-form").addEventListener("submit", event => void saveGroupName(event));
    $("group-rename-cancel").addEventListener("click", () => setRenameMode(false));
    $("close-group-manage").addEventListener("click", closeGroupManagement);
    $("group-manage-dialog").addEventListener("click", (event) => {
      if (event.target === $("group-manage-dialog")) closeGroupManagement();
    });
    $("group-manage-dialog").addEventListener("close", () => {
      const opener = [...document.querySelectorAll(".group-manage-button")].find(button => button.dataset.groupId === managedGroupId);
      setRenameMode(false);
      closeIconPicker();
      managedGroupId = null;
      opener?.focus({ preventScroll:true });
    });
    $("group-manage-leave").addEventListener("click", () => {
      const group = memberships().find(item => item.groupId === managedGroupId);
      if (group) void leaveGroup(group);
    });
    $("group-wish-all-day").addEventListener("change", updateWishTimeState);
    $("group-wish-cancel").addEventListener("click", closeWishEditor);
    $("group-wish-dialog").addEventListener("click", (event) => {
      if (event.target === $("group-wish-dialog")) closeWishEditor();
    });
    $("group-wish-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const group = activeGroup();
      if (!group) return;
      const button = $("group-wish-form").querySelector('[type="submit"]');
      const wishDate = $("group-wish-date").value;
      const isAllDay = $("group-wish-all-day").checked;
      button.disabled = true;
      setError("", "group-wish-form-error");
      try {
        await requestJson(editingWishId ? "/api/groups/wishes/update" : "/api/groups/wishes/create", {
          payload:{ ...credentials(group), ...(editingWishId ? { wishId:editingWishId } : {}), wishDate,
            isAllDay, start:isAllDay ? "" : $("group-wish-start").value,
            end:isAllDay ? "" : $("group-wish-end").value, message:$("group-wish-message").value },
        });
        closeWishEditor();
        view.groupDate = wishDate;
        view.groupMonth = new Date(Number(wishDate.slice(0, 4)), Number(wishDate.slice(5, 7)) - 1, 1);
        await Promise.all([loadWishes(), refreshCurrentMonth()]);
        $("group-calendar-status").textContent = "遊びたい日を保存しました。";
        $("group-calendar-status").hidden = false;
      } catch (error) { setError(error.message || "遊びたい日を保存できませんでした。", "group-wish-form-error"); }
      finally { button.disabled = false; }
    });
    $("group-status-create").addEventListener("click", () => showInviteStep("event"));
    $("group-status-availability").addEventListener("click", () => {
      if (!selectedWish) return;
      $("group-status-availability-note").textContent = "グループメンバーの空き時間（他グループの予定は内容を伏せて表示）";
      showInviteStep("availability");
      void renderAvailability();
    });
    $("group-status-cancel").addEventListener("click", closeStatusInvite);
    $("group-status-event-back").addEventListener("click", () => {
      showInviteStep("actions");
    });
    $("group-status-availability-back").addEventListener("click", () => showInviteStep("actions"));
    $("group-status-availability-date").addEventListener("change", () => void renderAvailability());
    $("group-status-availability-member").addEventListener("change", () => void renderAvailability());
    $("group-status-event-all-day").addEventListener("change", updateEventTimeState);
    $("group-status-event-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const group = activeGroup();
      if (!group || !convertedWishId) return;
      const button = $("group-status-event-form").querySelector('[type="submit"]');
      const date = $("group-status-event-date").value;
      const allDay = $("group-status-event-all-day").checked;
      button.disabled = true;
      setError("", "group-status-invite-error");
      try {
        await requestJson("/api/groups/wishes/confirm", { payload:{
          ...credentials(group), wishId:convertedWishId, title:$("group-status-event-title").value.trim(), eventDate:date,
          allDay, start:allDay ? "" : $("group-status-event-start").value,
          end:allDay ? "" : $("group-status-event-end").value,
          participantUserIds:[...$("group-status-event-participants").querySelectorAll('input[type="checkbox"]')]
            .filter((box) => box.checked).map((box) => box.value),
        } });
        closeStatusInvite();
        view.groupDate = date;
        view.groupMonth = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, 1);
        resetCache();
        renderCalendar();
        void loadWishes();
        void loadGroupMembers(group);
        $("group-calendar-status").textContent = "共有予定を登録しました。";
        $("group-calendar-status").hidden = false;
      } catch (error) { setError(error.message || "共有予定を登録できませんでした。", "group-status-invite-error"); }
      finally { button.disabled = false; }
    });
    $("group-status-invite-dialog").addEventListener("click", (event) => {
      if (event.target === $("group-status-invite-dialog")) closeStatusInvite();
    });
    $("open-invite-qr-scanner").addEventListener("click", () => void startInviteScanner());
    $("close-invite-qr-scanner").addEventListener("click", () => stopInviteScanner());
    $("close-group-invite-qr").addEventListener("click", closeInviteQr);
    $("group-invite-qr-dialog").addEventListener("click", (event) => {
      if (event.target === $("group-invite-qr-dialog")) closeInviteQr();
    });
    showHome();
    void flushPending();
  }
  return { init, showHome, openCalendar, markDirty };
}
