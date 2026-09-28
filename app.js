const STORAGE_KEY = "time-block-pwa-v1";
const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{"tasks":[],"records":[]}');
state.books ||= [];
state.dailySummaries ||= [];
state.pendingTaskUpserts ||= [];
state.pendingTaskDeletes ||= [];
state.pendingRecordUpserts ||= [];
state.pendingRecordDeletes ||= [];
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
const MIGRATION_KEY = "time-block-pending-migration";
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
  state.pendingTaskDeletes = state.pendingTaskDeletes.filter((pendingId) => pendingId !== id);
  if (!state.pendingTaskUpserts.includes(id)) state.pendingTaskUpserts.push(id);
}
function queueTaskDelete(id) {
  state.pendingTaskUpserts = state.pendingTaskUpserts.filter((pendingId) => pendingId !== id);
  if (!state.pendingTaskDeletes.includes(id)) state.pendingTaskDeletes.push(id);
}
function queueRecordUpsert(id) {
  state.pendingRecordDeletes = state.pendingRecordDeletes.filter((pendingId) => pendingId !== id);
  if (!state.pendingRecordUpserts.includes(id)) state.pendingRecordUpserts.push(id);
}
function queueRecordDelete(id) {
  state.pendingRecordUpserts = state.pendingRecordUpserts.filter((pendingId) => pendingId !== id);
  if (!state.pendingRecordDeletes.includes(id)) state.pendingRecordDeletes.push(id);
}
function recordErrorMessage(error, action = "保存") {
  const message = error?.message || "网络或权限异常";
  if (error?.code === "23514" || /check constraint/i.test(message)) return `${action}失败：云端尚未启用“休息”分类，请运行分类升级`;
  if (/row-level security|permission denied/i.test(message)) return `${action}失败：没有写入权限`;
  return `${action}失败：${message}`;
}
function queueThoughtUpsert(id) {
  state.pendingThoughtDeletes = state.pendingThoughtDeletes.filter((pendingId) => pendingId !== id);
  if (!state.pendingThoughtUpserts.includes(id)) state.pendingThoughtUpserts.push(id);
}
function queueThoughtDelete(id) {
  state.pendingThoughtUpserts = state.pendingThoughtUpserts.filter((pendingId) => pendingId !== id);
  if (!state.pendingThoughtDeletes.includes(id)) state.pendingThoughtDeletes.push(id);
}
let selectedBookId = state.books[0]?.id || null;
let bookScrollTimer;
let activeThoughtMenuId = null;
const expandedThoughtIds = new Set();
const summaryKey = (summary) => `${summary.date}:${summary.slot}`;
const summaryPrompts = ["今天最值得记录的一件事", "今天学到或意识到什么", "明天最重要的一件事"];

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
const pendingMigration = () => { try { return JSON.parse(localStorage.getItem(MIGRATION_KEY) || "null"); } catch { return null; } };
const isOwner = () => cloudUser?.email?.toLowerCase() === OWNER_EMAIL;
function emailRedirectUrl(migration) {
  const url = new URL(PUBLIC_APP_URL);
  if (migration) {
    url.searchParams.set("migration_source", migration.sourceUserId);
    url.searchParams.set("migration_token", migration.tokenHash);
  }
  return url.href;
}
function captureMigrationFromUrl() {
  const url = new URL(window.location.href);
  const sourceUserId = url.searchParams.get("migration_source");
  const tokenHash = url.searchParams.get("migration_token");
  if (!sourceUserId || !tokenHash) return;
  localStorage.setItem(MIGRATION_KEY, JSON.stringify({ sourceUserId, tokenHash }));
  url.searchParams.delete("migration_source");
  url.searchParams.delete("migration_token");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}
async function hashToken(token) { const bytes = new TextEncoder().encode(token); const hash = await crypto.subtle.digest("SHA-256", bytes); return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function blobToDataUrl(blob) { return new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); }); }
async function cacheBookImagesForMigration() {
  for (const book of state.books) for (const field of ["excerpts", "reflections"]) for (const note of book[field] || []) {
    if (note.image && !note.image.startsWith("data:")) { const response = await fetch(note.image); if (response.ok) note.image = await blobToDataUrl(await response.blob()); }
    if (note.image) note.imagePath = null;
  }
  saveLocal();
}
async function syncToCloud() {
  if (!cloudUser || !cloud) return;
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
  for (const id of [...state.pendingRecordDeletes]) await deleteRecordFromCloud(id);
  saveLocal();
  const syncFailed = taskResult.error || recordResult.error || taskDeleteResults.some((result) => !result.ok);
  setSyncStatus(syncFailed ? "同步失败" : "已同步", !syncFailed);
}
async function loadFromCloud() {
  if (!cloudUser || !cloud) return;
  setSyncStatus("读取云端", true);
  const [taskResult, recordResult, summaryResult] = await Promise.all([
    cloud.from("time_tasks").select("*").eq("user_id", cloudUser.id),
    cloud.from("time_records").select("*").eq("user_id", cloudUser.id),
    cloud.from("daily_summaries").select("*").eq("user_id", cloudUser.id)
  ]);
  if (taskResult.error || recordResult.error) { setSyncStatus("同步失败"); return; }
  const pendingTasks = new Map(state.tasks.filter((task) => state.pendingTaskUpserts.includes(task.id)).map((task) => [task.id, task]));
  const cloudTasks = new Map(taskResult.data.map((task) => [task.id, { id: task.id, title: task.title, time: task.planned_time || "", date: task.date, done: task.done }]));
  for (const [id, task] of pendingTasks) cloudTasks.set(id, task);
  for (const id of state.pendingTaskDeletes) cloudTasks.delete(id);
  state.tasks = [...cloudTasks.values()];
  const pendingUpserts = new Map(state.records.filter((record) => state.pendingRecordUpserts.includes(record.id)).map((record) => [record.id, record]));
  const cloudRecords = new Map(recordResult.data.map((record) => [record.id, { id: record.id, title: record.title, start: record.start_time, end: record.end_time, category: record.category, date: record.date }]));
  for (const [id, record] of pendingUpserts) cloudRecords.set(id, record);
  for (const id of state.pendingRecordDeletes) cloudRecords.delete(id);
  state.records = [...cloudRecords.values()];
  const summariesToUpload = [];
  if (!summaryResult.error) {
    const cloudSummaries = new Map(summaryResult.data.map((summary) => [summaryKey(summary), { id: summary.id, date: summary.date, slot: Number(summary.slot), content: summary.content, savedAt: summary.updated_at, syncState: "synced", syncError: "" }]));
    for (const localSummary of state.dailySummaries.filter((summary) => summary.content?.trim())) {
      const key = summaryKey(localSummary);
      if (!cloudSummaries.has(key)) {
        const preserved = { ...localSummary, syncState: "syncing", syncError: "" };
        cloudSummaries.set(key, preserved);
        summariesToUpload.push(preserved);
      }
    }
    state.dailySummaries = [...cloudSummaries.values()];
  }
  saveLocal(); renderTasks(); renderRecords(); renderStats(); renderDailySummaries(); renderDateControls();
  if (state.pendingTaskUpserts.length || state.pendingTaskDeletes.length) await syncToCloud();
  for (const id of [...state.pendingRecordUpserts]) {
    const record = state.records.find((item) => item.id === id);
    if (record) await syncRecordToCloud(record);
  }
  for (const id of [...state.pendingRecordDeletes]) await deleteRecordFromCloud(id);
  if (summaryResult.error) { setSyncStatus("日程已同步；总结读取失败", false); return; }
  for (const summary of summariesToUpload) await syncDailySummaryToCloud(summary);
  setSyncStatus("已同步", true);
}
async function deleteTaskFromCloud(id) {
  if (!cloudUser || !cloud) return { ok: false, local: true };
  const { error } = await cloud.from("time_tasks").delete().eq("id", id).eq("user_id", cloudUser.id);
  if (error) { setSyncStatus(`删除任务失败：${error.message || "网络或权限异常"}`, false); return { ok: false }; }
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
    return { ok: false };
  }
  state.pendingRecordUpserts = state.pendingRecordUpserts.filter((id) => id !== record.id);
  saveLocal();
  setSyncStatus("已同步", true);
  return { ok: true };
}
async function deleteRecordFromCloud(id) {
  if (!cloudUser || !cloud) return { ok: false, local: true };
  setSyncStatus("正在删除", true);
  const { error } = await cloud.from("time_records").delete().eq("id", id).eq("user_id", cloudUser.id);
  if (error) {
    setSyncStatus(recordErrorMessage(error, "删除"), false);
    return { ok: false };
  }
  state.pendingRecordDeletes = state.pendingRecordDeletes.filter((pendingId) => pendingId !== id);
  saveLocal();
  setSyncStatus("已同步", true);
  return { ok: true };
}
function summaryErrorMessage(error, action = "保存") {
  const message = error?.message || "网络或权限异常";
  if (/row-level security|permission denied/i.test(message)) return `${action}失败：没有写入权限`;
  if (/relation .*daily_summaries|does not exist/i.test(message)) return `${action}失败：总结数据表尚未完成升级`;
  if (/check constraint|char_length/i.test(message)) return `${action}失败：内容需要在 1 至 500 字之间`;
  return `${action}失败：${message}`;
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
    return { ok: false };
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
  const { error } = await cloud.from("daily_summaries").delete().eq("id", summary.id).eq("user_id", cloudUser.id);
  if (error) {
    summary.syncState = "failed";
    summary.pendingAction = "delete";
    summary.syncError = summaryErrorMessage(error, "删除");
    saveLocal(); renderDailySummaries();
    setSyncStatus(summary.syncError, false);
    return { ok: false };
  }
  setSyncStatus("已同步", true);
  return { ok: true };
}
async function signedImage(path) {
  if (!path || !cloud) return "";
  const { data } = await cloud.storage.from("reading-images").createSignedUrl(path, 60 * 60 * 24);
  return data?.signedUrl || "";
}
async function syncBooksToCloud() {
  if (!cloudUser || !cloud) return;
  setSyncStatus("正在同步", true);
  const bookRows = state.books.map((book) => ({ id: book.id, user_id: cloudUser.id, title: book.title, author: book.author || null, rating: book.rating || 0 }));
  const { error: bookError } = await cloud.from("reading_books").upsert(bookRows);
  if (bookError) { setSyncStatus("阅读笔记同步失败"); return; }
  const noteRows = [];
  for (const book of state.books) {
    for (const [field, noteType] of [["excerpts", "excerpt"], ["reflections", "reflection"]]) {
      for (const note of book[field] || []) {
        if (note.image?.startsWith("data:") && !note.imagePath) {
          const imagePath = `${cloudUser.id}/${book.id}/${note.id}.jpg`;
          const blob = await (await fetch(note.image)).blob();
          const { error } = await cloud.storage.from("reading-images").upload(imagePath, blob, { upsert: true, contentType: "image/jpeg" });
          if (error) { setSyncStatus("图片上传失败"); continue; }
          note.imagePath = imagePath;
        }
        noteRows.push({ id: note.id, book_id: book.id, user_id: cloudUser.id, note_type: noteType, body: note.text || null, image_path: note.imagePath || null });
      }
    }
  }
  const { error: noteError } = noteRows.length ? await cloud.from("reading_notes").upsert(noteRows) : { error: null };
  saveLocal(); setSyncStatus(noteError ? "阅读笔记同步失败" : "已同步", !noteError);
}
async function loadBooksFromCloud() {
  if (!cloudUser || !cloud) return;
  const [bookResult, noteResult] = await Promise.all([cloud.from("reading_books").select("*").eq("user_id", cloudUser.id).order("updated_at", { ascending: false }), cloud.from("reading_notes").select("*").eq("user_id", cloudUser.id).order("created_at", { ascending: false })]);
  if (bookResult.error || noteResult.error) { setSyncStatus("阅读笔记同步失败"); return; }
  if (!bookResult.data.length && state.books.length) { await syncBooksToCloud(); return; }
  const notesWithImages = await Promise.all(noteResult.data.map(async (note) => ({ ...note, image: await signedImage(note.image_path) })));
  state.books = bookResult.data.map((book) => ({ id: book.id, title: book.title, author: book.author || "", rating: book.rating || 0, excerpts: notesWithImages.filter((note) => note.book_id === book.id && note.note_type === "excerpt").map((note) => ({ id: note.id, text: note.body || "", image: note.image, imagePath: note.image_path })), reflections: notesWithImages.filter((note) => note.book_id === book.id && note.note_type === "reflection").map((note) => ({ id: note.id, text: note.body || "", image: note.image, imagePath: note.image_path })) }));
  selectedBookId = state.books[0]?.id || null;
  saveLocal(); renderBooks();
}
async function deleteNoteFromCloud(note) {
  if (!cloudUser || !cloud) return;
  await cloud.from("reading_notes").delete().eq("id", note.id).eq("user_id", cloudUser.id);
  if (note.imagePath) await cloud.storage.from("reading-images").remove([note.imagePath]);
}
async function updateBookInCloud(book) {
  if (!cloudUser || !cloud) return { ok: false, local: true };
  const { error } = await cloud.from("reading_books").update({ title: book.title, author: book.author || null, rating: book.rating || 0, updated_at: new Date().toISOString() }).eq("id", book.id).eq("user_id", cloudUser.id);
  if (error) { setSyncStatus(`书籍修改失败：${error.message || "网络或权限异常"}`, false); return { ok: false }; }
  return { ok: true };
}
async function deleteBookFromCloud(book) {
  if (!cloudUser || !cloud) return { ok: false, local: true };
  setSyncStatus("正在删除", true);
  const { data: notes, error: notesReadError } = await cloud.from("reading_notes").select("image_path").eq("book_id", book.id).eq("user_id", cloudUser.id);
  if (notesReadError) { setSyncStatus(`删除失败：${notesReadError.message}`, false); return { ok: false }; }
  const { error: notesError } = await cloud.from("reading_notes").delete().eq("book_id", book.id).eq("user_id", cloudUser.id);
  if (notesError) { setSyncStatus(`删除笔记失败：${notesError.message}`, false); return { ok: false }; }
  const paths = (notes || []).map((note) => note.image_path).filter(Boolean);
  if (paths.length) await cloud.storage.from("reading-images").remove(paths);
  const { error } = await cloud.from("reading_books").delete().eq("id", book.id).eq("user_id", cloudUser.id);
  if (error) { setSyncStatus(`删除书籍失败：${error.message}`, false); return { ok: false }; }
  setSyncStatus("已同步", true); return { ok: true };
}
async function saveReadingNote(book, type, text, image) {
  if (!cloudUser || !cloud) return { ok: false, local: true };
  const field = type === "excerpt" ? "excerpts" : "reflections";
  const note = (book[field] || [])[0] || { id: uid(), text: "", image: "" };
  let imagePath = note.imagePath || null;
  if (image?.startsWith("data:")) {
    imagePath = `${cloudUser.id}/${book.id}/${note.id}.jpg`;
    const blob = await (await fetch(image)).blob();
    const { error } = await cloud.storage.from("reading-images").upload(imagePath, blob, { upsert: true, contentType: "image/jpeg" });
    if (error) return { ok: false, error };
  }
  const { error } = await cloud.from("reading_notes").upsert({ id: note.id, book_id: book.id, user_id: cloudUser.id, note_type: type, body: text || null, image_path: imagePath }, { onConflict: "id" });
  if (error) return { ok: false, error };
  note.text = text; note.image = image || note.image || ""; note.imagePath = imagePath; book[field] = [note, ...(book[field] || []).filter((item) => item.id !== note.id)];
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
  if (/row-level security|permission denied/i.test(message)) return `${action}失败：没有写入权限`;
  return `${action}失败：${message}`;
}
async function syncThoughtToCloud(thought) {
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
    return { ok: false };
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
  const { error } = await cloud.from("thought_entries").delete().eq("id", id).eq("user_id", cloudUser.id);
  if (error) {
    setSyncStatus(thoughtErrorMessage(error, "删除"), false);
    return { ok: false };
  }
  state.pendingThoughtDeletes = state.pendingThoughtDeletes.filter((pendingId) => pendingId !== id);
  saveLocal();
  setSyncStatus("已同步", true);
  return { ok: true };
}
async function syncThoughtsToCloud() {
  for (const id of [...state.pendingThoughtUpserts]) {
    const thought = state.thoughts.find((item) => item.id === id);
    if (thought) await syncThoughtToCloud(thought);
  }
  for (const id of [...state.pendingThoughtDeletes]) await deleteThoughtFromCloud(id);
}
async function loadThoughtsFromCloud() {
  if (!cloudUser || !cloud) return;
  const { data, error } = await cloud.from("thought_entries").select("*").eq("user_id", cloudUser.id).order("created_at", { ascending: false });
  if (error) { setSyncStatus(thoughtErrorMessage(error, "读取"), false); return; }
  const localPending = new Map(state.thoughts.filter((thought) => state.pendingThoughtUpserts.includes(thought.id)).map((thought) => [thought.id, thought]));
  const cloudThoughts = new Map(data.map((thought) => [thought.id, { id: thought.id, title: thought.title || deriveThoughtTitle(thought.content || ""), content: thought.content, createdAt: thought.created_at, updatedAt: thought.updated_at, syncState: "synced", syncError: "" }]));
  for (const [id, thought] of localPending) cloudThoughts.set(id, thought);
  for (const id of state.pendingThoughtDeletes) cloudThoughts.delete(id);
  state.thoughts = [...cloudThoughts.values()];
  saveLocal(); renderThoughts();
  await syncThoughtsToCloud();
}
async function prepareOwnerLogin() {
  if (!cloud || isOwner()) return;
  const button = $("#emailConfirmButton");
  button.disabled = true;
  try {
    let migration = pendingMigration();
    if (cloudUser?.is_anonymous) {
      setSyncStatus("正在准备迁移数据");
      await cacheBookImagesForMigration();
      const token = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
      const tokenHash = await hashToken(token);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const { error } = await cloud.from("account_migrations").upsert({ source_user_id: cloudUser.id, token_hash: tokenHash, expires_at: expiresAt });
      if (error) { setSyncStatus(`迁移准备失败：${error.message}`); return; }
      migration = { sourceUserId: cloudUser.id, tokenHash, expiresAt };
      localStorage.setItem(MIGRATION_KEY, JSON.stringify(migration));
      await cloud.auth.signOut();
      cloudUser = null;
      updateAuthUI();
    }
    setSyncStatus("正在发送验证码");
    setAuthMessage("正在发送验证码…");
    const { error } = await cloud.auth.signInWithOtp({ email: OWNER_EMAIL, options: { shouldCreateUser: false } });
    if (error) {
      setSyncStatus(`验证码发送失败：${error.message}`);
      setAuthMessage("验证码发送失败，请检查网络后重试。", true);
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
      const expired = /expired|invalid/i.test(error.message || "");
      setSyncStatus(expired ? "验证码已过期或不正确" : "验证码验证失败");
      setAuthMessage(expired ? "验证码已过期或不正确，请重新发送。" : "验证码验证失败，请检查网络后重试。", true);
      return;
    }
    cloudUser = data.user || null;
    $("#otpCode").value = "";
    setAuthMessage("验证成功，正在同步数据。");
    updateAuthUI();
  } finally { button.disabled = false; }
}
async function completePendingMigration() {
  const pending = pendingMigration();
  if (!pending || !cloudUser || cloudUser.is_anonymous || !cloud) return false;
  if (!isOwner()) { setSyncStatus("请使用指定邮箱完成确认"); return false; }
  setSyncStatus("正在迁移云端数据");
  const { error } = await cloud.rpc("claim_anonymous_migration", { p_source_user_id: pending.sourceUserId, p_token_hash: pending.tokenHash });
  if (error) { setSyncStatus(`数据迁移失败：${error.message}`); return false; }
  localStorage.removeItem(MIGRATION_KEY);
  await syncBooksToCloud();
  setSyncStatus("数据已迁移到指定邮箱", true);
  return true;
}
async function initCloud() {
  if (!cloud) { setSyncStatus("本机模式"); return; }
  captureMigrationFromUrl();
  const { data } = await cloud.auth.getSession();
  cloudUser = data.session?.user || null;
  updateAuthUI();
  if (cloudUser) {
    await completePendingMigration();
    await loadFromCloud();
    await loadBooksFromCloud();
    await loadThoughtsFromCloud();
  } else if (pendingMigration()) {
    setSyncStatus("请用指定邮箱登录");
  } else {
    setSyncStatus("请用指定邮箱登录");
  }
  cloud.auth.onAuthStateChange(async (_event, session) => { cloudUser = session?.user || null; updateAuthUI(); if (cloudUser) { await completePendingMigration(); await loadFromCloud(); await loadBooksFromCloud(); await loadThoughtsFromCloud(); } });
}
async function startAnonymousSession() {
  if (!cloud) return;
  setSyncStatus("正在连接云端");
  const { data, error } = await cloud.auth.signInAnonymously();
  if (error) { setSyncStatus(`云端连接失败：${error.message}`); return; }
  cloudUser = data.user;
  updateAuthUI();
  await loadFromCloud();
  await loadBooksFromCloud();
  await loadThoughtsFromCloud();
}
function updateAuthUI() {
  const pending = !!pendingMigration();
  const signedIn = isOwner();
  $("#authPanel").hidden = signedIn;
  $("#emailConfirmButton").textContent = pending ? "重新发送验证码" : "发送验证码";
  $("#retrySyncButton").hidden = !cloudUser;
  $("#retrySyncButton").textContent = "立即同步";
  setSyncStatus(
    cloudUser ? (signedIn ? "已登录 QQ 邮箱" : "正在迁移旧数据") :
    "请用指定邮箱登录",
    signedIn
  );
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
function noteItem(note, type) { return `<article class="note-item"><div class="note-copy">${note.text ? `<p>${escapeHtml(note.text)}</p>` : ""}${note.image ? `<img src="${note.image}" alt="${type}图片" />` : ""}</div><button class="delete-button" type="button" data-note-delete="${note.id}" data-note-type="${type}" aria-label="删除${type}" title="删除">×</button></article>`; }
function noteFor(book, type) { return (book[type === "excerpt" ? "excerpts" : "reflections"] || [])[0] || null; }
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
  const excerpt = noteFor(book, "excerpt"); const reflection = noteFor(book, "reflection");
  $("#bookDetail").innerHTML = `<div class="note-section"><div class="note-section-title"><h4>书摘</h4><span>截图或文字片段</span></div><form class="note-form" id="excerptForm"><textarea id="excerptText" maxlength="1000" placeholder="摘下让你停下来的那一段文字">${escapeHtml(excerpt?.text || "")}</textarea><label class="upload-button">上传截图<input id="excerptImage" type="file" accept="image/*" /></label><button class="primary-button" type="submit">${excerpt ? "更新书摘" : "保存书摘"}</button><button class="text-button" type="button" data-note-clear="excerpt" ${excerpt ? "" : "disabled"}>删除书摘</button></form><div class="note-list">${excerpts}</div></div><div class="note-section"><div class="note-section-title"><h4>读书心得</h4><span>图片或文字</span></div><form class="note-form" id="reflectionForm"><textarea id="reflectionText" maxlength="1600" placeholder="这本书给你留下了什么？">${escapeHtml(reflection?.text || "")}</textarea><label class="upload-button">上传图片<input id="reflectionImage" type="file" accept="image/*" /></label><button class="primary-button" type="submit">${reflection ? "更新心得" : "保存心得"}</button><button class="text-button" type="button" data-note-clear="reflection" ${reflection ? "" : "disabled"}>删除心得</button></form><div class="note-list">${reflections}</div></div>`;
}
function imageData(file) { return new Promise((resolve) => { if (!file) return resolve(""); const reader = new FileReader(); reader.onload = () => { const image = new Image(); image.onload = () => { const max = 1200; const scale = Math.min(1, max / Math.max(image.width, image.height)); const canvas = document.createElement("canvas"); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale); canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height); resolve(canvas.toDataURL("image/jpeg", .82)); }; image.src = reader.result; }; reader.readAsDataURL(file); }); }
function saveBooks() { saveLocal(); renderBooks(); syncBooksToCloud(); }
function openBookEditor(id) { const book = state.books.find((item) => item.id === id); if (!book) return; $("#bookEditForm").dataset.bookId = id; $("#bookEditTitle").value = book.title; $("#bookEditAuthor").value = book.author || ""; $("#bookEditDialog").showModal(); }
async function saveBookEdit(event) { event.preventDefault(); const book = state.books.find((item) => item.id === event.currentTarget.dataset.bookId); const title = $("#bookEditTitle").value.trim(); if (!book || !title) return; book.title = title; book.author = $("#bookEditAuthor").value.trim(); saveLocal(); renderBooks(); $("#bookEditDialog").close(); const result = await updateBookInCloud(book); showToast(result.ok || result.local ? "书籍修改成功" : "书籍修改失败"); }
async function removeBook(id) { const book = state.books.find((item) => item.id === id); if (!book || !window.confirm(`确定删除《${book.title}》及其全部书摘和心得吗？`)) return; state.books = state.books.filter((item) => item.id !== id); selectedBookId = state.books[0]?.id || null; saveLocal(); renderBooks(); const result = await deleteBookFromCloud(book); showToast(result.ok || result.local ? "书籍及笔记已删除" : "删除失败，请重试"); }
async function clearSelectedNote(type) { const book = state.books.find((item) => item.id === selectedBookId); const note = book && noteFor(book, type); if (!book || !note || !window.confirm(`确定删除这条${type === "excerpt" ? "书摘" : "心得"}吗？`)) return; const field = type === "excerpt" ? "excerpts" : "reflections"; book[field] = (book[field] || []).filter((item) => item.id !== note.id); saveLocal(); renderBooks(); await deleteNoteFromCloud(note); showToast(`已删除${type === "excerpt" ? "书摘" : "心得"}`); }

function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
function updateRecordCount() { $("#recordTitleCount").textContent = `${$("#recordTitle").value.length} / 500`; }
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
  $("#recordEditCount").textContent = `${record.title.length} / 500`;
  $("#recordDialog").showModal();
}
async function saveRecordEdit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const record = state.records.find((item) => item.id === form.dataset.recordId);
  const title = $("#recordEditTitle").value.trim();
  const start = $("#recordEditStart").value;
  const end = $("#recordEditEnd").value;
  if (!record || !title || title.length > 500 || !start || !end || minutes(end) <= minutes(start)) {
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
  saveLocal(); $("#summaryDialog").close(); renderDailySummaries(); renderDateControls();
  await syncDailySummaryToCloud(summary);
}
async function removeDailySummary(id, confirmed = false) {
  const summary = state.dailySummaries.find((item) => item.id === id);
  if (!summary || (!confirmed && !window.confirm("确定删除这条总结吗？删除后无法恢复。"))) return;
  summary.syncState = "syncing";
  summary.pendingAction = "delete";
  summary.syncError = "";
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
    await syncToCloud();
    await syncBooksToCloud();
    await syncThoughtsToCloud();
  } else {
    await prepareOwnerLogin();
  }
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
  const star = event.target.closest("[data-rate]");
  if (star) { const book = state.books.find((item) => item.id === selectedBookId); if (book) { book.rating = Number(star.dataset.rate); saveBooks(); } return; }
  const bookButton = event.target.closest("[data-book-select]");
  if (bookButton) { selectedBookId = bookButton.dataset.bookSelect; renderBooks(); return; }
  const bookEdit = event.target.closest("[data-book-edit]");
  if (bookEdit) { openBookEditor(bookEdit.dataset.bookEdit); return; }
  const bookDelete = event.target.closest("[data-book-delete]");
  if (bookDelete) { removeBook(bookDelete.dataset.bookDelete); return; }
  const noteClear = event.target.closest("[data-note-clear]");
  if (noteClear) { clearSelectedNote(noteClear.dataset.noteClear); return; }
  const deleteNote = event.target.closest("[data-note-delete]");
  if (deleteNote) { const book = state.books.find((item) => item.id === selectedBookId); if (book) { const field = deleteNote.dataset.noteType === "书摘" ? "excerpts" : "reflections"; const note = (book[field] || []).find((item) => item.id === deleteNote.dataset.noteDelete); book[field] = (book[field] || []).filter((item) => item.id !== deleteNote.dataset.noteDelete); saveBooks(); if (note) deleteNoteFromCloud(note); } }
});
document.addEventListener("submit", async (event) => {
  if (event.target.matches("[data-summary-form]")) { await saveDailySummary(event); return; }
  if (event.target.id === "newBookForm") { event.preventDefault(); const title = $("#bookTitle").value.trim(); if (!title) return; const book = { id: uid(), title, author: $("#bookAuthor").value.trim(), rating: 0, excerpts: [], reflections: [] }; state.books.push(book); selectedBookId = book.id; saveBooks(); $("#newBookDialog").close(); showToast("书籍已创建"); return; }
  if (!["excerptForm", "reflectionForm"].includes(event.target.id)) return;
  event.preventDefault(); const book = state.books.find((item) => item.id === selectedBookId); if (!book) return; const isExcerpt = event.target.id === "excerptForm"; const type = isExcerpt ? "excerpt" : "reflection"; const text = $(isExcerpt ? "#excerptText" : "#reflectionText").value.trim(); const image = await imageData($(isExcerpt ? "#excerptImage" : "#reflectionImage").files[0]); if (!text && !image && !noteFor(book, type)) return; const field = isExcerpt ? "excerpts" : "reflections"; const note = noteFor(book, type) || { id: uid(), text: "", image: "" }; note.text = text; if (image) note.image = image; book[field] = [note, ...(book[field] || []).filter((item) => item.id !== note.id)]; saveLocal(); renderBooks(); const result = await saveReadingNote(book, type, text, image || note.image); if (!result.ok && !result.local) showToast(`保存失败：${result.error?.message || "网络或权限异常"}`); else showToast(isExcerpt ? "书摘已更新" : "心得已更新");
});
$("#taskForm").addEventListener("submit", (event) => { event.preventDefault(); const title = $("#taskTitle").value.trim(); if (!title) return; const task = { id: uid(), title, time: $("#taskTime").value, date: selectedDate, done: false }; state.tasks.push(task); queueTaskUpsert(task.id); save(); event.target.reset(); renderTasks(); $("#taskTitle").focus(); });
$("#recordForm").addEventListener("submit", async (event) => { event.preventDefault(); const title = $("#recordTitle").value.trim(); const start = $("#recordStart").value; const end = $("#recordEnd").value; if (!title || title.length > 500 || !start || !end || minutes(end) <= minutes(start)) { setSyncStatus("请填写内容，并确认结束时间晚于开始时间"); return; } const record = { id: uid(), title, start, end, category: $("#recordCategory").value, date: selectedDate }; state.records.push(record); queueRecordUpsert(record.id); saveLocal(); event.target.reset(); updateRecordCount(); renderRecords(); renderStats(); renderDateControls(); await syncRecordToCloud(record); $("#recordTitle").focus(); });
$("#recordEditForm").addEventListener("submit", saveRecordEdit);
$("#recordEditClose").addEventListener("click", () => $("#recordDialog").close());
$("#recordCategory").addEventListener("change", () => updateCategorySwatch("#recordCategory", "#recordCategorySwatch"));
$("#recordEditCategory").addEventListener("change", () => updateCategorySwatch("#recordEditCategory", "#recordEditCategorySwatch"));
$("#summaryEditForm").addEventListener("submit", saveSummaryEdit);
$("#summaryEditClose").addEventListener("click", () => $("#summaryDialog").close());
$("#recordTitle").addEventListener("input", updateRecordCount);
$("#recordEditTitle").addEventListener("input", () => { $("#recordEditCount").textContent = `${$("#recordEditTitle").value.length} / 500`; });
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
