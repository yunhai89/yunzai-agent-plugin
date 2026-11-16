/**
 * QQ 官方机器人主人判定（agent.masters 兜底）离线自检。
 *
 * 覆盖：
 *  ① openid 三种形态（完整 `<self_id>:<openid>`、裸 openid、`qg_<openid>`）都能匹配；
 *  ② 大小写/首尾空白容错（openid 为十六进制串，面板与手填常见大小写混用）；
 *  ③ 非官方协议不改变既有语义（仍只看 e.isMaster）；
 *  ④ 规则级 master 门（installMasterGate）：放行、拒绝文案、幂等；
 *  ⑤ describeMasterGate 排障视图。
 *
 * 运行：node model/qqofficial/guard.test.mjs
 */
import Config from '../../utils/Config.js'
import {
  isOfficialMaster, isEventMaster, installMasterGate, describeMasterGate, MASTER_DENIED_TEXT,
} from './guard.js'

let passed = 0
let failed = 0
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }
const eq = (a, b, m) => ok(Object.is(a, b), `${m}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`)

const OPENID = '807AC1596B40D96591A5ACBEB3CFFA4D'
const APPID = '1903797111'
const official = (user_id, extra = {}) => ({
  user_id,
  self_id: APPID,
  adapter_id: 'QQBot',
  adapter_name: 'QQBot',
  reply: async () => {},
  ...extra,
})
const cfgOf = (masters) => ({ agent: { masters } })

console.log('\n[1] openid 三种形态与大小写/空白')
{
  ok(isOfficialMaster(official(`${APPID}:${OPENID}`), cfgOf([OPENID])), '完整 user_id 命中裸 openid')
  ok(isOfficialMaster(official(`${APPID}:${OPENID}`), cfgOf([`${APPID}:${OPENID}`])), '完整 user_id 命中完整配置')
  ok(isOfficialMaster(official(OPENID), cfgOf([OPENID])), '裸 openid 命中')
  ok(isOfficialMaster(official(`qg_${OPENID}`), cfgOf([OPENID])), 'qg_ 前缀命中裸 openid')
  ok(isOfficialMaster(official(`qg_${OPENID}`), cfgOf([`qg_${OPENID}`])), 'qg_ 前缀命中 qg_ 配置')
  ok(isOfficialMaster(official(`${APPID}:${OPENID}`), cfgOf([OPENID.toLowerCase()])), '配置写小写仍命中（大小写不敏感）')
  ok(isOfficialMaster(official(`${APPID}:${OPENID}`), cfgOf([`  ${OPENID}  `])), '配置首尾空白被忽略')
  ok(!isOfficialMaster(official(`${APPID}:${OPENID}`), cfgOf([OPENID.slice(0, -1)])), '相似但不同的 openid 不命中')
  ok(isOfficialMaster(official(OPENID), { agent: { masters: OPENID } }), 'masters 写成字符串（手改 yaml）也命中')
  ok(isOfficialMaster(official(OPENID), { agent: { masters: `12345, ${OPENID}` } }), '字符串多值按逗号/空白拆分命中')
  ok(!isOfficialMaster(official(`999999:${OPENID}`), cfgOf([OPENID])), '其它 self_id 前缀不误判为裸 openid')
}

console.log('\n[2] 拒绝路径')
{
  ok(!isOfficialMaster(official(`${APPID}:${OPENID}`), cfgOf([])), 'masters 为空 → 拒绝')
  ok(!isOfficialMaster(official(`${APPID}:${OPENID}`), cfgOf(['someone-else'])), '不在 masters → 拒绝')
  const onebot = { user_id: '123456', self_id: '1903797111', adapter_id: 'OneBot11', adapter_name: 'OneBot11' }
  ok(!isOfficialMaster(onebot, cfgOf(['123456'])), '非官方协议即使 masters 命中也不接管（保持框架语义）')
  ok(isOfficialMaster({ ...onebot, isMaster: true }, cfgOf([])), 'e.isMaster 为真时直接放行（框架主人）')
  eq(isEventMaster(official(`${APPID}:${OPENID}`), cfgOf([OPENID])), true, 'isEventMaster 与 isOfficialMaster 同口径')
}

console.log('\n[3] installMasterGate：放行、拒绝、幂等')
{
  const realGet = Config.get
  let calls = 0
  const replies = []
  const ev = official(`${APPID}:${OPENID}`, { reply: async (t) => { replies.push(t) } })
  class FakePlugin {
    constructor(e) {
      this.e = e
      this.rule = [
        { reg: /^#gate$/, fnc: 'gated', permission: 'master' },
        { reg: /^#open$/, fnc: 'open' },
      ]
    }
    async gated() { calls++; return 'ok' }
    async open() { return 'open' }
  }
  try {
    Config.get = () => ({ agent: { masters: [] } })
    const p = new FakePlugin(ev)
    installMasterGate(p)
    eq(p.rule[0].permission, 'all', 'permission:master → all')
    eq(p.rule[0].__masterGate, true, '打上 __masterGate 标记')
    eq(await p.gated(), undefined, '无 masters 时被门拦截（返回 reply 结果）')
    eq(calls, 0, '原方法未被调用')
    eq(replies.length, 1, '拒绝时回复一次')
    ok(String(replies[0]).includes('仅主人可用'), '拒绝文案带权限提示')
    eq(replies[0], MASTER_DENIED_TEXT, '拒绝文案为 MASTER_DENIED_TEXT')
    const before = p.rule[0].fnc
    installMasterGate(p)
    eq(p.rule[0].fnc, before, '二次安装幂等（不重复包裹）')
    eq(await p.open(), 'open', '未声明 master 的规则不受影响')
    eq(describeMasterGate(p).length, 1, 'describeMasterGate 只列受控规则')

    Config.get = () => ({ agent: { masters: [OPENID] } })
    const p2 = new FakePlugin(ev)
    installMasterGate(p2)
    eq(await p2.gated(), 'ok', 'masters 命中时放行原方法')
    eq(calls, 1, '放行时原方法执行')
  } finally {
    Config.get = realGet
  }
}

console.log(`\n通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
