# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 最新 `master` / 最新 Release | ✅ |
| 旧版本 | ❌ 请先升级到最新版并复现 |

本项目只维护 `master` 分支，安全修复进入 `master`，不单独维护旧版本分支。

## Reporting a vulnerability

请使用 GitHub 的**私有漏洞报告**（Private vulnerability reporting）：

https://github.com/yunhai89/yunzai-agent-plugin/security/advisories/new

**不要为安全问题开公开 issue**，尤其是可能泄露 LLM API Key、QQ 官方机器人 AppSecret/token、Web 面板 token，或绕过主人权限、工具审批、RBAC、沙箱边界的问题。

报告中请尽量包含：

- 受影响的版本或 commit；
- 部署方式（协议端、Web 面板是否公网可达、`agent.sandbox.mode`、是否启用 MCP/外置工具）；
- 可复现步骤、影响范围与攻击前提；
- 相关日志/配置片段（请先移除 API Key、AppSecret、token 等敏感信息）。

## Security model

- **Web 面板**：默认监听 `0.0.0.0:6098`，所有 `/api/*` 需要 token（`Authorization: Bearer`，或登录跳转的 `?token=`）。`#agent登录` 会话令牌只存内存、24h；启动控制台令牌默认 30 天，持久化到 `data/web/console-token.json`（目录 `700`、文件 `600`）。默认情况下启动日志与 `data/web/console-url.txt` 会包含带 token 的地址；面板没有内置 Origin 校验，**不要直接暴露公网**。
- **主人权限**：`agent.masters` 定义主人；QQ 官方机器人的 openid 不是 QQ 号，相关指令通过 `installMasterGate` 复核，不能依赖框架的 `permission: 'master'` 直接判定。
- **工具 RBAC**：工具按 `query` / `personal` / `message` / `group_manage` / `system` 分级；未声明 `category` 的工具默认 `system`（仅主人）。高危写操作走 `#确认` 审批，超时拒绝；同名工具不会被静默覆盖。
- **不可信内容**：用户消息、引用、网页、MCP/工具结果、记忆都按数据处理；命中注入特征时加 `<untrusted_data>` 边界。写长期记忆、设提醒/定时任务必须带用户原话证据，不能由注入内容或模型推断自证。
- **SSRF 防护**：`web_crawl`、`web_download`、`send_file` 远程 URL、`stagehand__goto` 默认拒绝环回、私有、链路本地与云元数据地址，并逐跳复验重定向；内网访问需显式开启对应 `allowPrivateHosts`（如 `agent.kb.crawl.allowPrivateHosts`；`send_file` 无放宽项）；`agent.kb.crawl.sharedHosts` 仅对「域名解析到 CGNAT 100.64/10」的指定后缀做窄豁免（本机 GitHub 加速器场景），字面 IP 与元数据地址仍拦。
- **终端与沙箱**：`agent.sandbox.mode` 默认 `off`，此时 terminal 工具不注册；开启后命令只在 E2B microVM 内执行，连不上 E2B 即 fail-closed，绝不回退宿主 shell。沙箱网络默认放通，可按需收紧 `agent.sandbox.network.allowInternet` / `allowOut`。
- **密钥处理**：`config/config.yaml` 不会入库；Web API 对 API Key 做掩码；回复默认开启 `agent.redactSecrets` 脱敏。外置工具与 MCP 服务端都是受信代码（外置工具在插件进程内运行，MCP 通常以子进程运行），安装前需自行审查。

## Deployment guidance

- 不要把 Web 面板直接暴露到公网。使用 SSH 隧道、VPN、防火墙或带认证的反向代理；带 token 的 URL 等同于密码，分享日志/截图前先脱敏。
- 怀疑面板 token 泄露时，删除 `data/web/console-token.json` 让下次启动重新生成；不需要启动日志打印 token 可设 `agent.webApi.printTokenOnStart: false`。
- 除非确实需要，保持 `agent.sandbox.mode: off`。开启后使用专用 E2B 账号/Key，并设置并发、单会话命令数、超时与网络白名单，避免配额和账单失控。
- 保持 `agent.privateChat: false`，只把可信账号加入 `agent.masters`；不要给不可信群开启自动免审批（`masterSkipConfirm`）或高危工具。
- 把群消息、引用、网页、MCP 输出、第三方工具/技能都视为不可信输入；安装外置工具或 MCP 服务端前审查其代码与权限。
- 抓取运行时（crawl4ai + Chromium）默认会在启动时自动从 PyPI / Playwright CDN 下载并以运行 Yunzai 的用户身份执行；供应链敏感环境可设 `agent.kb.crawl.autoInstall: false`，改为审查后手动安装。
- 怀疑密钥泄露时，及时轮换 LLM API Key、QQ 官方 AppSecret、E2B Key，并检查 `config/config.yaml`、日志和提交历史中是否残留敏感信息。

更完整的内部安全边界与实现说明见 [`docs/security.md`](docs/security.md)。
