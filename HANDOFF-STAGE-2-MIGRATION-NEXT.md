# RIGHT NOW：阶段 2 首次迁移安全交接

更新时间：2026-09-28

## 下一窗口目标

完成阶段 2 的最小修复与真实验收。只使用明确可删除的测试账号或测试数据；不要操作正式业务数据。

当前不能宣布阶段 2 验收通过。语法和静态检查已通过，但以下关键验收项仍未闭环：

- 云端迁移前后数量校验尚未实现；当前只校验本地快照数量。
- 备份目前写入 `localStorage`，尚未生成并验证可读取的下载备份文件。
- `syncBooksToCloud()` 的失败返回值未在迁移完成流程中检查，图片或阅读笔记同步失败时可能误显示迁移成功。
- 真实浏览器回归尚未完成：取消、断网、云端冲突、重试和不覆盖已有云端数据。

## 当前工作区

- 项目：`/Users/joyyan/Documents/03_创业工作/04_运营与内容/公众号/time-block-pwa`
- 分支：`main`
- 当前未提交改动：`app.js`、`index.html`、`styles.css`、`sw.js`
- 新增未跟踪文件：`migration.js`、`supabase-sync-v1.sql`
- 现有 `HANDOFF.md`、`HANDOFF-STAGE-1-SESSION-RELIABILITY.md`、`HANDOFF-STAGE-1-SESSION-RELIABILITY-NEXT.md` 保留，不要重写或删除。

## 已完成实现

### migration.js

已将首次迁移逻辑集中到 `migration.js`，包括：

- `getLocalDataSnapshot()`、`countMigratableRecords()`
- `createMigrationBackup()`、`previewMigration()`、`confirmMigration()`
- `prepareMigration()`、`executeMigration()`、`verifyMigrationResult()`、`abortMigration()`
- `emailRedirectUrl()`、`captureMigrationFromUrl()`

迁移对象：tasks、records、dailySummaries、thoughts、books、readingNotes、images。

当前备份键：`time-block-migration-backup`、`time-block-migration-completed`。

### app.js

- 使用 `migrationController.preview()` 展示迁移数量。
- `onAuthStateChange` 不再无条件调用 `completePendingMigration()`；该函数已移除。
- 用户确认后才创建备份并执行迁移。
- 用户取消或迁移失败时保留本地数据，不读取云端覆盖本地状态。
- 失败时显示“迁移未完成，请从备份恢复或重试”。

### index.html / styles.css

迁移弹窗包含数量、备份状态、目标账号、确认、取消、重试和进度条。

### supabase-sync-v1.sql

新增独立增量 SQL，未修改 `supabase-schema.sql`。内容包括业务表检查、`updated_at`、`user_id` 与 RLS 复核、每日总结唯一约束、`sync_operations`、操作幂等约束、迁移批次字段、状态日志和更新时间触发器。

该 SQL 尚未在 Supabase 项目执行。

## 已完成检查

- `node --check app.js`：通过。
- `node --check migration.js`：通过。
- `git diff --check`：通过。

这些检查不等于真实浏览器或真实 Supabase 迁移验收。

## 下一窗口优先修复

1. 在迁移前保存明确的预期数量，并在云端迁移后按表查询实际数量；任何不一致都停止，不删除本地备份，不清除待迁移标记。
2. 将备份导出为可读取的 JSON 文件，并在浏览器中实际下载、读取和校验数量。
3. 检查 `syncBooksToCloud()` 返回值；图片或阅读笔记失败时不得写入迁移完成标记，必须保留可重试状态。
4. 复核 `claim_anonymous_migration` 的主键冲突行为，确认已有目标账号数据不会被覆盖；只使用测试账号验证。
5. 仅在上述修复完成后进行真实浏览器验收。

## 验收清单

使用可删除测试账号/数据逐项记录：

1. 登录后看到任务、记录、总结、思考、书籍、笔记和图片数量。
2. 备份完成前无法开始迁移。
3. 取消后不上传、不读取云端覆盖本地。
4. 中途断网后本地数据仍完整，迁移状态可重试。
5. 云端实际数量与迁移前预期不一致时自动停止。
6. 目标账号已有数据时，迁移不覆盖已有记录。
7. 迁移失败后可以重试，并且重试不会重复写入或破坏本地数据。
8. 下载的备份文件可独立读取，JSON 可解析，数量与预览一致。

## 安全边界

- 不清除浏览器 `localStorage`。
- 不删除旧 UID、正式云端数据或无关改动。
- 不记录密码、Token、OTP 或私密用户信息。
- 不修改或重写旧版 SQL；后续数据库变更只新增增量 SQL。
- 不把 `localStorage` 备份或待迁移标记误认为可靠多设备操作队列。
- 阶段 2 未验收通过前，不进入阶段 3 的 IndexedDB 操作队列或多设备迁移重构。
