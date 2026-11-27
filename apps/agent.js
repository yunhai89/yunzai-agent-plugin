/**
 * agents-plugin 对话入口（薄壳）。
 *
 * 实际实现拆分在 ./agent/：
 *   agent/constants.js  插件根目录、内置预算/标签
 *   agent/streaming.js  进度/逐字流式与分片安全
 *   agent/runtime.js    运行时装配、热加载、单例生命周期
 *   agent/context.js    事件/定时任务上下文、工具运行时能力
 *   agent/chat.js       Chat 类（构造/触发）+ 命令组装配
 *   agent/commands/*    按领域拆分的命令实现
 *
 * 对外导出保持与拆分前一致，apps/web.js 与 stress/e2e 仍可直接 import 本文件。
 */
export { Chat } from './agent/chat.js'
export { getRuntime, invalidateRuntime } from './agent/runtime.js'
export { makeDeltaStreamer } from './agent/streaming.js'
export {
  fireReminder, makeSandboxCtx, attachToolRuntime, makeFireDispatch,
} from './agent/context.js'
