# 萌娘百科外置工具

> 本文是主 README 的拆分文档。返回 [README](../README.md)。

`tools/moegirl/` 是随插件分发的只读外置工具包，用于查询萌娘百科词条与社区内容。

接口来源：萌娘百科移动端逆向调研。

| 通道 | 用途 |
| --- | --- |
| `grpc.moegirl.org.cn`（HTTP/2 + protobuf） | 词条精选搜索、社区帖子搜索/详情、首页混合流、词条摘要 |
| `mobile.moegirl.org.cn/api.php`（MediaWiki） | 全文搜索、词条纯文本正文（Cloudflare 对 `*.php` 放行） |

## 工具

| 工具 | 说明 |
| --- | --- |
| `moegirl__search` | 搜索词条。`mode=entry` 精选卡片（标题/摘要/标签/热评，无结果自动回退全文）；`fulltext` MediaWiki 全文搜索；`both` 合并 |
| `moegirl__page` | 词条摘要 + 封面 + 标签 + 纯文本正文；`intro=true` 只取引言，`maxChars` 控制长度 |
| `moegirl__post_search` | 搜索社区帖子/动态，返回 id/作者/分区/摘要/点赞/评论数 |
| `moegirl__post` | 帖子详情：正文纯文本、视频/图片链接、作者、分区、发布时间 |
| `moegirl__feed` | 首页混合流（词条 + 动态），可只看 `entry` 或 `moment` |

典型链路：

```text
用户问 ACGN 角色/作品/梗
  → moegirl__search(query, mode=entry)
  → moegirl__page(title, intro=false, maxChars=12000)

用户想看社区讨论/视频帖
  → moegirl__post_search(query)
  → moegirl__post(id)
```

## 配置

配置路径：`agent.tools.moegirl`（Web 面板「系统 → 外置工具」按 schema 渲染）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enable` | `true` | 关闭后不注册 `moegirl__*` |
| `searchLimit` | `8` | 搜索默认条数 |
| `postLimit` | `5` | 帖子搜索默认条数 |
| `feedLimit` | `10` | 首页流默认条数 |
| `maxPageChars` | `12000` | 词条正文默认上限 |
| `maxPostChars` | `8000` | 帖子正文默认上限 |
| `includeComments` | `true` | 搜索结果附带最多 2 条热评 |
| `timeoutMs` | `15000` | 请求超时 |
| `minIntervalMs` | `300` | 所有请求的实际发起间隔（限速） |
| `cacheTtlSeconds` | `120` | 相同查询的进程内缓存；0=关闭 |
| `grpcHost` | `grpc.moegirl.org.cn` | gRPC 网关 |
| `wikiBase` | `https://mobile.moegirl.org.cn` | MediaWiki 站点 |
| `userAgent` | `agents-plugin-moegirl/1.0` | 请求标识 |

## 行为与限制

- 只读、无需登录；不写入任何用户数据。
- 所有请求经过 `minIntervalMs` 限速；相同查询有短 TTL 缓存。
- 词条正文来自 MediaWiki `extracts` 纯文本，**表格、信息框和部分模板内容可能被省略**；需要原始 wikitext 时请用其他方式。
- 评论接口（`GetArticleCommentListWithUserInfo`）目前公开调用通常返回空列表，因此未暴露为工具。
- H5 的 `/api/*` 受 Cloudflare Turnstile 保护，工具不依赖它；gRPC 与 `api.php` 是当前可用通道。
- 社区帖子中的视频链接通常指向 B 站；工具只返回链接，不下载视频。
- 请控制调用频率并标注来源；角色/作品版权归原权利人所有。

## 自检

```bash
node tools/moegirl/moegirl.test.mjs                       # 离线：wire / Delta / HTML / 配置夹紧
MOEGIRL_INTEGRATION=1 node tools/moegirl/integration.test.mjs  # 真实接口（可选）
```
