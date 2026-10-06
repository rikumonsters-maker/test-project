import { API_BASE } from './config.mjs';

export function initShared(app) {
  const { $, state, view, parseDate, requestJson, saveState, renderMonthCalendar, changeMonth, dateLabel, QrScanner, qrcode } = app;
  let activeGroupId = null;
  let selectedGroupId = null;
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
    name.textContent = group.groupName;
    name.setAttribute("aria-label", `${group.groupName}の共有カレンダーを表示`);
    name.setAttribute("aria-pressed", String(group.groupId === selectedGroupId));
    name.addEventListener("click", () => openCalendar(group.groupId));
    const avatar = groupImage(group, "group-card-image");
    name.prepend(avatar);
    heading.append(name);
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
    const actions = document.createElement("div");
    actions.className = "actions";
    const leave = document.createElement("button");
    leave.type = "button";
    leave.className = "action-button danger";
    leave.textContent = "グループから退出";
    leave.addEventListener("click", () => void leaveGroup(group));
    actions.append(leave);
    card.append(heading, member, label, showQr, actions);
    return card;
  }
  function groupImage(group, className = "") {
    if (!group.hasImage) {
      const icon = document.createElement("span");
      icon.className = `group-image-placeholder ${className}`;
      icon.textContent = "🌿";
      icon.setAttribute("aria-hidden", "true");
      return icon;
    }
    const image = document.createElement("img");
    image.className = `group-image ${className}`;
    image.alt = "";
    image.src = `${API_BASE}/api/groups/image?groupId=${encodeURIComponent(group.groupId)}&v=${encodeURIComponent(group.imageVersion || "")}`;
    return image;
  }
  function updateGroupImage(group) {
    $("group-calendar-image").replaceWith(Object.assign(groupImage(group), { id:"group-calendar-image" }));
    $("group-image-delete").hidden = !group.hasImage;
  }
  async function prepareGroupImage(file) {
    if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("JPEG、PNG、WebP画像を選択してください。");
    if (file.size > 5 * 1024 * 1024) throw new Error("画像は5MB以下にしてください。");
    const bitmap = await createImageBitmap(file);
    try {
      const size = Math.min(bitmap.width, bitmap.height);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = Math.min(512, size);
      const offsetX = (bitmap.width - size) / 2;
      const offsetY = (bitmap.height - size) / 2;
      canvas.getContext("2d").drawImage(bitmap, offsetX, offsetY, size, size, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
      if (!blob) throw new Error("画像を処理できませんでした。");
      return blob;
    } finally { bitmap.close(); }
  }
  async function changeGroupImage(file) {
    const group = activeGroup();
    if (!group) return;
    setError("", "group-image-error");
    try {
      const blob = await prepareGroupImage(file);
      const preview = URL.createObjectURL(blob);
      const original = $("group-calendar-image");
      const image = document.createElement("img");
      image.id = "group-calendar-image";
      image.className = "group-image";
      image.alt = "";
      image.src = preview;
      original.replaceWith(image);
      const response = await fetch(`${API_BASE}/api/groups/image?groupId=${encodeURIComponent(group.groupId)}`, {
        method:"POST", credentials:"include", headers:{ "Content-Type":"image/webp" }, body:blob,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "画像を保存できませんでした。");
      group.hasImage = true;
      group.imageVersion = data.avatarUpdatedAt;
      saveState();
      renderGroups();
      updateGroupImage(group);
      URL.revokeObjectURL(preview);
    } catch (error) {
      updateGroupImage(group);
      setError(error.message || "画像を保存できませんでした。", "group-image-error");
    }
  }
  async function deleteGroupImage() {
    const group = activeGroup();
    if (!group || !window.confirm("グループ画像を削除しますか？")) return;
    try {
      const response = await fetch(`${API_BASE}/api/groups/image?groupId=${encodeURIComponent(group.groupId)}`, { method:"DELETE", credentials:"include" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "画像を削除できませんでした。");
      group.hasImage = false;
      group.imageVersion = null;
      saveState();
      renderGroups();
      updateGroupImage(group);
    } catch (error) { setError(error.message || "画像を削除できませんでした。", "group-image-error"); }
  }
  function showInviteQr(group) {
    const url = new URL(window.location.href);
    url.searchParams.set("invite", group.inviteCode);
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
    updateGroupImage(group);
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
    try {
      await requestJson("/api/groups/leave", { payload:credentials(group) });
      state.groups = state.groups.filter((item) => item.groupId !== group.groupId);
      delete state.pendingGroupMonths[group.groupId];
      saveState();
      renderGroups();
      setStatus(`${group.groupName}から退出しました。`, "safe");
    } catch (error) {
      setError(error.message || "グループから退出できませんでした。");
    }
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
    $("group-image-file").addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      if (file) void changeGroupImage(file);
      event.target.value = "";
    });
    document.querySelector(".group-image-label").addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        $("group-image-file").click();
      }
    });
    $("group-image-delete").addEventListener("click", () => void deleteGroupImage());
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
