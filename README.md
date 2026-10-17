# ReadWords

Mac 本地个人英语语料库。当前实现范围为首个闭环及 Excel 严格 P1 导入：**Source → 手动采集 → Inbox → 保存 → 搜索详情**，并非完整 R0。

第一次使用请看 [中文使用指南](documents/USER_GUIDE.md)，或启动后打开 [网站内使用指南](http://127.0.0.1:3000/guide)。本 README 主要用于开发、启动及验收。

功能现状见 [Feature List](documents/FEATURE_LIST.md)；后续计划见 [云端与多设备升级方案](documents/07-云端与多设备升级方案.md)。[PRD v0.4](documents/02-产品需求文档.md) 包含已确认本地基线与尚未实现的 C 阶段，不代表当前已上云。

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

本阶段尚未实现 JSON 备份恢复。在后续交付前，临时人工备份方式：停止所有使用该库的服务，复制完整 `data` 目录到另一个安全位置；恢复也在服务停止时进行。不要将备份提交到公开仓库。

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

## 检查命令

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

E2E 使用本机已安装的 Google Chrome、独立 3100 端口和系统临时目录中的独立 SQLite 文件，不使用 `data/` 用户库。无需手动先启动测试服务器；E2E 使用独立 `.next-e2e/` 构建目录，避免与日常开发服务争用 `.next/`。失败 trace 位于 `test-results/`。若未安装 Google Chrome，先安装或在 Playwright 配置中指定可用浏览器。

## 当前边界

- 已有：Excel 严格 P1 导入、四类来源、来源编辑/归档、手动采集、Inbox 自动保存/忽略恢复、义项候选与重复事件确认、原子入库、搜索筛选和多语境详情。
- 后续 R0：Review、真实 AI、JSON 备份恢复、表达和 Context 编辑、删除及回收站、容量性能验收。
- 后续 R1：OCR、PWA、CSV、统计。
- 无登录、云端同步或后台外部调用。安装依赖后，本地核心流程运行无需外网。

详细规则见 [PRD](documents/02-产品需求文档.md)、[技术设计](documents/04-技术设计与首个闭环.md) 和 [阶段验收记录](documents/05-首个闭环验收记录.md)。
