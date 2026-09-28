# RIGHT NOW 项目交接文档

> **接手优先阅读（2026-09-28，域名绑定与 HTTPS 已完成）**：本文件后方历史记录描述的是已发布的 `v38/v14/v34` 版本。当前本地含已验证但未提交的手机 OTP 登录修复，正式站点为 `https://www.signorecarnevale.top`。不要覆盖现有本地改动，不要清除浏览器 `localStorage` 或删除云端数据。

## 本轮：正式域名绑定（已完成，待提交发布）

### 已完成的外部配置

- DNS 服务商为腾讯云 DNSPod，域名为 `signorecarnevale.top`，免费套餐的同主机、同线路、同类型记录负载均衡配额为 2 条。因此不使用根域名的 GitHub Pages A 记录，统一以 `www` 作为正式站点。
- 已删除此前两条根域名 `@ A` 记录，当前 DNS 唯一记录为：`www CNAME sariarich.github.io`（默认线路，TTL `600`）。根域名 `signorecarnevale.top` 暂不解析；如需根域访问，须在注册商另设 URL 转发或升级 DNS 套餐。
- GitHub Pages（仓库 `Sariarich/cike-time-journal-joyyan`）已在 Safari 登录的 `Sariarich` 账号中设置 Custom domain：`www.signorecarnevale.top`。
  - GitHub 已显示 **DNS valid for primary**，且已启用 **Enforce HTTPS**（复选框已勾选）。
  - GitHub 仍提示裸域名 `signorecarnevale.top` 未指向 Pages；这是免费方案下未配置根域名的预期状态，不影响 `www` 主站。
  - Pages 发布源仍为 `main` 分支的根目录。
- Supabase 项目 `wacwjwtmmziakklcyuvt` 的 Authentication URL Configuration 已更新：
  - Site URL：`https://www.signorecarnevale.top`
  - Redirect URLs：保留原有两个 `sariarich.github.io/cike-time-journal-joyyan` 地址，新增 `https://www.signorecarnevale.top/**`。

### 当前停点：提交并发布本地改动

- 域名、DNS、HTTPS 与 Supabase 配置均已完成；下一步是复核工作区差异，提交本轮 OTP 修复和域名文件，并推送至 `github/main`。

### 已完成的本地准备（尚未提交或推送）

- 根目录 `CNAME` 文件内容为 `www.signorecarnevale.top`。
- `app.js` 的 `PUBLIC_APP_URL` 已改为 `https://www.signorecarnevale.top/`，以供旧迁移回调路径使用；当前 OTP 登录并不依赖邮件重定向。
- 原本待发布的手机 OTP 登录修复保持不变：`HANDOFF.md`、`app.js`、`index.html`、`styles.css`、`sw.js` 均有未提交改动，另有未跟踪 `CNAME`。
- 本地校验已通过：`node --check app.js`、`git diff --check`。

### 发布与回归待办

1. 人工复核工作区差异，提交本轮登录修复和域名文件，推送至 `github/main`（远端名是 `github`，不要使用 `origin`）。命令行 `gh` 登录令牌已失效，但 Safari 的 GitHub 会话可用；Git 推送的可用凭据需另行验证。
2. 等待 GitHub Pages 部署，确认线上实际加载 `app.js?v=40`、`styles.css?v=15`、缓存 `right-now-v36`，且 `www` 走 HTTPS。
3. 在手机 Safari/Android Chrome 进行真实 8 位 OTP 登录回归；验证任务、记录、总结、思考、书籍、笔记同步，不得删除正式数据。
4. 邮件模板与自定义 SMTP 已在上一轮设置完成；不得记录或暴露 SMTP 密码、令牌或 OTP。

---

> **接手优先阅读（2026-09-27）**：本文件后方的历史记录描述的是已发布的 `v38/v14/v34` 版本；下列登录修复是新的本地改动，**已验证但尚未提交、推送或发布**。请以本节为当前状态。

## 本轮：手机竖屏 OTP 登录修复

### 已完成

- 已完成现状检查与数据备份；备份文件可读取，未迁移、修改或删除任何正式用户数据。
  - `/Users/joyyan/Downloads/right-now-backup-2026-09-27.json`
  - `/Users/joyyan/Downloads/right-now-local-storage-backup-2026-09-27.json`
- 已确认登录服务使用 Supabase Auth Email OTP，项目为 `wacwjwtmmziakklcyuvt`。
- 管理员已在 Supabase 后台配置自定义 SMTP，并将 “Magic link or OTP” 邮件模板改为 `{{ .Token }}`。**不要把 SMTP 密码、会话令牌或验证码写入代码、提交记录或交接文档。**
- 已实际发送验证码、完成 OTP 验证，并以已验证会话读取云端任务数据；三项请求均返回成功。
- 找到手机端问题：发送登录入口原先位于 `.sync-bar` 内，而移动端 CSS 会隐藏其中的 `.logout-button`，导致入口不可见；旧实现也仅支持魔法链接，页面没有验证码输入路径。

### 本地代码改动（尚未发布）

- `index.html`：将登录区独立为普通文档流中的验证码面板，包含发送、输入和验证按钮；320px 宽度无需横向滚动。
- `app.js`：改用 `signInWithOtp` 发送验证码，再用 `verifyOtp` 校验；真实服务返回 **8 位数字验证码**，因此前端限制为 8 位而非 6 位。
- `styles.css`：新增手机单列登录面板与键盘友好尺寸；移除页面 `min-width: 320px`，消除窄屏横向溢出。
- `sw.js`：更新缓存为 `right-now-v36`，资源版本为 `app.js?v=40`、`styles.css?v=15`。

### 已完成验证

- `node --check app.js`：通过。
- `git diff --check`：通过。
- 本地 320px 与桌面布局检查：登录区可见、可操作且无横向滚动。
- 实际 SMTP 发信、8 位 OTP 验证和已登录云端读取：通过。

### 当前工作区与发布说明

- 当前分支：`main`；远端名称：`github`（不要使用 `origin`）。
- 当前未提交文件：`HANDOFF.md`、`app.js`、`index.html`、`styles.css`、`sw.js`。
- `HANDOFF.md` 在本轮前已有用户维护的历史更新；不要覆盖其历史内容。
- **尚未提交、推送或部署登录修复。**发布前应先人工查看差异，随后提交、推送至 `github/main`，等待 GitHub Pages 部署，并在手机浏览器上做一次真实登录回归。

### 建议的最后回归

1. iOS Safari 与 Android Chrome：320px/窄屏、软键盘弹出后均能发送、看到、输入并提交 8 位验证码。
2. 验证重发、错误码、过期码、慢网和断网提示。
3. 登录成功后确认任务、时间记录、每日总结、思考、书籍和笔记同步正常；不得清除 `localStorage` 或删除云端数据。
4. 发布后确认实际加载 `app.js?v=40`、`styles.css?v=15` 和 Service Worker 缓存 `right-now-v36`。

### 数据位置速查

- 浏览器正式本地数据：`localStorage` 的 `time-block-pwa-v1`；登录会话：`cike-journal-auth`；迁移临时信息：`time-block-pending-migration`。
- 云端业务表：`time_tasks`、`time_records`、`daily_summaries`、`thought_entries`、`reading_books`、`reading_notes`；均以 `user_id` 区分用户。
- 私有图片 Bucket：`reading-images`，路径为 `用户 UID/书籍 ID/笔记 ID.jpg`。
- Service Worker Cache Storage 仅用于离线和加速，不是用户正式数据。

---

## 项目概况

- 项目目录：`/Users/joyyan/Documents/03_创业工作/04_运营与内容/公众号/time-block-pwa`
- GitHub 仓库：`Sariarich/cike-time-journal-joyyan`
- 当前线上地址：<https://sariarich.github.io/cike-time-journal-joyyan/?date=2026-09-25>
- 当前分支：`main`
- Supabase 新账号 UID：`2542b033-0c41-4b25-9698-af145f6824fc`
- 旧账号 UID：`5f37a899-96ee-4862-b3dc-54dfa411f808`

## 当前状态

网页目前已经可以正常投入使用。线上页面应以带 `?date=2026-09-25` 的地址为准；此前不带日期参数的访问曾返回 GitHub Pages 404，不要据此判断当前部署状态。

本轮功能已提交并推送：`b9c354a feat: add backup and reading note controls`。GitHub Pages 已发布，线上带日期参数的页面已确认显示“导出数据”入口。

本交接文档的上一版已随 `2272663 docs: update project handoff status` 推送至 `github/main`（远端名称为 `github`，不是 `origin`）。

本轮导航调整与思考浏览调整已随 `13f139f feat: show all thoughts across dates` 推送至 `github/main`，并已在 GitHub Pages 线上地址复核。THOUGHTS 已从页面底部的独立入口移入主导航，成为与 MISSION、24 HOURS、STATISTICS、READING NOTES 并列的第五个功能区。进入思考页后主导航保持可见；手机端底栏已改为五等分。THOUGHTS 不再受全局日期切换影响，进入后始终展示全部思考；编辑思考也不再因当前日期而改写其原始归档日期。

最新已提交版本为 `52eed64 fix: brighten centered carousel card`，已位于本地 `main` 与 `github/main`。GitHub Pages 已完成部署并在线复核。

本轮已修复轮播第三张卡片滚动到居中位置后无法变亮的问题：轮播滚动结束时会按视口中心同步实际高亮卡片，兼容前、中、后三份无限循环轨道。线上资源已确认更新为 `app.js?v=38`、`styles.css?v=14`，Service Worker 缓存版本为 `right-now-v34`。

应用代码当前无未提交改动；本次仅更新了本交接文档，`HANDOFF.md` 目前有未提交改动。当前分支为 `main`，远端为 `github`，不要使用 `origin`。

线上复核结果：进入 THOUGHTS 显示“全部思考”；将全局日期从 2026-09-27 切至 2026-09-26 后，该提示与思考列表维持全部浏览模式。

本轮已完成并发布的本地界面调整如下：

- THOUGHTS：移除了页内的“THOUGHTS”及“全部思考”两行文字；顶部导航中的 THOUGHTS 标签保持不变，全部思考浏览逻辑不变。
- READING NOTES：改为全局书架，日期切换不再改写页面标题或影响书架内容；页面标题固定为“阅读笔记”。
- 空书架：书架为空时，仅居中显示“书架还是空的”，不再同时显示右侧的新建表单。
- 新建书籍：点击“新建书籍”后，才以独立的 NEW BOOK 弹窗展示书名、作者与创建按钮；创建成功后弹窗关闭。
- 已完成验证：`node --check app.js`、`git diff --check`；线上已确认资源版本更新。未创建、修改或删除任何真实数据。

本轮 READING NOTES 界面改动已随 `52eed64` 提交、推送并部署：

- 书籍卡片改为固定 `326px × 163px`，比例 2:1，当前卡片居中；移动端在屏幕不足时缩小到可用宽度。
- 卡片左上原来的黑白两个点已删除。
- 书名、作者和星级保留在上方卡片内，并整体上下居中；星级仍可点击调整。
- 下方 P2 读书笔记面板已移除书籍标题和星级头部，面板直接从“书摘”开始。
- 轮播仍支持左右滚动和选中卡片联动；书摘、心得的保存、删除和图片上传逻辑未改动。
- 已加入无限循环轮播：书籍列表渲染为前、中、后三份轨道，滚动接近首尾时自动无感跳回中间轨道；每本书仍使用原始 ID，选中后下方笔记面板正常联动。
- 本轮只改动展示结构、样式与轮播高亮逻辑，未创建、修改或删除任何真实数据。

已完成校验：`node --check app.js`、`git diff --check`、本地隔离预览、390px 移动端布局检查、线上资源版本复核。未登录云端，未执行任何真实数据删除。

## 本轮已完成的功能

### 数据导出

- 顶部新增“导出数据”按钮，手机端保留入口。
- 以 JSON 导出当前用户在 `time_tasks`、`time_records`、`daily_summaries`、`thought_entries`、`reading_books`、`reading_notes` 中的全部数据。
- 所有查询均按当前登录用户的 `user_id` 过滤。
- 文件名格式：`right-now-backup-YYYY-MM-DD.json`。

### 阅读笔记书籍管理

- 书籍卡片悬停时显示编辑、删除按钮。
- 支持编辑书名和作者。
- 删除书籍前会二次确认，并同步删除该书的 `reading_notes` 与阅读图片。

### 书摘与心得

- 选中书籍后自动加载最新书摘和心得到输入框。
- 有记录时显示“更新书摘”或“更新心得”，无记录时显示“保存书摘”或“保存心得”。
- 增加“删除书摘”和“删除心得”按钮。
- 保留多条书摘、心得列表和单条删除能力。

### 安全与交互

- 阅读模块的读取、更新、删除操作增加 `user_id` 过滤。
- 任务、时间记录、总结、思考的读取和删除路径补充用户过滤。
- 增加 Toast 操作提示。

## 关键版本信息

- `index.html` 使用 `app.js?v=38`。
- `index.html` 使用 `styles.css?v=14`。
- `sw.js` 使用缓存版本 `right-now-v34`，并预缓存 `app.js?v=38` 与 `styles.css?v=14`。

## 下一步建议

1. 如需完整云端回归，使用线上地址登录后测试导出、编辑书籍、更新/删除书摘与心得；删除书籍仅限明确可删除的测试书籍，并确认关联笔记和阅读图片同步删除。
2. 如需继续开发，先执行 `git status --short --branch` 与 `git diff --check`，确认当前干净状态后再开始新一轮改动。
3. 若继续调整轮播，优先验证：任意前/中/后副本滚动到视口中心后均变亮，且下方笔记面板与选中书籍保持联动。
4. 后续改动提交与推送使用以下 Git 可执行文件，并使用远端名称 `github`：

```text
/Users/joyyan/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/git
```

5. 发布新改动时，先更新 `app.js`、`styles.css` 的查询版本和 Service Worker 缓存版本，再推送；随后重新打开线上地址复核。

## 注意事项

- 不要删除旧 UID 用户。
- 不要清除浏览器 `localStorage`。
- 不再处理数据迁移事项。
- 删除书籍属于真实数据删除操作，测试时只使用明确可删除的测试书籍。
- 若提交前发现与本轮无关的改动，保留并单独报告，不要覆盖或清理。
