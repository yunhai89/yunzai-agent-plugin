/**
 * Agent 系统提示裁剪回归（master/legacy 内核）。
 *
 * 目的：常驻执行/搜索指令必须跟随当前工具集，不能对无搜索能力的 Agent
 * 注入“必须换源重搜”，也不能引用不存在的工具。
 *
 * 运行：node model/agent/prompt-assembly.test.mjs
 */
import { Agent } from './Agent.js'
import { ToolRegistry } from './tools/registry.js'

let passed = 0
let failed = 0
function ok(c, m) { if (c) { passed++; console.log('  ✓', m) } else { failed++; console.error('  ✗ FAIL', m) } }

function registryWith(names) {
  const reg = new ToolRegistry()
  for (const name of names) {
    reg.register({
      name, description: name, category: name.startsWith('memory') ? 'personal' : 'query',
      parameters: { type: 'object', properties: {} },
      async execute() { return {} },
    })
  }
  return reg
}

function systemFor(names) {
  const agent = new Agent({
    provider: { async chat() { return { content: '' } } },
    systemPrompt: '你是助手',
    tools: registryWith(names),
  })
  return agent._assembleSystem([], null, '', undefined).system
}

console.log('\n[有搜索工具 → 注入搜索纪律]')
{
  const s = systemFor(['web_search', 'memory_search'])
  ok(s.includes('## 执行取向'), '执行取向')
  ok(s.includes('## 搜索与核验'), '搜索与核验')
  ok(s.includes('engines'), '包含换源参数提示')
}

console.log('\n[无搜索工具 → 不注入搜索纪律]')
{
  const s = systemFor(['memory_search', 'calculate'])
  ok(s.includes('## 执行取向'), '仍注入执行取向')
  ok(!s.includes('## 搜索与核验'), '不注入搜索段')
}

console.log('\n[完全无工具 → 只保留身份/服务准则]')
{
  const s = systemFor([])
  ok(s.includes('你是助手'), '身份仍在')
  ok(s.includes('## 服务准则'), '服务准则仍在')
  ok(!s.includes('## 执行取向') && !s.includes('## 搜索与核验'), '不注入工具相关段')
}

console.log('\n[工具目录稳定排序]')
{
  const s = systemFor(['web_search', 'calculate', 'memory_search'])
  const iCat = s.indexOf('## 工具目录')
  const calc = s.indexOf('- calculate：')
  const mem = s.indexOf('- memory_search：')
  const web = s.indexOf('- web_search：')
  ok(iCat >= 0 && calc > iCat && calc < mem && mem < web, '工具目录按名称排序')
}

console.log(`\n========================================`)
console.log(`通过 ${passed}，失败 ${failed}`)
console.log(`========================================`)
if (failed > 0) process.exitCode = 1
