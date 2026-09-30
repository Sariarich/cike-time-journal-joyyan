# RIGHT NOW：阶段 1 会话可靠性交接

更新时间：2026-09-28

## 当前基线

- 分支：`main`
- 已提交基线：`e8ef1aa docs: prepare long-term sync handoff`（`github/main` 同步）
- 本轮未提交改动：`app.js`
- 本轮未修改：`HANDOFF.md`、`index.html`、`styles.css`、`sw.js`、历史 SQL 文件及任何云端数据。
- 远端仅使用 `github`，不使用 `origin`。

## 本轮完成内容

### 会话生命周期

- 新增显式会话状态：恢复中、已登录、已过期、退出中、未登录、网络不可用、本机模式。
- 页面启动先显示“正在恢复登录”，随后读取 Supabase 当前 session。
- 网络重新可用时重新读取 session；Token 失效显示重新登录提示。
- 新增 `signOut()`：只调用 `cloud.auth.signOut()`，不会删除 `time-block-pwa-v1`、任务、记录、总结、思考、书籍、笔记或待同步状态。
- 手动退出完成后显示“未登录，本机数据仍保留”。

### 多标签页认证同步

- 新增 `BroadcastChannel`，频道为 `right-now-auth`。
- 只广播 `signed-in`、`signed-out`、`session-expired` 三种无敏感内容的事件。
- 其他标签页收到登录事件后重新读取自己的 Supabase session。
- 其他标签页收到退出或过期事件后只更新认证界面和内存状态；不会在标签页之间传输、合并或覆盖业务数据。

### 错误与重试

- 新增 `classifyAuthError()` 与 `classifySyncError()`。
- 已覆盖：无网络、会话过期、RLS/权限、数据冲突、服务端、未知错误。
- 网络或服务失败时，本机修改保留并显示待同步/失败，不显示“已同步”。
- 任务、记录、总结、思考和阅读同步均接入统一错误提示；阅读同步使用 `pendingBookSync` 标记待重试。
- 顶部“立即同步”会重试任务/记录、阅读、思考及总结；仅所有重试成功后显示“已同步”。

## 验证结果

- `node --check app.js`：通过。
- `git diff --check`：通过。
- 未进行真实 OTP、断网、Token 过期或多标签页浏览器回归；上线前必须补测。

## 已知限制与下一步

- 本轮只修改 `app.js`。`signOut()` 已就绪，但退出按钮与会话状态界面尚未加入 `index.html` / `styles.css`。
- 现有匿名迁移逻辑仍保留，且 `completePendingMigration()` 仍由登录恢复路径调用；阶段 2 必须按“预览 → 本地备份 → 用户确认 → 执行”重构，不能自动迁移。
- 当前待同步标记是既有本地状态的增强，不是阶段 3 计划中的 IndexedDB 持久化操作队列；不要据此认定已支持可靠的多设备自动同步。
- 后续先完成阶段 1 的界面入口与真实浏览器回归，再进入迁移和增量同步工作。

## 安全边界

- 不清除浏览器 `localStorage`。
- 不删除旧 UID、正式云端数据或无关改动。
- 不记录 SMTP 密码、Token、OTP 或私密用户信息。
- 后续 SQL 变更必须创建新的增量迁移文件，不能重写历史 SQL。
