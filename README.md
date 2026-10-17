# ReadWords

Mac 本地个人英语语料库。当前实现范围为首个闭环及 Excel 严格 P1 导入：**Source → 手动采集 → Inbox → 保存 → 搜索详情**，并非完整 R0。

第一次使用请看 [中文使用指南](documents/USER_GUIDE.md)，或启动后打开 [网站内使用指南](http://127.0.0.1:3000/guide)。本 README 主要用于开发、启动及验收。

功能现状见 [Feature List](documents/FEATURE_LIST.md)；后续计划见 [云端与多设备升级方案](documents/07-云端与多设备升级方案.md)。[PRD v0.8](documents/02-产品需求文档.md) 包含已确认本地基线与尚未实现的 C 阶段，不代表当前已上云。

Review 需求见 [低压力复习需求与技术设计](documents/11-低压力Review需求与技术设计.md) 和 [开发/验收计划](documents/12-Review开发计划与验收清单.md)：手动选择复习池，限时限量，无补课欠账。当前 RV-A 认义功能已实现，完整 Mac 验收待补，RV-B 未开始。实施证据见 [Review 自检记录](documents/13-Review实现与自检记录.md)。

## 启动

需要 Node.js **24.x** 和 npm；无需安装独立数据库。

```sh
cd /Users/Admin/Src/themoonstone/Reader
npm ci
npm run dev
```

浏览器访问 [http://127.0.0.1:3000](http://127.0.0.1:3000)。首次启动自动创建数据库。首次编译可能较慢；日常开发无需重复执行 `npm ci`。服务默认仅监听本机回环地址，Safari/Chrome 均为目标浏览器。

稳定构建运行：

```sh
npm run build
npm start
```

开发与正式模式使用相同数据库；请先在终端按 `Ctrl+C` 停止另一模式，避免端口冲突。停止服务不会删除数据；再次启动即可继续使用。当前使用 Node 内置 SQLite，出现实验性模块提示时不表示保存失败。

## 数据位置

默认：`/Users/Admin/Src/themoonstone/Reader/data/readwords.sqlite`。同目录的 `-wal` / `-shm` 文件属于运行时数据库状态，勿在运行中单独移动或删除。`data/` 不入 Git，Git 提交不等于数据备份。

可在 `.env.local` 设置 `READWORDS_DB_PATH=/绝对路径/readwords.sqlite`，然后重启服务；这会切换数据库位置，**不会自动搬迁原有数据**。

左下“本地工作空间”→“备份与恢复”可下载全库 JSON（schema 3，兼容有效 schema 2，上限 50 MB），恢复时先校验和预览、生成当前库快照，再确认整库替换。恢复后旧窗口须复制输入并刷新。快照按数据库文件名隔离，默认在 `data/snapshots/readwords.sqlite/`，与数据库同机，不代替异地备份；尚无定时备份。详见 [备份与维护说明](documents/09-备份恢复与数据维护.md)。

首次打开原 schema v1/v2 数据库会在相应升级前生成 `before-schema-v2-*.sqlite` / `before-schema-v3-*.sqlite` 一致性快照，再事务升级到当前 v3。旧 schema 2 JSON 恢复会清除复习进度，须检查预览警告。不要在运行中手动替换数据库；应急回退步骤见上述说明。

## 5 分钟验收

1. Library → 新建来源，选择 Reading，标题填写 `Slow Down`。
2. 顶部“记录表达”：填写 `carve out`、原句 `I carve out some time every morning.`，选择刚创建的来源，加入 Inbox。
3. 整理页填写语境释义“专门腾出时间”、页码 `12`，设 P1；等待“草稿已保存”。刷新页面，确认输入仍在。
4. 点击“确认入库”，详情应显示原句、释义、页码，Seen=1、Used=0。
5. Search 搜 `腾出`、`Slow Down` 或 `carve out`，都能找到此表达并打开详情。
6. 再采集一次同义表达，换一条原句；在 Inbox 选择已有义项后保存。详情应仍为一个表达，包含两个 Context，Seen=2，原 P1 不被覆盖。
7. 停止并重新启动服务，重新打开详情，确认数据保留。

可继续验证四类来源；Writing 选择“获得纠正”并填写不同的原表达和改进表达，Used 仍应为 0；明确选择“已自主使用”的事件才增加 Used。Inbox 支持忽略和恢复，整理输入自动保存，保存失败时保留当前文本并支持重试与复制。

## 只导入本书 P1

1. 如终端运行的是旧的 `npm start`，先停止服务并重新 `npm run build` / `npm start`；开发模式可重新执行 `npm run dev`。
2. 刷新页面，点击顶部“导入 Excel”，选择 `resources/bringing_up_bebe_vocabulary_strict_P1_P2_P3.xlsx`。
3. 检查预览：仅严格 P1 的 120 条语境可选，P2/P3 与汇总表不会入库。
4. 选择已有 Reading 来源，或新建 `Bringing Up Bébé`；已有同词默认跳过，可用“仅查看已有同词 / 等级冲突”快速检查并逐组选择。
5. 勾选确认，点击“确认导入 N 条 P1”。空库默认分组应得到 112 个表达和 120 条语境；已有内容或分组调整会改变数量。
6. 点击“查看本书的表达”，页面自动按 P1 筛选；详情可展开 Excel 导入信息。

表格由服务端在本机解析，不调用 AI；上传后必须由你明确确认才写入。原始文件不被修改，也不会自动提交到 Git。完整规则与验收见 [Excel P1 导入说明](documents/06-Excel-P1导入说明与验收.md)。

Our Little Farm 可直接选择 `resources/Our_Little_Farm_Vocabulary-4.xlsx`，无需改表。应识别 373 条明细、P1/P2/P3=50/192/131，跳过 P1 汇总；自动建议 Our Little Farm 来源。空库全选新增 50 个表达和 50 条语境；已有同词需逐组确认。两种模板都只导入 P1。详见 [新格式说明与验收](documents/10-Our-Little-Farm导入说明与验收.md)。

## 检查命令

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

E2E 使用本机已安装的 Google Chrome、独立 3100 端口和系统临时目录中的独立 SQLite 文件，不使用 `data/` 用户库。无需手动先启动测试服务器；E2E 使用独立 `.next-e2e/` 构建目录，避免与日常开发服务争用 `.next/`。失败 trace 位于 `test-results/`。若未安装 Google Chrome，先安装或在 Playwright 配置中指定可用浏览器。

## 当前边界

- 已有：Excel 严格 P1 导入、四类来源、来源编辑/归档、表达编辑/归档/回收站、语境编辑/归属调整/删除恢复、JSON 备份恢复、手动采集、Inbox 自动保存/忽略恢复、义项候选与重复事件确认、原子入库、搜索筛选和多语境详情。
- 后续 R0：Review 完整验收与 RV-B、真实 AI、来源删除、容量性能及完整 Mac 验收。
- 后续 R1：OCR、PWA、CSV、统计。
- 无登录、云端同步或后台外部调用。安装依赖后，本地核心流程运行无需外网。

详细规则见 [PRD](documents/02-产品需求文档.md)、[技术设计](documents/04-技术设计与首个闭环.md) 和 [阶段验收记录](documents/05-首个闭环验收记录.md)。
# Reader


上云准备现已提供邮箱＋密码（Supabase Auth、唯一所有者）、服务端权限校验、维护只读、原生 SQLite 一致性备份/核对、Docker/Caddy 与定时 restic 加密备份配置。默认仍为本地模式，未部署线上服务。真实认证项目、SMTP、服务器/域名和异地备份仓库尚待配置与验收；不是 Git push 后自动上云。

配置与完整操作见 [邮箱登录及部署手册](documents/15-邮箱登录配置与部署操作手册.md)，实现及真实缺口见 [上云自检记录](documents/16-上云准备实现与自检记录.md)。追加检查命令：`npm run test:e2e:cloud`（仅合成认证服务和临时库）、`npm run ops -- manifest /absolute/path/readwords.sqlite`。Docker 文件位于 `deploy/`；当前环境没有 Docker，不宣称已通过真实容器部署。
