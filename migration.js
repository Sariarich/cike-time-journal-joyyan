const MIGRATION_KEY = "time-block-pending-migration";
const MIGRATION_BACKUP_KEY = "time-block-migration-backup";
const MIGRATION_COMPLETED_KEY = "time-block-migration-completed";
const MIGRATION_ENTITIES = {
  tasks: "time_tasks",
  records: "time_records",
  dailySummaries: "daily_summaries",
  thoughts: "thought_entries",
  books: "reading_books",
  readingNotes: "reading_notes"
};

function createMigrationService({ getState, saveLocal, getCloud, getCloudUser, getOwnerEmail, getPublicAppUrl, setStatus }) {
  let lastSnapshot = null;
  let lastBackup = null;
  let backupStatus = { created: false, downloaded: false, verified: false };
  const clone = (value) => typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const setBackupStatus = (status) => {
    backupStatus = { ...backupStatus, ...status };
    const element = document.querySelector("#migrationBackupStatus");
    if (element) {
      element.textContent = backupStatus.verified && backupStatus.downloaded
        ? "备份已校验，下载已触发"
        : backupStatus.created
          ? "备份已创建，正在验证下载…"
          : "备份尚未开始";
    }
    return backupStatus;
  };

  const pendingMigration = () => {
    try { return JSON.parse(localStorage.getItem(MIGRATION_KEY) || "null"); } catch { return null; }
  };
  const savePendingMigration = (migration) => {
    localStorage.setItem(MIGRATION_KEY, JSON.stringify(migration));
    return migration;
  };
  const getLocalDataSnapshot = () => {
    const state = getState();
    const snapshot = {
      tasks: clone(state.tasks || []),
      records: clone(state.records || []),
      dailySummaries: clone(state.dailySummaries || []),
      thoughts: clone(state.thoughts || []),
      books: clone(state.books || []),
      readingNotes: (state.books || []).flatMap((book) => [ ...(book.excerpts || []), ...(book.reflections || []) ].map((note) => ({ ...note, bookId: book.id }))),
      images: (state.books || []).flatMap((book) => [ ...(book.excerpts || []), ...(book.reflections || []) ]).filter((note) => note.image).map((note) => note.image)
    };
    return snapshot;
  };
  const countMigratableRecords = (snapshot = getLocalDataSnapshot()) => Object.fromEntries(Object.entries(snapshot).map(([key, value]) => [key, value.length]));
  const countStoredImages = async (cloud, userId) => {
    const { data: folders, error: foldersError } = await cloud.storage.from("reading-images").list(userId, { limit: 1000 });
    if (foldersError) throw foldersError;
    const counts = await Promise.all((folders || []).filter((item) => item.id === null).map(async (folder) => {
      const { data: files, error } = await cloud.storage.from("reading-images").list(`${userId}/${folder.name}`, { limit: 1000 });
      if (error) throw error;
      return (files || []).filter((item) => item.id !== null).length;
    }));
    return counts.reduce((total, count) => total + count, 0);
  };
  const fetchCloudCounts = async (userId) => {
    const cloud = getCloud();
    if (!cloud) throw new Error("云端服务不可用");
    const entries = await Promise.all(Object.entries(MIGRATION_ENTITIES).map(async ([entity, table]) => {
      const { count, error } = await cloud.from(table).select("*", { count: "exact", head: true }).eq("user_id", userId);
      if (error) throw error;
      return [entity, count || 0];
    }));
    const counts = Object.fromEntries(entries);
    counts.images = await countStoredImages(cloud, userId);
    return counts;
  };
  const compareCounts = (expected, actual, baseline, { includeImages = true } = {}) => {
    const entities = Object.keys(expected).filter((entity) => includeImages || entity !== "images");
    const details = Object.fromEntries(entities.map((entity) => {
      const expectedAdded = expected[entity] || 0;
      const actualAdded = (actual[entity] || 0) - (baseline[entity] || 0);
      return [entity, { expected: expectedAdded, actual: actualAdded, matched: expectedAdded === actualAdded }];
    }));
    return { valid: Object.values(details).every((result) => result.matched), details };
  };
  const migrationConflictError = (result) => {
    const conflicts = result?.conflicts || [];
    const summary = conflicts.map((conflict) => `${conflict.entityType}${conflict.date ? `（${conflict.date} / ${conflict.slot}）` : ""}`).join("、");
    const inserted = JSON.stringify(result?.inserted || {});
    const skipped = JSON.stringify(result?.skipped || {});
    return new Error(`云端冲突：${summary || "目标账号已有数据"}。已插入 ${inserted}，已跳过 ${skipped}，冲突 ${result?.failed || conflicts.length || 1} 项；未覆盖任何已有数据。`);
  };
  const emailRedirectUrl = (migration) => {
    const url = new URL(getPublicAppUrl());
    if (migration) {
      url.searchParams.set("migration_source", migration.sourceUserId);
      url.searchParams.set("migration_token", migration.tokenHash);
    }
    return url.href;
  };
  const captureMigrationFromUrl = () => {
    const url = new URL(window.location.href);
    const sourceUserId = url.searchParams.get("migration_source");
    const tokenHash = url.searchParams.get("migration_token");
    if (!sourceUserId || !tokenHash) return;
    localStorage.setItem(MIGRATION_KEY, JSON.stringify({ sourceUserId, tokenHash }));
    url.searchParams.delete("migration_source");
    url.searchParams.delete("migration_token");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };
  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
  const cacheBookImagesForMigration = async () => {
    const state = getState();
    for (const book of state.books || []) for (const field of ["excerpts", "reflections"]) for (const note of book[field] || []) {
      if (note.image && !note.image.startsWith("data:")) {
        const response = await fetch(note.image);
        if (!response.ok) throw new Error("无法备份阅读图片");
        note.image = await blobToDataUrl(await response.blob());
      }
      if (note.image) note.imagePath = null;
    }
    saveLocal();
  };
  const previewMigration = () => {
    const snapshot = getLocalDataSnapshot();
    lastSnapshot = snapshot;
    return { snapshot, counts: countMigratableRecords(snapshot) };
  };
  const validateMigrationBackup = (backup) => {
    if (backup?.format !== "right-now-migration-backup" || backup.version !== 1 || !backup.data || !backup.counts) {
      throw new Error("备份文件格式无效");
    }
    const actualCounts = countMigratableRecords(backup.data);
    const matched = Object.keys(actualCounts).every((key) => actualCounts[key] === backup.counts[key]);
    if (!matched) throw new Error("备份文件数量与迁移预览不一致");
    return actualCounts;
  };
  const downloadMigrationBackup = (backup) => {
    const json = JSON.stringify(backup, null, 2);
    const parsed = JSON.parse(json);
    validateMigrationBackup(parsed);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = `right-now-migration-backup-${Date.now()}.json`;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setBackupStatus({ downloaded: true, verified: true });
    } catch (error) {
      setBackupStatus({ downloaded: false, verified: true });
      document.querySelector("#migrationDownloadBackupButton")?.removeAttribute("hidden");
      throw new Error(`备份下载未能启动：${error.message || "浏览器阻止了下载"}`);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  };
  const createMigrationBackup = async () => {
    backupStatus = { created: false, downloaded: false, verified: false };
    await cacheBookImagesForMigration();
    const snapshot = getLocalDataSnapshot();
    const counts = countMigratableRecords(snapshot);
    const previewCounts = countMigratableRecords(lastSnapshot || snapshot);
    if (!Object.keys(counts).every((key) => counts[key] === previewCounts[key])) {
      throw new Error("本地数据已变化，请重新查看迁移预览");
    }
    const backup = { format: "right-now-migration-backup", version: 1, createdAt: new Date().toISOString(), counts, data: snapshot };
    localStorage.setItem(MIGRATION_BACKUP_KEY, JSON.stringify(backup));
    lastBackup = backup;
    setBackupStatus({ created: true });
    downloadMigrationBackup(backup);
    lastSnapshot = snapshot;
    return { ...backup, backupStatus };
  };
  const renderPreview = (preview) => {
    const dialog = document.querySelector("#migrationDialog");
    if (!dialog) return null;
    const labels = { tasks: "任务", records: "时间记录", dailySummaries: "每日总结", thoughts: "思考", books: "书籍", readingNotes: "阅读笔记", images: "图片" };
   dialog.querySelector("#migrationCount").innerHTML = Object.entries(preview.counts).map(([key, count]) => "<li><span>" + labels[key] + "</span><strong>" + count + "</strong></li>").join("");
    dialog.querySelector("#migrationTargetAccount").textContent = getOwnerEmail();
    backupStatus = { created: false, downloaded: false, verified: false };
    setBackupStatus(backupStatus);
    dialog.dataset.migrationState = "pending";
    dialog.querySelector("#migrationProgress").setAttribute("aria-valuenow", "0");
    dialog.querySelector("#migrationProgress span").style.width = "0%";
    dialog.querySelector("#migrationConfirmButton").hidden = false;
    dialog.querySelector("#migrationRetryButton").hidden = true;
    dialog.querySelector("#migrationDownloadBackupButton").hidden = true;
    return dialog;
  };
  const preview = async (onConfirm) => {
    if (!pendingMigration()) return { skipped: true };
    const preview = previewMigration();
    const dialog = renderPreview(preview);
    if (!dialog) {
      const confirmed = window.confirm(`将迁移 ${Object.values(preview.counts).reduce((sum, count) => sum + count, 0)} 项本地数据。已确认本地数据会先备份，是否继续？`);
      if (confirmed) await onConfirm?.(preview);
      return { ...preview, confirmed };
    }
    dialog.showModal();
    return new Promise((resolve) => {
      const confirmButton = dialog.querySelector("#migrationConfirmButton");
      const cancelButton = dialog.querySelector("#migrationCancelButton");
      const retryButton = dialog.querySelector("#migrationRetryButton");
      const downloadButton = dialog.querySelector("#migrationDownloadBackupButton");
      const attempt = async () => {
        confirmButton.disabled = true;
        retryButton.disabled = true;
        dialog.dataset.migrationState = "preparing";
        dialog.querySelector("#migrationProgress").setAttribute("aria-valuenow", "55");
        dialog.querySelector("#migrationProgress span").style.width = "55%";
        dialog.querySelector("#migrationBackupStatus").textContent = "正在创建备份…";
        try {
          await onConfirm?.(preview);
          dialog.dataset.migrationState = "completed";
          dialog.querySelector("#migrationProgress").setAttribute("aria-valuenow", "100");
          dialog.querySelector("#migrationProgress span").style.width = "100%";
          dialog.querySelector("#migrationBackupStatus").textContent = "备份完成，迁移完成";
          dialog.close();
          resolve({ ...preview, confirmed: true });
        } catch (error) {
          abortMigration(error);
          dialog.dataset.migrationState = "failed";
          dialog.querySelector("#migrationProgress").setAttribute("aria-valuenow", "100");
          dialog.querySelector("#migrationProgress span").style.width = "100%";
          dialog.querySelector("#migrationBackupStatus").textContent = `迁移未完成：${error.message || "请从备份恢复或重试"}`;
          confirmButton.hidden = true;
          retryButton.hidden = false;
          retryButton.disabled = false;
        } finally {
          confirmButton.disabled = false;
        }
      };
      cancelButton.onclick = () => { dialog.dataset.migrationState = "aborted"; dialog.close(); resolve({ ...preview, confirmed: false }); };
      downloadButton.onclick = () => {
        try {
          if (!lastBackup) throw new Error("请先创建备份");
          downloadMigrationBackup(lastBackup);
          downloadButton.hidden = true;
          dialog.querySelector("#migrationBackupStatus").textContent = "备份已校验，下载已触发；请点击重试继续迁移";
        } catch (error) {
          dialog.querySelector("#migrationBackupStatus").textContent = error.message || "备份下载未能启动";
        }
      };
      confirmButton.onclick = attempt;
      retryButton.onclick = attempt;
      dialog.oncancel = () => { dialog.dataset.migrationState = "aborted"; resolve({ ...preview, confirmed: false }); };
    });
  };
  const confirmMigration = async () => {
    const result = await preview(async () => {
      setStatus("正在创建本地备份");
      await createMigrationBackup();
    });
    return !!result.confirmed && !result.error;
  };
  const prepareMigration = async () => {
    const cloud = getCloud();
    const user = getCloudUser();
    if (!cloud || !user?.is_anonymous) return null;
    const token = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const tokenHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)).then((bytes) => Array.from(new Uint8Array(bytes)).map((byte) => byte.toString(16).padStart(2, "0")).join(""));
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { error } = await cloud.from("account_migrations").upsert({ source_user_id: user.id, token_hash: tokenHash, expires_at: expiresAt });
    if (error) throw error;
    const migration = { sourceUserId: user.id, tokenHash, expiresAt };
    localStorage.setItem(MIGRATION_KEY, JSON.stringify(migration));
    return migration;
  };
  const verifyMigrationResult = async ({ includeImages = true } = {}) => {
    const pending = pendingMigration();
    const user = getCloudUser();
    if (!pending?.expectedCounts || !pending.cloudBaseline || !user || user.is_anonymous) {
      throw new Error("缺少迁移数量校验所需的数据");
    }
    const cloudCounts = await fetchCloudCounts(user.id);
    const comparison = compareCounts(pending.expectedCounts, cloudCounts, pending.cloudBaseline, { includeImages });
    return { ...comparison, expected: pending.expectedCounts, baseline: pending.cloudBaseline, actual: cloudCounts };
  };
  const executeMigration = async () => {
    const pending = pendingMigration();
    const cloud = getCloud();
    const user = getCloudUser();
    if (!pending || !user || user.is_anonymous || !cloud) return { ok: false, skipped: true };
    const expectedCounts = pending.expectedCounts || countMigratableRecords(lastSnapshot || getLocalDataSnapshot());
    const cloudBaseline = pending.cloudBaseline || await fetchCloudCounts(user.id);
    let migration = pending.expectedCounts && pending.cloudBaseline ? pending : savePendingMigration({ ...pending, expectedCounts, cloudBaseline });
    if (!migration.claimedAt) {
      const { data, error } = await cloud.rpc("claim_anonymous_migration_safe", { p_source_user_id: migration.sourceUserId, p_token_hash: migration.tokenHash });
      if (error) return { ok: false, error };
      if (!data?.success) return { ok: false, error: migrationConflictError(data), conflict: data };
      migration = savePendingMigration({ ...migration, claimedAt: new Date().toISOString() });
    }
    const verification = await verifyMigrationResult({ includeImages: false });
    if (!verification.valid) return { ok: false, error: new Error("云端迁移数量不一致"), verification };
    return { ok: true, verification };
  };
  const completeMigration = async () => {
    const verification = await verifyMigrationResult();
    if (!verification.valid) return { ok: false, error: new Error("云端迁移数量不一致"), verification };
    localStorage.setItem(MIGRATION_COMPLETED_KEY, JSON.stringify({ completedAt: new Date().toISOString(), expected: verification.expected, baseline: verification.baseline, actual: verification.actual }));
    localStorage.removeItem(MIGRATION_KEY);
    return { ok: true, verification };
  };
  const abortMigration = (error) => {
    setStatus(error ? `迁移已中断：${error.message || "本地数据仍保留"}` : "迁移已取消，本地数据仍保留", false);
    return { ok: false, error };
  };
  return { pendingMigration, getLocalDataSnapshot, countMigratableRecords, fetchCloudCounts, compareCounts, getBackupStatus: () => ({ ...backupStatus }), validateMigrationBackup, downloadMigrationBackup, createMigrationBackup, previewMigration, preview, confirmMigration, prepareMigration, executeMigration, completeMigration, verifyMigrationResult, abortMigration, emailRedirectUrl, captureMigrationFromUrl };
}

window.createMigrationService = createMigrationService;
