# Runner 主机遥测与容量看板设计

## 目标

把现有 `/runners` 从 GitHub self-hosted Runner 的即时在线状态扩展为「Runner 与主机容量」看板：

- 独立监控 Mac、Windows、WSL/Linux 的 CPU、内存、磁盘、Swap、网络、运行中的 Runner 进程与最后心跳；
- 展示最近 24 小时的利用率趋势、p95 与数据覆盖率；
- 对每个**物理容量域**给出「继续观察 / 有余量但暂无需求 / 可先增加 1 个 Runner / 保持当前规模」的可解释建议；
- 保持用户隔离，采集器只提交汇总数值，永不上传进程命令、环境变量、路径、日志或 GitHub 凭据。

Windows 主机与其中的 WSL2 不是两台可相加的物理机器：两者会分别显示健康数据，但必须归入同一个容量域，Windows 作为 CPU、内存和宿主磁盘的权威容量来源，WSL 只报告自身虚拟机和 Runner 健康。

## 搜索结论

现有项目已经有 Next.js、Postgres、Drizzle、Zod 和 `/runners` 入口，但没有时序指标数据层。候选方案如下：

1. **跨平台轻量 Node 采集器（推荐，Extend/Compose）**：复用 [`systeminformation`](https://systeminformation.io/) 的 macOS、Windows、Linux 指标能力，使用 Node 内置 `fetch` 向 PRboard 出站 HTTPS 上报。它没有 npm 传递依赖，且 GitHub Actions Runner 主机通常已经具备 Node。PRboard 保留自己的小型、面向容量的查询模型，无需新增一套观测基础设施。
2. **Prometheus + node_exporter + windows_exporter + Grafana（Adopt）**：指标覆盖和生态最完整，但 Windows 需要另一 exporter，主机还必须被 Prometheus 入站访问，并新增 TSDB、告警和 Grafana 运维面；对三个个人 Runner 主机过重。
3. **OpenTelemetry Collector hostmetrics（Adopt）**：标准化强、跨平台 scraper 完整，但仍需配置 Collector 和 OTLP 后端；PRboard 当前没有通用观测后端，首版会引入较大的运行面。

因此采用方案 1。采集器以 60 秒为默认间隔；原始样本保留 30 天，接口仅向浏览器下发按小时压缩后的最近 24 小时序列。

## 数据与安全模型

### 主机与容量域

新增 `monitor_hosts`：

- 归属 `users.id`，并保存展示名、平台、容量域、容量角色（`primary` 或 `shared`）、单个新增 Runner 的 CPU/内存预留、可选 GitHub Runner 名称与最后心跳；
- 每个用户、每个容量域只能有一个 `primary` 主机；Mac 自己是独立主域，Windows 是 `Windows-WSL` 主域，WSL 是同域的 `shared` 成员；
- 新增 `host_ingest_tokens`。创建主机时生成 256-bit 随机 token，只向浏览器返回一次；数据库只保存 SHA-256 摘要，删除主机即可撤销 token。

新增 `host_metric_samples`：采集时间、CPU/内存/磁盘的 basis-points、内存/磁盘总量与使用量、Swap、网络收发速率、CPU 核数、WSL/Linux load、Runner Listener/Worker 进程数。`(host_id, captured_at)` 唯一，支持采集器重试而不重复记样本；索引支持按主机和时间窗口读取。

`POST /api/hosts/ingest` 不使用浏览器 session：它需要 `X-PRboard-Host-Id` 和 Bearer token，严格校验 JSON、指标上下界、时间漂移与最小上报间隔。浏览器管理接口一律使用 `requireSession()`、用户归属过滤及同源校验。

## 容量决策

日均 CPU 低不等于应该扩容：它只说明主机可以承载更多工作，并不说明有实际排队需求。看板把两个信号拆开：

1. **主机余量**（取主域）：最近 24 小时覆盖率至少 80%，CPU p95 不高于 70%，内存 p95 不高于 75%，磁盘最高使用率低于 80%，没有持续 Swap 警报；
2. **Runner 工作压力**（取同一容量域全部成员）：Runner Worker 样本忙碌率至少 60%，才说明并发 Runner 有现实价值；
3. **建议方式**：只提示先增加 1 个带独立标签的 canary Runner，观察一周后再继续扩容；不由 PRboard 自动启动、注册或修改任何 Runner。

可承载的上限使用保守余量计算：以 `min((70%-CPU p95) × 逻辑核数 / 每 Runner 预留核数, (75%-内存 p95) × 总内存 / 每 Runner 预留内存)` 计算；默认预留为 2 逻辑核与 4096 MiB，创建主机时可按工作负载调整。若未采满 24 小时、主机遥测过期、磁盘/Swap 告警，均只显示原因而不给扩容数。

GitHub 的即时 online/busy 视图继续保留，但它不参与每日容量结论：现有 GitHub App 权限不必为本功能额外扩大为 Administration read，且同一组织 Runner 可能跨仓库重复出现。

## 界面与采集器

- `/runners` 保留既有 GitHub Runner 状态区；主机 API 与 GitHub API 独立加载，GitHub 权限或网络异常不遮蔽主机数据。
- 新增容量域摘要卡、主机卡、24 小时原生 SVG sparkline、最后心跳、实时快照、p95/峰值、建议原因与「新增主机」入口。
- 新增主机后弹出一次性 token 与 Mac/WSL、Windows 的启动命令；token 不写入页面 URL、日志或文档示例。
- 新增 `scripts/host-monitor/agent.mjs`。它仅依赖 `systeminformation` 和 Node 内置模块，定时向 `/api/hosts/ingest` 发 HTTPS 请求。新增文档给出 macOS launchd、Windows 任务计划程序、WSL systemd 的**可选**常驻安装方式。

## 验收标准

- [ ] 用户能分别注册 Mac、Windows 与 WSL 主机，并把 Windows/WSL 绑定到同一容量域。
- [ ] 采集器能每 60 秒上报 CPU、内存、磁盘、Swap、网络、Load（可用时）和 Runner 进程汇总；无 token、过期/撤销 token、错误指标、越权请求全部被拒绝。
- [ ] 看板按用户隔离显示 24 小时趋势、数据过期状态、主机 p95/峰值和容量域建议；Windows 与 WSL 不重复计算可增加 Runner 数。
- [ ] 资源有余量但 Runner 忙碌率不足时不建议扩容；高忙碌且有余量时最多建议先增加一个 canary Runner；资源瓶颈时明确阻止扩容。
- [ ] 删除主机立即撤销 token 并级联删除其样本。
- [ ] 单元/路由测试、lint、类型检查和生产构建全部通过。
