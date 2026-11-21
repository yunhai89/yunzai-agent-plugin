# PR4b / PR4c 实施报告（S5 功能 · 流式/取消/原生审批）

> 对应 [07 开发计划](07-development-plan.md) 的 **PR4b（流式/取消/灰度扩群）** 与 **PR4c（原生 ApprovalBridge 聊天接入）**。
> 状态：**功能完成**；`S5` 的 72h 观察期仍未执行。
> PR4a 非流式灰度见 [PR4a-report.md](PR4a-report.md)，PR3b 审批基础见 [PR3b-report.md](PR3b-report.md)。

---

## 1. PR4b：流式与取消

### 1.1 流式

`chat-runner.js` 现在同时支持：

- 非流式 `agent.generate()`；
- 流式 `agent.stream()` + `fullStream`；
- chunk 映射：
  - `text-delta` → 按 step 缓冲；
  - `reasoning-delta` → `onReasoning`；
  - `tool-call` → 标记该 step 有工具；
  - `step-finish` → 无工具 step 一次性 `onDelta`；有工具 step 文本走 `onAssistant`（narration）；
  - `finish` → `getFullOutput()`。
- 最终正文取**最后一个 step 的 text**，避免 `FullOutput.text` 把中间旁白拼进最终答案；
- 仅最终文本进入 `onDelta`，避免“流式已发旁白 + 最终整段重发”的重复；
- 结果仍写回 SessionStore，tool_calls/tool 结果配对。

限制：文本按 step 聚合后发送，不是 token 级实时；这是为了在不知道后续是否有 tool-call 时不把旁白误当最终答案。

### 1.2 取消

- `AgentRuntimeFacade` 维护 `_runs`（taskId → AbortController）；
- `runChat` 把外部 signal 与内部 controller 合并；
- `abort(taskId)` / `abortAll()` 中止 Mastra `generate/stream`；
- TaskStore 的 cancel hook 同时调用 `abortActiveRun`（legacy）与 `runtime.abort`（Mastra）；
- `close` 先 abortAll，再 `mastra.shutdown → memory.settled → vector.close → storage.close`。

测试：`facade.test.mjs` 的“灰度取消”断言 Runner 收到 aborted signal。

---

## 2. PR4c：原生审批接入聊天

### 2.1 启用

```yaml
agent:
  runtime: { engine: mastra, gray: { users: [...], groups: [...] } }
  mastra:
    approval:
      mode: bridge      # legacy（默认，旧 ConfirmStore 阻塞）| bridge（持久化 suspend/resume）
      timeoutMs: 300000
```

- `mode=legacy`：PR4a 的阻塞模式；`#确认`/`#拒绝` 走 ConfirmStore；
- `mode=bridge`：Adapter 使用 `ApprovalBridge`，Mastra 原生 `requireApproval`/`beforeApproval` suspend。

### 2.2 流程

1. 模型调用写工具 → `beforeApproval` 创建 ApprovalBridge 记录并通知主人；
2. `generate/stream` 返回 `finishReason:'suspended'`；
3. Runner 返回 `stopReason:'waiting_input'` + “需要审批 #10001”回复；
4. `#确认 10001` / Web `/api/confirm/10001/decide` → `runtime.approve()`：
   - CAS 结算 bridge；
   - `agent.approveToolCallGenerate({runId,toolCallId})` 恢复；
   - 返回最终文本，应用层发送；
5. 拒绝 → `declineToolCallGenerate`，工具不执行。

### 2.3 重启恢复

- ApprovalBridge 落 KV，`restore()` 恢复 pending；
- Mastra Agent 以固定 id `yz-chat` 注册到 Mastra storage，snapshot 持久；
- Runner `approve()` 在内存 pending 不存在时，用 `deps.makeAgent()` 重建 legacy 上下文，按 ApprovalBridge 记录中的 `ctx/system/conversationId` 重建 RequestContext，加载同一 storage snapshot 后 `approveToolCallGenerate`；
- 自动化测试覆盖“关闭 Mastra/storage → 新建同库 Mastra → approve → 工具只执行一次”。

### 2.4 命令/Web

- `#确认/#拒绝`：先 `runtime.approve`，未命中再回退 `ConfirmStore`；
- `#待确认`：合并 ConfirmStore + ApprovalBridge；
- `GET /api/confirm`：合并两队列；
- `POST /api/confirm/:id/decide`：先 `runtime.approve`，未命中再 ConfirmStore。

---

## 3. 灰度扩群

- `shouldUseMastra` 支持 `gray.users` / `gray.groups` / `percent`；
- 真实运行验证了 1 个用户（`tester`）与 1 个群（`g1`，fake group event）均命中 Mastra Runner；
- 未配置 gray 时 `engine=mastra` 也不切流量。

---

## 4. 测试

| 指标 | 结果 |
|---|---|
| 测试文件 | **170 通过 / 0 失败 / 12 跳过（182）** |
| 断言 | **7,908** |
| Lint | **0 errors / 50 warnings** |

新增/扩展：

- `chat-runner.test.mjs`：流式 `text-delta → onDelta`、最终内容、持久化；
- `facade.test.mjs`：灰度取消（abort 命中在途 Runner）；
- `chat-runner-native-approval.test.mjs`：批准/拒绝/重启后 resume（13）；
- `approval-mastra.test.mjs`：底层 suspend/approve。

---

## 5. 真机/运行验证

### 5.1 完整 Yunzai 非流式（隔离 YunCat）

日志：`/tmp/opencode/pr4a-full2.log`

```
[trigger] user=tester gid=- mode=at
[runtime] runChat engine=mastra chat=mastra user=tester gray=yes
[runtime] Mastra 灰度回复 model=deepseek-v4.1-flash turns=1 tools=0
[stdin] full2-ok
```

### 5.2 流式（真实 runtime + 真实模型）

`AGENTS_STREAM_TEST=1`，`/tmp/opencode/pr4b-stream.log`：

```
[runtime] runChat engine=mastra chat=mastra user=tester gray=yes
[runtime] Mastra 灰度回复 ...
REPLIES ["思考中…","stream-ok"]
```

最终正文只出现一次，无重复。

### 5.3 灰度群

`/tmp/opencode/pr4b-group.log`：

```
[trigger] user=tester2 gid=g1 mode=at
[runtime] runChat engine=mastra chat=mastra user=tester2 gray=yes
[runtime] Mastra 灰度回复 ...
```

群事件命中 Mastra Runner；回复中的 `[object Object]` 是测试 fake `reply` 未展开 `at` 段，不是产品路径。

### 5.4 原生审批 E2E

`chat-runner-native-approval.test.mjs`：真实 Mastra storage + 脚本化模型，suspend → 批准 → 工具一次；拒绝不执行；重启后 resume 成功。

`mastra.approval.mode=bridge` 真实 runtime 启动（`/tmp/opencode/pr4c-bridge.log`）：

```
[runtime] ApprovalBridge 已启用（持久化审批 / suspend-resume）
[runtime] runChat engine=mastra chat=mastra user=tester gray=yes
[runtime] Mastra 灰度回复 model=deepseek-v4.1-flash turns=1 tools=0
REPLIES ["思考中…","bridge-ok"]
PENDING 0
```

---

## 6. 已知边界

- 流式文本按 step 聚合，不是 token 级；
- `approval.mode` 默认 `legacy`，原生 bridge 需显式开启；灰度期可逐步切换；
- 重启 resume 依赖 `deps.makeAgent` 重建上下文；真实进程重启后由 apps 提供，已在测试中模拟；
- 多模态、Gemini/Azure、自定义 thinking 仍回退 legacy；
- S5 的 72h 群观察尚未执行，不能声称 soak 通过。

---

## 7. 回滚

- `runtime.gray` 清空或 `engine=legacy`；
- `mastra.approval.mode=legacy` 回退 ConfirmStore；
- 在途 Mastra run 由 `runtime.abortAll` / Mastra shutdown 取消；
- 不删除 SessionStore/Mastra 数据。
