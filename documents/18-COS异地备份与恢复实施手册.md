# COS 异地加密备份与恢复实施手册

版本：0.1；日期：2026-10-18。适用：单用户 PhraseBud / ReadWords，Node 24、SQLite schema 3、restic。依赖 [15](15-邮箱登录配置与部署操作手册.md)、[17](17-PhraseBud部署执行记录.md)。本文先明确实施合同；执行结果在末尾按证据更新。尚无 COS 桶或访问凭据，不能声称已开启异地备份。

## 1. 目标和边界

香港服务器保存日常 SQLite；异地对象存储保存 restic 客户端加密仓库。建议使用新加坡 COS（`ap-singapore`），与应用分开地域；同属腾讯云账号不等于独立账号容灾，后续可另评估跨账号/供应商副本。选择新加坡是本项目建议，不是平台强制要求。

当前只能对服务器的**空 preview 测试库**演练。Mac 正式学习库尚未迁移，也不会自动被服务器任务备份。正式切换时须改数据卷和仓库前缀，并重新验收。

目标是每次成功备份间隔约一天、超过 26 小时无成功标记显示 unhealthy；这是监测阈值，不是保证不丢 24 小时以上数据。首次成功、失败处理、恢复演练均通过后才标“已配置”；实际连续调度须另记录。当前没有外部告警通知渠道。

## 2. 用户先创建 COS 存储桶

在 [COS 控制台](https://console.cloud.tencent.com/cos/bucket) 开通服务并创建存储桶。涉及按量费用由用户确认，不需要先买固定容量资源包。

| 字段 | 本项目选择 |
|---|---|
| 存储桶类型 | 通用存储桶 |
| 名称 | `phrasebud-backup`；平台会形成带 APPID 后缀的完整名称 |
| 地域 | 新加坡 `ap-singapore`，创建后不可直接改地域 |
| 访问权限 | **私有读写**；如有“禁止公有访问”，保持启用 |
| 数据冗余 | 初期单 AZ；与香港服务器的地域隔离仍成立 |
| 存储类型 | 标准存储；不选归档/深度归档 |
| 版本控制 | 首次可保持关闭，由 restic 管理快照；若开启，须另设计历史对象费用和清理规则 |
| CDN、全球加速、静态网站、数据处理等 | 本次不启用 |
| 自动过期/转归档生命周期 | 不对 restic 仓库对象配置；会破坏仍被快照引用的数据块 |

保留完整桶名和地域即可，不用手动上传 SQLite。官方：[创建存储桶](https://cloud.tencent.com/document/product/436/13309)、[私有访问原则](https://cloud.tencent.com/document/product/436/30749)、[地域与访问域名](https://cloud.tencent.com/document/product/436/6224)。存储、请求和恢复下载可能计费，创建时按实际区域价目检查账单及费用提醒；预算提醒不是自动停费保证。

## 3. 权限和密码分工

- 建一个备份专用 CAM 子用户/访问密钥，权限只覆盖专用桶。不要把主账号密钥或全量 COS 管理权限交给服务器。
- restic 需要列举、读取、写入、删除仓库对象（删除锁和执行保留清理都会用到）。桶级列举/定位权限与对象级权限分开限定；按实际桶名生成策略后再关联子用户。
- COS 动作候选：桶级 `GetBucket`、`HeadBucket`、`GetBucketLocation`、`ListMultipartUploads`；对象级 `GetObject`、`HeadObject`、`PutObject`、`DeleteObject`、`InitiateMultipartUpload`、`UploadPart`、`CompleteMultipartUpload`、`AbortMultipartUpload`、`ListParts`。以真实 restic/COS 返回值验证，不将未实测策略标为通过；若出现 403，定位缺少的动作，不放宽到整个账号。
- API 的 SecretId / SecretKey 分别映射到 restic 的 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`。命名为 AWS 是 S3 兼容接口约定，不代表还要买 AWS。
- **restic 加密密码**与 API SecretKey 是两种凭据。生成独立随机密码，离线保存在个人密码管理器，并在服务器存一份受限文件。仅服务器存一份不够；丢失密码无法解密，API 密钥也不能替代它。
- 当前脚本会 prune，服务器持有对象删除能力。因此本方案防磁盘/主机损坏，不承诺能抵抗服务器与云账号同时失陷；不将其称为不可篡改备份。

官方：[COS 授权策略](https://cloud.tencent.com/document/practice/436/31923)、[restic S3 与密码配置](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)。不要把任何密码、SecretKey 或完整环境配置发到聊天、Git 或截图。

## 4. 配置与隔离合同

独立备份 Compose：`deploy/compose.backup.yaml`，已补齐并完成合成环境变量下的结构校验。它引用已有数据卷并只读挂载，**不创建或迁移源库**；不发布端口、不依赖域名、不含 Supabase 凭据。镜像使用已验证的 `readwords:phrasebud-amd64`。

服务器配置约定：`/home/ubuntu/.config/phrasebud-backup/backup.env` 和 `restic-password`，目录 700、文件 600；目前服务器 ubuntu 和镜像 node 的 UID 都为 1000，因此该密码文件可被备份容器读取。其他环境须重新核对 UID，不能将文件改成全局可读来解决权限问题。

以下只是模板，不能以占位值运行：

```dotenv
READWORDS_BACKUP_PROJECT=phrasebud-backup-preview
READWORDS_IMAGE=readwords:phrasebud-amd64
READWORDS_DATA_VOLUME=phrasebud-preview_preview-data
RESTIC_REPOSITORY=s3:https://cos.ap-singapore.myqcloud.com/完整桶名/phrasebud-preview
RESTIC_PASSWORD_FILE=/home/ubuntu/.config/phrasebud-backup/restic-password
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_DEFAULT_REGION=ap-singapore
```

COS 使用 S3 兼容的 region endpoint 与完整桶名，连接须通过真实 init/备份/恢复验收。预演前缀 `phrasebud-preview` 和正式前缀 `phrasebud-production` **分别初始化成独立仓库**。现有脚本使用固定 host/tag `readwords` 做保留分组，不能让两套环境指向同一仓库，否则会相互参与保留清理。

生产数据卷来自正式 Compose 的 `learning-data`，以实际 `docker volume ls` 和容器 mount 核对，不能沿用 preview 卷名。预演备份缓存卷为独立 `phrasebud-backup-preview_backup-cache`，不作为异地副本。正式上线沿用 `deploy/compose.yaml` 的 backup 服务和正式缓存卷，先停止预演调度；不得同时对同一数据库/仓库启动两套调度。若未来独立部署生产备份，使用另一项目名及缓存卷，并显式关闭正式 Compose 中的重复任务。

## 5. 首次执行（运维步骤，等桶与凭据就绪）

在服务器进入部署目录。以下 Compose 环境文件路径是本次约定；先确认新仓库前缀为空，且密码已另存。`config --quiet` 只检查结构/变量，不检查远端权限。

```bash
cd /home/ubuntu/readwords/source
docker compose --env-file /home/ubuntu/.config/phrasebud-backup/backup.env -f deploy/compose.backup.yaml config --quiet
docker compose --env-file /home/ubuntu/.config/phrasebud-backup/backup.env -f deploy/compose.backup.yaml run --rm --no-deps --entrypoint restic backup init
docker compose --env-file /home/ubuntu/.config/phrasebud-backup/backup.env -f deploy/compose.backup.yaml run --rm --no-deps --entrypoint node backup scripts/backup-job.mts
docker compose --env-file /home/ubuntu/.config/phrasebud-backup/backup.env -f deploy/compose.backup.yaml run --rm --no-deps --entrypoint restic backup snapshots
```

`init` 仅执行一次；若已有仓库，先 `snapshots` / `check` 验证，不能重新初始化或覆盖。单次作业必须退出 0、出现 `READWORDS_BACKUP_OK` 并产生本次 `.last-success`；仅桶中有对象不等于成功。`restic check` 默认检查仓库结构/元数据，不等于完整读回全部加密数据。

现有顺序：原生一致性快照 → restic backup → 保留最近 7 个有备份的日周期和 4 个周周期的代表快照 → prune → check → 清理本地旧快照 → 写成功标记。同一天多个快照不保证都保留；日/周保留可重叠，不保证固定 11 份。任务失败不更新成功标记；没有远端成功前不清理本地旧快照。

## 6. 首次恢复演练

先选择没有业务写入的 preview 库并保存基线清单；生产有写入时须维护冻结再做同一时点比较，不能拿历史快照与已变化的当前库直接判定一致性。

在服务器新建独立、UID 1000 可写、权限 700 的空目录，例如 `/home/ubuntu/readwords-restore-drill`。不覆盖原库或原卷。尚未开启调度时执行；已开启则先 stop 备份服务并确认没有遗留手动作业。

```bash
cd /home/ubuntu/readwords/source
docker compose --env-file /home/ubuntu/.config/phrasebud-backup/backup.env -f deploy/compose.backup.yaml run --rm --no-deps --entrypoint restic backup check --read-data
```

随后将 `实际快照ID` 换成刚完成备份的快照 ID：

```bash
docker compose --env-file /home/ubuntu/.config/phrasebud-backup/backup.env -f deploy/compose.backup.yaml run --rm --no-deps --entrypoint restic -v /home/ubuntu/readwords-restore-drill:/restore backup restore 实际快照ID --target /restore
```

在恢复的 `/restore/app/backups/` 中选择该次最新 SQLite 文件。将下列 `实际文件名.sqlite` 替换后核对：

```bash
docker compose --env-file /home/ubuntu/.config/phrasebud-backup/backup.env -f deploy/compose.backup.yaml run --rm --no-deps --entrypoint node -v /home/ubuntu/readwords-restore-drill:/restore:ro backup scripts/ops.mts compare /app/data/readwords.sqlite /restore/app/backups/实际文件名.sqlite
```

compare 同时验证 schema、完整性、外键、八张业务表字段摘要和 generation。首轮空库演练通过只证明管道，正式迁移后必须再验一次含真实内容的备份恢复；恢复启动引起的 Review 运行态变化按 15 区分。

至少记录快照 ID、版本、备份/恢复耗时、校验结论、凭据恢复方式已妥存，不记录密码。确认恢复成功后才启动日调度：

```bash
docker compose --env-file /home/ubuntu/.config/phrasebud-backup/backup.env -f deploy/compose.backup.yaml up -d
docker compose --env-file /home/ubuntu/.config/phrasebud-backup/backup.env -f deploy/compose.backup.yaml ps
```

服务立即再执行一次，然后每次作业完成后 sleep 86400 秒；不是每天固定时刻，也不是由域名或用户登录触发。首次 60 秒内可能处于 starting，按任务时长检查最终状态。备份宿主服务重启后再启动，需另验重启与至少两次实际执行记录。每月至少再做一次隔离恢复；`check --read-data` 和恢复下载会产生请求及流量费用。

## 7. 失败、轮换与回退

看固定错误码及容器健康状态；当前没有自动消息提醒，不保证有人收到 unhealthy 通知。失败后先检查桶、凭据、密码文件读取权限、磁盘和锁；不公开打印环境或展开后的 Compose。

异常中断的 `.backup.lock` 仅在调度服务已停止且确认所有作业退出后处理；restic 仓库锁也须确认无活动进程再解锁。不要同时运行手动作业和调度，不使用删桶、删除仓库对象或 `down -v` 排错。

API 密钥轮换：创建相同受限权限的新密钥 → 更新私有 env → 重新创建备份服务使新 env 生效 → 单次备份及恢复确认 → 再撤销旧密钥。restic 加密密钥轮换另用 restic key 管理；仅替换密码文件会导致无法打开旧仓库。

需要恢复到正式卷时，先停写并保全现状，在隔离库核对后按 15 的正式切换步骤执行；本手册的演练命令不直接覆盖生产库。

## 8. 验收状态

| ID | 验收项 | 当前结果 |
|---|---|---|
| BK-01 | 文档、源卷/缓存/仓库隔离、凭据边界 | 配置与合成变量校验通过：已有外部源卷、只读挂载、无公开端口/认证凭据、缺 COS 密钥拒绝展开；真实 COS 权限仍待验证 |
| BK-02 | 真实只读挂载 SQLite 原生备份与摘要一致 | 已在云服务器运行独立容器：preview 源卷只读、输出临时内存盘、快照 600、schema 3 摘要一致、源库不变；仅空测试库 |
| BK-03 | COS 桶私有、受限权限、仓库初始化 | 用户尚未创建桶 |
| BK-04 | 真实加密上传、保留/check、成功标记 | 未执行 |
| BK-05 | 读回全仓库、隔离恢复、数据库核对 | 未执行 |
| BK-06 | 调度与至少两次执行、重启 | 未执行 |
| BK-07 | 故障码与健康状态 | 既有模拟测试；真实故障待验收，无外部告警 |
| BK-08 | 正式学习库迁移后的备份恢复 | 未执行；当前只允许 preview 演练 |


## 9. 本轮实际执行记录

- 已查验服务器：preview 容器 healthy，无主机端口映射；仅有 preview 应用卷。restic 0.14.0、node/ubuntu UID 1000。
- 已上传 `compose.backup.yaml` 与不含密钥的 `backup.env.example`。服务器创建 `/home/ubuntu/.config/phrasebud-backup/`（700）及 `backup.env` 模板（600）；尚未创建加密密码文件，未填 SecretId/SecretKey、未设真实仓库。
- BK-01 配置合成测试通过；不输出展开配置。BK-02 用 `--network none` 的一次性独立容器、只读源卷及临时内存备份目录验证，退出后输出销毁，没有上传任何数据。
- `node --import tsx --test tests/cloud.test.ts`：13/13 通过、无跳过，包括备份远端失败不清理、成功标记/保留参数的测试替身验证。这不代表 COS 真实验收。
- `npm run format:check`、`npm run guide:check`、文档本地链接/表格/围栏及 `git diff --check` 通过。未变更业务逻辑或 backup-job.mts；未重跑业务 E2E 或重建当前服务器应用镜像，网页指南文字的本轮变更将随下一次应用构建部署。
- 用户已确认尚未创建桶，已给出 §2 创建步骤。下一步等完整桶名和地域，再生成针对该桶的 CAM 策略、配置凭据和密码，执行 BK-03–BK-06。当前异地备份仍未开启，Mac 正式数据未受影响。
