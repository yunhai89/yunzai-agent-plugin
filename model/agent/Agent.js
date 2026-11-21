/**
 * 兼容出口：旧 handwritten ReAct 内核已在 S11 删除。
 * 保留此文件仅为 research/multiagent/prompt 等模块的既有 import 路径；
 * 新代码应直接使用 `model/runtime/mastra-agent.js` 或 `chat-runner`。
 */
export {
  MastraAgent as Agent,
  GOVERNOR_STOP,
  STOP_REASON_CN,
  abortActiveRun,
  abortAllActiveRuns,
  isAgentRunActive,
} from '../runtime/mastra-agent.js'
