# 在 iPad 上把 PRboard 装成 App

PRboard 是 PWA：不需要 App Store，用 iPad 自带 Safari「添加到主屏幕」即可得到全屏独立窗口（有自己的图标、无浏览器地址栏），配合 Bark 接收 CI 推送。iPhone 同样适用。

## 前置

- iPad 上已登录能访问 PRboard 站点的网络。
- 已有 GitHub 账号授权（同桌面端登录流程）。

## 安装（添加到主屏幕）

1. 用 **Safari** 打开 PRboard 站点（Chrome/Edge 等第三方浏览器不支持添加 PWA）。
2. 登录一次，确认看板正常加载。
3. 点工具栏的「分享」按钮（方框加向上箭头）。
4. 在分享面板中选「**添加到主屏幕**」。
5. 确认名称（默认 PRboard），点「添加」。

主屏图标来自站点的 `apple-touch-icon`，启动后即为全屏独立窗口；显示模式由 manifest 的 `standalone` 声明。

## CI 推送（Bark）

PRboard 的推送走 [Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865)（自建 bark-worker 转发）：

1. iPad App Store 安装 **Bark**。
2. 打开 Bark 拷贝你的推送 URL（形如 `https://<bark-worker>/abcdefg`）。
3. 在 PRboard 中进入 **设置 → 通知**（`/settings/notifications`），粘贴 Bark URL，按需开关四类事件（CI 全绿 / CI 重试耗尽 / PR 冲突 / Vercel 部署失败），点「发送测试推送」确认 iPad 能收到。

## 显示模式

点按头部主题按钮循环切换：

- **auto**：白天浅色 / 夜间自动深色
- **light / dark**：固定浅色 / 深色
- **eink**：墨水屏模式（纯黑白、关动画、关 SSE，仅手动刷新），供文石 Boox、Bigme 等安卓墨水屏平板使用

## 常见问题

- **图标是网页截图而不是 app 图标**：站点版本过旧（缺 `apple-touch-icon`），删除主屏图标后重新「添加到主屏幕」。
- **离线时打不开**：Service Worker 缓存了应用外壳，断网时能进壳；PR 数据依赖在线，恢复网络后手动刷新即可。
- **想删除**：长按主屏图标 → 移除 App（不影响服务器数据）。
