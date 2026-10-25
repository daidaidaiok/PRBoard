# GitHub Actions 自动与手动重试设计

## 背景

PRboard 当前把所有失败的 `CheckRun` 都交给 Checks API 的 `rerequestRun`。GitHub 只允许创建该检查的 App 重试它，因此 PRboard 对 GitHub Actions 或第三方 App 检查发起请求时会得到 403。

## 设计

- PR 列表通过 `CheckRun.checkSuite.workflowRun` 识别 GitHub Actions，并携带 workflow run ID、当前 attempt 与可重试状态。
- 面板只为 GitHub Actions 检查显示重试按钮；单项按钮重跑该检查所属 workflow 的失败 jobs，“重试全部”按 workflow run ID 去重。
- 与 PR 关联的 `workflow_run.completed` 在 `failure` 或 `timed_out` 且 attempt 为 1、2 时自动调用 `rerunFailedJobs`；attempt 3 起停止自动重试。
- 数据库用 `(repo_full_name, workflow_run_id, run_attempt)` 唯一键认领自动重试。重复 webhook 只允许一个调用；调用失败将认领标为失败，后续投递可以重新认领。
- 审计日志在 detail 中记录 `manual` 或 `automatic` 来源。达到自动上限后仅停止自动行为，面板仍允许手动重试。

## 边界

- `cancelled`、`action_required` 等状态不自动重试。
- 第三方 App 检查仍可通过状态点进入详情页，但没有重试按钮。
- 服务端从仓库重新解析 installation，不信任客户端传入的安装信息。
