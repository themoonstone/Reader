# PhraseBud 部署执行记录

最新发布（2026-11-03）：`readwords:levels-v2-20261103`，新增 Excel P1/P2/P3 等级选择与全量收藏，并修复反馈时间一致性。06:58:41 CST 发布前后业务清单完全相等、挂载/认证配置不变；原生快照、隔离门禁及 HTTPS/资源验证通过，app/backup healthy。当前镜像、回退和完整证据见 [29](29-Excel导入等级选择与全量语料.md#44-生产候选和发布)，下文旧版本为历史记录。

日期：2026-10-18。正式域名：`phrasebud.com`；初始阶段用户报告域名审核中；后续截图显示 .com 正常、已添加根域 A 记录，当前状态见文末 HTTPS 增量。本记录补充 [15 部署手册](15-邮箱登录配置与部署操作手册.md) 和 [16 自检记录](16-上云准备实现与自检记录.md)。域名选择不改变应用名称、数据模型或单用户权限。

## 部署目标与隔离

- 服务器：既有 SSH 别名 `readwords`；Ubuntu 24.04、x86_64、约 2GB 内存，Docker/Compose 已可用。首次检查无业务容器，只有 SSH 和本机 DNS 端口监听，`~/readwords` 尚不存在。
- Mac 为 ARM 架构；使用 `docker buildx build --platform linux/amd64 --load -f deploy/Dockerfile -t readwords:phrasebud-amd64 .` 构建服务器镜像，不能将现有 ARM 镜像直接部署到 x86_64。
- 云端准备阶段使用 `deploy/compose.preview.yaml`，项目名 `phrasebud-preview`、独立 `preview-data` 卷。没有公开端口，只通过 SSH 执行容器内 HTTP 检查。模式仍为 production/cloud，正式 origin 为 `https://phrasebud.com`；不降低认证或 Cookie 的 HTTPS 要求。
- 此临时配置只用于部署验证，不是正式上线；不能直接用浏览器 HTTP/SSH 隧道完成生产 Secure Cookie 登录。真实网页登录在域名解析与 HTTPS 可用后执行。
- 仅复制 Supabase URL、publishable key、所有者 UUID/邮箱及域名到权限 600 的环境文件，不复制 Mac 本地数据库路径或 `127.0.0.1:7890` 代理设置。凭据配置不进入 Git、Docker 构建上下文或文档。
- Mac 正式学习库和 3000 原服务保持原状；不得用测试卷替换正式库。未配置 restic 独立仓库前，不声称已完成异地备份。

## 执行顺序

1. 只读检查服务器环境/现有容器、端口和目录，确认不会覆盖已有部署。
2. 优先本机构建 amd64 镜像；若本机 Docker Hub 连接失败而服务器网络正常，则上传只含允许目录的源码归档，在服务器核对 SHA-256 后原生构建 amd64 镜像。构建归档排除环境文件、数据库、工作簿、Git 和本机依赖。
3. 安装 preview Compose 和受限环境文件，`config --quiet` 校验；只启动 preview 应用。容器内验证健康、正式域名登录跳转、未登录 API 拒绝、错误 Host 拒绝及真实认证配置连接，不代填密码。
4. 域名审核通过后，由用户在 DNS 配置根域名 A 记录指向服务器 IPv4；只有实际配置 IPv6 接入时才添加 AAAA。检查外部解析结果，再开放代理所需 80/443 入站并验证 HTTPS。
5. 配置认证后台正式 Site URL、恢复回调和邮件模板，完成真实登录/退出/恢复；配置独立故障域的 restic 仓库并执行加密备份与隔离恢复验收。
6. 冻结本地正式库，生成并核对一致性快照，安装到尚未启动的正式 `learning-data` 卷。核对后以正式 Compose 启动，验证后解除维护，手机/iPad 验收。本地原库保留为只读回退副本，避免双端各写各的数据。

正式配置必须使用 `deploy/compose.yaml` 的代理、数据卷和备份服务。测试卷不作迁移源；不使用 `down -v` 清理正式数据。回退沿用 15 中的冻结与备份流程。

## 本次执行证据

- Mac 跨架构构建在 Docker Hub token 请求阶段超时；服务器 Docker Hub 认证端点与 npm registry 均返回 200，改为服务器原生构建。
- 上传源码归档 SHA-256：`296703e2dff321d03d71fee72fe21441586e7dde1f6ddee18578814681ff9bf1`，服务器校验通过。源码包含本轮未提交的 Docker 健康检查修正和 preview 配置；不代表 Git 已提交或推送。
- 本地 preview Compose `config --quiet` 校验通过。

- 服务器原生镜像生产编译、TypeScript 与页面构建通过，镜像平台 `linux/amd64`，本次 image config ID 为 `9ee113aebc02e46f13de5e57096588c2b2a0154535c092ae34fa913b70792336`。
- 服务器配置文件 `/home/ubuntu/readwords/.env.phrasebud` 权限为 600；服务器 Compose 静默校验通过。容器 `phrasebud-preview-app-1` 的 Docker 健康状态为 healthy。
- 容器内实测：健康 200/ok、首页 307 到 `https://phrasebud.com/login`、登录页 200、未登录来源接口 401、错误 Host 健康请求 503。真实 Supabase 认证配置接口返回 200、邮箱 provider 开启，无需 Mac 代理；没有代填密码或发送登录/恢复请求。
- 在空 preview 库使用 SQLite Backup API 生成快照，并核对 schema 3 全业务表/字段摘要/generation 一致。随后 `up -d --force-recreate --wait` 替换容器；对比替换前后 manifest 哈希一致，删除临时校验标记。此项只证明容器重建保卷和原生备份可用，不代表服务器重启、真实库迁移或异地恢复通过。
- `docker ps` 仅显示镜像的 `3000/tcp`，无主机端口映射；主机监听检查仍只有 SSH 和本机 DNS。域名 IPv4 查询无结果；没有申请证书、改 DNS、防火墙、认证后台或迁移正式数据。

## 查看和停止预部署

在服务器执行以下命令，路径均为本次实际部署目录：

```bash
cd /home/ubuntu/readwords
docker compose --env-file .env.phrasebud -f source/deploy/compose.preview.yaml ps
docker compose --env-file .env.phrasebud -f source/deploy/compose.preview.yaml stop
```

`stop` 仅在需要停止测试服务时执行；测试容器目前保持运行。应用日志不要公开粘贴包含恢复链接的请求或密钥，不执行输出展开配置的命令。正式配置仍缺 restic 仓库，不能把 preview 当成正式上线。

## 验收进度

| 项目 | 状态 |
|---|---|
| SSH、Ubuntu、Docker、Compose、空闲端口和目录 | 已只读确认 |
| amd64 镜像构建、服务器私有容器验证 | 已通过服务器原生构建、健康和鉴权/连接检查 |
| 域名/DNS、HTTPS | .com 正常、A 记录正确；受信证书与公网 HTTPS 已通过，网页真实登录/手机仍待用户验证 |
| 正式认证后台/邮件恢复 | 待完成；Mac 3001 真实登录已通过 |
| restic 真实异地备份与恢复 | COS 加密上传、完整读回及隔离恢复已通过，重启后自动新备份成功；跨日调度/通知仍待验收，见 [18](18-COS异地备份与恢复实施手册.md) |
| 正式学习数据迁移、多设备、服务器重启持久化 | preview 宿主机重启通过；正式含内容库迁移/恢复和手机原数据查阅通过；新正式卷宿主重启、办公电脑/多设备完整任务仍待验，见 21、22 |


## 2026-10-18 DNS 与 HTTPS 增量

用户确认根域 A 记录已添加；服务器解析 `phrasebud.com` 得到 `43.129.199.154`。主机 UFW inactive，应用仍 healthy、没有公开主机端口。云平台入站规则需由实际外部连接验证，不能以 UFW 状态代替。

新增显式 HTTPS 验证 overlay `deploy/compose.preview-https.yaml`，与原 preview Compose 合并使用，继续同一个空测试库，只给 Caddy 发布 80/443，应用不发布 3000。没有启用正式生产库或备份任务，也没有变更 Supabase 后台设置。Caddy 配置与合并 Compose 校验通过，已启动 Caddy 2.11.7；使用 Let's Encrypt 自动签发 phrasebud.com 证书成功，证书存于独立的持久 preview-caddy-data 卷。

启动命令（在服务器执行；overlay 部署并核对后使用）：

```bash
cd /home/ubuntu/readwords
docker compose --env-file .env.phrasebud -f source/deploy/compose.preview.yaml -f source/deploy/compose.preview-https.yaml up -d --wait --wait-timeout 60
```

暂停公网入口而保留应用/数据卷：使用相同两个 `-f` 参数执行 `stop proxy`。原 preview 查询命令只显示基础配置；启用入口后查看完整服务也需带上 overlay。预演结束时保留 Caddy 证书卷，避免不必要的重复签发；正式迁移时先安排同机 80/443 的代理交接，不能让两套代理争用端口。此前“没有公网端口”的记录仅描述启用此 overlay 之前的阶段。


本轮结果：Mac 外部 HTTP 请求收到 308 到 HTTPS；Mac 直连 HTTPS 连接超时，经本机可信代理连接 HTTPS 也超时。服务器内部使用 `curl --resolve phrasebud.com:443:127.0.0.1`（保持正常 CA/主机名验证，没有 `-k`）访问登录页为 HTTP/2 200，健康 200、首页 307、未登录来源 API 401、跨站登录请求 403、10KB 认证请求 413。未发送密码或合法登录请求。说明证书与本机代理链工作正常，外部 443 可达性尚未通过，需用户核对腾讯云实例防火墙中的 TCP 443 允许规则及来源；不能将主机 UFW inactive 等同于云端规则已放行。

当前应用及代理均在运行，主机公开映射仅代理 80/443；应用 3000 和 Caddy 管理端口没有主机映射。尚未验证外部浏览器真实登录、密码恢复或手机；Supabase 后台 Site URL/恢复回调尚未替用户修改。当前网页仍为服务器空 preview 数据库，不能录入正式内容后再直接用 Mac 旧库覆盖；异地备份仍待创建 COS 桶，不把本轮 HTTPS 部署当作备份完成。


## 2026-10-18 放行规则后公网复验

用户报告已完成防火墙设置后，从 Mac 使用 `curl --noproxy '*'` 直连，正常验证 CA 和主机名，没有跳过证书检查，全部通过：HTTP 首页 308、HTTPS 登录页 200、首页未登录 307、健康接口 200、来源业务接口未登录 401；所有 HTTPS 请求的 ssl_verify_result 为 0。先前 443 超时已不再复现。

当前 `https://phrasebud.com` 可用于公开网络上的单用户登录预演，仍使用独立空 preview 卷。没有迁移 Mac 学习库，没有部署真实 COS 仓库，也没有完成手机/密码恢复/正式数据上线验收。用户可自行输入现有 Supabase 账号验证登录和退出；不由代理代填密码。后续仍须完成 18 的加密异地恢复及正式数据迁移。


## 2026-10-18 手机布局更新

用户已在 iPhone 16 登录成功，并报告侧栏/账户竖排问题。按 [20 手机修复与验收](20-手机布局修复与验收.md) 完成响应式修复及本地回归后，服务器 app 已切换为 `readwords:phrasebud-mobile-20261018`，仍使用原 preview 数据卷。原生快照、部署前后业务摘要一致、公网新样式及登录保护已核对，维护已解除，代理未重建。旧镜像和同机回退快照保留；用户刷新手机后的 Safari 实机确认待完成，COS 异地备份仍未启用。


## 2026-10-18 COS 与宿主机重启增量

当前状态以 [18 备份手册](18-COS异地备份与恢复实施手册.md) 和 [21 重启验收](21-服务器重启与持久化验收.md) 为准：新加坡 COS 已完成加密备份、完整读回与隔离恢复；19:14:51 实际重启 Ubuntu，app/proxy/backup 自动恢复，数据清单、容器、镜像和卷配置一致。公网 TLS/登录保护复验通过，维护已关闭，重启后新备份快照 87acf61f。当前 preview 八张业务表仍为空；未迁移 Mac 正式学习库。跨日调度、外部通知、真实邮件恢复及正式含内容库验收仍待完成。此前各增量中的“COS 尚未启用/服务器重启待验”是对应历史阶段的状态。


## 2026-10-18 正式学习库切换

最新运行状态见 [22](22-正式登录验收与学习库迁移.md)。原 Mac 全量学习库已迁至 readwords_learning-data，19:34:25 开放正式写入；4 来源、164 表达、172 语境、172 已保存草稿和完整复习记录的 SHA-256/清单核对、正式仓库加密备份/全量读回/隔离恢复通过。用户确认手机能看到原数据。

正式项目 readwords 使用 compose.yaml + compose.production-volumes.yaml、私有 .env.production；代理复用旧 TLS 卷，旧 preview 的 app/proxy/backup 均已停止但未删除。Mac 原库只读保留。第一次探测失败时自动回退旧入口，修正探测方式后完成切换，记录没有隐去失败。正式邮件模板/SMTP/真实改密、办公电脑实际访问、跨日调度和失败通知尚未完成；通知按用户要求降低优先级。


## 2026-10-18 详情正文优先加载

按 [23](23-详情加载耗时分析与优化.md) 部署 readwords:detail-parallel-v2-20261018，详情与来源/Inbox 同轮请求，正文不再等待辅助数据。70 项测试和 9 条浏览器流程通过。首个归档遗漏 proxy.ts 被上线门禁捕获并自动回退，补齐文件后先通过无网络隔离鉴权门禁，再成功替换 app；此问题和复验未隐去。

当前业务摘要/挂载/认证配置不变，维护已解除，公网首页 307/登录 200/健康 200/未登录业务 401，前端新资源哈希核对通过。备份服务未变，手机直连体验待刷新复测。22 中移动端镜像描述迁移时点，当前 app 镜像以本增量/23 为准。


## 2026-10-18 来源去重与增量导入

按 [24](24-来源去重与增量导入设计及验收.md) 更新正式 app 为 `readwords:source-merge-20261018`。82 项领域/API 测试、11 条浏览器完整回归、393×852 新流程复验和隔离生产容器门禁通过。部署前冻结并原生快照，更新后业务清单、数据挂载和认证配置一致；维护已解除。公网正常验证 TLS，健康 200、登录 200、首页 307、未登录业务 401，新前端资源哈希一致。

备份服务与仓库不变，没有自动合并用户来源或重新导入表格。应用前一镜像为 `readwords:detail-parallel-v2-20261018`，审计/回退快照见 24。当前镜像以本增量为准；真实手机刷新后的新流程仍待用户确认。


## 2026-10-20 详情原文前置

按 [25](25-详情原文优先展示与验收.md)完成原文与出处前置，06:15:05 正式 app 切换为 `readwords:original-first-20261020`。82 项领域/API 与 13 条浏览器流程通过，生产构建及隔离鉴权/导入回归通过。冻结快照后上线，业务清单、数据挂载和认证一致；维护已解除，app/backup healthy。公网 TLS/健康/登录保护及新资源哈希复验通过。当前镜像以此增量为准，来源合并版本为前一版；回退路径与验收边界见 25，真实 iPhone 刷新验收待用户确认。


## 2026-10-21 原句高亮与标准模板

按 [26](26-原句高亮与标准模板导入.md) 完成目标加粗高亮、PhraseBud v1 导入及格式错误整份拦截。89 项领域/API 和 15 条完整 Chrome 流程通过，最终 v3 生产构建和隔离门禁通过。06:33:33 正式 app 更新为 `readwords:highlight-standard-v3-20261021`，此前两候选未发布。冻结快照后核对业务清单/挂载/认证一致，维护已解除，app/backup 健康，proxy 正常。公网 TLS/保护和新资源哈希通过。当前镜像以此增量为准；新模板元数据写入后的旧程序回退限制见 26，不能盲目恢复旧镜像/快照。

## 2026-10-24 详情连续浏览与返回定位

按 [27](27-详情连续浏览与列表返回.md) 更新正式 app 为 `readwords:browse-v2-20261024`。92 项领域/API、20 条完整 Chrome 流程通过；补充前进/后退往返的桌面/393px 两流程复验通过。最终生产构建、隔离 API/认证门禁通过，维护快照后核对业务清单、卷和认证一致，维护已解除。backup 和 proxy 不变。当前镜像以本增量为准；审计、回退范围和真实 Safari 剩余验收见 27。


## 2026-10-24 Excel 多 Sheet 选择导入

按 [28](28-Excel多Sheet选择导入开发设计与验收.md) 实现并于 18:47:44（北京时间）更新正式 app 为 `readwords:sheet-select-20261024`，前一版 `readwords:browse-v2-20261024`。109 项领域/API、25 条本地 Chrome 及 2 条合成认证流程通过；最后补测 cloud 导入断网重试/切回前台保留选择和确认仍通过。生产构建、新旧 API 隔离门禁、维护快照前后业务清单/卷/认证一致性、公网 TLS/保护和新资源哈希核对通过。维护已解除，backup/proxy 不变，当前镜像以本增量为准。没有重导用户 Excel，回退和剩余真实 Safari 验收见 28。
