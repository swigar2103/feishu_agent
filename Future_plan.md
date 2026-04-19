# Future Plan（飞书办公 Agent 落地路线）

本文档用于汇总当前项目从“本地原型”升级到“真实飞书办公 Agent”的核心建设内容。  
目标是把现有 `Fastify + LangGraph + LLM + Schema` 骨架，逐步补齐为可在飞书内端到端运行的系统。

---

## 0. 当前项目基线（已具备）

当前仓库已经具备以下基础能力：

- 本地 API 入口：`POST /generate-report`、`POST /generate-report-docx`
- 主流程图：`parse -> intent -> planner -> retriever -> analyst -> buildWriterInput -> writer -> reviewer -> format`
- LLM 规划与写作：`src/llm/orchestratorModel.ts`、`src/llm/writerModel.ts`
- Zod 约束：`src/schemas/index.ts`、`src/types/contracts.ts`
- 本地检索与技能匹配：`src/services/retrieval/engine.ts`
- 本地 Web 演示页与 Word 导出：`src/web/*`、`src/services/wordExport.ts`

当前仍是“本地可演示原型”，尚未形成真实飞书闭环。

---

## 1. 模块一：飞书真实入口（Webhook/Bot/Card）

### 1.1 建设目标

实现“用户在飞书中发起需求 -> 系统接收并触发报告生成”：

- 接收飞书事件（消息、卡片回调）
- 验签鉴权
- 消息回复（文本/卡片）
- 将飞书消息映射为 `UserRequest`

### 1.2 基于当前项目的实现路径

当前入口在 `src/api/report.ts`（本地 HTTP）。  
需要新增飞书接入层，不替代现有接口，而是并行增加：

- 新增 `src/api/feishu.ts`
  - `POST /feishu/webhook`（事件接收）
  - `POST /feishu/card-callback`（卡片提交）
- 新增 `src/integrations/feishu/auth.ts`
  - 验签、token 管理
- 新增 `src/integrations/feishu/events.ts`
  - 事件解析（challenge、message、card action）
- 新增 `src/integrations/feishu/messaging.ts`
  - 发送文本、发送卡片、更新卡片

在 `src/app.ts` 中注册 `registerFeishuRoutes(app)`。

### 1.3 最小可用流程（MVP）

1. 飞书用户 @bot 发送需求文本  
2. `/feishu/webhook` 收到事件并解析出 `userId/sessionId/prompt`  
3. 调用 `runReportPipeline`  
4. 将结果摘要回复到飞书（文本）  
5. 回传“查看完整报告链接”（后续由模块四提供）

### 1.4 验收标准

- 不通过本地 UI，也能在飞书触发一次完整报告生成
- 收到并回复真实飞书消息
- 错误日志可定位到具体 `message_id/session_id`

---

## 2. 模块二：真实 Retriever（消息/文档/表格/日历/外部）

### 2.1 建设目标

替换当前 mock 检索，实现真实多源上下文召回：

- `searchMessages`
- `readDoc`
- `readTable`
- `readCalendar`
- `externalSearch`

### 2.2 基于当前项目的实现路径

当前检索入口是 `getContextForReport`（`src/services/retrievalClient.ts`），建议保留为统一入口。  
重点改造 `src/services/retrieval/engine.ts` 与 `feishuAdapter.ts`：

- 抽象接口：`RetrievalProvider`
- 新增 `src/services/retrieval/providers/feishuProvider.ts`
- 新增 `src/services/retrieval/providers/externalProvider.ts`
- `engine.ts` 中并发调用 provider，统一组装 `projectContext`

当前 `FeishuMockAdapter.searchEverything()` 作为 fallback 保留（用于本地离线 demo）。

### 2.3 数据结构增强建议

扩展 `projectContext` 元数据（在 `src/schemas/index.ts`）：

- `title?: string`
- `timestamp?: string`
- `sourceUrl?: string`
- `score?: number`
- `owner?: string`

### 2.4 验收标准

- 至少 2~3 个真实来源返回可用数据
- `TaskPlan.useSources` 引用真实 sourceId
- 任一数据源失败时不阻断整个生成链路（可降级）

---

## 3. 模块三：缺信息自动追问 + 同事协作收集

### 3.1 建设目标

从“提示 openQuestions”升级为“可执行追问闭环”：

- 发现 `missingFields` 后暂停流程
- 自动发飞书卡片追问
- 支持向指定同事收集信息
- 收到补充后自动恢复流程继续生成

### 3.2 基于当前项目的实现路径

当前已有基础：

- `analystNode` 会生成 `followUpQuestions`
- `reviewerNode` 会提示待补充问题

需要增加状态管理与恢复机制：

- 新增 `src/services/followupService.ts`
- 新增 `src/services/taskStore.ts`（状态持久化）
  - 状态：`RUNNING / WAITING_FOR_INPUT / RESUMED / DONE / FAILED`
- 在 graph 中新增条件分支节点（建议在 planner 后判断）
  - 缺信息：进入 wait 节点并结束本轮
  - 信息齐全：继续 writer

### 3.3 图流程建议

建议重构图为：

`parse -> intent -> retriever -> planner -> check_missing -> (wait_for_input | build_writer_input -> writer -> reviewer -> format -> publish)`

说明：当前 `plannerNode` 与 `analystNode` 规划职责重叠，建议合并为“单一真实 planner”。

### 3.4 验收标准

- 缺字段时系统不直接产出最终报告
- 飞书卡片能收集补充信息并写回任务上下文
- 恢复后能生成完整报告，缺失字段减少或清空

---

## 4. 模块四：输出到飞书文档/多维表格/幻灯片

### 4.1 建设目标

把当前 `outputTargets` 从“声明字段”变成“真实发布能力”：

- 发布飞书文档（优先）
- 发布多维表格（其次）
- 发布幻灯片（最后）

### 4.2 基于当前项目的实现路径

当前只有本地 `docx` 导出（`src/services/wordExport.ts`）。  
建议增加发布层：

- 新增 `src/services/publish/publisher.ts`（统一入口）
- 新增 `src/services/publish/feishuDocPublisher.ts`
- 新增 `src/services/publish/bitablePublisher.ts`
- 新增 `src/services/publish/slidesPublisher.ts`

在 graph 中新增 `publishNode`（放在 `formatOutput` 后）。  
在 API 响应中增加：

- `publishedArtifacts: Array<{ type: "feishu_doc" | "bitable" | "slides"; id: string; url: string }>`
- `publishWarnings: string[]`

### 4.3 发布策略（建议顺序）

1. 先做 `feishu_doc`（MVP）
2. 再做 `bitable`（写入 sections/chartSuggestions）
3. 最后做 `slides`（先模板化页面）

### 4.4 验收标准

- 选择 `feishu_doc` 时返回真实可打开链接
- 发布失败不影响结构化报告返回
- 返回结果可追踪发布状态

---

## 5. 模块五：用户修改写回 Memory（学习闭环）

### 5.1 建设目标

实现“用户改过的内容会影响下一次输出风格”：

- 接收用户修改前后内容
- diff 提取风格偏好
- 更新用户记忆
- 下次生成生效

### 5.2 基于当前项目的实现路径

当前 `memories.md` 仅支持读，不支持写。  
建议新增 memory 子系统：

- 新增 `src/api/feedback.ts`
  - `POST /report-feedback`
- 新增 `src/services/memory/memoryStore.ts`
- 新增 `src/services/memory/styleLearner.ts`
- 新增 `src/services/memory/memoryUpdater.ts`

请求体建议：

- `userId`
- `sessionId`
- `originalReport`
- `editedReport`
- `comment`（可选）

学习产物写入：

- `preferredTone`
- `preferredStructure`
- `commonTerms`
- `styleNotes`
- `memoryVersion`
- `updatedAt`

### 5.3 验收标准

- 接口可写入更新后的用户记忆
- 同一用户下一次报告风格出现可观测变化
- 可追踪 memory 版本变化与来源

---

## 6. 关键重构建议（穿透五大模块）

### 6.1 统一 Planner 职责

现状：`plannerNode`（占位）+ `analystNode`（真实规划）职责混淆。  
建议：合并为单一 planner，确保“计划只在一个节点产生”。

### 6.2 引入任务状态实体（Task）

没有任务持久化就无法做追问暂停/恢复。  
建议新增任务表（或 JSON/SQLite 过渡），最少字段：

- `taskId`, `sessionId`, `userId`, `state`, `missingFields`, `context`, `createdAt`, `updatedAt`

### 6.3 Provider 分层

将 mock 与 real provider 解耦，按环境切换：

- `RETRIEVAL_MODE=mock|real|hybrid`
- 开发期保留 mock，生产走 real

---

## 7. 分阶段落地计划（建议）

### 阶段 A：MVP（1~2 周）

- 模块一：飞书入口打通
- 模块四：飞书文档发布
- 模块二：至少 message/doc 两源检索

目标：飞书内“提需求 -> 回文档链接”可演示。

### 阶段 B：V1（2~4 周）

- 模块三：自动追问闭环
- 模块五：memory 写回与风格学习
- 模块二补齐 table/calendar/external

目标：从一次性生成，升级为“可协作、可迭代、可学习”的 Agent。

---

## 8. 工程执行清单（文件级）

优先新增：

- `src/api/feishu.ts`
- `src/api/feedback.ts`
- `src/integrations/feishu/auth.ts`
- `src/integrations/feishu/events.ts`
- `src/integrations/feishu/messaging.ts`
- `src/services/retrieval/providers/feishuProvider.ts`
- `src/services/retrieval/providers/externalProvider.ts`
- `src/services/publish/publisher.ts`
- `src/services/publish/feishuDocPublisher.ts`
- `src/services/followupService.ts`
- `src/services/taskStore.ts`
- `src/services/memory/memoryStore.ts`
- `src/services/memory/styleLearner.ts`
- `src/services/memory/memoryUpdater.ts`

需要改造：

- `src/app.ts`（注册新路由）
- `src/graph/reportGraph.ts`（增加条件分支/发布节点）
- `src/graph/state.ts`（新增 task/publish/followup 状态字段）
- `src/schemas/index.ts`（扩展上下文/反馈/发布契约）
- `src/services/retrieval/engine.ts`（接入 provider）
- `src/api/report.ts`（返回发布结果和状态）

---

## 9. 完成定义（Definition of Done）

当以下条件全部满足，可认为“飞书办公 Agent V1”达标：

- 飞书内可触发生成并回传结果
- 检索来源不低于 3 种，且非 mock
- 缺失信息可自动追问并恢复执行
- 可发布到飞书文档（至少 1 种真实输出）
- 用户修改可写回 memory，且下次生成可观察到风格变化

