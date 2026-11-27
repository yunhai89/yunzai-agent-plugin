# 网页抓取（web_crawl / crawl4ai）

> 本文是主 README 的拆分文档。返回 [README](../../README.md)。

## 🕸️ 网页抓取（web_crawl / crawl4ai）

> `web_crawl` 常驻工具（query 类，全员可用）与知识库 URL 入库/刷新共用同一抓取链路。默认走 [crawl4ai](https://docs.crawl4ai.com) 真浏览器渲染（Playwright Chromium）：SPA/JS 动态页、同态渲染页都能拿到渲染后正文；未就绪或失败自动降级纯 HTTP + cheerio（静态兜底）。

**开箱即用（默认开启）**：插件启动时会检测 crawl4ai 和 Chromium，缺什么就在后台补什么，不需要手动跑脚本。

- 缺 venv/crawl4ai → 安装完整运行时；已有 crawl4ai 只缺 Chromium → 只补浏览器。需要系统有 `python3` ≥3.10（缺 Python/venv 时安装会失败并降级 fetch）。
- 默认装到**插件目录**：`.crawl4ai-venv/` + `.crawl4ai-browsers/`（约 300~500MB，随插件走，删插件即清理）。
- 安装期间 `web_crawl` 仍可用（先走纯 HTTP）；完成后自动生效，无需重启。
- 失败不会阻塞启动，会继续降级 fetch；默认 6 小时内不自动重试，避免无网络环境反复下载。
- 关闭自动安装：`agent.kb.crawl.autoInstall: false`。
- **Stagehand 复用**：`agent.stagehand.enable=true` 且本地模式时，会自动探测并使用这里安装的 Chromium（日志 `source=crawl4ai`），不需要再装一份浏览器。
- Windows 下自动安装器不运行（脚本依赖 POSIX `sh`）；建议用 WSL/容器，或手动安装后通过 `CRAWL4AI_VENV` / `CRAWL4AI_BROWSERS_DIR` 指向现成目录。

**查看 / 手动修复**（主人）：

```text
#抓取环境         查看 crawl4ai / Chromium / 解释器路径 / 失败原因
#抓取环境 安装     首次安装（或补装 Chromium），完成/失败都会推回当前会话
#抓取环境 修复     忽略失败冷却，立即重试
```

安装是后台任务，命令会先回复「已开始」；结束时会再推一条结果（成功 ✅ / 失败 ❌，失败附退出码与日志尾部），不再只写控制台日志。若安装已由启动自检发起，`#抓取环境 安装` 会挂到同一任务上，装完同样会通知。

**离线 / 自定义镜像手动安装**：

```sh
sh plugins/agents-plugin/scripts/install-crawl4ai.sh   # 独立 venv + 插件目录内 Chromium
# 国内镜像加速示例：
PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple sh scripts/install-crawl4ai.sh
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright sh scripts/install-crawl4ai.sh
# 只补浏览器：
CRAWL4AI_BROWSER_ONLY=1 sh scripts/install-crawl4ai.sh
```

安装后 `web_crawl` 默认走浏览器；`config.yaml → agent.kb.crawl.engine: fetch` 可强制纯 HTTP。多个插件副本时注意运行时装在**正在运行的那一份**目录下（`#抓取环境` 会打印实际解释器/浏览器路径）。已显式设置 `PLAYWRIGHT_BROWSERS_PATH` / `CRAWL4AI_BROWSERS_DIR` 时优先使用该目录，旧版装在全局缓存里的浏览器仍可继续使用。

**反爬链**（`agent.kb.crawl`）：

```yaml
kb:
  crawl:
    engine: crawl4ai      # crawl4ai（默认真浏览器）| fetch（纯 HTTP+cheerio）
    autoInstall: true     # 缺少 crawl4ai/Chromium 时后台安装到插件目录（约 300-500MB）
    stealth: true         # 浏览器路径反检测（playwright-stealth + 模拟用户行为），默认开
    chromeChannel: auto   # auto=自带 Chromium 缺失时自动复用系统 Chrome/Edge；chrome/msedge=强制系统浏览器
    retryBlocked: true    # 被反爬拦截（403/CF 挑战等）时自动 undetected+stealth 强化再试一轮
    allowPrivateHosts: false  # 允许抓取本机/内网/元数据地址（防 SSRF，默认禁）
    sharedHosts: [github.com, api.github.com, githubusercontent.com]  # 允许解析到 CGNAT 的主机（本地加速器场景）
    sessionPersist: true      # 按站点持久化 cookie（清关凭证 12h 内复用；data/crawl/sessions.json，0600）
    sessionTtlHours: 12       # 会话有效期（小时）
    sessionProfile: false     # 持久浏览器 profile（user_data_dir，显式 opt-in；开启后浏览器全局串行）
    siteMemory: true          # 站点难度记忆：上次 fetch 够用就不再起浏览器；上次被拦就直接 undetected
    perHostIntervalMs: 1200   # 同站点最小抓取间隔（毫秒，含抖动）
    hostConcurrency: 1        # 同站点并发上限（1=串行）
```

- **代理**：`agent.proxy` 同时作用于浏览器渲染与降级 fetch（配了代理则浏览器也走代理）；目标为本地/内网地址时始终直连。
- **CGNAT 加速器豁免（`sharedHosts`）**：部分网络的本机 DNS/GitHub 加速器会把公网域名解析到 `100.64.0.0/10`（运营商级 NAT），SSRF 门禁若按「私网」一刀切会误杀整条 GitHub 链路。`sharedHosts` 只豁免「域名命中列表且解析结果除 CGNAT 外无其他内网地址」的情况；字面 IP 与 `100.100.100.200` 等元数据地址始终拦截。默认覆盖 GitHub 全系，换用其他加速器时把其域名（支持子域后缀）加进数组。
- **无需下载浏览器（`chromeChannel`）**：默认 `auto`，优先用 Playwright 自带 Chromium；未装或下载失败时自动改用系统已装的 Chrome/Edge（`channel` 启动，不落盘、不下载），受限网络/离线部署可省 200MB+ 下载。也可显式设 `chrome` / `msedge` 强制复用系统浏览器，或用 `chromium` 保证环境隔离。
- **阅读器兜底（`readerFallback`）**：浏览器与 fetch 都被 Cloudflare/403 判挑战时，最后尝试 `https://r.jina.ai/<url>` 服务端代取正文（Jina Reader，公开服务，需本机可达）。命中后结果标 `via: "reader"`；失败静默保留原错误。强制抓取器（`engine: "fetch"`）同样适用。
- **静态资源直取**：`.md/.txt/.json/.xml/.csv`、GitHub raw/API、jsDelivr/unpkg 等明确无需 JS 的 URL 会先走 HTTP fetch（快且不会被 crawl4ai 的「小页面正文过短」误判成反爬），失败再进浏览器阶梯；GitHub `blob/raw` 页面自动换成 raw 原文地址，raw 主源失败时依次尝试 jsDelivr / githack 镜像。
- **降级 fetch 的加固**：自动字符集（GBK/Big5 老站不乱码）、Cookie Jar（跳转携带会话）、反爬挑战页/JS 空壳识别（不把「Just a moment」「加载中」当正文）、Retry-After 退避重试。
- **高级能力**（仅 crawl4ai 生效）：`wait_for` 等渲染完成、`js_code` 滚动/点击触发懒加载、`extract` CSS schema 结构化抽取、`links` 链接清单、`scroll` 虚拟滚动；降级纯 HTTP 时结果带 `degraded:true + skipped:[...]`（诚实标注）。**`js_code` 与 `wait_for: js:...` 会执行任意页面脚本，仅主人可用**；普通成员使用会被确定性拒绝（其余抓取能力不受影响）。
- **PDF**：URL/content-type 识别为 PDF（或 crawl4ai 返回 `%PDF-` 原始字节）时，自动用 `pdfjs-dist` 提取文本，返回 `via: "pdf"` + `pdf.pages`；不会把 `%PDF-1.5` / `FlateDecode` 流当正文。扫描版/加密 PDF 无法提取文本时返回 `pdf_no_text` / `pdf_extract_failed` 明确提示。
- **失败提示**：结果区分 `blocked`（403/429 反爬）、`challenge`（CF 等挑战页）、`js_required`（JS 空壳）、`empty`、`ssrf_blocked`，并给出下一步建议；crawl4ai 与 fetch 双路失败时附带两路错误。
- **会话复用（抗反爬的关键一环）**：`sessionPersist` 打开时，该站点拿到的 cookie（含 Cloudflare `cf_clearance`/`__cf_bm` 等清关凭证）会按 host 存到 `data/crawl/sessions.json`，下次抓取（fetch 与浏览器两条路径）自动带上——不再"每次都是第一次访客"。fetch 路径是可靠的捕获通道（能拿到 HttpOnly 凭证），浏览器路径按 crawl4ai 版本尽力回传。清除会话：删 `data/crawl/` 下对应文件即可。
- **站点难度记忆**：`siteMemory` 按 host 记住有效档位（上次纯 HTTP 就够 → 下次不再起浏览器；上次普通档被拦 → 下次直接用 `undetected`），避免反复用注定失败的档位去打同一站。
- **抓取节奏**：`perHostIntervalMs`/`hostConcurrency` 约束同站点请求节奏（默认 1200ms、串行）——同一对话里连问几个页面时，节奏比单次快慢更容易触发风控。
- **安全**：默认拒绝抓取环回/私有/链路本地/元数据地址（含混淆 IPv4、IPv6、域名解析结果），fetch 重定向逐跳复验；持久化 cookie 落盘 `data/crawl/sessions.json`（权限 0600，**cookie 值不写日志**，可随时删除）；`sessionProfile` 打开的浏览器 profile 会保留更多站点状态（默认关）。crawl4ai 浏览器内的子资源/内部重定向不受此层约束（已知边界）。

---
