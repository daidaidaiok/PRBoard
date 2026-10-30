# 发布前依赖安全修复

目标：清除生产依赖审计 high/critical 后继续 main 回流 staging 与 staging 晋级 main。
根因：锁定依赖包含已公告漏洞版本；UI PR 未变更依赖，属既有基线问题。
方案：同 major 定向升级 next/eslint-config-next 至 16.4.3、shadcn 至 4.23.0、zod 至 4.6.7、systeminformation 至 5.33.19，并更新受影响的兼容传递依赖。
备选 audit fix --force 会建议不兼容 shadcn 降级，不采用；shadcn 的 CSS 被 globals.css 使用，保留该包。
边界：不改鉴权、数据库、CI 配置；不扩大功能范围。所有新发现 high/critical 仍必须修复或明确升级处理。
验证：安全版本下限测试先红后绿；production 和完整审计；lint/type-check/test/build。使用 CI 已有的构建占位环境，不改 .env。
