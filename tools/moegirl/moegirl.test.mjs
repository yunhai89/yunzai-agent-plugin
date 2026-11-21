/**
 * 萌娘百科工具包离线自检：wire 编解码 + Quill Delta 格式化 + HTML 片段清理。
 * 运行：node tools/moegirl/moegirl.test.mjs
 */
import { decode, wire } from './grpc.js'
import {
  deltaToText, deltaMedia, stripHtml, truncate, formatPageUrl, clampInt, isoTime, decodeEntities,
} from './format.js'
import { normalizeOpts } from './api.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
function eq(a, b, m) { const s = JSON.stringify(a) === JSON.stringify(b); ok(s, `${m}${s ? '' : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`}`) }
async function test(name, fn) { console.log(`\n[${name}]`); try { await fn() } catch (e) { failed++; console.error('  ✗ THROW', e?.message || e) } }

await test('protobuf wire：字符串 / varint / 嵌套消息', async () => {
  const buf = Buffer.concat([
    wire.encString(1, '初音未来'),
    wire.encVarint(3, 10),
    wire.encMsg(4, wire.encString(1, 'hello')),
  ])
  const f = decode(buf)
  eq(f[0].field, 1, '字段 1')
  eq(f[0].value.toString('utf8'), '初音未来', '字符串值')
  eq(f[1].value, 10, 'varint 值')
  eq(f[2].field, 4, '嵌套消息字段')
  eq(decode(f[2].value)[0].value.toString('utf8'), 'hello', '嵌套消息内容')
})

await test('gRPC frameScan：帧切分', async () => {
  const payload = wire.encString(1, 'abc')
  const body = Buffer.concat([wire.frame(payload), wire.frame(payload)])
  const r = wire.unframe(body)
  eq(r.length, 2, '两帧')
  eq(r[0].equals(payload), true, '第一帧内容')
})

await test('Quill Delta → 纯文本 / 媒体', async () => {
  const delta = [
    { insert: '今天聊聊 ' },
    { insert: { video: 'https://www.bilibili.com/video/BV1xx' } },
    { insert: '\n' },
    { insert: { image: 'https://storage.moegirl.org.cn/a.jpg' } },
    { insert: '初音未来。\n' },
  ]
  eq(deltaToText(delta), '今天聊聊 [视频] https://www.bilibili.com/video/BV1xx\n[图片] https://storage.moegirl.org.cn/a.jpg初音未来。', '文本拼接')
  eq(deltaMedia(delta), [
    { type: 'video', url: 'https://www.bilibili.com/video/BV1xx' },
    { type: 'image', url: 'https://storage.moegirl.org.cn/a.jpg' },
  ], '媒体提取')
  eq(deltaToText(JSON.stringify(delta)).includes('初音未来'), true, 'JSON 字符串输入')
  eq(deltaToText('纯文本'), '纯文本', '非 Delta 原样返回')
})

await test('HTML snippet 清理 + 实体解码', async () => {
  const html = '<span class="searchmatch">初音</span>&nbsp;未来 &amp; &#x521D; &#38899;'
  eq(stripHtml(html), '初音 未来 & 初 音', '去标签 + 实体')
  eq(decodeEntities('&lt;tag&gt; &quot;x&quot; &#39;y&#39;'), '<tag> "x" \'y\'', '常见实体')
})

await test('truncate / clampInt / isoTime / URL', async () => {
  const t = truncate('x'.repeat(120), 100)
  eq(t.truncated, true, '截断标记')
  eq(t.originalLength, 120, '原始长度')
  ok(t.text.startsWith('x'.repeat(100)), '保留前 N 字')
  eq(clampInt(99, 1, 20, 8), 20, '上限夹紧')
  eq(clampInt('x', 1, 20, 8), 8, '非法值回落')
  eq(isoTime(0), null, '无效时间')
  eq(isoTime(1700000000000), new Date(1700000000000).toISOString(), 'ISO 时间')
  eq(formatPageUrl('https://mobile.moegirl.org.cn/', '初音 未来'), 'https://mobile.moegirl.org.cn/%E5%88%9D%E9%9F%B3_%E6%9C%AA%E6%9D%A5', '词条 URL')
})

await test('normalizeOpts：配置夹紧与 host 归一', async () => {
  const o = normalizeOpts({
    host: 'https://grpc.moegirl.org.cn/path',
    wikiBase: 'https://mobile.moegirl.org.cn///',
    timeoutMs: 999999,
    minIntervalMs: -1,
    cacheTtlMs: 1,
    userAgent: '  test-ua  ',
  })
  eq(o.host, 'grpc.moegirl.org.cn', 'host 去协议/路径')
  eq(o.wikiBase, 'https://mobile.moegirl.org.cn', 'wikiBase 去尾斜杠')
  eq(o.timeoutMs, 60000, 'timeout 上限')
  eq(o.minIntervalMs, 0, 'minInterval 下限')
  eq(o.cacheTtlMs, 1, 'cache TTL 保留有效小值')
  eq(o.userAgent, 'test-ua', 'UA 去空白')
})

await test('tool.config：开关 / 默认值 / 字段类型', async () => {
  const { default: cfg } = await import('./tool.config.js')
  ok(cfg && cfg.info && cfg.info.title === '萌娘百科', 'info.title')
  const fields = Object.fromEntries((cfg.config || []).map((f) => [f.key, f]))
  eq(fields.enable?.default, true, '默认启用')
  eq(fields.searchLimit?.default, 8, 'searchLimit 默认值')
  eq(fields.maxPageChars?.type, 'number', 'maxPageChars 类型')
  eq(fields.grpcHost?.default, 'grpc.moegirl.org.cn', 'gRPC 默认地址')
  ok((cfg.config || []).every((f) => /^[A-Za-z0-9_]+$/.test(f.key)), '字段 key 合法')
})

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
process.exit(failed > 0 ? 1 : 0)
