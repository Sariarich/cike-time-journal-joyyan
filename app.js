const STORAGE_KEY = "time-block-pwa-v1";
const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"tasks":[],"records":[]}');
state.books ||= [];
state.dailySummaries ||= [];
state.pendingTaskUpserts ||= [];
state.pendingTaskDeletes ||= [];
state.pendingRecordUpserts ||= [];
state.pendingRecordDeletes ||= [];
state.pendingBookSync ||= false;
state.thoughts ||= [];
state.pendingThoughtUpserts ||= [];
state.pendingThoughtDeletes ||= [];
function deriveThoughtTitle(content) {
  return content.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "未命名思考";
}
state.thoughts.forEach((thought) => { thought.title ||= deriveThoughtTitle(thought.content || ""); thought.date ||= String(thought.createdAt || "").slice(0, 10); });
const $ = (selector) => document.querySelector(selector);
const localDateKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const todayKey = () => localDateKey();
const dateFromKey = (value) => new Date(`${value}T00:00:00`);
const saveLocal = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
const SUPABASE_URL = "https://wacwjwtmmziakklcyuvt.supabase.co";
const SUPABASE_KEY = "sb_publishable_WygT01COp2jBZOKQMmQt-A_SQfVzgI5";
const OWNER_EMAIL = "signorecarnevale@163.com";
const PUBLIC_APP_URL = "https://www.signorecarnevale.top/";
const AUTH_CHANNEL_NAME = "right-now-auth";
const cloud = window.supabase?.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    storage: window.localStorage,
    storageKey: "cike-time-journal-auth",
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});
let cloudUser = null;
const SESSION_STATE = Object.freeze({
  SIGNED_OUT: "signed-out",
  RESTORING: "restoring",
  SIGNED_IN: "signed-in",
  EXPIRED: "expired",
  SIGNING_OUT: "signing-out",
  OFFLINE: "offline",
  UNAVAILABLE: "unavailable"
});
let sessionState = cloud ? SESSION_STATE.RESTORING : SESSION_STATE.UNAVAILABLE;
let manualSignOutRequested = false;
let hydratedSessionToken = null;
let networkListenersRegistered = false;
let authChannel = null;
let explicitSignOutUntil = 0;
const save = () => { saveLocal(); syncToCloud(); };
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const urlDate = new URLSearchParams(window.location.search).get("date");
let selectedDate = /^\d{4}-\d{2}-\d{2}$/.test(urlDate || "") ? urlDate : todayKey();
let calendarMonth = new Date(dateFromKey(selectedDate).getFullYear(), dateFromKey(selectedDate).getMonth(), 1);
const formatDate = (value = selectedDate) => new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(dateFromKey(value));
const formatDateTime = (value) => new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
const minutes = (time) => { const [h, m] = time.split(":").map(Number); return h * 60 + m; };
const categories = {
  money: { label: "钱", color: "#A38652" },
  learning: { label: "学习", color: "#596875" },
  network: { label: "人脉", color: "#9A6B68" },
  fun: { label: "娱乐", color: "#98798B" },
  rest: { label: "休息", color: "#6F7392" }
};
const categoryData = (records) => Object.keys(categories).map((key) => ({ key, ...categories[key], value: records.filter((record) => (record.category || "fun") === key).reduce((sum, record) => sum + Math.max(0, minutes(record.end) - minutes(record.start)), 0) }));
function queueTaskUpsert(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (task) task.updatedAt = new Date().toISOString();
  state.pendingTaskDeletes = state.pendingTaskDeletes.filter((pendingId) => pendingId !== id);
  if (!state.pendingTaskUpserts.includes(id)) state.pendingTaskUpserts.push(id);
  persistSyncOperation("task", id, "upsert");
}
function queueTaskDelete(id) {
  state.pendingTaskUpserts = state.pendingTaskUpserts.filter((pendingId) => pendingId !== id);
  if (!state.pendingTaskDeletes.includes(id)) state.pendingTaskDeletes.push(id);
  persistSyncOperation("task", id, "delete");
}
function queueRecordUpsert(id) {
  const record = state.records.find((item) => item.id === id);
  if (record) record.updatedAt = new Date().toISOString();
  state.pendingRecordDeletes = state.pendingRecordDeletes.filter((pendingId) => pendingId !== id);
  if (!state.pendingRecordUpserts.includes(id)) state.pendingRecordUpserts.push(id);
  persistSyncOperation("record", id, "upsert");
}
function queueRecordDelete(id) {
  state.pendingRecordUpserts = state.pendingRecordUpserts.filter((pendingId) => pendingId !== id);
  if (!state.pendingRecordDeletes.includes(id)) state.pendingRecordDeletes.push(id);
  persistSyncOperation("record", id, "delete");
}
function recordErrorMessage(error, action = "保存") {
  const message = error?.message || "网络或权限异常";
  if (error?.code === "23514" || /check constraint/i.test(message)) return `${action}失败：云端尚未启用“休息”分类，请运行分类升级`;
  return `${action}失败：${classifySyncError(error).message}`;
}
function queueThoughtUpsert(id) {
  state.pendingThoughtDeletes = state.pendingThoughtDeletes.filter((pendingId) => pendingId !== id);
  if (!state.pendingThoughtUpserts.includes(id)) state.pendingThoughtUpserts.push(id);
  persistSyncOperation("thought", id, "upsert");
}
function queueThoughtDelete(id) {
  state.pendingThoughtUpserts = state.pendingThoughtUpserts.filter((pendingId) => pendingId !== id);
  if (!state.pendingThoughtDeletes.includes(id)) state.pendingThoughtDeletes.push(id);
  persistSyncOperation("thought", id, "delete");
}
let selectedBookId = state.books[0]?.id || null;
let editingExcerptId = null;
let editingReflectionId = null;
let bookScrollTimer;
let activeThoughtMenuId = null;
const expandedThoughtIds = new Set();
let activeNoteMenuId = null;
const expandedNoteIds = new Set();
const summaryKey = (summary) => `${summary.date}:${summary.slot}`;
const summaryPrompts = ["今天最值得记录的一件事", "今天学到或意识到什么", "明天最重要的一件事"];
const conflictService = window.createConflictService({ state, saveLocal });

function renderConflictDialog() {
  const conflicts = conflictService.unresolved();
  const button = $("#conflictButton");
  button.hidden = conflicts.length === 0;
  button.textContent = `冲突 ${conflicts.length}`;
  if (!conflicts.length) return;
  const conflict = conflicts[0];
  const localText = conflictService.textFor(conflict.entityType, conflict.local);
  const cloudText = conflictService.textFor(conflict.entityType, conflict.cloud);
  $("#conflictDialogContent").innerHTML = `<div class="dialog-heading"><div><p class="date-label">SYNC CONFLICT</p><h3>发现两个版本</h3></div><button class="delete-button" type="button" data-conflict-close aria-label="关闭冲突处理">×</button></div><p class="conflict-note">本机和云端都改过这段内容。请选择要保留的版本，或编辑合并后的正文。</p><div class="conflict-versions"><section><h4>本机版本</h4><pre>${escapeHtml(localText)}</pre></section><section><h4>云端版本</h4><pre>${escapeHtml(cloudText)}</pre></section></div><label class="conflict-merge-label" for="conflictMergedText">合并后保存</label><textarea id="conflictMergedText" placeholder="编辑合并后的正文">${escapeHtml(localText)}</textarea><div class="migration-actions"><button class="logout-button" type="button" data-conflict-resolve="cloud" data-conflict-key="${escapeHtml(conflict.key)}">使用云端</button><button class="logout-button" type="button" data-conflict-resolve="local" data-conflict-key="${escapeHtml(conflict.key)}">保留本机</button><button class="primary-button" type="button" data-conflict-resolve="merged" data-conflict-key="${escapeHtml(conflict.key)}">合并后保存</button></div>`;
}
function openConflictDialog() { renderConflictDialog(); if (conflictService.unresolved().length) $("#conflictDialog").showModal(); }
function applyConflictResolution(key, decision) {
  const mergedText = $("#conflictMergedText")?.value.trim();
  if (decision === "merged" && !mergedText) { showToast("合并内容不能为空"); return; }
  const result = conflictService.resolve(key, decision, mergedText);
  if (!result) return;
  const { record, value } = result;
  if (record.entityType === "summary") {
    const index = state.dailySummaries.findIndex((item) => summaryKey(item) === summaryKey(record.local));
    if (index >= 0) state.dailySummaries[index] = { ...value, id: state.dailySummaries[index].id, savedAt: new Date().toISOString(), syncState: "syncing", syncError: "" };
    persistSyncOperation("summary", state.dailySummaries[index]?.id || value.id, "upsert");
  } else if (record.entityType === "thought") {
    const index = state.thoughts.findIndex((item) => item.id === record.entityId);
    if (index >= 0) state.thoughts[index] = { ...value, id: record.entityId, updatedAt: new Date().toISOString(), syncState: "syncing", syncError: "" };
    persistSyncOperation("thought", record.entityId, "upsert");
  } else if (record.entityType === "reading-note") {
    for (const book of state.books) for (const field of ["excerpts", "reflections"]) {
      const index = (book[field] || []).findIndex((item) => item.id === record.entityId);
      if (index >= 0) book[field][index] = { ...book[field][index], ...value, id: record.entityId, updatedAt: new Date().toISOString() };
    }
    state.pendingBookSync = true;
    persistSyncOperation("reading-note", record.entityId, "upsert");
  }
  saveLocal(); renderDailySummaries(); renderThoughts(); renderBooks(); renderConflictDialog();
  if (!conflictService.unresolved().length) $("#conflictDialog").close();
  void durableSyncEngine?.run();
}

function setSyncStatus(text, online = false) { $("#syncStatus").textContent = text; $("#syncDot").classList.toggle("is-online", online); }
function setAuthMessage(text, failed = false) { const message = $("#authMessage"); message.textContent = text; message.classList.toggle("is-failed", failed); }
let toastTimer;
function showToast(message) { const toast = $("#toast"); if (!toast) return; toast.textContent = message; toast.classList.add("is-visible"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600); }
async function exportAllData() {
  if (!cloudUser || !cloud) { showToast("请先登录同步账号"); return; }
  const button = $("#exportDataButton");
  button.disabled = true;
  try {
    const tableNames = ["time_tasks", "time_records", "daily_summaries", "thought_entries", "reading_books", "reading_notes"];
    const results = await Promise.all(tableNames.map((table) => cloud.from(table).select("*").eq("user_id", cloudUser.id)));
    const failed = results.find((result) => result.error);
    if (failed) throw failed.error;
    const backup = { exported_at: new Date().toISOString(), user_id: cloudUser.id, data: Object.fromEntries(tableNames.map((table, index) => [table, results[index].data || []])) };
    const stamp = localDateKey();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `right-now-backup-${stamp}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("数据备份已下载");
  } catch (error) { showToast(`导出失败：${error.message || "网络或权限异常"}`); }
  finally { button.disabled = false; }
}
function updateCategorySwatch(selectId, swatchId) {
  const category = categories[$(selectId).value] || categories.fun;
  $(swatchId).style.setProperty("--category-color", category.color);
  $(swatchId).title = `${category.label}：${category.color}`;
}
const isOwner = () => cloudUser?.email?.toLowerCase() === OWNER_EMAIL;
const isNetworkError = (error) => !navigator.onLine || /network|fetch|offline|internet/i.test(error?.message || "");
function classifyError(error, messages) {
  const message = error?.message || "";
  const code = String(error?.code || "");
  const status = Number(error?.status || 0);
  if (isNetworkError(error)) return { kind: "network", message: messages.network };
  if (/jwt.*expired|token.*expired|invalid.*jwt|session.*expired|auth.*expired/i.test(message) || ["PGRST301", "401"].includes(code) || status === 401) return { kind: "expired", message: messages.expired };
  if (code === "42501" || /row-level security|permission denied|not authorized|forbidden/i.test(message) || status === 403) return { kind: "permission", message: messages.permission };
  if (code === "23505" || status === 409 || /conflict|duplicate key|already exists/i.test(message)) return { kind: "conflict", message: messages.conflict };
  if (status >= 500 || /internal server|service unavailable|gateway|server error/i.test(message)) return { kind: "server", message: messages.server };
  return { kind: "unknown", message: messages.unknown };
}
function classifyAuthError(error) {
  return classifyError(error, {
    network: "网络不可用，请恢复网络后重试。",
    expired: "登录会话已过期，请重新登录。",
    permission: "当前账号没有认证权限。",
    conflict: "登录状态冲突，请重新尝试。",
    server: "认证服务暂时不可用，请稍后重试。",
    unknown: "认证失败，请稍后重试。"
  });
}
function classifySyncError(error) {
  return classifyError(error, {
    network: "网络不可用，本机修改已保留，等待重试。",
    expired: "登录会话已过期，本机修改已保留，请重新登录。",
    permission: "没有同步权限，本机修改已保留。",
    conflict: "云端数据发生冲突，本机修改已保留，等待处理。",
    server: "云端服务暂时不可用，本机修改已保留，等待重试。",
    unknown: "同步失败，本机修改已保留，请重试。"
  });
}
function broadcastAuthEvent(type) {
  authChannel?.postMessage({ type });
}
const migrationService = window.createMigrationService({ getState: () => state, saveLocal, getCloud: () => cloud, getCloudUser: () => cloudUser, getOwnerEmail: () => OWNER_EMAIL, getPublicAppUrl: () => PUBLIC_APP_URL, setStatus: setSyncStatus });
const migrationController = migrationService;
const pendingMigration = migrationService.pendingMigration;
const emailRedirectUrl = migrationService.emailRedirectUrl;
const captureMigrationFromUrl = migrationService.captureMigrationFromUrl;
const durableSyncQueue = window.createSyncQueue();
let durableSyncEngine;
const cloneSyncPayload = (value) => typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
function persistSyncOperation(entityType, entityId, action, payload = null) {
  // Legacy pending markers remain active until every entity is migrated.
  void durableSyncQueue.enqueue({ entityType, entityId, action, payload })
    .then(() => { if (cloudUser) void durableSyncEngine?.run(); })
    .catch(() => setSyncStatus("本机同步队列不可用，修改仍保留在本机。", false));
}
async function replaySyncOperation(operation) {
  if (!cloudUser || !cloud) throw new Error("尚未登录同步账号");
  if (operation.entityType === "task") {
    if (operation.action === "delete") return deleteTaskFromCloud(operation.entityId);
    return syncToCloud();
  }
  if (operation.entityType === "record") {
    if (operation.action === "delete") return deleteRecordFromCloud(operation.entityId);
    const record = state.records.find((item) => item.id === operation.entityId);
    return record ? syncRecordToCloud(record) : { ok: true };
  }
  if (operation.entityType === "summary") {
    if (operation.action === "delete") return deleteDailySummaryFromCloud(operation.payload);
    const summary = state.dailySummaries.find((item) => item.id === operation.entityId);
    return summary ? syncDailySummaryToCloud(summary) : { ok: true };
  }
  if (operation.entityType === "thought") {
    if (operation.action === "delete") return deleteThoughtFromCloud(operation.entityId);
    const thought = state.thoughts.find((item) => item.id === operation.entityId);
    return thought ? syncThoughtToCloud(thought) : { ok: true };
  }
  if (operation.entityType === "book") {
    if (operation.action === "delete") return deleteBookFromCloud(operation.payload);
    return syncBooksToCloud();
  }
  if (operation.entityType === "reading-note") {
    if (operation.action === "delete") { await deleteNoteFromCloud(operation.payload); return { ok: true }; }
    return syncBooksToCloud();
  }
  throw new Error("暂不支持的同步操作");
}
function initDurableSyncQueue() {
  void durableSyncQueue.recoverInterrupted().then(() => {
    durableSyncEngine = window.createSyncEngine({
      queue: durableSyncQueue,
      execute: async (operation) => {
        const result = await replaySyncOperation(operation);
        if (!result?.ok) throw result?.error || new Error("同步未完成");
      },
      onStateChange: async () => {
        const pending = await durableSyncQueue.pendingCount();
        if (pending && cloudUser) setSyncStatus(`有 ${pending} 项待同步`, false);
      }
    });
    if (cloudUser) void durableSyncEngine.run();
  }).catch(() => setSyncStatus("本机同步队列不可用，修改仍保留在本机。", false));
}
async function syncToCloud() {
  if (!cloudUser || !cloud) return { ok: false, local: true };
  setSyncStatus("正在同步", true);
  const tasks = state.tasks.map((task) => ({ id: task.id, user_id: cloudUser.id, title: task.title, planned_time: task.time || null, date: task.date, done: task.done }));
  const records = state.records.map((record) => ({ id: record.id, user_id: cloudUser.id, title: record.title, start_time: record.start, end_time: record.end, category: record.category || "fun", date: record.date }));
  const [taskResult, recordResult] = await Promise.all([
    tasks.length ? cloud.from("time_tasks").upsert(tasks) : Promise.resolve({ error: null }),
    records.length ? cloud.from("time_records").upsert(records) : Promise.resolve({ error: null })
  ]);
  if (!taskResult.error) state.pendingTaskUpserts = [];
  if (!recordResult.error) state.pendingRecordUpserts = [];
  const taskDeleteResults = await Promise.all([...state.pendingTaskDeletes].map(deleteTaskFromCloud));
  const recordDeleteResults = [];
  for (const id of [...state.pendingRecordDeletes]) recordDeleteResults.push(await deleteRecordFromCloud(id));
  saveLocal();
  const failure = taskResult.error || recordResult.error || taskDeleteResults.find((result) => !result.ok)?.error || recordDeleteResults.find((result) => !result.ok)?.error;
  if (failure) {
    setSyncStatus(`同步失败：${classifySyncError(failure).message}`, false);
    return { ok: false, error: failure };
  }
  setSyncStatus("已同步", true);
  return { ok: true };
}
async function loadFromCloud() {
  if (!cloudUser || !cloud) return;
  setSyncStatus("读取云端", true);
  const [taskResult, recordResult, summaryResult] = await Promise.all([
    cloud.from("time_tasks").select("*").eq("user_id", cloudUser.id).is("deleted_at", null),
    cloud.from("time_records").select("*").eq("user_id", cloudUser.id).is("deleted_at", null),
    cloud.from("daily_summaries").select("*").eq("user_id", cloudUser.id).is("deleted_at", null)
  ]);
  if (taskResult.error || recordResult.error) {
    setSyncStatus(`同步失败：${classifySyncError(taskResult.error || recordResult.error).message}`, false);
    return;
  }
  const pendingTasks = new Map(state.tasks.filter((task) => state.pendingTaskUpserts.includes(task.id)).map((task) => [task.id, task]));
  const cloudTasks = new Map(taskResult.data.map((task) => [task.id, { id: task.id, title: task.title, time: task.planned_time || "", date: task.date, done: task.done, updatedAt: task.updated_at }]));
  for (const [id, task] of pendingTasks) {
    const decision = conflictService.compare({ entityType: "task", entityId: id, local: task, cloud: cloudTasks.get(id), localChanged: true });
    cloudTasks.set(id, decision.value);
  }
  for (const id of state.pendingTaskDeletes) cloudTasks.delete(id);
  state.tasks = [...cloudTasks.values()];
  const pendingUpserts = new Map(state.records.filter((record) => state.pendingRecordUpserts.includes(record.id)).map((record) => [record.id, record]));
  const cloudRecords = new Map(recordResult.data.map((record) => [record.id, { id: record.id, title: record.title, start: record.start_time, end: record.end_time, category: record.category, date: record.date, updatedAt: record.updated_at }]));
  for (const [id, record] of pendingUpserts) {
    const decision = conflictService.compare({ entityType: "record", entityId: id, local: record, cloud: cloudRecords.get(id), localChanged: true });
    cloudRecords.set(id, decision.value);
  }
  for (const id of state.pendingRecordDeletes) cloudRecords.delete(id);
  state.records = [...cloudRecords.values()];
  const summariesToUpload = [];
  if (!summaryResult.error) {
    const cloudSummaries = new Map(summaryResult.data.map((summary) => [summaryKey(summary), { id: summary.id, date: summary.date, slot: Number(summary.slot), content: summary.content, savedAt: summary.updated_at, syncState: "synced", syncError: "" }]));
    for (const localSummary of state.dailySummaries.filter((summary) => summary.content?.trim())) {
      const key = summaryKey(localSummary);
      const cloudSummary = cloudSummaries.get(key);
      const localChanged = localSummary.syncState !== "synced" || localSummary.pendingAction;
      if (cloudSummary && localChanged) {
        const decision = conflictService.compare({ entityType: "summary", entityId: localSummary.id, local: localSummary, cloud: cloudSummary, localChanged: true });
        if (decision.outcome !== "cloud") cloudSummaries.set(key, localSummary);
      } else if (!cloudSummary) {
        const preserved = { ...localSummary, syncState: "syncing", syncError: "" };
        cloudSummaries.set(key, preserved);
        summariesToUpload.push(preserved);
      }
    }
    state.dailySummaries = [...cloudSummaries.values()];
  }
  saveLocal(); renderTasks(); renderRecords(); renderStats(); renderDailySummaries(); renderDateControls(); renderConflictDialog();
  let syncFailed = false;
  if (state.pendingTaskUpserts.length || state.pendingTaskDeletes.length) {
    const result = await syncToCloud();
    syncFailed ||= !result.ok;
  }
  for (const id of [...state.pendingRecordUpserts]) {
    const record = state.records.find((item) => item.id === id);
    if (record) {
      const result = await syncRecordToCloud(record);
      syncFailed ||= !result.ok;
    }
  }
  for (const id of [...state.pendingRecordDeletes]) {
    const result = await deleteRecordFromCloud(id);
    syncFailed ||= !result.ok;
  }
  if (summaryResult.error) {
    setSyncStatus(`总结读取失败：${classifySyncError(summaryResult.error).message}`, false);
    return;
  }
  for (const summary of summariesToUpload) {
    const result = await syncDailySummaryToCloud(summary);
    syncFailed ||= !result.ok;
  }
  if (syncFailed) return;
  setSyncStatus("已同步", true);
}
async function deleteTaskFromCloud(id) {
  if (!cloudUser || !cloud) return { ok: false, local: true };
  const { error } = await cloud.from("time_tasks").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("user_id", cloudUser.id);
  if (error) { setSyncStatus(`删除任务失败：${classifySyncError(error).message}`, false); return { ok: false, error }; }
  state.pendingTaskDeletes = state.pendingTaskDeletes.filter((pendingId) => pendingId !== id);
  saveLocal();
  return { ok: true };
}
async function syncRecordToCloud(record) {
  if (!cloudUser || !cloud) return { ok: false, local: true };
  setSyncStatus("正在同步", true);
  const { error } = await cloud.from("time_records").upsert({ id: record.id, user_id: cloudUser.id, title: record.title, start_time: record.start, end_time: record.end, category: record.category || "fun", date: record.date });
  if (error) {
    setSyncStatus(recordErrorMessage(error), false);
    return { ok: false, error };
  }
  state.pendingRecordUpserts = state.pendingRecordUpserts.filter((id) => id !== record.id);
  saveLocal();
  setSyncStatus("已同步", true);
  return { ok: true };
}
async function deleteRecordFromCloud(id) {
  if (!cloudUser || !cloud) return { ok: false, local: true };
  setSyncStatus("正在删除", true);
  const { error } = await cloud.from("time_records").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("user_id", cloudUser.id);
  if (error) {
    setSyncStatus(recordErrorMessage(error, "删除"), false);
    return { ok: false, error };
  }
  state.pendingRecordDeletes = state.pendingRecordDeletes.filter((pendingId) => pendingId !== id);
  saveLocal();
  setSyncStatus("已同步", true);
  return { ok: true };
}
function summaryErrorMessage(error, action = "保存") {
  const message = error?.message || "网络或权限异常";
  if (/relation .*daily_summaries|does not exist/i.test(message)) return `${action}失败：总结数据表尚未完成升级`;
  if (/check constraint|char_length/i.test(message)) return `${action}失败：内容需要在 1 至 500 字之间`;
  return `${action}失败：${classifySyncError(error).message}`;
}
function summarySyncMeta(summary) {
  if (summary.syncState === "syncing") return { text: "正在同步", tone: "" };
  if (summary.syncState === "failed") return { text: summary.syncError || "保存失败，请重试", tone: "is-failed" };
  if (!cloudUser || summary.syncState === "local") return { text: "仅本机保存，请登录后同步", tone: "is-local" };
  return { text: "已同步", tone: "is-synced" };
}
function summaryTime(summary) {
  if (!summary.savedAt) return "已保存";
  const date = new Date(summary.savedAt);
  return Number.isNaN(date.valueOf()) ? "已保存" : `已保存 · ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
}
async function syncDailySummaryToCloud(summary) {
  if (conflictService.hasUnresolved("summary", summary.id)) return { ok: false, error: new Error("总结存在待处理冲突") };
  if (!cloudUser || !cloud) {
    summary.syncState = "local";
    summary.syncError = "仅本机保存，请登录后同步";
    saveLocal(); renderDailySummaries(); renderDateControls();
    return { ok: false, local: true };
  }
  summary.syncState = "syncing";
  summary.syncError = "";
  saveLocal(); renderDailySummaries();
  setSyncStatus("正在同步", true);
  const { error } = await cloud.from("daily_summaries").upsert({ id: summary.id, user_id: cloudUser.id, date: summary.date, slot: summary.slot, content: summary.content, updated_at: new Date().toISOString() }, { onConflict: "user_id,date,slot" });
  if (error) {
    summary.syncState = "failed";
    summary.syncError = summaryErrorMessage(error);
    saveLocal(); renderDailySummaries();
    setSyncStatus(summary.syncError, false);
    return { ok: false, error };
  }
  summary.syncState = "synced";
  summary.syncError = "";
  summary.savedAt = new Date().toISOString();
  saveLocal(); renderDailySummaries(); renderDateControls();
  setSyncStatus("已同步", true);
  return { ok: true };
}
async function deleteDailySummaryFromCloud(summary) {
  if (!cloudUser || !cloud) return { ok: true, local: true };
  setSyncStatus("正在删除", true);
  const { error } = await cloud.from("daily_summaries").update({ deleted_at: new Date().toISOString() }).eq("id", summary.id).eq("user_id", cloudUser.id);
  if (error) {
    summary.syncState = "failed";
    summary.pendingAction = "delete";
    summary.syncError = summaryErrorMessage(error, "删除");
    saveLocal(); renderDailySummaries();
    setSyncStatus(summary.syncError, false);
    return { ok: false, error };
  }
  setSyncStatus("已同步", true);
  return { ok: true };
}
async function signedImage(path) {
  if (!path || !cloud) return "";
  const { data } = await cloud.storage.from("reading-images").createSignedUrl(path, 60 * 60 * 24);
  return data?.signedUrl || "";
}
function bookSyncResult({ inserted = 0, errors = [], error = null, local = false } = {}) {
  const success = errors.length === 0 && !local;
  return { success, ok: success, inserted, failed: errors.length, errors, error, local };
}
function bookSyncError(entityType, entityId, error) {
  return { entityType, entityId, message: error?.message || "同步失败", error };
}
async function syncBooksToCloud() {
  try {
    return await syncBooksToCloudAttempt();
  } catch (error) {
    const result = bookSyncResult({ errors: [bookSyncError("books", null, error)], error });
    state.pendingBookSync = true;
    saveLocal();
    setSyncStatus(`阅读笔记同步失败：${classifySyncError(error).message}`, false);
    return result;
  }
}
async function syncBooksToCloudAttempt() {
  if (conflictService.unresolved().some((item) => item.entityType === "reading-note")) {
    return bookSyncResult({ errors: [bookSyncError("readingNotes", null, new Error("阅读正文存在待处理冲突"))] });
  }
  if (!cloudUser || !cloud) {
    state.pendingBookSync = state.books.length > 0;
    saveLocal();
    return bookSyncResult({ local: true, errors: [bookSyncError("books", null, new Error("未登录，无法同步阅读数据"))] });
  }
  setSyncStatus("正在同步", true);
  const bookRows = state.books.map((book) => ({ id: book.id, user_id: cloudUser.id, title: book.title, author: book.author || null, rating: book.rating || 0 }));
  const { data: syncedBooks, error: bookError } = bookRows.length ? await cloud.from("reading_books").upsert(bookRows).select("id") : { data: [], error: null };
  if (bookError) {
    state.pendingBookSync = true;
    saveLocal();
    setSyncStatus(`阅读笔记同步失败：${classifySyncError(bookError).message}`, false);
    return bookSyncResult({ errors: bookRows.map((book) => bookSyncError("books", book.id, bookError)), error: bookError });
  }
  const noteRows = [];
  const errors = [];
  let inserted = syncedBooks?.length || 0;
  for (const book of state.books) {
    for (const [field, noteType] of [["excerpts", "excerpt"], ["reflections", "reflection"]]) {
      for (const note of book[field] || []) {
        if (note.image?.startsWith("data:") && !note.imagePath) {
          try {
            const imagePath = `${cloudUser.id}/${book.id}/${note.id}.jpg`;
            const response = await fetch(note.image);
            if (!response.ok) throw new Error("图片数据读取失败");
            const { error } = await cloud.storage.from("reading-images").upload(imagePath, await response.blob(), { upsert: true, contentType: "image/jpeg" });
            if (error) throw error;
            note.imagePath = imagePath;
            inserted += 1;
          } catch (error) {
            errors.push(bookSyncError("images", note.id, error));
            continue;
          }
        }
        noteRows.push({ id: note.id, book_id: book.id, user_id: cloudUser.id, note_type: noteType, body: note.text || null, image_path: note.imagePath || null });
      }
    }
  }
  const { data: syncedNotes, error: noteError } = noteRows.length ? await cloud.from("reading_notes").upsert(noteRows).select("id") : { data: [], error: null };
  if (noteError) errors.push(...noteRows.map((note) => bookSyncError("readingNotes", note.id, noteError)));
  inserted += syncedNotes?.length || 0;
  const result = bookSyncResult({ inserted, errors, error: errors[0]?.error || null });
  state.pendingBookSync = !result.success;
  saveLocal();
  if (!result.success) {
    setSyncStatus(`阅读笔记同步失败：${classifySyncError(result.error).message}`, false);
    return result;
  }
  setSyncStatus("已同步", true);
  return result;
}
async function loadBooksFromCloud() {
  if (!cloudUser || !cloud) return;
  const [bookResult, noteResult] = await Promise.all([cloud.from("reading_books").select("*").eq("user_id", cloudUser.id).is("deleted_at", null).order("updated_at", { ascending: false }), cloud.from("reading_notes").select("*").eq("user_id", cloudUser.id).is("deleted_at", null).order("created_at", { ascending: false })]);
  if (bookResult.error || noteResult.error) {
    setSyncStatus(`阅读笔记读取失败：${classifySyncError(bookResult.error || noteResult.error).message}`, false);
    return;
  }
  if (!bookResult.data.length && state.books.length) { await syncBooksToCloud(); return; }
  const notesWithImages = await Promise.all(noteResult.data.map(async (note) => ({ ...note, text: note.body || "", image: await signedImage(note.image_path), imagePath: note.image_path, updatedAt: note.updated_at })));
  const localNotes = new Map(state.books.flatMap((book) => [...(book.excerpts || []), ...(book.reflections || [])]).map((note) => [note.id, note]));
  for (const cloudNote of notesWithImages) {
    const localNote = localNotes.get(cloudNote.id);
    if (!localNote?.updatedAt) continue;
    const decision = conflictService.compare({ entityType: "reading-note", entityId: cloudNote.id, local: localNote, cloud: cloudNote, localChanged: true });
    if (decision.outcome !== "cloud") Object.assign(cloudNote, localNote);
  }
  state.books = bookResult.data.map((book) => ({ id: book.id, title: book.title, author: book.author || "", rating: book.rating || 0, excerpts: notesWithImages.filter((note) => note.book_id === book.id && note.note_type === "excerpt").map((note) => ({ id: note.id, text: note.text || note.body || "", image: note.image, imagePath: note.imagePath || note.image_path, updatedAt: note.updatedAt })), reflections: notesWithImages.filter((note) => note.book_id === book.id && note.note_type === "reflection").map((note) => ({ id: note.id, text: note.text || note.body || "", image: note.image, imagePath: note.imagePath || note.image_path, updatedAt: note.updatedAt })) }));
  selectedBookId = state.books[0]?.id || null;
  saveLocal(); renderBooks();
}
async function deleteNoteFromCloud(note) {
  if (!cloudUser || !cloud) return;
  await cloud.from("reading_notes").update({ deleted_at: new Date().toISOString() }).eq("id", note.id).eq("user_id", cloudUser.id);
}
async function updateBookInCloud(book) {
  if (!cloudUser || !cloud) return { ok: false, local: true };
  const { error } = await cloud.from("reading_books").update({ title: book.title, author: book.author || null, rating: book.rating || 0, updated_at: new Date().toISOString() }).eq("id", book.id).eq("user_id", cloudUser.id);
  if (error) {
    state.pendingBookSync = true;
    saveLocal();
    setSyncStatus(`书籍修改失败：${classifySyncError(error).message}`, false);
    return { ok: false, error };
  }
  return { ok: true };
}
async function deleteBookFromCloud(book) {
  if (!cloudUser || !cloud) return { ok: false, local: true };
  setSyncStatus("正在删除", true);
  const { error: notesError } = await cloud.from("reading_notes").update({ deleted_at: new Date().toISOString() }).eq("book_id", book.id).eq("user_id", cloudUser.id).is("deleted_at", null);
  if (notesError) { setSyncStatus(`删除笔记失败：${classifySyncError(notesError).message}`, false); return { ok: false, error: notesError }; }
  const { error } = await cloud.from("reading_books").update({ deleted_at: new Date().toISOString() }).eq("id", book.id).eq("user_id", cloudUser.id);
  if (error) { setSyncStatus(`删除书籍失败：${classifySyncError(error).message}`, false); return { ok: false, error }; }
  setSyncStatus("已同步", true); return { ok: true };
}
async function saveReadingNote(book, type, note, text, image) {
  if (!cloudUser || !cloud) return { ok: false, local: true };
  let imagePath = note.imagePath || null;
  if (image?.startsWith("data:")) {
    imagePath = `${cloudUser.id}/${book.id}/${note.id}.jpg`;
    const blob = await (await fetch(image)).blob();
    const { error } = await cloud.storage.from("reading-images").upload(imagePath, blob, { upsert: true, contentType: "image/jpeg" });
    if (error) return { ok: false, error };
  }
  const { error } = await cloud.from("reading_notes").upsert({ id: note.id, book_id: book.id, user_id: cloudUser.id, note_type: type, body: text || null, image_path: imagePath }, { onConflict: "id" });
  if (error) return { ok: false, error };
  note.text = text; note.image = image || note.image || ""; note.imagePath = imagePath;
  return { ok: true };
}
function thoughtSyncMeta(thought) {
  if (thought.syncState === "syncing") return "正在同步";
  if (thought.syncState === "failed") return thought.syncError || "保存失败，请重试";
  if (!cloudUser || thought.syncState === "local") return "仅本机保存";
  return "已同步";
}
function thoughtErrorMessage(error, action = "保存") {
  const message = error?.message || "网络或权限异常";
  if (/relation .*thought_entries|does not exist/i.test(message)) return `${action}失败：思考数据表尚未完成升级`;
  if (/column .*title|title .*column/i.test(message)) return `${action}失败：思考标题数据尚未完成升级`;
  return `${action}失败：${classifySyncError(error).message}`;
}
async function syncThoughtToCloud(thought) {
  if (conflictService.hasUnresolved("thought", thought.id)) return { ok: false, error: new Error("思考存在待处理冲突") };
  if (!cloudUser || !cloud) {
    thought.syncState = "local";
    saveLocal(); renderThoughts();
    return { ok: false, local: true };
  }
  thought.syncState = "syncing";
  thought.syncError = "";
  saveLocal(); renderThoughts();
  setSyncStatus("正在同步思考", true);
  const { error } = await cloud.from("thought_entries").upsert({ id: thought.id, user_id: cloudUser.id, title: thought.title, content: thought.content, created_at: thought.createdAt, updated_at: thought.updatedAt });
  if (error) {
    thought.syncState = "failed";
    thought.syncError = thoughtErrorMessage(error);
    saveLocal(); renderThoughts();
    setSyncStatus(thought.syncError, false);
    return { ok: false, error };
  }
  state.pendingThoughtUpserts = state.pendingThoughtUpserts.filter((id) => id !== thought.id);
  thought.syncState = "synced";
  thought.syncError = "";
  saveLocal(); renderThoughts();
  setSyncStatus("已同步", true);
  return { ok: true };
}
async function deleteThoughtFromCloud(id) {
  if (!cloudUser || !cloud) return { ok: false, local: true };
  setSyncStatus("正在删除思考", true);
  const { error } = await cloud.from("thought_entries").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("user_id", cloudUser.id);
  if (error) {
    setSyncStatus(thoughtErrorMessage(error, "删除"), false);
    return { ok: false, error };
  }
  state.pendingThoughtDeletes = state.pendingThoughtDeletes.filter((pendingId) => pendingId !== id);
  saveLocal();
  setSyncStatus("已同步", true);
  return { ok: true };
}
async function syncThoughtsToCloud() {
  let failure = null;
  for (const id of [...state.pendingThoughtUpserts]) {
    const thought = state.thoughts.find((item) => item.id === id);
    if (thought) {
      const result = await syncThoughtToCloud(thought);
      failure ||= result.ok ? null : result.error || new Error("思考同步失败");
    }
  }
  for (const id of [...state.pendingThoughtDeletes]) {
    const result = await deleteThoughtFromCloud(id);
    failure ||= result.ok ? null : result.error || new Error("思考删除失败");
  }
  return failure ? { ok: false, error: failure } : { ok: true };
}
async function syncPendingDailySummaries() {
  let failure = null;
  const pending = state.dailySummaries.filter((summary) => summary.content?.trim() && (summary.pendingAction || summary.syncState !== "synced"));
  for (const summary of pending) {
    const result = summary.pendingAction === "delete" ? await deleteDailySummaryFromCloud(summary) : await syncDailySummaryToCloud(summary);
    failure ||= result.ok ? null : result.error || new Error("总结同步失败");
  }
  return failure ? { ok: false, error: failure } : { ok: true };
}
async function loadThoughtsFromCloud() {
  if (!cloudUser || !cloud) return;
  const { data, error } = await cloud.from("thought_entries").select("*").eq("user_id", cloudUser.id).is("deleted_at", null).order("created_at", { ascending: false });
  if (error) { setSyncStatus(thoughtErrorMessage(error, "读取"), false); return; }
  const localPending = new Map(state.thoughts.filter((thought) => state.pendingThoughtUpserts.includes(thought.id)).map((thought) => [thought.id, thought]));
  const cloudThoughts = new Map(data.map((thought) => [thought.id, { id: thought.id, title: thought.title || deriveThoughtTitle(thought.content || ""), content: thought.content, createdAt: thought.created_at, updatedAt: thought.updated_at, syncState: "synced", syncError: "" }]));
  for (const [id, thought] of localPending) {
    const decision = conflictService.compare({ entityType: "thought", entityId: id, local: thought, cloud: cloudThoughts.get(id), localChanged: true });
    if (decision.outcome !== "cloud") cloudThoughts.set(id, thought);
  }
  for (const id of state.pendingThoughtDeletes) cloudThoughts.delete(id);
  state.thoughts = [...cloudThoughts.values()];
  saveLocal(); renderThoughts(); renderConflictDialog();
  await syncThoughtsToCloud();
}
async function prepareOwnerLogin() {
  if (!cloud || isOwner()) return;
  const button = $("#emailConfirmButton");
  button.disabled = true;
  try {
    let migration = pendingMigration();
    if (cloudUser?.is_anonymous) {
      try {
        setSyncStatus("正在同步迁移来源数据");
        const coreResult = await syncToCloud();
        if (!coreResult.ok) throw coreResult.error || new Error("任务或记录未能写入迁移来源");
        const booksResult = await syncBooksToCloud();
        if (!booksResult.success) throw booksResult.error || new Error("阅读数据未能写入迁移来源");
        const summariesResult = await syncPendingDailySummaries();
        if (!summariesResult.ok) throw summariesResult.error || new Error("总结未能写入迁移来源");
        const thoughtsResult = await syncThoughtsToCloud();
        if (!thoughtsResult.ok) throw thoughtsResult.error || new Error("思考未能写入迁移来源");
        setSyncStatus("正在准备迁移入口");
        migration = await migrationController.prepareMigration();
      } catch (error) {
        migrationService.abortMigration(error);
        setAuthMessage(`迁移准备失败：${error.message || "本地数据仍保留"}`, true);
        return;
      }
      await cloud.auth.signOut();
      cloudUser = null;
      sessionState = SESSION_STATE.SIGNED_OUT;
      updateAuthUI();
    }
    setSyncStatus("正在发送验证码");
    setAuthMessage("正在发送验证码…");
    const { error } = await cloud.auth.signInWithOtp({ email: OWNER_EMAIL, options: { shouldCreateUser: false } });
    if (error) {
      const classified = classifyAuthError(error);
      setSyncStatus(`验证码发送失败：${classified.message}`, false);
      setAuthMessage(classified.message, true);
      return;
    }
    setSyncStatus("验证码已发送");
    setAuthMessage("验证码已发送，请在邮件中查看后输入。验证码会过期，可重新发送。");
    $("#otpCode").focus();
  } finally { button.disabled = false; }
}
async function verifyOwnerOtp(event) {
  event.preventDefault();
  if (!cloud || isOwner()) return;
  const token = $("#otpCode").value.trim();
  if (!/^\d{8}$/.test(token)) { setAuthMessage("请输入邮件中的 8 位验证码。", true); return; }
  const button = $("#verifyOtpButton");
  button.disabled = true;
  setSyncStatus("正在验证验证码");
  setAuthMessage("正在验证验证码…");
  try {
    const { data, error } = await cloud.auth.verifyOtp({ email: OWNER_EMAIL, token, type: "email" });
    if (error) {
      const classified = classifyAuthError(error);
      if (classified.kind === "expired") {
        sessionState = SESSION_STATE.EXPIRED;
        updateAuthUI();
      } else {
        setSyncStatus(`验证码验证失败：${classified.message}`, false);
      }
      setAuthMessage(classified.message, true);
      return;
    }
    cloudUser = data.user || null;
    sessionState = SESSION_STATE.SIGNED_IN;
    $("#otpCode").value = "";
    setAuthMessage("验证成功，正在同步数据。");
    updateAuthUI();
  } finally { button.disabled = false; }
}
async function previewPendingMigration() {
  if (!cloudUser || cloudUser.is_anonymous || !isOwner() || !pendingMigration()) return null;
  return migrationController.preview(async () => {
    try {
      setSyncStatus("正在创建本地备份");
      await migrationController.createMigrationBackup();
      setSyncStatus("正在迁移云端数据");
      const result = await migrationController.executeMigration();
      if (!result.ok) throw result.error || new Error("迁移未完成");
      const coreResult = await syncToCloud();
      if (!coreResult.ok) throw coreResult.error || new Error("任务或记录迁移未完成");
      const booksResult = await syncBooksToCloud();
      if (!booksResult || booksResult.success !== true) throw booksResult?.error || new Error("阅读笔记或图片迁移未完成");
      const completion = await migrationController.completeMigration();
      if (!completion.ok) throw completion.error || new Error("云端迁移数量不一致");
      setSyncStatus("数据已迁移到指定邮箱", true);
    } catch (error) {
      migrationController.abortMigration(error);
      setAuthMessage("迁移未完成，请从备份恢复或重试。", true);
      throw error;
    }
  });
}
async function hydrateSignedInSession(session) {
  const sessionToken = session?.access_token || session?.user?.id;
  if (!sessionToken || hydratedSessionToken === sessionToken) return;
  hydratedSessionToken = sessionToken;
  const migrationReview = await previewPendingMigration();
  if (pendingMigration()) {
    if (migrationReview?.error) setAuthMessage("迁移未完成，请从备份恢复或重试。", true);
    setSyncStatus("迁移未完成，本机数据仍保留。", false);
    return;
  }
  await loadFromCloud();
  await loadBooksFromCloud();
  await loadThoughtsFromCloud();
}
async function handleAuthStateChange(event, session) {
  if (session?.user) {
    cloudUser = session.user;
    sessionState = SESSION_STATE.SIGNED_IN;
    updateAuthUI();
    if (event === "SIGNED_IN") broadcastAuthEvent("signed-in");
    if (event !== "TOKEN_REFRESHED") await hydrateSignedInSession(session);
    return;
  }

  cloudUser = null;
  hydratedSessionToken = null;
  if (manualSignOutRequested || Date.now() < explicitSignOutUntil) {
    sessionState = SESSION_STATE.SIGNED_OUT;
    manualSignOutRequested = false;
  } else if (event === "SIGNED_OUT" || event === "TOKEN_REFRESH_FAILED") {
    sessionState = SESSION_STATE.EXPIRED;
    broadcastAuthEvent("session-expired");
  } else {
    sessionState = SESSION_STATE.SIGNED_OUT;
  }
  updateAuthUI();
}
async function restoreCloudSession() {
  if (!cloud) return;
  try {
    const { data, error } = await cloud.auth.getSession();
    if (error) throw error;
    await handleAuthStateChange("INITIAL_SESSION", data.session);
  } catch (error) {
    cloudUser = null;
    sessionState = classifyAuthError(error).kind === "network" ? SESSION_STATE.OFFLINE : SESSION_STATE.EXPIRED;
    updateAuthUI();
  }
}
function registerNetworkListeners() {
  if (networkListenersRegistered) return;
  networkListenersRegistered = true;
  window.addEventListener("offline", () => {
    if (sessionState === SESSION_STATE.SIGNING_OUT) return;
    sessionState = SESSION_STATE.OFFLINE;
    updateAuthUI();
  });
  window.addEventListener("online", () => {
    if (!cloud) return;
    sessionState = SESSION_STATE.RESTORING;
    updateAuthUI();
    void restoreCloudSession();
    void durableSyncEngine?.run();
  });
}
function registerAuthChannel() {
  if (authChannel || !("BroadcastChannel" in window)) return;
  authChannel = new BroadcastChannel(AUTH_CHANNEL_NAME);
  authChannel.addEventListener("message", ({ data }) => {
    if (!data || !["signed-in", "signed-out", "session-expired"].includes(data.type)) return;
    if (data.type === "signed-in") {
      sessionState = SESSION_STATE.RESTORING;
      updateAuthUI();
      void restoreCloudSession();
      return;
    }
    cloudUser = null;
    hydratedSessionToken = null;
    if (data.type === "signed-out") {
      explicitSignOutUntil = Date.now() + 3000;
      sessionState = SESSION_STATE.SIGNED_OUT;
      setAuthMessage("已在另一标签页退出登录，本机数据仍保留。");
    } else {
      sessionState = SESSION_STATE.EXPIRED;
      setAuthMessage("会话已在另一标签页过期，请重新登录。本机数据仍保留。", true);
    }
    updateAuthUI();
  });
}
async function initCloud() {
  if (!cloud) {
    sessionState = SESSION_STATE.UNAVAILABLE;
    updateAuthUI();
    return;
  }
  captureMigrationFromUrl();
  sessionState = SESSION_STATE.RESTORING;
  updateAuthUI();
  registerNetworkListeners();
  registerAuthChannel();
  initDurableSyncQueue();
  await restoreCloudSession();
  cloud.auth.onAuthStateChange((event, session) => {
    // Defer asynchronous work so the auth client can finish its own state transition first.
    queueMicrotask(() => { void handleAuthStateChange(event, session); });
  });
}
async function startAnonymousSession() {
  if (!cloud) return;
  sessionState = SESSION_STATE.RESTORING;
  updateAuthUI();
  const { data, error } = await cloud.auth.signInAnonymously();
  if (error) {
    sessionState = classifyAuthError(error).kind === "network" ? SESSION_STATE.OFFLINE : SESSION_STATE.SIGNED_OUT;
    updateAuthUI();
    return;
  }
  cloudUser = data.user;
  sessionState = SESSION_STATE.SIGNED_IN;
  updateAuthUI();
  await hydrateSignedInSession(data.session || { user: data.user });
}
async function signOut() {
  if (!cloud) return;
  manualSignOutRequested = true;
  explicitSignOutUntil = Date.now() + 3000;
  sessionState = SESSION_STATE.SIGNING_OUT;
  updateAuthUI();
  const { error } = await cloud.auth.signOut();
  if (error) {
    manualSignOutRequested = false;
    explicitSignOutUntil = 0;
    sessionState = classifyAuthError(error).kind === "network" ? SESSION_STATE.OFFLINE : SESSION_STATE.SIGNED_IN;
    updateAuthUI();
    setAuthMessage(classifyAuthError(error).message, true);
    return;
  }
  cloudUser = null;
  hydratedSessionToken = null;
  sessionState = SESSION_STATE.SIGNED_OUT;
  updateAuthUI();
  setAuthMessage("已退出登录，本机数据仍保留。");
  broadcastAuthEvent("signed-out");
}
function updateAuthUI() {
  const pending = !!pendingMigration();
  const signedIn = isOwner();
  $("#syncBar").dataset.authState = sessionState;
  $("#authPanel").hidden = signedIn;
  $("#emailConfirmButton").textContent = pending ? "重新发送验证码" : "发送验证码";
  $("#retrySyncButton").hidden = !cloudUser;
  $("#retrySyncButton").textContent = "立即同步";
  $("#signOutButton").hidden = !cloudUser;
  const status = {
    [SESSION_STATE.RESTORING]: ["正在恢复登录", false],
    [SESSION_STATE.SIGNED_IN]: [signedIn ? "已登录 QQ 邮箱" : "已登录，正在迁移旧数据", signedIn],
    [SESSION_STATE.EXPIRED]: ["会话已过期，请重新登录。本机数据仍保留", false],
    [SESSION_STATE.SIGNING_OUT]: ["正在退出登录", false],
    [SESSION_STATE.SIGNED_OUT]: ["未登录，本机数据仍保留", false],
    [SESSION_STATE.OFFLINE]: ["网络不可用，本机数据仍保留", false],
    [SESSION_STATE.UNAVAILABLE]: ["本机模式，本机数据仍保留", false]
  }[sessionState] || ["未登录，本机数据仍保留", false];
  setSyncStatus(status[0], status[1]);
}

function showView(name) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === name));
  document.querySelectorAll(".view").forEach((section) => section.classList.toggle("is-visible", section.id === `${name}View`));
  if (name === "thoughts") updateThoughtExpanders();
}

function renderTasks() {
  const tasks = state.tasks.filter((task) => task.date === selectedDate);
  const list = $("#taskList");
  list.innerHTML = tasks.map((task) => `
    <div class="task-item">
      <input class="check" type="checkbox" ${task.done ? "checked" : ""} data-task-check="${task.id}" aria-label="完成任务" />
      <div class="item-main"><div class="item-title ${task.done ? "done" : ""}">${escapeHtml(task.title)}</div>${task.time ? `<div class="item-meta">预计 ${task.time}</div>` : ""}</div>
      <button class="delete-button" type="button" data-task-delete="${task.id}" aria-label="删除任务" title="删除任务">×</button>
    </div>`).join("");
  $("#taskEmpty").hidden = tasks.length > 0;
  $("#taskProgress").textContent = `${tasks.filter((task) => task.done).length} / ${tasks.length}`;
}

function renderRecords() {
  const records = state.records.filter((record) => record.date === selectedDate).sort((a, b) => a.start.localeCompare(b.start));
  $("#recordList").innerHTML = records.map((record) => { const category = categories[record.category] || categories.fun; return `
    <div class="record-item" data-record-card="${record.id}" style="--category:${category.color}"><div class="record-time">${record.start} - ${record.end}</div><div class="item-main"><div class="item-title">${escapeHtml(record.title)}</div><div class="item-meta">${category.label}</div></div><div class="record-actions"><button class="edit-button" type="button" data-record-edit="${record.id}" aria-label="编辑记录" title="编辑记录">✎</button><button class="delete-button" type="button" data-record-delete="${record.id}" aria-label="删除记录" title="删除记录">×</button></div></div>`; }).join("");
  $("#recordEmpty").hidden = records.length > 0;
  const total = records.reduce((sum, record) => sum + Math.max(0, minutes(record.end) - minutes(record.start)), 0);
  $("#timeTotal").textContent = `${(total / 60).toFixed(total % 60 ? 1 : 0)} 小时`;
}

function renderDateControls() {
  $("#timelineDateLabel").textContent = formatDate(selectedDate);
  $("#todayLabel").textContent = formatDate(selectedDate);
  $("#tasksHeading").textContent = selectedDate === todayKey() ? "今天准备做什么？" : "这一天准备做什么？";
  $("#nextDateButton").disabled = false;
}
function setSelectedDate(value) {
  if (!value) return;
  selectedDate = value;
  calendarMonth = new Date(dateFromKey(value).getFullYear(), dateFromKey(value).getMonth(), 1);
  const url = new URL(window.location.href);
  url.searchParams.set("date", value);
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  renderDateControls(); renderTasks(); renderRecords(); renderDailySummaries(); renderStats(); renderBooks(); renderThoughts();
}
function activeDateKeys() {
  return new Set([
    ...state.records.map((record) => record.date),
    ...state.dailySummaries.filter((summary) => summary.content?.trim()).map((summary) => summary.date),
    ...state.tasks.map((task) => task.date),
    ...state.thoughts.map((thought) => thought.date || localDateKey(new Date(thought.createdAt)))
  ]);
}
function renderCalendar() {
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const activeDates = activeDateKeys();
  $("#calendarMonthLabel").textContent = `${year}年${month + 1}月`;
  $("#nextMonthButton").disabled = false;
  $("#calendarGrid").innerHTML = `${"<span></span>".repeat(firstDay)}${Array.from({ length: days }, (_, index) => {
    const day = index + 1;
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const selected = key === selectedDate ? " is-selected" : "";
    const current = key === todayKey() ? " is-today" : "";
    return `<button class="calendar-day${selected}${current}" type="button" data-calendar-date="${key}">${day}${activeDates.has(key) ? '<span class="calendar-dot"></span>' : ""}</button>`;
  }).join("")}`;
}
function renderDailySummaries() {
  $("#summaryList").innerHTML = summaryPrompts.map((prompt, index) => {
    const slot = index + 1;
    const summary = state.dailySummaries.find((item) => item.date === selectedDate && item.slot === slot);
    if (!summary) return `<form class="summary-card" data-summary-form="${slot}"><label for="summary-${slot}">${prompt}</label><textarea id="summary-${slot}" data-summary-input="${slot}" maxlength="500" placeholder="写下这一句"></textarea><div class="summary-footer"><span class="char-count" data-summary-count="${slot}">0 / 500</span><button class="primary-button" type="submit">保存</button></div></form>`;
    const sync = summarySyncMeta(summary);
    const retryAction = summary.pendingAction === "delete" ? "删除重试" : "重试";
    return `<article class="summary-card summary-card--saved ${summary.syncState === "failed" ? "summary-card--failed" : ""}"><div class="summary-card-header"><label>${prompt}</label><span class="summary-status ${sync.tone}">${sync.text}</span></div><p class="summary-copy">${escapeHtml(summary.content)}</p><div class="summary-card-footer"><span>${summaryTime(summary)}</span><div class="summary-actions">${summary.syncState === "failed" ? `<button class="text-button" type="button" data-summary-retry="${summary.id}">${retryAction}</button>` : ""}<button class="text-button" type="button" data-summary-edit="${summary.id}">编辑</button><button class="delete-button" type="button" data-summary-delete="${summary.id}" aria-label="删除总结" title="删除总结">×</button></div></div></article>`;
  }).join("");
}

function renderChart(donutId, legendId, centerId, data) {
  const total = data.reduce((sum, item) => sum + item.value, 0);
  let cursor = 0;
  const stops = data.map((item) => { const start = total ? cursor / total * 100 : 0; cursor += item.value; const end = total ? cursor / total * 100 : 0; return `${item.color} ${start}% ${end}%`; }).join(", ");
  $("#" + donutId).style.background = total ? `conic-gradient(${stops})` : "conic-gradient(#e3e0d8 0 100%)";
  $("#" + centerId).textContent = `${(total / 60).toFixed(total % 60 ? 1 : 0)}h`;
  $("#" + legendId).innerHTML = data.map((item) => `<div class="legend-row"><span class="legend-dot" style="background:${item.color}"></span><span>${item.label}</span><strong>${(item.value / 60).toFixed(item.value % 60 ? 1 : 0)}h</strong></div>`).join("");
}

function renderStats() {
  const daily = state.records.filter((record) => record.date === selectedDate);
  const dailyData = categoryData(daily);
  const allData = categoryData(state.records);
  const allTotal = allData.reduce((sum, item) => sum + item.value, 0);
  $("#statsDateLabel").textContent = formatDate(selectedDate);
  $("#dailyStatsLabel").textContent = selectedDate === todayKey() ? "今天" : formatDate(selectedDate);
  const dailyTotal = dailyData.reduce((sum, item) => sum + item.value, 0);
  $("#statsTotal").textContent = `${(dailyTotal / 60).toFixed(dailyTotal % 60 ? 1 : 0)} 小时`;
  renderChart("dailyDonut", "dailyLegend", "dailyTotal", dailyData);
  renderChart("totalDonut", "totalLegend", "allTotal", allData);
}

function thoughtTimeLabel(thought) {
  const updated = thought.updatedAt && thought.updatedAt !== thought.createdAt;
  return updated ? `最后编辑于 ${formatDateTime(thought.updatedAt)}` : `记录于 ${formatDateTime(thought.createdAt)}`;
}
function thoughtStatusClass(thought) {
  return thought.syncState === "failed" ? "is-failed" : thought.syncState === "synced" ? "is-synced" : "";
}
function thoughtActionControl(thought) {
  const isOpen = activeThoughtMenuId === thought.id;
  return `<div class="thought-action-wrap"><button class="thought-action-button" type="button" data-thought-menu="${thought.id}" aria-label="编辑或删除" title="编辑或删除" aria-expanded="${isOpen}"><span class="visually-hidden">编辑或删除</span></button>${isOpen ? `<div class="thought-action-menu"><button type="button" data-thought-edit="${thought.id}">编辑</button><button class="is-danger" type="button" data-thought-delete="${thought.id}">删除</button></div>` : ""}</div>`;
}
function updateThoughtExpanders() {
  requestAnimationFrame(() => {
    document.querySelectorAll("[data-thought-copy]").forEach((copy) => {
      const button = document.querySelector(`[data-thought-expand="${copy.dataset.thoughtCopy}"]`);
      if (!button) return;
      const expanded = expandedThoughtIds.has(copy.dataset.thoughtCopy);
      button.hidden = !expanded && copy.scrollHeight <= copy.clientHeight + 1;
      button.textContent = expanded ? "收起" : "显示全部";
    });
  });
}
function renderThoughts() {
  const thoughts = [...state.thoughts].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  $("#thoughtList").innerHTML = thoughts.map((thought) => `<article class="thought-card" data-thought-open="${thought.id}" role="button" tabindex="0"><div class="thought-card-header"><div class="thought-card-ident"><span class="thought-card-date">${formatDateTime(thought.createdAt)}</span><span class="thought-card-title">${escapeHtml(thought.title || deriveThoughtTitle(thought.content || ""))}</span></div><div class="thought-card-status"><span class="summary-status ${thoughtStatusClass(thought)}">${thoughtSyncMeta(thought)}</span>${thoughtActionControl(thought)}</div></div><p class="thought-card-copy ${expandedThoughtIds.has(thought.id) ? "is-expanded" : ""}" data-thought-copy="${thought.id}">${escapeHtml(thought.content)}</p><div class="thought-card-footer"><span>${thoughtTimeLabel(thought)}</span><div class="thought-card-actions">${thought.syncState === "failed" ? `<button class="text-button" type="button" data-thought-retry="${thought.id}">重试</button>` : ""}<button class="text-button thought-expand-button" type="button" data-thought-expand="${thought.id}" hidden>显示全部</button></div></div></article>`).join("");
  $("#thoughtEmpty").hidden = thoughts.length > 0;
  const hasFailed = thoughts.some((thought) => thought.syncState === "failed");
  const hasLocal = thoughts.some((thought) => thought.syncState === "local");
  $("#thoughtSaveStatus").textContent = hasFailed ? "有思考尚未保存" : hasLocal ? "仅本机保存" : thoughts.length ? "已同步" : "";
  updateThoughtExpanders();
}
function openThought(id) {
  const thought = state.thoughts.find((item) => item.id === id);
  if (!thought) return;
  $("#thoughtDialogContent").innerHTML = `<div class="dialog-heading"><div><p class="date-label">${formatDateTime(thought.createdAt)}</p><h3>${escapeHtml(thought.title || deriveThoughtTitle(thought.content || ""))}</h3></div><div class="thought-card-status"><span class="summary-status ${thoughtStatusClass(thought)}">${thoughtSyncMeta(thought)}</span>${thoughtActionControl(thought)}<button class="delete-button" type="button" data-thought-close aria-label="关闭阅读" title="关闭">×</button></div></div><p class="thought-dialog-copy">${escapeHtml(thought.content)}</p><div class="thought-dialog-footer"><span class="thought-dialog-meta">${thoughtTimeLabel(thought)}</span></div>`;
  if (!$("#thoughtDialog").open) $("#thoughtDialog").showModal();
}
function openThoughtEditor(id) {
  const thought = state.thoughts.find((item) => item.id === id);
  if (!thought) return;
  $("#thoughtEditForm").dataset.thoughtId = id;
  $("#thoughtEditDate").textContent = formatDateTime(thought.createdAt);
  $("#thoughtEditTitle").value = thought.title || deriveThoughtTitle(thought.content || "");
  $("#thoughtEditContent").value = thought.content;
  $("#thoughtEditStatus").textContent = thoughtSyncMeta(thought);
  if ($("#thoughtDialog").open) $("#thoughtDialog").close();
  $("#thoughtEditDialog").showModal();
}
async function saveThought(event) {
  event.preventDefault();
  const title = $("#thoughtTitle").value.trim();
  const content = $("#thoughtContent").value.trim();
  if (!title || !content) return;
  const now = new Date().toISOString();
  const createdAt = `${selectedDate}T12:00:00.000Z`;
  const thought = { id: uid(), title, content, date: selectedDate, createdAt, updatedAt: now, syncState: cloudUser ? "syncing" : "local", syncError: "" };
  state.thoughts.unshift(thought);
  queueThoughtUpsert(thought.id);
  saveLocal();
  event.currentTarget.reset();
  renderThoughts();
  await syncThoughtToCloud(thought);
}
async function saveThoughtEdit(event) {
  event.preventDefault();
  const thought = state.thoughts.find((item) => item.id === event.currentTarget.dataset.thoughtId);
  const title = $("#thoughtEditTitle").value.trim();
  const content = $("#thoughtEditContent").value.trim();
  if (!thought || !title || !content) return;
  thought.title = title;
  thought.content = content;
  thought.updatedAt = new Date().toISOString();
  thought.syncState = cloudUser ? "syncing" : "local";
  thought.syncError = "";
  queueThoughtUpsert(thought.id);
  saveLocal();
  $("#thoughtEditDialog").close();
  renderThoughts();
  await syncThoughtToCloud(thought);
}
async function removeThought(id) {
  const thought = state.thoughts.find((item) => item.id === id);
  if (!thought || !window.confirm("删除后无法恢复，确定删除这篇思考吗？")) return;
  state.thoughts = state.thoughts.filter((item) => item.id !== id);
  activeThoughtMenuId = null;
  expandedThoughtIds.delete(id);
  queueThoughtDelete(id);
  saveLocal();
  if ($("#thoughtDialog").open) $("#thoughtDialog").close();
  if ($("#thoughtEditDialog").open) $("#thoughtEditDialog").close();
  renderThoughts();
  await deleteThoughtFromCloud(id);
}

function stars(rating) { return [1, 2, 3, 4, 5].map((value) => `<button class="star-button ${value <= rating ? "is-on" : ""}" type="button" data-rate="${value}" aria-label="${value} 星">★</button>`).join(""); }
function noteActionControl(note, type) {
  const isOpen = activeNoteMenuId === note.id;
  return `<div class="note-action-wrap"><button class="note-action-button" type="button" data-note-menu="${note.id}" aria-label="编辑或删除${type}" title="编辑或删除" aria-expanded="${isOpen}"><span aria-hidden="true">⋯</span><span class="visually-hidden">编辑或删除</span></button>${isOpen ? `<div class="note-action-menu"><button type="button" data-note-edit="${note.id}" data-note-type="${type}">编辑</button><button class="is-danger" type="button" data-note-delete="${note.id}" data-note-type="${type}">删除</button></div>` : ""}</div>`;
}
function noteItem(note, type) {
  const kind = type === "书摘" ? "excerpt" : "reflection";
  const expanded = expandedNoteIds.has(note.id);
  const text = note.text ? `<p class="note-text">${escapeHtml(note.text)}</p>` : "";
  const image = note.image ? `<div class="excerpt-media" data-note-media="${note.id}"><img src="${note.image}" alt="${type}图片" /></div>` : "";
  return `<article class="note-item note-item--${kind}"><div class="note-copy ${expanded ? "is-expanded" : ""}" data-note-copy="${note.id}">${text}${image}</div>${noteActionControl(note, type)}<div class="note-footer"><button class="text-button note-expand-button" type="button" data-note-expand="${note.id}" hidden>展开完整内容</button></div></article>`;
}
function updateNoteExpanders() {
  requestAnimationFrame(() => {
    document.querySelectorAll("[data-note-copy]").forEach((copy) => {
      const id = copy.dataset.noteCopy;
      const button = document.querySelector(`[data-note-expand="${id}"]`);
      if (!button) return;
      const media = copy.querySelector("[data-note-media]");
      const expanded = expandedNoteIds.has(id);
      const textOverflow = copy.scrollHeight > copy.clientHeight + 1;
      const mediaOverflow = media && media.scrollHeight > media.clientHeight + 1;
      button.hidden = !expanded && !textOverflow && !mediaOverflow;
      button.textContent = expanded ? "收起" : "展开完整内容";
    });
  });
}
function centerSelectedBookCard(behavior = "auto") {
  const card = document.querySelector(`[data-book-card="${selectedBookId}"][data-book-copy="middle"]`);
  if (card) card.scrollIntoView({ behavior, block: "nearest", inline: "center" });
}
function highlightCenteredBookCard(viewport) {
  const center = viewport.scrollLeft + viewport.clientWidth / 2;
  const card = [...viewport.querySelectorAll("[data-book-card]")].sort((a, b) => Math.abs(a.offsetLeft + a.offsetWidth / 2 - center) - Math.abs(b.offsetLeft + b.offsetWidth / 2 - center))[0];
  viewport.querySelectorAll("[data-book-card]").forEach((item) => item.classList.toggle("is-selected", item === card));
  return card;
}
function bookCarouselDots() {
  return state.books.map((book) => `<button class="book-carousel-dot ${book.id === selectedBookId ? "is-active" : ""}" type="button" data-book-select="${book.id}" aria-label="查看《${escapeHtml(book.title)}》"></button>`).join("");
}
function renderBooks() {
  const list = $("#bookList");
  const layout = $(".book-layout");
  const hasBooks = state.books.length > 0;
  layout.classList.toggle("is-empty", !hasBooks);
  $("#bookDetail").hidden = !hasBooks;
  if (!hasBooks) { list.innerHTML = '<div class="book-empty">书架还是空的</div>'; return; }
  if (!state.books.some((book) => book.id === selectedBookId)) selectedBookId = state.books[0].id;
  $("#bookCarouselDots").innerHTML = bookCarouselDots();
  const repeatedBooks = [...state.books, ...state.books, ...state.books];
  list.innerHTML = repeatedBooks.map((book, index) => {
    const copy = index < state.books.length ? "before" : index < state.books.length * 2 ? "middle" : "after";
    return `<article class="book-card ${copy === "middle" && book.id === selectedBookId ? "is-selected" : ""}" data-book-card="${book.id}" data-book-copy="${copy}"><div class="book-card-top"><span class="book-card-actions"><button class="book-card-action" type="button" data-book-edit="${book.id}" aria-label="编辑书籍" title="编辑">✎</button><button class="book-card-action is-danger" type="button" data-book-delete="${book.id}" aria-label="删除书籍" title="删除">×</button></span></div><div class="book-card-copy" data-book-select="${book.id}"><strong>${escapeHtml(book.title)}</strong><small>${escapeHtml(book.author || "未填写作者")}</small><span class="book-stars">${stars(book.rating || 0)}</span></div></article>`;
  }).join("");
  centerSelectedBookCard();
  const book = state.books.find((item) => item.id === selectedBookId);
  if (!book) return;
  const excerpts = (book.excerpts || []).map((note) => noteItem(note, "书摘")).join("") || '<p class="note-empty">还没有书摘</p>';
  const reflections = (book.reflections || []).map((note) => noteItem(note, "心得")).join("") || '<p class="note-empty">还没有读书心得</p>';
  const editedExcerpt = (book.excerpts || []).find((note) => note.id === editingExcerptId) || null;
  const editedReflection = (book.reflections || []).find((note) => note.id === editingReflectionId) || null;
  if (!editedExcerpt) editingExcerptId = null;
  if (!editedReflection) editingReflectionId = null;
  $("#bookDetail").innerHTML = `<div class="note-section note-section--excerpt"><div class="note-section-title"><h4>书摘</h4><span>截图或文字片段</span></div><form class="note-form" id="excerptForm"><textarea id="excerptText" placeholder="摘下让你停下来的那一段文字">${escapeHtml(editedExcerpt?.text || "")}</textarea><label class="upload-button">上传截图<input id="excerptImage" type="file" accept="image/*" /></label><button class="primary-button" type="submit">${editedExcerpt ? "保存修改" : "发布书摘"}</button>${editedExcerpt ? '<button class="text-button" type="button" data-note-cancel="excerpt">取消编辑</button>' : ""}</form><div class="note-list">${excerpts}</div></div><div class="note-section note-section--reflection"><div class="note-section-title"><h4>读书心得</h4><span>你的理解与延伸</span></div><form class="note-form" id="reflectionForm"><textarea id="reflectionText" maxlength="1600" placeholder="这本书给你留下了什么？">${escapeHtml(editedReflection?.text || "")}</textarea><label class="upload-button">上传图片<input id="reflectionImage" type="file" accept="image/*" /></label><button class="primary-button" type="submit">${editedReflection ? "保存修改" : "发布心得"}</button>${editedReflection ? '<button class="text-button" type="button" data-note-cancel="reflection">取消编辑</button>' : ""}</form><div class="note-list">${reflections}</div></div>`;
  updateNoteExpanders();
  document.querySelectorAll("[data-note-media] img").forEach((image) => image.addEventListener("load", updateNoteExpanders, { once: true }));
}
function imageData(file) { return new Promise((resolve) => { if (!file) return resolve(""); const reader = new FileReader(); reader.onload = () => { const image = new Image(); image.onload = () => { const max = 1200; const scale = Math.min(1, max / Math.max(image.width, image.height)); const canvas = document.createElement("canvas"); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale); canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height); resolve(canvas.toDataURL("image/jpeg", .82)); }; image.src = reader.result; }; reader.readAsDataURL(file); }); }
function saveBooks() { state.pendingBookSync = true; persistSyncOperation("book", selectedBookId || "library", "upsert"); saveLocal(); renderBooks(); syncBooksToCloud(); }
function openBookEditor(id) { const book = state.books.find((item) => item.id === id); if (!book) return; $("#bookEditForm").dataset.bookId = id; $("#bookEditTitle").value = book.title; $("#bookEditAuthor").value = book.author || ""; $("#bookEditDialog").showModal(); }
async function saveBookEdit(event) { event.preventDefault(); const book = state.books.find((item) => item.id === event.currentTarget.dataset.bookId); const title = $("#bookEditTitle").value.trim(); if (!book || !title) return; book.title = title; book.author = $("#bookEditAuthor").value.trim(); persistSyncOperation("book", book.id, "upsert"); saveLocal(); renderBooks(); $("#bookEditDialog").close(); const result = await updateBookInCloud(book); showToast(result.ok || result.local ? "书籍修改成功" : "书籍修改失败"); }
async function removeBook(id) { const book = state.books.find((item) => item.id === id); if (!book || !window.confirm(`确定删除《${book.title}》及其全部书摘和心得吗？`)) return; persistSyncOperation("book", id, "delete", cloneSyncPayload(book)); state.books = state.books.filter((item) => item.id !== id); selectedBookId = state.books[0]?.id || null; saveLocal(); renderBooks(); const result = await deleteBookFromCloud(book); showToast(result.ok || result.local ? "书籍及笔记已删除" : "删除失败，请重试"); }

function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
function openRecordEditor(id) {
  const record = state.records.find((item) => item.id === id);
  if (!record) return;
  $("#recordEditForm").dataset.recordId = id;
  $("#recordEditDate").textContent = formatDate(record.date);
  $("#recordEditStart").value = record.start;
  $("#recordEditEnd").value = record.end;
  $("#recordEditCategory").value = record.category || "fun";
  updateCategorySwatch("#recordEditCategory", "#recordEditCategorySwatch");
  $("#recordEditTitle").value = record.title;
  $("#recordDialog").showModal();
}
async function saveRecordEdit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const record = state.records.find((item) => item.id === form.dataset.recordId);
  const title = $("#recordEditTitle").value.trim();
  const start = $("#recordEditStart").value;
  const end = $("#recordEditEnd").value;
  if (!record || !title || !start || !end || minutes(end) <= minutes(start)) {
    setSyncStatus("请填写内容，并确认结束时间晚于开始时间");
    return;
  }
  record.title = title;
  record.start = start;
  record.end = end;
  record.category = $("#recordEditCategory").value;
  queueRecordUpsert(record.id);
  saveLocal();
  $("#recordDialog").close();
  renderRecords(); renderStats(); renderDateControls();
  await syncRecordToCloud(record);
}
async function saveDailySummary(event) {
  event.preventDefault();
  const form = event.target;
  const slot = Number(form.dataset.summaryForm);
  const content = form.querySelector("textarea").value.trim();
  if (!content || content.length > 500) { setSyncStatus("总结内容需要在 1 至 500 字之间"); return; }
  const summary = { id: uid(), date: selectedDate, slot, content, savedAt: new Date().toISOString(), syncState: cloudUser ? "syncing" : "local", syncError: "" };
  state.dailySummaries.push(summary);
  persistSyncOperation("summary", summary.id, "upsert");
  saveLocal(); renderDailySummaries(); renderDateControls();
  await syncDailySummaryToCloud(summary);
}

function openSummaryEditor(id) {
  const summary = state.dailySummaries.find((item) => item.id === id);
  if (!summary) return;
  $("#summaryEditForm").dataset.summaryId = id;
  $("#summaryEditDate").textContent = formatDate(summary.date);
  $("#summaryEditPrompt").textContent = summaryPrompts[summary.slot - 1];
  $("#summaryEditContent").value = summary.content;
  $("#summaryEditCount").textContent = `${summary.content.length} / 500`;
  $("#summaryDialog").showModal();
}
async function saveSummaryEdit(event) {
  event.preventDefault();
  const summary = state.dailySummaries.find((item) => item.id === event.currentTarget.dataset.summaryId);
  const content = $("#summaryEditContent").value.trim();
  if (!summary || !content || content.length > 500) { setSyncStatus("总结内容需要在 1 至 500 字之间"); return; }
  summary.content = content;
  summary.savedAt = new Date().toISOString();
  summary.pendingAction = "";
  summary.syncState = cloudUser ? "syncing" : "local";
  summary.syncError = "";
  persistSyncOperation("summary", summary.id, "upsert");
  saveLocal(); $("#summaryDialog").close(); renderDailySummaries(); renderDateControls();
  await syncDailySummaryToCloud(summary);
}
async function removeDailySummary(id, confirmed = false) {
  const summary = state.dailySummaries.find((item) => item.id === id);
  if (!summary || (!confirmed && !window.confirm("确定删除这条总结吗？删除后无法恢复。"))) return;
  summary.syncState = "syncing";
  summary.pendingAction = "delete";
  summary.syncError = "";
  persistSyncOperation("summary", summary.id, "delete", { ...summary });
  saveLocal(); renderDailySummaries();
  const result = await deleteDailySummaryFromCloud(summary);
  if (!result.ok) return;
  state.dailySummaries = state.dailySummaries.filter((item) => item.id !== id);
  saveLocal(); renderDailySummaries(); renderDateControls();
}

$("#todayLabel").textContent = formatDate(selectedDate);
$("#emailConfirmButton").addEventListener("click", prepareOwnerLogin);
$("#otpForm").addEventListener("submit", verifyOwnerOtp);
$("#retrySyncButton").addEventListener("click", async () => {
  if (cloudUser) {
    if (pendingMigration()) {
      await previewPendingMigration();
      if (pendingMigration()) return;
    }
    const results = [
      await syncToCloud(),
      await syncBooksToCloud(),
      await syncThoughtsToCloud(),
      await syncPendingDailySummaries()
    ];
    if (results.every((result) => result.ok)) setSyncStatus("已同步", true);
    else setSyncStatus("仍有待同步数据，请恢复网络或重新登录后重试。", false);
  } else {
    await prepareOwnerLogin();
  }
});
$("#conflictButton").addEventListener("click", openConflictDialog);
$("#signOutButton").addEventListener("click", () => { void signOut(); });
$("#syncStatusButton").addEventListener("click", () => { $("#retrySyncButton").click(); });
$("#accountMenuButton").addEventListener("click", () => {
  const menu = $("#accountMenu");
  const isOpen = !menu.hidden;
  menu.hidden = isOpen;
  $("#accountMenuButton").setAttribute("aria-expanded", String(!isOpen));
});
document.addEventListener("click", (event) => {
  if (event.target.closest(".account-menu-wrap")) return;
  $("#accountMenu").hidden = true;
  $("#accountMenuButton").setAttribute("aria-expanded", "false");
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  $("#accountMenu").hidden = true;
  $("#accountMenuButton").setAttribute("aria-expanded", "false");
});
$("#thoughtForm").addEventListener("submit", saveThought);
$("#thoughtEditForm").addEventListener("submit", saveThoughtEdit);
$("#thoughtEditClose").addEventListener("click", () => $("#thoughtEditDialog").close());
$("#bookEditForm").addEventListener("submit", saveBookEdit);
$("#bookEditClose").addEventListener("click", () => $("#bookEditDialog").close());
$("#newBookClose").addEventListener("click", () => $("#newBookDialog").close());
$("#exportDataButton").addEventListener("click", exportAllData);
$("#newBookButton").addEventListener("click", () => { $("#newBookForm").reset(); $("#newBookDialog").showModal(); });
$("#bookCarouselViewport").addEventListener("scroll", () => {
  clearTimeout(bookScrollTimer);
  const viewport = $("#bookCarouselViewport");
  const cards = [...viewport.querySelectorAll("[data-book-card]")];
  const count = state.books.length;
  if (count > 0 && cards.length >= count * 2) {
    const cycleWidth = cards[count].offsetLeft - cards[0].offsetLeft;
    if (viewport.scrollLeft < cycleWidth * .5) viewport.scrollLeft += cycleWidth;
    else if (viewport.scrollLeft > cycleWidth * 1.5) viewport.scrollLeft -= cycleWidth;
  }
  bookScrollTimer = setTimeout(() => {
    const card = highlightCenteredBookCard(viewport);
    if (card && card.dataset.bookCard !== selectedBookId) { selectedBookId = card.dataset.bookCard; renderBooks(); }
  }, 120);
});
document.addEventListener("click", (event) => {
  const noteMenu = event.target.closest("[data-note-menu]");
  if (noteMenu) { const id = noteMenu.dataset.noteMenu; activeNoteMenuId = activeNoteMenuId === id ? null : id; renderBooks(); return; }
  const noteExpand = event.target.closest("[data-note-expand]");
  if (noteExpand) { const id = noteExpand.dataset.noteExpand; if (expandedNoteIds.has(id)) expandedNoteIds.delete(id); else expandedNoteIds.add(id); renderBooks(); return; }
  if (activeNoteMenuId && !event.target.closest(".note-action-wrap")) { activeNoteMenuId = null; renderBooks(); }
  const star = event.target.closest("[data-rate]");
  if (star) { const book = state.books.find((item) => item.id === selectedBookId); if (book) { book.rating = Number(star.dataset.rate); saveBooks(); } return; }
  const bookButton = event.target.closest("[data-book-select]");
  if (bookButton) { selectedBookId = bookButton.dataset.bookSelect; renderBooks(); return; }
  const bookEdit = event.target.closest("[data-book-edit]");
  if (bookEdit) { openBookEditor(bookEdit.dataset.bookEdit); return; }
  const bookDelete = event.target.closest("[data-book-delete]");
  if (bookDelete) { removeBook(bookDelete.dataset.bookDelete); return; }
  const noteEdit = event.target.closest("[data-note-edit]");
  if (noteEdit) { const isExcerpt = noteEdit.dataset.noteType === "书摘"; activeNoteMenuId = null; if (isExcerpt) editingExcerptId = noteEdit.dataset.noteEdit; else editingReflectionId = noteEdit.dataset.noteEdit; renderBooks(); $(isExcerpt ? "#excerptText" : "#reflectionText")?.focus(); return; }
  const noteCancel = event.target.closest("[data-note-cancel]");
  if (noteCancel) { if (noteCancel.dataset.noteCancel === "excerpt") editingExcerptId = null; else editingReflectionId = null; renderBooks(); return; }
  const deleteNote = event.target.closest("[data-note-delete]");
  if (deleteNote) { const book = state.books.find((item) => item.id === selectedBookId); if (book) { const field = deleteNote.dataset.noteType === "书摘" ? "excerpts" : "reflections"; const note = (book[field] || []).find((item) => item.id === deleteNote.dataset.noteDelete); if (note) persistSyncOperation("reading-note", note.id, "delete", cloneSyncPayload(note)); expandedNoteIds.delete(deleteNote.dataset.noteDelete); activeNoteMenuId = null; book[field] = (book[field] || []).filter((item) => item.id !== deleteNote.dataset.noteDelete); saveBooks(); if (note) deleteNoteFromCloud(note); } }
});
document.addEventListener("submit", async (event) => {
  if (event.target.matches("[data-summary-form]")) { await saveDailySummary(event); return; }
  if (event.target.id === "newBookForm") { event.preventDefault(); const title = $("#bookTitle").value.trim(); if (!title) return; const book = { id: uid(), title, author: $("#bookAuthor").value.trim(), rating: 0, excerpts: [], reflections: [] }; state.books.push(book); selectedBookId = book.id; saveBooks(); $("#newBookDialog").close(); showToast("书籍已创建"); return; }
  if (!["excerptForm", "reflectionForm"].includes(event.target.id)) return;
  event.preventDefault(); const book = state.books.find((item) => item.id === selectedBookId); if (!book) return; const isExcerpt = event.target.id === "excerptForm"; const type = isExcerpt ? "excerpt" : "reflection"; const text = $(isExcerpt ? "#excerptText" : "#reflectionText").value.trim(); const image = await imageData($(isExcerpt ? "#excerptImage" : "#reflectionImage").files[0]); const field = isExcerpt ? "excerpts" : "reflections"; const editingId = isExcerpt ? editingExcerptId : editingReflectionId; const editedNote = (book[field] || []).find((note) => note.id === editingId); if (!text && !image && !editedNote) return; const note = editedNote || { id: uid(), text: "", image: "" }; note.text = text; note.updatedAt = new Date().toISOString(); if (image) note.image = image; book[field] = editedNote ? (book[field] || []).map((item) => item.id === note.id ? note : item) : [note, ...(book[field] || [])]; if (isExcerpt) editingExcerptId = null; else editingReflectionId = null; persistSyncOperation("reading-note", note.id, "upsert"); saveLocal(); renderBooks(); const result = await saveReadingNote(book, type, note, text, image || note.image); if (!result.ok && !result.local) showToast(`保存失败：${result.error?.message || "网络或权限异常"}`); else showToast(editedNote ? `${isExcerpt ? "书摘" : "心得"}已修改` : `${isExcerpt ? "书摘" : "心得"}已发布`);
});
$("#taskForm").addEventListener("submit", (event) => { event.preventDefault(); const title = $("#taskTitle").value.trim(); if (!title) return; const task = { id: uid(), title, time: $("#taskTime").value, date: selectedDate, done: false }; state.tasks.push(task); queueTaskUpsert(task.id); save(); event.target.reset(); renderTasks(); $("#taskTitle").focus(); });
$("#recordForm").addEventListener("submit", async (event) => { event.preventDefault(); const title = $("#recordTitle").value.trim(); const start = $("#recordStart").value; const end = $("#recordEnd").value; if (!title || !start || !end || minutes(end) <= minutes(start)) { setSyncStatus("请填写内容，并确认结束时间晚于开始时间"); return; } const record = { id: uid(), title, start, end, category: $("#recordCategory").value, date: selectedDate }; state.records.push(record); queueRecordUpsert(record.id); saveLocal(); event.target.reset(); renderRecords(); renderStats(); renderDateControls(); await syncRecordToCloud(record); $("#recordTitle").focus(); });
$("#recordEditForm").addEventListener("submit", saveRecordEdit);
$("#recordEditClose").addEventListener("click", () => $("#recordDialog").close());
$("#recordCategory").addEventListener("change", () => updateCategorySwatch("#recordCategory", "#recordCategorySwatch"));
$("#recordEditCategory").addEventListener("change", () => updateCategorySwatch("#recordEditCategory", "#recordEditCategorySwatch"));
$("#summaryEditForm").addEventListener("submit", saveSummaryEdit);
$("#summaryEditClose").addEventListener("click", () => $("#summaryDialog").close());
$("#summaryEditContent").addEventListener("input", () => { $("#summaryEditCount").textContent = `${$("#summaryEditContent").value.length} / 500`; });
$("#selectedDateButton").addEventListener("click", () => { calendarMonth = new Date(dateFromKey(selectedDate).getFullYear(), dateFromKey(selectedDate).getMonth(), 1); renderCalendar(); $("#dateCalendar").showModal(); });
$("#calendarCloseButton").addEventListener("click", () => $("#dateCalendar").close());
$("#previousMonthButton").addEventListener("click", () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1); renderCalendar(); });
$("#nextMonthButton").addEventListener("click", () => { calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1); renderCalendar(); });
$("#previousDateButton").addEventListener("click", () => { const date = dateFromKey(selectedDate); date.setDate(date.getDate() - 1); setSelectedDate(localDateKey(date)); });
$("#nextDateButton").addEventListener("click", () => { const date = dateFromKey(selectedDate); date.setDate(date.getDate() + 1); setSelectedDate(localDateKey(date)); });
$("#todayDateButton").addEventListener("click", () => setSelectedDate(todayKey()));
$("#calendarGrid").addEventListener("click", (event) => { const day = event.target.closest("[data-calendar-date]"); if (!day) return; setSelectedDate(day.dataset.calendarDate); $("#dateCalendar").close(); });
document.addEventListener("click", async (event) => { const view = event.target.closest("[data-view]"); if (view) { showView(view.dataset.view); return; }
  if (event.target.closest("[data-conflict-close]")) { $("#conflictDialog").close(); return; }
  const conflictResolve = event.target.closest("[data-conflict-resolve]");
  if (conflictResolve) { applyConflictResolution(conflictResolve.dataset.conflictKey, conflictResolve.dataset.conflictResolve); return; }
  const thoughtMenu = event.target.closest("[data-thought-menu]"); if (thoughtMenu) { const id = thoughtMenu.dataset.thoughtMenu; activeThoughtMenuId = activeThoughtMenuId === id ? null : id; if ($("#thoughtDialog").open) openThought(id); else renderThoughts(); return; }
  const thoughtExpand = event.target.closest("[data-thought-expand]"); if (thoughtExpand) { const id = thoughtExpand.dataset.thoughtExpand; if (expandedThoughtIds.has(id)) expandedThoughtIds.delete(id); else expandedThoughtIds.add(id); renderThoughts(); return; }
  if (activeThoughtMenuId && !event.target.closest(".thought-action-wrap")) { activeThoughtMenuId = null; if ($("#thoughtDialog").open) openThought($("#thoughtDialogContent").querySelector("[data-thought-menu]")?.dataset.thoughtMenu); else renderThoughts(); }
  const thoughtClose = event.target.closest("[data-thought-close]"); if (thoughtClose) { $("#thoughtDialog").close(); return; }
  const thoughtRetry = event.target.closest("[data-thought-retry]"); if (thoughtRetry) { const thought = state.thoughts.find((item) => item.id === thoughtRetry.dataset.thoughtRetry); if (thought) await syncThoughtToCloud(thought); return; }
  const thoughtDelete = event.target.closest("[data-thought-delete]"); if (thoughtDelete) { await removeThought(thoughtDelete.dataset.thoughtDelete); return; }
  const thoughtEdit = event.target.closest("[data-thought-edit]"); if (thoughtEdit) { openThoughtEditor(thoughtEdit.dataset.thoughtEdit); return; }
  const thoughtCard = event.target.closest("[data-thought-open]"); if (thoughtCard && !event.target.closest("button")) { openThought(thoughtCard.dataset.thoughtOpen); return; }
  const summaryEdit = event.target.closest("[data-summary-edit]"); if (summaryEdit) { openSummaryEditor(summaryEdit.dataset.summaryEdit); return; }
  const summaryDelete = event.target.closest("[data-summary-delete]"); if (summaryDelete) { await removeDailySummary(summaryDelete.dataset.summaryDelete); return; }
  const summaryRetry = event.target.closest("[data-summary-retry]"); if (summaryRetry) { const summary = state.dailySummaries.find((item) => item.id === summaryRetry.dataset.summaryRetry); if (summary) { if (summary.pendingAction === "delete") await removeDailySummary(summary.id, true); else await syncDailySummaryToCloud(summary); } return; }
  const taskDelete = event.target.closest("[data-task-delete]"); if (taskDelete) { const id = taskDelete.dataset.taskDelete; state.tasks = state.tasks.filter((task) => task.id !== id); queueTaskDelete(id); save(); renderTasks(); return; }
  const recordDelete = event.target.closest("[data-record-delete]"); if (recordDelete) { const id = recordDelete.dataset.recordDelete; state.records = state.records.filter((record) => record.id !== id); queueRecordDelete(id); saveLocal(); renderRecords(); renderStats(); renderDateControls(); await deleteRecordFromCloud(id); return; }
  const recordEdit = event.target.closest("[data-record-edit]"); if (recordEdit) { openRecordEditor(recordEdit.dataset.recordEdit); return; }
  const recordCard = event.target.closest("[data-record-card]"); if (recordCard && !event.target.closest("button")) openRecordEditor(recordCard.dataset.recordCard);
});
document.addEventListener("change", (event) => { const checkbox = event.target.closest("[data-task-check]"); if (!checkbox) return; const task = state.tasks.find((item) => item.id === checkbox.dataset.taskCheck); if (task) { task.done = checkbox.checked; queueTaskUpsert(task.id); } save(); renderTasks(); });
document.addEventListener("input", (event) => { const input = event.target.closest("[data-summary-input]"); if (!input) return; const count = document.querySelector(`[data-summary-count="${input.dataset.summaryInput}"]`); if (count) count.textContent = `${input.value.length} / 500`; });
document.addEventListener("keydown", (event) => { const thoughtCard = event.target.closest?.("[data-thought-open]"); if (thoughtCard && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openThought(thoughtCard.dataset.thoughtOpen); } });
window.addEventListener("resize", updateThoughtExpanders);

let deferredPrompt;
window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); deferredPrompt = event; $("#installButton").hidden = false; });
$("#installButton").addEventListener("click", async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); deferredPrompt = null; $("#installButton").hidden = true; });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
renderTasks();
renderDateControls();
renderRecords();
renderStats();
renderDailySummaries();
renderBooks();
renderThoughts();
updateCategorySwatch("#recordCategory", "#recordCategorySwatch");
updateCategorySwatch("#recordEditCategory", "#recordEditCategorySwatch");
initCloud();
