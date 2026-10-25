# Runner 监控与清理面板设计

## 目标

在 PRboard 中增加 `/runners` 页面，聚合所有观察仓库最近 50 条 GitHub Actions workflow runs，并对超过 30 分钟仍处于活动状态的运行标记为堵塞。用户可以展开查看 jobs，并取消、强制取消或删除已结束运行。

## 方案

复用现有 GitHub App installation token、观察仓库查询、SSE 更新和审计日志。runs 通过 Actions REST API 实时读取，不增加状态表；jobs 在展开时懒加载。所有写操作在服务端重新校验仓库范围与 run 状态。

## 接口

- `GET /api/runners`：每仓库最近 50 条 run、统计和堵塞阈值。
- `GET /api/runners/jobs?repoFullName=OWNER/REPO&workflowRunId=ID`：按需返回 jobs。
- `POST /api/runners/action`：`cancel`、`force-cancel`、`delete` 三种操作；删除仅允许终态 run。

## 验收

- 头像旁可进入 `/runners`，页面可返回 PR 看板。
- 活动运行、堵塞运行、终态运行状态和统计准确。
- 操作有确认、服务端鉴权、审计记录和错误反馈。
- SSE 更新、30 秒轮询、移动端布局和键盘可访问性正常。
