# 部署指南

本文说明如何把 PRboard 部署到生产环境。GitHub App、环境变量含义等配置见 [SETUP.md](SETUP.md)，这里只讲部署平台上的操作。

## 运行时要求

- Node.js 22+ 与 npm。
- Postgres。需要两条连接串：`DATABASE_URL`（普通读写）和 `DATABASE_URL_UNPOOLED`（直连，用于 SSE 的 `LISTEN` 与数据库迁移）。
- 一个能长期运行 Node 进程、并支持长连接（SSE）的平台。
- 一个 HTTPS 域名，GitHub App 的回调与 webhook 都指向它。

## 构建与启动命令

| 步骤 | 命令 | 说明 |
|---|---|---|
| 安装依赖 | `npm ci` | 必须包含 devDependencies，因为 `drizzle-kit` 在其中，迁移要用 |
| 构建 | `npm run build` | |
| 启动 | `npm run start` | 监听 `PORT` 环境变量，未设置时为 3000 |
| 健康检查 | `GET /api/health` | 返回 `status`、`sha` 等字段，无需登录 |

`sha` 字段会依次读取 `VERCEL_GIT_COMMIT_SHA`、`GIT_COMMIT_SHA`、`SOURCE_COMMIT`。部署后可以用它确认线上跑的是哪个提交。

## 环境变量

按 [SETUP.md 第 3 节](SETUP.md#3-配置环境变量) 配置。生产环境注意两点：

- `AUTH_URL` 填写 `https://你的域名`，不要填 localhost。
- `DATABASE_URL` 与 `DATABASE_URL_UNPOOLED` 都要配置。事务池（pooler）地址不支持 `LISTEN`，所以 `DATABASE_URL_UNPOOLED` 必须是直连地址。

敏感变量只放在平台的环境变量设置里，不要写进仓库。

## 数据库迁移

`npm run db:migrate` 通过 `dotenv-cli` 读取 `.env.local`，服务器上通常没有这个文件。在部署环境里直接运行：

```bash
npx drizzle-kit migrate
```

该命令读取 `DATABASE_URL_UNPOOLED`（缺失时回退到 `DATABASE_URL`）。

发布流程：先对数据库执行迁移，再发布新版本。新增 migration 时，在本地用 `npm run db:generate` 生成，并提交 `drizzle/` 目录。

## GitHub App 地址

部署完成后，确认以下地址都指向生产域名（详见 SETUP.md 第 2 节）：

- Callback URL：`https://你的域名/api/auth/callback/github-app`
- Setup URL：`https://你的域名/api/install/github/callback`
- Webhook URL：`https://你的域名/api/webhooks/github`

## 平台

### Coolify（自托管，推荐）

界面名称以你使用的 Coolify 版本为准。

1. 新建应用，来源选择你的 Git 仓库（GitHub App 方式），分支选 `main`。
2. 构建方式选择 Nixpacks 或 Node.js。命令设置为：
   - Install：`npm ci`
   - Build：`npm run build`
   - Start：`npm run start`
   - Port：`3000`
3. 在环境变量里填写第 3 节的全部变量。
4. 绑定域名并开启 HTTPS。
5. 首次部署成功后，在应用的终端里执行一次 `npx drizzle-kit migrate`。之后每次有新 migration 时重复执行。
6. 确认 `https://你的域名/api/health` 正常返回，`sha` 与仓库最新提交一致。

如果实时更新不工作，检查反向代理是否开启了响应缓冲。`/api/events` 必须关闭缓冲。

### 其他 VPS（systemd + 反向代理）

下面以 Node 进程直接运行为例。

`/etc/systemd/system/prboard.service`：

```ini
[Unit]
Description=PRboard
After=network.target

[Service]
WorkingDirectory=/opt/prboard
EnvironmentFile=/opt/prboard/.env.production
ExecStart=/usr/bin/npm run start
Restart=always
User=prboard

[Install]
WantedBy=multi-user.target
```

反向代理（Nginx 示例），`/api/events` 必须关闭缓冲，否则实时推送会被攒住：

```nginx
location /api/events {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 1h;
}

location / {
    proxy_pass http://127.0.0.1:3000;
}
```

### Railway、Render、Fly.io 等容器平台

与 Coolify 相同，使用同样的安装、构建、启动命令与环境变量。添加一个 Postgres 服务，把它的两条连接串填入环境变量。

### Vercel（不推荐）

PRboard 依赖 Postgres `LISTEN` 与长连接 SSE 做实时更新。无服务器函数有执行时长限制，且不保持长连接，实时推送可能不可用，页面会依赖轮询。本项目没有在 Vercel 上验证过，不建议作为主要部署方式。

## 宿主机监控（可选）

`scripts/host-monitor/agent.mjs` 运行在 GitHub Actions runner 或其他机器上，把主机指标推送到 PRboard。它不属于 Web 服务，部署在需要监控的机器上即可。

需要的环境变量：

| 变量 | 说明 |
|---|---|
| `PRBOARD_URL` | PRboard 的地址，必须是 HTTPS（本地 localhost 除外） |
| `PRBOARD_HOST_ID` | 主机标识 |
| `PRBOARD_HOST_TOKEN` | 43 位 base64url 令牌 |
| `PRBOARD_INTERVAL_SECONDS` | 可选，30 到 60，默认 60 |
| `PRBOARD_DISK_MOUNT` | 可选，要统计的磁盘挂载点 |

启动：`npm run host:monitor`。具体配置方式见 [SETUP.md 第 6 节](SETUP.md)。

## 上线检查清单

- [ ] `https://你的域名/api/health` 返回 200，`sha` 与预期提交一致
- [ ] 能用 GitHub 登录，并能安装 GitHub App
- [ ] 在 GitHub 上触发一次事件，PRboard 页面能收到更新
- [ ] 数据库迁移已执行，没有遗漏的 migration
- [ ] 日志中没有持续报错
