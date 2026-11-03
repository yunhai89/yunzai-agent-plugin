/**
 * 内置工具元数据入库（provenance=human, status=stable）。
 *
 * 仅注册逻辑身份 + manifest 元数据（供检索/统计/调用埋点关联 versionId）；
 * execute 仍走插件原代码（不入沙箱、不进化）。幂等：已存在则复用其 active 版本绑定。
 *
 * @param registry ToolEvoRegistry 实例
 * @param builtins [{ name, description, parameters, sideEffects[], tags[], useWhen[] }]
 * @returns {{added:number, bindings:Array<{name:string, versionId:string}>}}
 *   bindings 供 apps 把每个内置工具的执行契约绑定到 seed 出的版本 ID（审计 P1-8 埋点关联）。
 */
import crypto from 'node:crypto'
import { dao } from './db.js'
import { makeManifest, normalizeSideEffects } from './manifest.js'

export async function seedBuiltinTools(registry, builtins = []) {
  let added = 0
  const bindings = []
  const warnings = []
  for (const b of builtins) {
    if (!b?.name) continue
    try {
      const exist = await registry.getByName(b.name)
      if (exist?.active_version_id) {
        // 已入库：复用其 active 版本绑定（热重载/重启后仍能关联调用埋点）
        bindings.push({ name: b.name, versionId: exist.active_version_id })
        continue
      }
      // 没有 active 版本的情况有两种：全新工具，或**历史版本半途失败留下的空壳**
      // （旧 seed 先 createTool 再 createVersion，manifest 校验抛错后只留下 tools 行）。
      const toolId = exist?.id || ('tool_' + crypto.randomBytes(6).toString('hex'))
      if (!exist) await registry.createTool({ id: toolId, name: b.name, namespace: 'builtin' })
      // 若已有版本但 active 指针为空（淘汰/半失败/旧数据），优先恢复既有 stable 版本，
      // 避免再次创建固定 1.0.0 撞 UNIQUE；没有 stable 时新建下一个 patch 版本。
      const existingVersions = exist ? await registry.listVersions({ toolId }) : []
      const reusable = existingVersions.find((v) => v.status === 'stable')
      if (reusable) {
        await dao.run(`UPDATE tools SET active_version_id=? WHERE id=?`, [reusable.id, toolId])
        bindings.push({ name: b.name, versionId: reusable.id })
        warnings.push(`${b.name}: active 指针为空但存在 stable ${reusable.semver}，已恢复绑定`)
        continue
      }
      if (exist) warnings.push(`${b.name}: 发现无 active 版本的空壳工具，已补建版本（旧版本 seed 失败残留）`)
      // 副作用值归一化：别名（file_write→write 等）自动纠正，未知值剔除并告警——
      // 单个第三方工具的脏 meta 不能连累整批内置工具入库失败（曾因 diagram 的 file_write 全量 seed 失败）。
      const se = normalizeSideEffects(b.sideEffects)
      if (se.unknown.length) warnings.push(`${b.name}: 未知 sideEffects [${se.unknown.join(',')}] 已忽略（合法值：none/read/write/network/message/delete）`)
      const semver = existingVersions.length ? null : '1.0.0'
      const manifest = makeManifest({
        name: b.name,
        version: semver || undefined,
        status: 'stable',
        description: b.description || `内置工具 ${b.name}`,
        inputSchema: b.parameters || { type: 'object', properties: {} },
        tags: b.tags || [],
        useWhen: b.useWhen || [],
        permissions: {
          sideEffects: se.values,
          network: { mode: 'deny', hosts: [] },
          filesystem: { read: [], write: [] },
          secrets: [],
        },
        provenance: { kind: 'human', createdAt: new Date().toISOString() },
      })
      // 内置工具直接 stable（人维护，跳过状态机审批）；createVersion 存 manifest.status。
      // semver=null 时由注册表原子分配，避免与已有 1.0.0 撞唯一键。
      const v = await registry.createVersion({ toolId, semver, manifest, source: '', tests: [] })
      await dao.run(`UPDATE tools SET active_version_id=? WHERE id=?`, [v.id, toolId])
      bindings.push({ name: b.name, versionId: v.id })
      added++
    } catch (e) {
      // 单工具脏数据/半写入不能连累整批内置工具：记录后继续，其余工具仍能绑定埋点。
      warnings.push(`${b.name}: seed 失败已跳过（${e?.message || e}）`)
    }
  }
  return { added, bindings, warnings }
}
