# 2026-10-12 Coolify 部署配置（参照 同类项目 复制）

## 背景

生产已从 Vercel 迁到自建 Coolify（单应用跟踪 main 自动部署）。仓库里两个
Vercel 时代的 workflow（`vercel-deploy-sync-check.yml` / `vercel-env-audit.yml`）随之
失效：前者指向已不存在的 Vercel 项目（secrets 还在时会误报 drift），后者同理。
同类项目已完成同款迁移并沉淀了 Coolify 时代的替代配置——本任务按先例复制适配。

## 复制范围（同类项目 → PRboard 适配）

| 其他项目 | PRboard 适配点 |
|---|---|
| `deploy-sync-check.yml`（15min 比对 main HEAD vs `/api/health` sha） | ubuntu-latest（去掉 self-hosted checkout 重试舞步）；`PRODUCTION_URL`/阈值可调；sha 读 `.sha`（端点扁平结构）；Bark composite + continue-on-error |
| `env-audit.yml`（Coolify env key 审计） | **单 production 应用**（PRboard 无 staging 应用）；required 真源 = `.env.example`（非 lib/env.ts）；去掉 cleanup-temp-dir（一次性 runner） |
| `.github/actions/bark-notify-anomaly` | 原样复制，group 默认改 `prboard-ci`；未配 secrets 优雅跳过 |
| `scripts/tools/pull-coolify-env.mjs` | 单 production 应用；写仓库根 `.env.local`；保留 git-tracked 拒绝与 --yes 确认 |
| `apps/web/app/api/health/route.ts` | 新增 `src/app/api/health/route.ts`（扁平 JSON，无 withLogging 包装） |
| `extract-required-envs.mjs`（解析 lib/env.ts .min(1)） | 改为解析 `.env.example` 的 KEY= 行（PRboard 的真源，SETUP.md 口径） |

同时删除两个 Vercel 死 workflow，`docs/SETUP.md` 增补 Coolify 部署节。

## 待用户填充（占位符）

- `YOUR_COOLIFY_APP_UUID`（env-audit.yml / pull-coolify-env.mjs）
- `YOUR_PRODUCTION_URL`（deploy-sync-check.yml）
- GitHub repo secrets：`COOLIFY_API_TOKEN`（只读）；可选 `BARK_DEVICE_KEY` / `BARK_WORKER_URL`

## 验收标准

- [x] `/api/health` 200 且 sha 按 `VERCEL_GIT_COMMIT_SHA → GIT_COMMIT_SHA → SOURCE_COMMIT → 'unknown'` 回退（测试锁定）。
- [x] extract 脚本输出 `.env.example` 全部 key（注释/空行跳过，排序去重，测试锁定）。
- [x] 两个新 workflow 过 actionlint；heredoc 写 `GITHUB_*` 用随机分隔符（workflow-file-guard 合规）。
- [x] 全量 lint / type-check / test / build 绿。
- [x] Vercel 两 workflow 移除，无残留引用。

## 风险点

- workflow 增删本身是 CI·CD 配置改动（ship 6d 红线类）：用户明确指令「参照 同类项目 复制」即为授权，
  PR diff 全量呈现供复核。
- 阈值 3600s 假设 Coolify 构建 <45min；同类项目因构建 42-93min 用 7200s。误报时调大即可（注释已写）。
- `pull-coolify-env.mjs` 拉生产凭据写本地文件：保留 同类项目的 --yes 确认 + git-tracked 拒绝。

## 范围外

- 迁移 `post-merge-smoke` / `staging-smoke`（同类项目另有的部署后冒烟）——PRboard 无此先例需求，另议。
