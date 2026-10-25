# PRboard

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个可自托管的 GitHub Pull Request 看板。用户通过自己的 GitHub 账号登录、安装 GitHub App 后，只能查看和操作自己授权仓库的 PR、CI 与 GitHub Actions。

## 功能

- 通过 GitHub App 连接用户选择的仓库，不使用长期 Personal Access Token。
- 按已关联的 GitHub App installation 聚合开放 PR、Checks 与 GitHub Actions 状态。
- 支持失败 job 重试、PR 合并、工作流取消/强制取消/删除，并记录审计日志。
- GitHub webhook → Postgres `NOTIFY`/`LISTEN` → SSE 实时刷新；保留轮询兜底。
- 每个用户的 installation 与仓库访问独立隔离。

## 适用范围

PRboard 面向个人与受控小团队的自托管场景。当前访问边界以 GitHub 登录用户及其关联 installation 为单位；不提供组织内细粒度角色管理、跨用户共享看板或托管 SaaS 服务。GitHub App 安装范围、数据库与部署环境均由实例管理员负责。

## 快速开始

前置条件：Node.js 22+、Postgres，以及一个 GitHub App。

```bash
npm ci
cp .env.example .env.local
# 按 docs/SETUP.md 填写 .env.local
npm run dev
```

浏览器打开 `http://localhost:3000`。完整的 GitHub App 权限、webhook 与数据库说明见 [docs/SETUP.md](docs/SETUP.md)，各平台的部署步骤见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 部署

### 一键部署到 Render（推荐新手）

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/daidaidaiok/PRBoard)

点击按钮后，Render 会读取仓库根目录的 `render.yaml`，创建一个 Web 服务和一个 Postgres 数据库。创建时需要填写 GitHub App 的凭据（见 [SETUP.md 第 2、3 节](docs/SETUP.md)）。部署完成后，把分配到的 `https://<服务名>.onrender.com` 填入 `AUTH_URL`，并把 GitHub App 的回调与 webhook 地址改为这个域名。免费套餐的限制以 Render 当前文档为准。

### 其他平台

- **Coolify**：选择 Public Repository 或 GitHub App 作为来源，构建命令 `npm ci && npm run build`，启动命令 `npm run start`，端口 `3000`。
- **VPS、Railway 等**：参考 [docs/DEPLOY.md](docs/DEPLOY.md)。
- **Vercel**：不推荐，原因见 DEPLOY.md。

## GitHub App 权限

仅授予以下最小权限：Metadata（只读）、Pull requests（读写）、Checks（只读）、Actions（读写）、Commit statuses（只读）和 Contents（读写，用于合并 PR）。App 只应安装到需要监控的仓库；`Contents: write` 和 `Actions: write` 允许执行真实写操作。

## 安全

- 私钥、OAuth secret、webhook secret、数据库 URL 与 `AUTH_SECRET` 只保存在环境变量中，绝不提交。
- 高权限操作会校验目标仓库属于当前登录用户已关联的 installation，并写入审计日志。
- GitHub App 安装回调以签名 state 与 installation 所属 GitHub 账号校验关联关系。
- 安全问题请遵循 [SECURITY.md](SECURITY.md) 的私密报告流程。

## 开发

```bash
npm run lint
npm run type-check
npm test
npm run build
```

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，行为要求见 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 许可证

本项目采用 [MIT License](LICENSE)。
