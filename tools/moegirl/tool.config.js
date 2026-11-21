/**
 * 萌娘百科工具包配置（固定模板）。
 * 用户值统一保存在集中配置 `agent.tools.moegirl`。
 */
export default {
  info: {
    title: '萌娘百科',
    description: '萌娘百科词条/全文搜索、词条正文、社区帖子搜索/详情、首页动态流（gRPC + MediaWiki 只读接口）',
    author: 'yunzai-agent-plugin',
    version: '1.0.0',
    homepage: 'https://mobile.moegirl.org.cn',
    icon: 'book',
  },
  config: [
    { key: 'enable', type: 'boolean', label: '启用', default: true, description: '关闭后不注册 moegirl__* 工具，零影响' },
    { key: 'searchLimit', type: 'number', label: '搜索默认条数', default: 8, min: 1, max: 20, step: 1 },
    { key: 'postLimit', type: 'number', label: '帖子搜索默认条数', default: 5, min: 1, max: 20, step: 1 },
    { key: 'feedLimit', type: 'number', label: '首页流默认条数', default: 10, min: 1, max: 30, step: 1 },
    { key: 'maxPageChars', type: 'number', label: '词条正文默认上限(字)', default: 12000, min: 1000, max: 30000, step: 1000 },
    { key: 'maxPostChars', type: 'number', label: '帖子正文默认上限(字)', default: 8000, min: 1000, max: 30000, step: 1000 },
    { key: 'includeComments', type: 'boolean', label: '搜索结果附带热评', default: true, description: '词条搜索默认附带最多 2 条热评；关闭可让结果更短更干净' },
    { key: 'timeoutMs', type: 'number', label: '请求超时(ms)', default: 15000, min: 3000, max: 60000, step: 1000 },
    { key: 'minIntervalMs', type: 'number', label: '请求最小间隔(ms)', default: 300, min: 0, max: 5000, step: 50, description: '所有 gRPC/MediaWiki 请求的实际发起间隔；避免高频请求站点' },
    { key: 'cacheTtlSeconds', type: 'number', label: '缓存 TTL(秒)', default: 120, min: 0, max: 3600, step: 10, description: '相同查询的进程内缓存时长；0=关闭' },
    { key: 'grpcHost', type: 'string', label: 'gRPC 网关', default: 'grpc.moegirl.org.cn', description: '移动端业务后端；一般无需修改' },
    { key: 'wikiBase', type: 'string', label: 'MediaWiki 站点', default: 'https://mobile.moegirl.org.cn', description: '用于全文搜索与词条正文；一般无需修改' },
    { key: 'userAgent', type: 'string', label: 'User-Agent', default: 'agents-plugin-moegirl/1.0', description: '请求标识；公开分发时建议保留可识别来源' },
  ],
}
