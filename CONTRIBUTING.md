# 贡献指南

感谢你对 PRboard 的关注。PRboard 是一个自托管的 GitHub PR 看板，当前优先服务单用户与小团队的实际工作流。

## 开始前

1. 阅读 [README.md](README.md) 和 [docs/SETUP.md](docs/SETUP.md)。
2. 从 `staging` 创建功能分支，不直接向 `main` 提交。
3. 不提交 `.env*`、私钥、令牌、数据库连接串、真实域名或部署标识。

## 开发与验证

```bash
npm ci
npm run lint
npm run type-check
npm test
npm run build
```

涉及 GitHub 写操作、鉴权或请求校验时，请先编写能复现问题的测试，再提交修复。新增环境变量时，同步更新 `.env.example`、部署文档和相关 CI 占位配置。

## Pull Request

- 一个 PR 只解决一个明确问题，并说明动机、行为变化和验证结果。
- 保持 GitHub App 最小权限、仓库范围校验和审计日志不被弱化。
- 遵守 [行为准则](CODE_OF_CONDUCT.md)，并在提交前使用 PR 模板自检。

## 安全问题

安全漏洞请按 [SECURITY.md](SECURITY.md) 的私密流程报告，不要创建公开 Issue。
