# 自托管部署与 GitHub App 配置

PRboard 使用 GitHub App 接入仓库。安装令牌为短期令牌，应用只在数据库中保存 installation ID，不持久化 GitHub access token。每位用户登录后关联自己安装的 GitHub App，数据查询和写操作按该关联范围隔离。

## 1. 准备部署地址与数据库

准备一个 HTTPS 访问地址，例如 `https://APP_BASE_URL`，以及 Postgres 数据库。生产环境需要一条普通连接串和一条直连串：

- `DATABASE_URL`：普通查询与写入使用的连接串。
- `DATABASE_URL_UNPOOLED`：SSE 使用 Postgres `LISTEN`，必须使用能保持会话的直连串；事务池连接不适用。

本地开发默认地址为 `http://localhost:3000`。部署到任意支持 Next.js 的平台均可；Vercel 只是可选部署目标，不是运行时依赖。

## 2. 创建 GitHub App

前往 GitHub 的 **Settings → Developer settings → GitHub Apps → New GitHub App**，填写：

| 字段 | 值 |
|---|---|
| GitHub App name | 任意全局唯一的名字，例如 `yourname-prboard` |
| Homepage URL | `https://APP_BASE_URL` |
| Callback URL | `https://APP_BASE_URL/api/auth/callback/github-app`；另加 `http://localhost:3000/api/auth/callback/github-app` 供本地使用 |
| Request user authorization during installation | 勾选 |
| Webhook Active | 勾选 |
| Webhook URL | `https://APP_BASE_URL/api/webhooks/github` |
| Webhook secret | 使用 `openssl rand -hex 32` 生成随机值 |
| Installation scope | 选择 **Any account**，让每位用户将 App 安装到自己的 GitHub 账户或组织 |
| Setup URL | `https://APP_BASE_URL/api/install/github/callback`；本地为 `http://localhost:3000/api/install/github/callback` |

### Repository permissions

| 权限 | 级别 | 用途 |
|---|---|---|
| Metadata | Read-only | GitHub 强制要求 |
| Pull requests | Read and write | 列出与合并 PR |
| Checks | Read-only | 展示检查状态 |
| Actions | Read and write | 查看、重试、取消和删除 workflow run |
| Commit statuses | Read-only | 展示第三方 CI 状态 |
| Contents | Read and write | GitHub 合并 PR API 所需 |

其余仓库权限保持关闭。`Contents: write` 和 `Actions: write` 是高权限：用户只应将 App 安装在受信任的仓库中。

### Subscribe to events

勾选：`Check run`、`Check suite`、`Workflow run`、`Pull request`、`Installation`、`Installation repositories` 与 `Meta`。

## 3. 配置环境变量

```bash
cp .env.example .env.local
```

填写以下值：

| 变量 | 说明 |
|---|---|
| `GITHUB_APP_ID` / `GITHUB_APP_SLUG` | GitHub App 页面提供的标识 |
| `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` | GitHub App OAuth 凭据 |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App 生成的 PEM 私钥完整内容；支持字面量 `\\n` |
| `GITHUB_APP_WEBHOOK_SECRET` | 配置 GitHub webhook 时使用的同一随机值 |
| `AUTH_SECRET` | 使用 `npx auth secret` 生成 |
| `AUTH_URL` | 本地填 `http://localhost:3000`；生产环境按部署平台要求配置 |
| `DATABASE_URL` / `DATABASE_URL_UNPOOLED` | 第 1 步准备的 Postgres 连接串 |

将同一组敏感变量配置到生产部署平台的受管环境变量中。不要把 `.env.local`、PEM 文件或任何真实值加入 Git。

## 4. 初始化和运行

```bash
npm ci
npm run db:generate  # schema 变更后生成 migration
npm run db:migrate   # 对目标数据库应用 migration
npm run dev
```

打开 `http://localhost:3000`，使用 GitHub 登录；登录后按页面提示安装 App 并选择需要查看的仓库。Webhook 会同步 installation 与仓库信息；若首次加载时尚未收到 webhook，看板会执行一次受控同步。

## 5. 通知配置

登录后点击顶栏铃铛图标进入「通知设置」，粘贴 Bark App 中的推送 URL 即可。四类通知（CI 全绿 / 重试耗尽 / PR 冲突 / Vercel 部署失败）可独立开关。无需配置任何环境变量或 GitHub secret。

## 6. Runner 主机性能监控

部署包含主机监控 migration 的版本后，先在 PRboard 所连接的目标数据库执行：

```bash
npm run db:migrate
```

登录后打开右上角的 **Runner 监控**，选择「新增主机」。登记成功时页面只会显示一次该主机的 token；立刻将它保存到对应主机的受限配置中，关闭弹窗后不能从 PRboard 再次读取。

### 容量域配置

主机卡片可以分别显示性能，但扩容建议按**物理容量域**计算：

| 实例 | 平台 | 容量域 | 角色 | 容量含义 |
|---|---|---|---|---|
| Mac Runner | macOS | 例如 `mac-studio` | `primary` | 该 Mac 的 CPU、内存和磁盘是独立容量。 |
| Windows Runner | Windows | 例如 `windows-wsl` | `primary` | Windows 的 CPU、内存和宿主磁盘是 Windows/WSL 的权威容量。 |
| WSL/Linux Runner | Linux | 与 Windows 相同的 `windows-wsl` | `shared` | 仅展示 guest 的 Linux 根盘、swap、load 与 Runner 活动；不会再加一次 CPU/内存。 |

Windows 与 WSL 必须使用相同容量域。WSL2 如果在 `.wslconfig` 中限制了 CPU、内存或 swap，容量建议会同时受 Windows 主机余量和 WSL guest 健康约束。

### 先以前台方式验证采集器

在每台要监控的主机的 PRboard 部署版本目录中执行 `npm ci`，然后填写一次性 token。生产地址必须为 HTTPS；本地开发可使用 `http://localhost`。

macOS 或 WSL/Linux：

```bash
export PRBOARD_URL="https://APP_BASE_URL"
export PRBOARD_HOST_ID="HOST_ID"
export PRBOARD_HOST_TOKEN="TOKEN"
export PRBOARD_INTERVAL_SECONDS=60
# WSL/Linux 如需指定根盘以外的文件系统，再设置：export PRBOARD_DISK_MOUNT="/"
npm run host:monitor
```

Windows PowerShell：

```powershell
$env:PRBOARD_URL = "https://APP_BASE_URL"
$env:PRBOARD_HOST_ID = "HOST_ID"
$env:PRBOARD_HOST_TOKEN = "TOKEN"
$env:PRBOARD_INTERVAL_SECONDS = "60"
npm run host:monitor
```

采集器只会上报 CPU、内存、磁盘、swap、网络速率、load（非 Windows）、Runner Listener/Worker 数量和采集时间。它不会上传进程命令、路径、环境变量、日志、IP/MAC 地址、硬件序列号或 GitHub 凭据；终端日志也不会回显 token。

### 可选：设为常驻服务

先以前台方式确认看板收到心跳，再选择相应平台的服务管理器。token 文件只应由运行采集器的服务账号读取。

**macOS launchd**：创建 `~/Library/LaunchAgents/com.prboard.host-monitor.plist`，把 `APP_PATH`、`NODE_PATH`、`APP_BASE_URL`、`HOST_ID` 与 `TOKEN` 替换为本机值，然后运行 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.prboard.host-monitor.plist`。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.prboard.host-monitor</string>
  <key>ProgramArguments</key><array>
    <string>NODE_PATH</string><string>APP_PATH/scripts/host-monitor/agent.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>APP_PATH</string>
  <key>EnvironmentVariables</key><dict>
    <key>PRBOARD_URL</key><string>https://APP_BASE_URL</string>
    <key>PRBOARD_HOST_ID</key><string>HOST_ID</string>
    <key>PRBOARD_HOST_TOKEN</key><string>TOKEN</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
```

执行 `chmod 600 ~/Library/LaunchAgents/com.prboard.host-monitor.plist`，并不要把该 plist 提交到 Git。

**Windows Task Scheduler**：创建一个仅 Runner 服务账户可读的 `C:\PRboard\host-monitor.cmd`，写入环境变量和 Node 调用；再以「系统启动时」触发该 `.cmd`。示例：

```bat
@echo off
set PRBOARD_URL=https://APP_BASE_URL
set PRBOARD_HOST_ID=HOST_ID
set PRBOARD_HOST_TOKEN=TOKEN
set PRBOARD_INTERVAL_SECONDS=60
"C:\Program Files\nodejs\node.exe" "C:\PRboard\scripts\host-monitor\agent.mjs"
```

**WSL systemd**：在 `/etc/prboard-host-monitor.env` 放置上面的四个环境变量并执行 `sudo chmod 600 /etc/prboard-host-monitor.env`；随后创建 `/etc/systemd/system/prboard-host-monitor.service`：

```ini
[Unit]
Description=PRboard host monitor
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/PRboard
EnvironmentFile=/etc/prboard-host-monitor.env
ExecStart=/usr/bin/node /opt/PRboard/scripts/host-monitor/agent.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

执行 `sudo systemctl daemon-reload && sudo systemctl enable --now prboard-host-monitor`。WSL 被暂停时 agent 会暂停上报；看板将其显示为遥测过期，而不是误判为物理 Windows 主机离线。

### 如何解读扩容建议

看板使用最近 24 小时、覆盖率至少 80% 的数据，依据 CPU p95（≤70%）、内存 p95（≤75%）、磁盘最高使用率（<80%）、swap 压力与 Runner Worker 忙碌率（≥60%）联合判断。资源空闲仅表示“可以承载”，并不表示“需要扩容”；有余量但 Worker 低忙碌率时会明确显示「有余量，暂无需求」。满足条件时也只建议先新增 **1 个带隔离标签的 canary Runner**，观察一周后再评估下一次扩容。PRboard 不会自动创建、注册或启动 Runner。

## 7. AI Review 集中管理

在 PRboard 的 `/settings/ai-review`（页头机器人图标）集中管理各仓库 CI 里的 AI review：逐仓库开关、全局暂停、服务商、模型、思考等级，以及按月额度。

### 接入一个仓库

1. 设置页「添加服务商」：Claude OAuth 订阅选「Claude OAuth」，GLM 等 Anthropic 兼容端点选「Anthropic 兼容」并填 https Base URL。「仓库 Secret 名」填该仓库 GitHub Secrets 里存密钥的名字（密钥本身不进 PRboard）。订阅服务商设"暂停阈值"（窗口已用 %），API key 服务商可选填月预算上限。
2. 设置页「添加仓库」填 `owner/repo`。**token 只显示一次**：存为该仓库的 Actions secret `PRBOARD_TOKEN`。
3. 把页面给出的 workflow 片段接进该仓库的 review workflow（`ai-review-config` 在 `claude-code-action` 之前，`ai-review-usage` 在其后、带 `if: always()`），并保留该仓库原有的 prompt 与其它 `claude_args`。
4. 回设置页给仓库选服务商、模型、思考等级，打开开关。新增仓库默认关闭。

### 一个项目里的各路 review（通道）

设置页每个仓库下，除「Claude 主审」（仓库级配置）外，还列出该项目 CI 里其余各路 review：Haiku、GLM、免费模型池、@mention、桌面端 Claude 等。每一路一行：模型、思考、凭据名、计量方式（订阅窗口 / 按量美元 / 套餐 / 免费）、开关。

- 只有标「**已接入**」的通道可改：它的 workflow 在运行时用 `ai-review-config` 取配置（带 `lane: <通道标识>`），所以面板上改模型、改思考、关掉，下一次 review 就生效。
- 标「**未接入 · 只读**」的只是记录，**改了不会生效**。把某路的 workflow 接上之后，在面板点「标记为已接入」。
- 每一路只显示它真正支持的思考选项：Claude 与 @mention 是 low–max；GLM 是 off / on / max；Haiku 5.5 与免费池没有思考控制，不显示。
- 空模型 = 「不指定，用 CLI / 脚本自带默认」（比如从没传过 `--model` 的 @mention，或没有配置时走自己默认池的免费池）。
- 拿不到配置（PRboard 不可达、token 无效、该通道未登记）时，该路回退到 workflow 里 `lane-fallback-model` / `lane-fallback-thinking` 写死的值，与接入前行为一致。通道模式的回退值**独立于**仓库级的 `fallback-model`，不会把 Claude 模型名误传给其它脚本。
- 通道的凭据（`ZHIPU_API_KEY`、`ANTHROPIC_API_KEY`、`NEWAPI_API_KEY` …）始终留在各仓库 Secrets 里，由各自 workflow 固定引用；PRboard 只记录名字用于展示，不经手密钥。

接入一路通道的 workflow 片段（以 GLM 为例，`glm-review.yml`）：

```yaml
- id: cfg
  uses: daidaidaiok/PRboard/.github/actions/ai-review-config@main
  with:
    prboard-url: ${{ vars.PRBOARD_URL }}
    token: ${{ secrets.PRBOARD_TOKEN }}
    lane: glm
    lane-fallback-model: glm-5.3
    lane-fallback-thinking: max

- if: steps.cfg.outputs.enabled == 'true'
  env:
    GLM_MODEL: ${{ steps.cfg.outputs.model }}
    GLM_THINKING: ${{ steps.cfg.outputs.thinking }}   # off / on / max；空 = 脚本默认
  run: node .github/scripts/glm-review.mjs
```

### 一次性的仓库设置

- PRboard 是私有仓库，其它仓库要引用它的 composite action，需在 PRboard 仓库 Settings → Actions → General → Access 选 **Accessible from repositories owned by the user**。
- PRboard 自己的 review workflow 另需仓库变量 `PRBOARD_URL`（站点根地址）与 secret `PRBOARD_TOKEN`；没配时自动回退到内置默认，行为与接入前一致。
- 改动 workflow 文件的 PR 上，`claude-code-action` 会因为 workflow 内容与默认分支不一致而拒绝运行（OIDC 校验），这是 action 的既有限制，合并后恢复。

### 上线检查（首个真实 review run 之后）

- 设置页该服务商的「本月」用量应非 0；若 CI 日志出现 `execution_file 的 result 消息里没有 usage 字段` 或「取不到 execution_file」的 warning，说明 `claude-code-action` 输出结构与 `ai-review-usage/run.sh` 的假设（最后一条 `type==result`，字段 `usage.*` / `total_cost_usd`）不符，token/美元类预算将不会触发，需要按真实结构修 jq。
- 确认 review 步骤通过 `secrets[<secret-name>]` 动态取到了密钥（没有因缺 token 失败），且 `--effort` 被接受。

### 行为约定

- PRboard **明确停用**（全局暂停 / 仓库关闭 / 未选服务商 / 额度用尽）→ CI 跳过 review。
- PRboard **不可达**、token 无效或响应异常 → CI 回退到 workflow 内置默认配置继续 review，并输出 warning。
- **Claude 订阅（OAuth）按限流窗口显示剩余额度，不显示金额**：CI 里 `claude-code-action` 的 `rate_limit_event` 带有五小时窗口、七天窗口、Opus 专属七天窗口的已用比例与重置时间，`ai-review-usage` 在每次 review 后把它们上报，设置页显示"剩余 X%（已用 Y%）· N 小时后重置"。读数反映整个订阅账号的真实占用（含你自己交互使用的部分），但**只在有 review 运行时才更新**，页面会标注"更新于 N 分钟前"。任一窗口达到 80% 变黄，达到服务商的**暂停阈值**（默认 95%，可改，留空 = 只在被限流时才停）就暂停相关仓库的 review，窗口重置时间一过自动恢复；达到 80% 与暂停时推送 Bark。
- **API key 类服务商才有金额/次数/token 预算**：按 UTC 自然月统计，达 90% 推送 Bark 提醒，用尽后自动停用，下月 1 日（UTC）重置。
- 推送需要在通知设置里配置 Bark 地址。
- 思考等级选「默认」时使用 workflow 里 `fallback-effort`（默认 `high`）。

## 部署

PRboard 是普通的 Next.js 应用，需要 Node.js 22+ 与 Postgres。可部署到任何支持 Node 运行时与长连接（SSE）的平台。部署时请按上文的 `.env.example` 配置环境变量，并确保 GitHub App 的 webhook URL 指向你的部署地址。
