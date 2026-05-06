# 项目变更记录

## 2026-05-07

### OAuth callback 最小命中日志（排障用）

- **原因**：
  - 排查“授权后 Cloudflare 502”时，需要先确认请求是否命中本地 callback handler，而不是先改业务逻辑。
- **处理**：
  - `src/api/feishuAuth.ts` 的 `/api/feishu/auth/callback` 入口新增最小日志标记 `[FEISHU CALLBACK HIT]`。
  - 日志字段包含：`url`、`host`、`origin`、`x-forwarded-host`、`hasCode`、`hasState`、`queryKeys`。
- **验证**：
  - `npm run check` 通过；
  - 仅增加诊断日志，不改变 OAuth 分支行为。

### OAuth 自动刷新（refresh_token）接入

- **原因**：
  - 用户已授权但 `user_access_token` 到期后，UAT 链路会直接判定“未授权”，反复发授权卡，体验上表现为“明明授权过又要重新授权”。
- **处理**：
  - 新增 `src/integrations/feishu/userOAuthRefresh.ts`：
    - 统一封装 `ensureUserOAuthReady(userId)`：
      - token 未过期直接复用；
      - token 过期且存在 `refresh_token` 时，调用飞书 `authen/v2/oauth/token` 的 `grant_type=refresh_token` 自动换新；
      - 刷新成功后回写 `user-oauth-tokens.json`；
      - 刷新失败再回退到原“发授权卡”流程。
  - `src/api/feishuWebhookDispatch.ts`：
    - UAT 鉴权前先尝试自动刷新；
    - 仅在刷新后仍无有效 token 或 scope 不覆盖时才发授权卡。
  - `src/services/toolGateway/feishuMcpAdapter.ts`：
    - MCP UAT 请求头构建时引入自动刷新，避免“调用前瞬时过期”导致的无效令牌错误。
  - `src/api/feishuAuth.ts`：
    - `/api/feishu/auth/status` 查询状态时也先尝试自动刷新，并返回 `refreshed` 标记便于排障。
- **验证**：
  - `npm run check` 通过。
- **当前项目结构（本次变更范围）**：
  - 新增：`src/integrations/feishu/userOAuthRefresh.ts`
  - 修改：`src/api/feishuWebhookDispatch.ts`、`src/services/toolGateway/feishuMcpAdapter.ts`、`src/api/feishuAuth.ts`
  - 文档：`history.md`（本文件追加记录）

## 2026-05-06

### 纯 HMRS 硬切（移除旧 pool 依赖）

- **背景**：
  - 生成仍出现旧 `resource-pool` 拼接痕迹，说明主链仍走了兼容壳。
- **处理**：
  - `src/graph/nodes/hmrsSummaryNode.ts`：
    - 去掉 `ResourcePoolManager + screenResources + memPalace` 旧筛选链；
    - 改为直接从 `ToolGateway.searchDocuments`（按 `deriveMcpDocumentSearchQueries`）构建 HMRS seed；
    - 合并 `historyDocs/personalKnowledge/imContacts` 作为内联资源并写入 HMRS；
    - 直接由 HMRS L1 产出候选，彻底不依赖旧 pool 文件。
  - `src/services/agent/plannerAgent.ts`：
    - 移除 `shouldUseHmrs` 分支，Planner 始终读取 HMRS L1/L2 并产出 expansion/budget。
  - `src/services/retrieval/deepRetriever.ts`：
    - 删除 legacy 深读路径（`assets.md` + 旧 screening 候选）；
    - Retriever 始终走 HMRS expansion -> detailRetrieval。
  - `src/services/agent/memoryUpdater.ts`：
    - 移除条件分支，始终执行 HMRS 分层 writeback。
  - `src/services/resourcePool/enricher.ts`：
    - 去除 `ResourcePoolStore` 写回副作用，不再回写 `resource-pool.json`。
  - 物理清理旧数据文件：
    - 删除 `src/data/memPalace.json`
    - 删除 `src/data/resource-pool.json`
- **验证**：
  - `npm run check` 通过。

### HMRS 分层重构迁移（Phase A-E 一次落地）

- **目标**：
  - 在不改 graph 节点顺序的前提下，将 flat resource/memory 主链替换为 HMRS（分层暴露、按需展开、预算控制）。
- **新增 HMRS 模块**（`src/services/hmrs/`）：
  - `model/`：新增 `layerSchemas.ts`、`memoryObjects.ts`，定义 L1/L2/L3 对象与 `sourceRef` 规范。
  - `repo/interfaces.ts` + `repo/file/*`：落地 repo abstraction 与 file-based 存储（catalog/index/relation/writeback）。
  - `query/summaryQueryService.ts`、`expand/expansionPlanner.ts`、`expand/detailRetrievalService.ts`、`budget/recallBudgetService.ts`、`writeback/memoryWritebackService.ts`。
  - `facade/memoryFacade.ts`：统一提供 query / expand / retrieve / writeback 入口。
  - `flags/hmrsFeatureFlags.ts`、`observe/hmrsDiffLogger.ts`：任务类型灰度切流与差异日志观测。
- **图节点兼容替换**（顺序不变）：
  - `resourceScreeningNode` -> 内部委托 `hmrsSummaryNode`；
  - `retrieverAgentNode` -> 内部委托 `hmrsExpansionNode`；
  - `memoryUpdateNode` -> 内部委托 `hmrsMemoryUpdateNode`。
  - 新增薄节点：`src/graph/nodes/hmrsSummaryNode.ts`、`hmrsExpansionNode.ts`、`hmrsMemoryUpdateNode.ts`。
- **Planner / Retriever / Memory Update 改造**：
  - `ExecutionPlan` 扩展 `expansionDecision` 与 `recallBudgetHint`（保持向后兼容为 optional）。
  - `plannerAgent.ts`：接入 HMRS L1/L2 查询并产出展开决策 + 预算 hint；写入 diff log。
  - `deepRetriever.ts`：改为 HMRS 分层展开（L2 -> L3 按需拉取），保留 legacy fallback。
  - `memoryUpdater.ts`：在 HMRS 灰度命中时走分层 writeback，同时保留旧 `MemoryStore` 写回。
- **Feature Flag 与预算硬上限**：
  - `env.ts` 新增：
    - `HMRS_ENABLED`
    - `HMRS_ROLLOUT_TASK_TYPES`
    - `HMRS_DIFF_LOG_ENABLED`
    - `HMRS_RECALL_MAX_ITEMS`
    - `HMRS_RECALL_MAX_CHARS`
  - 默认对 `weekly_report,meeting_summary,templated_doc` 灰度切流。
- **兼容清理（legacy-compat）**：
  - 老的 resource/memory 接口不直接删除，统一作为 HMRS disabled/fallback 路径保留，避免一次性回归。
  - 通过 `hmrsDiffLogger` 记录旧候选与新分层选择差异，支持后续逐步收口。
- **验证**：
  - `npm run check` 通过。

### 修复：IM 报告链路 `candidates[n].summary` 空串导致 Zod 失败

- **问题现象**：
  - webhook full 流程中出现：
    - `String must contain at least 1 character(s)`
    - `path: ["candidates", 4, "summary"]`
  - 触发点在 Resource Screening 合并外部候选后做 `CandidateResourceListSchema.parse`。
- **根因**：
  - MCP `search-doc` 某些返回仅包含 `title/url`，`summary` 为空；
  - 外部候选映射时未做摘要兜底，导致候选列表校验直接失败，整条报告管线提前中断。
- **处理**：
  - `src/services/resourcePool/screening.ts`：
    - `mapDocToResourceSummary` 对 `summary` 增加保底：
      - 优先 `doc.summary` / `doc.content`
      - 否则回退 `文档候选：{title}`。
  - `src/services/toolGateway/feishuMcpAdapter.ts`：
    - `searchDocuments` 映射 `GatewayDocument.summary` 时同样增加保底文案，减少下游空摘要传播。
- **验证**：
  - `npm run check` 通过。

### IM 质量链路补强：编辑入口、会话落盘、结构占位保底

- **问题背景**：
  - IM 侧已返回成果链接，但缺少“进入在线编辑工作台”的明确入口；
  - webhook full 链路未把 IM 对话结果写入 `chat_sessions`，导致工作台无法直接接管同一会话；
  - 低上下文命中时 `chartSuggestions` 可能为空，初稿缺少图表/时间线/甘特等结构骨架。
- **处理**：
  - `src/integrations/feishu/cards.ts`：
    - `buildPipelineResultCard` 新增可选 `workbenchUrl`；
    - 卡片“快速入口”新增“进入在线编辑工作台”链接（未配置时给出提示文案）。
  - `src/config/env.ts` + `env.example`：
    - 新增 `FEISHU_WORKBENCH_BASE_URL`（用于 IM 卡片深链到前端工作台）。
  - `src/services/chat/sessionStore.ts`：
    - 新增 `ensureChatSession(sessionId, userId, ...)`，支持外部链路按固定 `sessionId` 落盘。
  - `src/integrations/feishu/reportImDelivery.ts`：
    - full 流程生成完成后将 user/assistant 消息与 `latestReport` 写入 `chat_sessions`；
    - 自动推导工作台 URL（优先 `FEISHU_WORKBENCH_BASE_URL`，否则尝试从 OAuth 回调地址推导域名）并写入结果卡片；
    - 工作台 URL 透传 `sessionId`、`userId`、`docUrl`。
  - `src/web/chat.js`：
    - 启动时支持从 URL 参数读取 `sessionId` / `userId` 并直接加载对应会话，支持 IM 卡片深链直达。
  - `src/services/agent/writerAgent.ts`：
    - Draft v2 扩展中对 `chartSlots` / `timelineSlots` / `ganttSlots` 增加保底占位；
    - 若模型未返回 `chartSuggestions`，自动由 `chartSlots` 反推一组可发布图表建议，避免“无结构可视提示”。
  - `src/services/output/publisher.ts`：
    - 发布模板增加 `图表槽位（可继续编辑）` 区块，保证初稿有结构化可编辑位。
  - `src/services/resourcePool/mcpSearchQueries.ts`：
    - 增强中文关键词拆分与组合关键词保底（项目报告/周报/会议纪要等），降低整句搜索导致的低命中。
- **验证**：
  - `npm run check` 通过。

### 中书省产品愿景对齐：生成质量与协作编辑改造（本次）

- **目标对齐**：
  - 将系统心智从“聊天回文本”推进到“IM 触发任务 -> 模板化初稿 -> 在线协作编辑 -> 正式文档交付”。
- **生成质量基线（gap-baseline）**：
  - `src/schemas/agentContracts.ts` 新增 `QualityBaselineSchema`；
  - `src/services/reportPipeline.ts` 增加 `computeQualityBaseline()`，输出章节覆盖率、模板结构贴合度、产物就绪度与模板元素命中；
  - `src/types/contracts.ts`、`src/integrations/feishu/reportImDelivery.ts` 接入质量基线回传/摘要展示。
- **workflow/skill 模板接入（skill-ingest）**：
  - `src/services/agent/workflowSkillRegistry.ts` 改为优先解析 `cli-main/skills/lark-workflow-standup-report|meeting-summary/SKILL.md`，失败回退本地默认表；
  - `src/services/agent/larkCliGuidance.ts` 注入 `workflowTemplates`，统一透传模板结构、评审规则、推荐工具、输出目标。
- **Planner/Writer 契约升级（planner-writer-contract）**：
  - `src/prompts/agentPrompts.ts` 与 `src/prompts/reviewPrompts.ts` 显式注入 `templateHints`、`qualityChecks`、`sectionSchema`；
  - `src/schemas/agentContracts.ts` 的 `WorkflowMetaSchema` 新增 `templateHints`、`qualityChecks`；
  - `src/services/agent/skillRouter.ts` 在 workflow 命中时回传上述字段。
- **Draft v2（draft-v2）**：
  - `DraftSchema` 新增 `sectionBlocks`、`timelineSlots`、`ganttSlots`、`chartSlots`；
  - `src/services/agent/writerAgent.ts` 在 repair/fallback 自动补齐 v2 槽位；
  - `src/services/output/publisher.ts` 发布文档时渲染时间线与甘特占位。
- **在线编辑工作台 MVP（editor-mvp）**：
  - 前端：`src/web/chat.html`、`src/web/chat.css`、`src/web/chat.js` 升级为“对话区 + 编辑工作台”双栏；
  - 后端：`src/api/chat.ts` 新增
    - `GET /api/chat/sessions/:sessionId/outline`
    - `PATCH /api/chat/sessions/:sessionId/sections/:sectionIndex`（手动局部改写/追加）
    - `POST /api/chat/sessions/:sessionId/sections/:sectionIndex/rewrite`（AI 局部改写）
  - 对话发送接口返回 `latestReport` 与 `outline` 供前端同步。
- **编辑行为回流（memory-feedback）**：
  - `src/storage/memoryStore.ts` 新增 `editStats` 与 `recordEditSignal()`；
  - `src/api/chat.ts` 在手动编辑和 AI 局部改写后写回编辑信号；
  - `src/services/agent/memoryUpdater.ts` 将结构化版式偏好回写为 `template_preference` 信号。
- **验证**：
  - `npm run check` 通过。

### OAuth pending state 文件防膨胀增强

- **原因**：
  - `oauth-pending-states.json` 在长时间联调下可能持续增长，影响排障与维护。
- **处理**：
  - `src/config/env.ts` 新增 `FEISHU_OAUTH_PENDING_STATE_MAX_ITEMS`（默认 200）。
  - `src/integrations/feishu/userOAuthAuthorizeFlow.ts` 增加条目上限裁剪逻辑：
    - 写入时按 `createdAtMs` 仅保留最新 N 条；
    - 清理过期 state 后再次执行上限裁剪。
  - `env.example` 与 `README.md` 补充该配置和行为说明。
- **验证**：
  - `npm run check` 通过。

### OAuth state 持久化（修复重启/多用户误点导致 state 失效）

- **原因**：
  - 授权回调 state 之前仅存内存，进程重启后会丢失；多次授权卡并存时容易点击旧链接，触发 `state 无效或已过期`。
- **处理**：
  - `src/integrations/feishu/userOAuthAuthorizeFlow.ts`：
    - pending state 改为落盘到可写目录 `oauth-pending-states.json`；
    - 保留 TTL 清理逻辑；
    - 同一 `userId` 只保留最新授权会话，减少旧卡片干扰；
    - 回调消费后从持久化文件移除对应 state。
  - `README.md`：补充 OAuth state 持久化行为说明。
- **验证**：
  - `npm run check` 通过。

### 公网 502 链路修复与可观测性增强

- **现象**：
  - 本地 `http://127.0.0.1:3000/healthz` 正常，但 `https://www.feishu.space/healthz` 间歇性 502。
- **排查结论**：
  - 应用进程与业务路由正常，故障位于“公网域名 -> 本机服务”的转发层（隧道/反代）。
- **处理**：
  - 连通性验收：本地与公网 `healthz`、公网 `config-check` 均恢复 200。
  - `src/api/feishuAuth.ts`：新增 OAuth 回调结构化诊断日志（回调入站、state 命中/失效、token 交换耗时与结果）。
  - `src/api/phase1.ts`：新增 `GET /api/phase1/public-reachability-check`，输出本地与公网可达性检测结果。
  - `README.md`：新增 `feishu.space 502` 排障 SOP（三步定位、修复动作、OAuth state 注意事项）。
- **验证**：
  - `npm run check` 通过；
  - 公网 `https://www.feishu.space/healthz` 连续多次 200。

### 文档搜索：拆词 + 兼容返回结构

- **原因**：整句任务描述直接 `search-doc` 易 **0 条**（飞书侧更像关键词检索）；MCP 若返回 `documents` / `data.files` 等而非 `docs`，原解析会得到空数组。
- **实现**：`deriveMcpDocumentSearchQueries`（`services/resourcePool/mcpSearchQueries.ts`）从提示词生成最多 **6** 条短查询；`screening.fetchExternalCandidates` 与 `retrieval.engine.fetchGatewayContext` **逐条搜索、按文档 id 去重合并**；`extractSearchDocListFromUnknown`（`mcpResponseParse.ts`）统一解析列表字段；解析仍 0 条时 **warn + sample** 便于核对 JSON。
- **search-doc Unauthorized**：见上；`env` 默认 scope 已含 **`search:docs:read`**；可选 **`FEISHU_USER_OAUTH_PROMPT=consent`** 强制重授权（见 README §12.3）。

### 文档搜索调试日志

- **`[document-search-debug] searchDocuments`**（`toolGateway.gateway.ts`）：每次 `searchDocuments` 成功后输出 `query` / `queryLength` / `resultCount` / `userId` / `preferUserScope`，以及最多 **16** 条结果的 `id`、`title`、`url`、`source`（与飞书 MCP 返回一致，便于对照用户云文档）；条数多于 16 时 `truncated: true`。

## 2026-05-05

### IM + UAT：未授权时发卡拦截 + OAuth 后自动续跑

- **行为**：`FEISHU_MCP_IDENTITY=uat` 且 **`hasValidUserOAuth` 为假或已存 token 的 `scopes` 未覆盖 `FEISHU_USER_OAUTH_SCOPES` 全部项**时，webhook **不发** phase1/full 流水线；改为发送互动卡片（`open_url` 打开飞书授权页）。用户同意后，回调落盘 UAT 并 **异步续跑** 同一条 IM（`chatId` / `text` / `messageId` / 当前 `FEISHU_BOT_PIPELINE` 写入 OAuth `state`）。
- **实现**：新增 `userOAuthAuthorizeFlow.ts`（state 与授权 URL）、`imTextPipelineDispatch.ts`（与 webhook 一致的 fire-and-forget 流水线）、`cards.buildUserOAuthRequiredCard`；`feishuAuth.ts` 复用上述 flow；`feishuWebhookDispatch.ts` 合并原 phase1/full 分支为统一调度。
- **仍支持**：`GET /api/feishu/auth/start`（无 IM 续跑上下文时 `replay` 为空，回调仅结束授权页提示）。
- **修复（OAuth 回调 502）**：飞书 `authen/v2/oauth/token` 部分环境下返回根级 `access_token`（非 `data.access_token`），回调已同时兼容两种 JSON 结构，避免误报「换取 token 失败」并返回 502。
- **修复（UAT 发布后 mock.feishu.local）**：MCP `create-doc` 成功但 `update-doc` 返回体未判成功 → 回退 OpenAPI 用 TAT 写正文 → 对用户刚创建的文档报 `1770032 forBidden`。已增强 `interpretMcpUpdateDocResult`（识别 `code:0` / 嵌套 data 等），且在 `FEISHU_MCP_IDENTITY=uat` 且请求带 `userId` 时，`document.create` / `document.update` / `document.comment.add` 不再回退 OpenAPI。**补充**：`update-doc` 仍非标准时增加 `revision_id` / `error_code` 等判定，并以 **fetch-doc 写后读**（短延迟 + `##` / 前缀匹配）判定成功，避免落 `feishu_doc-fallback`。**根因补充**：远程 `update-doc` 要求参数 `docID`（camelCase）与 **`mode`**（如 `overwrite`）；已传 `docID` + `document_id` + `mode` + `markdown`/`content`，并为 JSON 字符串错误体增加 `toolResultAsRecord` 解析。IM 结果卡对 `mock.feishu.local` / fallback 不再渲染可点链接，改为说明文案。

### `env.ts`：固定从包根目录加载 `.env`

- **原因**：`dotenv.config()` 默认读 `process.cwd()` 下的 `.env`；从仓库上级目录或其它路径启动 `npm run dev` 时读不到 `feishu_agent/.env`，导致 `FEISHU_USER_OAUTH_REDIRECT_URI` 等为空，`/api/feishu/auth/start` 报「缺少 FEISHU_USER_OAUTH_REDIRECT_URI」。
- **实现**：`src/config/env.ts` 使用 `import.meta.url` 解析 `feishu_agent/.env` 绝对路径后再 `dotenv.config({ path })`。
- **当前项目结构**：仅改 `src/config/env.ts`；本记录追加至 `history.md`。

### README §12 收尾（P2 + 文档）

- **P2**：新增 `mcpResponseParse.ts` 与 `mcpResponseParse.test.ts`（`npm test`）；发布链路 `publisher.ts` 增加 `[publish-telemetry]`，`reportImDelivery.ts` 增加 `[im-telemetry].card_fallback_triggered`。
- **文档**：README §12.4 步骤编号修正；§12.5 P2 标为已完成。
- **验证**：`npm run check`、`npm test` 通过。

### MCP 客户端接入完善（对齐 README §12）

- **背景**：飞书远程 MCP 工具名以[官方工具列表](https://open.feishu.cn/document/mcp_open_tools/supported-tools)为准；原适配器混用旧版 plural 名称且对 create/update 软成功容忍度过高。
- **实现**：
  - `feishuMcpAdapter.ts`：`tools/call` 统一错误分类（`PERMISSION_DENIED` / `VALIDATION` / `INVALID_RESPONSE`）、`create-doc` 强校验 `id`+`title`+`url`、`update-doc` 解析布尔或 `ok`/`success`、工具名与官方一致（`search-doc`、`fetch-file`、`add-comments`、`search-user`、`get-user`）；支持 `tools/list` 供探针使用。
  - `errors.ts`：新增错误码；`INVALID_RESPONSE` 可回退到其他 adapter。
  - `publisher.ts`：发布后强制 `viewDocument` + 正文长度与标题关键字验收；产物附带 `artifactSource`。
  - `phase1.ts`：新增 `GET /api/phase1/mcp-check`。
  - `reportImDelivery.ts` / `cards.ts`：IM 卡片与文本降级中展示产物来源；日志增加 `artifactSources`。
  - `env.ts` / `env.example` / `README.md`：默认 `FEISHU_MCP_ALLOWED_TOOLS` 与官方一致，`FEISHU_DOC_LARK_CLI_HARD_PREFER` 默认 `false`，新增 `FEISHU_DOC_PUBLISH_VERIFY_MIN_CHARS`。
- **验证**：`npm run check` 通过。
- **当前项目结构**：未改目录层级；变更集中于 `src/services/toolGateway/`、`src/services/output/`、`src/api/phase1.ts`、`src/integrations/feishu/`、`src/config/env.ts`、`src/schemas/agentContracts.ts`、`README.md`、`env.example`。
- **补充（同日）**：本地 `feishu_agent/.env` 中 `FEISHU_MCP_ALLOWED_TOOLS` 已与官方工具名、`env.example` 对齐。
- **补充（IM 回退排查）**：MCP `create-doc` 返回结构多样、`fetch-doc` 用 `document_id` 时正文可能为空；已增强 `feishuMcpAdapter` 字段解析与 URL 二次拉取，并在 `publisher` 验收中对「fetch 空正文」用待发 markdown 兜底，避免误落 `mock.feishu.local` fallback。
- **补充（标题验收）**：`fetch-doc` 正文可能不含报告标题（块结构/片段），验收改为「fetch 与待发 markdown 任一含标题关键字」即通过；`create-doc` 解析失败时打 `sample` 日志便于对齐 MCP 字段。
- **补充（章节 ## 误判）**：终端曾出现 `verify_failed`：待发含 `##` 但 fetch 无字面量 `##`（云文档常见）。`verifyPublishedDocBody` 改为：无 `##` 时若章节标题（去 Markdown 噪声后）出现在 fetch，或 fetch 纯文本长度 ≥ `max(FEISHU_DOC_PUBLISH_VERIFY_MIN_CHARS, 80)`，则 warn + `publish-telemetry` 放行，不再触发 fallback。

### 本地 `.env` 由 `env.example` 与用户配置生成

- **处理**：
  - 依据 `env.example` 全量键位，将用户提供的百炼、飞书、MCP、lark-cli、超时与资源筛选等变量写入 `feishu_agent/.env`（含 `FEISHU_MCP_FETCH_DOC_ID` 联调项）。
  - 未在用户配置中出现的 `env.example` 键保留模板默认值（如 `LARK_CLI_GUIDANCE_REQUIRED`、`FEISHU_RESOURCE_POOL_SOURCE=mock` 等）。
- **说明**：`.env` 已 gitignore，勿将密钥提交到版本库。
- **当前项目结构**：与变更前一致；仅新增本地 `feishu_agent/.env`（不计入 git）。

### 合并冲突修复：docxBlocks 双能力并存

- **原因**：
  - 合并 resource pool 分支后，`src/integrations/feishu/docxBlocks.ts` 出现冲突：
    - 一侧新增 `createTextChildrenBlocks`（文档发布空白修复）；
    - 另一侧新增 `docxBlocksToOutlineAndMarkdown`（资源池文档结构抽取）。
- **处理**：
  - 冲突采用“保留两侧功能”的合并策略，删除冲突标记并确保同文件内两组能力共存。
  - 相关链路保持：
    - 文档发布链：`src/services/toolGateway/feishuOpenApiAdapter.ts` 使用 `createTextChildrenBlocks`；
    - 资源池链：`src/resource_pool/feishu/feishuBackedAdapter.ts` 使用 `docxBlocksToOutlineAndMarkdown`。
- **验证**：
  - `npm run check` 通过。

### MCP 服务端协作指南补充（README）

- **目标**：
  - 给负责 MCP 的同学提供一份可直接执行的接入与联调文档；
  - 明确“服务端就绪后”本仓库需继续完成的系统完善项与验收标准。
- **处理**：
  - `README.md` 新增「12. MCP 服务端接入与完善指南（给后端同学）」章节，覆盖：
    - MCP 必备工具清单；
    - 返回契约建议（create/update/fetch）；
    - `.env` 推荐配置；
    - 联调验收步骤（日志应命中 `adapter=mcp`）；
    - P0/P1/P2 完善改造清单与常见故障判断。
- **当前项目结构（概要）**：
  - 目录结构无新增；本次仅补充文档说明。

### 文档正文空白修复（OpenAPI 首段落写入）

- **原因**：
  - 当前未启用 MCP 时走 OpenAPI；新建 Docx 可能只有 page 块而无 text/heading 块。
  - `feishuOpenApiAdapter.updateDocument` 遇到该情况会返回 `false`，但发布层此前未校验返回值，导致“发布成功但正文为空白”。
- **处理**：
  - `src/integrations/feishu/docxBlocks.ts`：新增 `createTextChildrenBlocks`，在父块下创建文本子块。
  - `src/services/toolGateway/feishuOpenApiAdapter.ts`：
    - 优先替换已有 text/heading 块；
    - 若不存在，自动在 page 块下创建段落并写入正文。
  - `src/services/output/publisher.ts`：强校验 `updateDocument` 返回值，失败直接抛错走受控回退，不再误报成功。
- **验证**：
  - `npm run build` 通过；
  - `ReadLints` 无新增问题。

### IM 结果卡片兼容修复（避免回退整篇文本）

- **原因**：
  - 飞书返回 `code=230099`，提示 `schema V2` 不支持 `action` 标签，导致结果卡片更新失败并降级为文本。
  - 同时日志显示文档已成功创建/更新，但卡片失败误导为“只输出文本”。
- **处理**：
  - `src/integrations/feishu/cards.ts`：移除 `schema 2.0` 卡片中的 `action` 区块，改为 markdown 链接入口（主成果 URL + 会话标识）。
  - `src/integrations/feishu/reportImDelivery.ts`：卡片失败后的文本降级从“整篇正文”改为“成果链接 + 结构化摘要”，避免刷屏。
- **验证**：
  - `npm run build` 通过；
  - `ReadLints` 无新增问题。

### Doc 产物链路提质（MCP 正式发布优先 + Writer 修复链）

- **目标**：
  - `outputTarget=feishu_doc` 时优先返回正式飞书文档产物，而不是 IM 长文本；
  - 提升 Writer 结构化稳定性，减少 `title/summary Required` 导致的低质量兜底；
  - 让 `cli-main/skills/lark-doc` 的规范真正进入 Skill Router / Planner / Writer 约束链。
- **处理**：
  - 质量规则注入：
    - `src/services/agent/larkCliGuidance.ts`：从 `cli-main/skills/lark-doc` 与 `references/lark-doc-fetch.md` 提取并新增 `hardRules/styleHints`；
    - `src/services/agent/skillRouter.ts`：将 `hardRules/styleHints` 合并进 skill 规则，硬约束以显式前缀透传。
  - Prompt 强化：
    - `src/prompts/agentPrompts.ts`：Planner 增加 `larkCliHardRules/larkCliStyleHints` 输入；
    - `src/prompts/reviewPrompts.ts`：Writer 增加非空字段与 section 对齐硬约束提示。
  - Writer 稳态修复：
    - `src/services/agent/writerAgent.ts`：改为 `raw -> safeParse -> repair/normalize -> retry -> fallback` 链路，修复阶段优先补齐 `title/summary/sections`。
  - 发布层产物优先：
    - `src/services/output/publisher.ts`：
      - 去掉固定模板噪音区块，仅保留草稿真实内容；
      - IM 通知改为“文档链接 + 简短摘要/要点”；
      - 文档创建后增加 `id/title/url` 最小验收，不通过即受控回退；
      - 产物状态支持 `published/fallback/mock_published`。
  - 网关策略固化：
    - `src/services/toolGateway/gateway.ts`：对 `document.create/update` 强制 MCP 优先，且回退适配器会显式日志标注。
  - 契约更新：
    - `src/schemas/agentContracts.ts`：补充 `LarkCliGuidance.hardRules/styleHints` 与 `publishedArtifacts.status` 新枚举。
- **验证**：
  - `npm run build` 通过；
  - 针对本次变更文件执行 `ReadLints`，无新增 lint 错误。
- **当前项目结构（概要）**：
  - 目录结构未新增；核心改动集中在 `src/services/agent/`、`src/services/output/`、`src/services/toolGateway/`、`src/prompts/`、`src/schemas/`。

### lark-cli 分层策略 + user-aware 发布/检索（模板层强制）

- **目标**：
  - 模板/结构化生成层强制使用 lark-cli guidance，确保质量提升来源不可被静默降级；
  - 执行层按能力分流：发布类优先 lark-cli，检索类可回退；
  - 用户授权后发布与检索优先走 user-aware 路径，降低 `FEISHU_TARGET_FOLDER_TOKEN` 强依赖。
- **处理**：
  - 模板层强制：
    - `src/config/env.ts`：新增 `LARK_CLI_GUIDANCE_REQUIRED`；
    - `src/services/agent/skillRouter.ts`：当 guidance 必需但未加载时直接报错；
    - `src/graph/nodes/skillRouterNode.ts`：debugTrace 增加 guidance 开关状态。
  - 执行层分流与降噪：
    - `src/config/env.ts`：新增 `FEISHU_DOC_LARK_CLI_HARD_PREFER`；
    - `src/services/toolGateway/larkCliExecutor.ts`：新增“不可执行缓存”，避免重复 spawn 告警刷屏；
    - `src/services/toolGateway/gateway.ts`：文档发布类能力支持 hard-prefer 策略，检索类保留 fallback。
  - user-aware 发布/检索：
    - `src/services/toolGateway/types.ts`：新增 `GatewayRequestContext`，文档/用户能力透传 context；
    - `src/services/toolGateway/larkCliAdapter.ts`：支持按 context 切换 user scope，发布可自动落 `my_library`；
    - `src/services/resourcePool/screening.ts`、`src/services/retrieval/deepRetriever.ts`：按用户授权状态优先 user-aware 检索；
    - `src/services/output/publisher.ts`、`src/services/agent/outputGenerator.ts`：发布透传 `userId/preferUserScope`。
  - 文档与配置：
    - `env.example`、`README.md` 同步分层策略、hard-prefer 与 user-aware 说明。
- **验证**：`npm run check` 通过。

### 双层身份（bot 主导 + 用户授权增强）与 IM 成果化交付

- **目标**：
  - 主流程改为“服务端统一运行 + 应用身份主导”，不再依赖每台开发机都执行 `lark-cli auth login`。
  - 飞书 IM 交付改为“成果链接主导 + 结构化摘要 + 状态/操作卡片”。
- **处理**：
  - 身份与授权：
    - `src/config/env.ts`：新增 `FEISHU_IDENTITY_MODE`、`FEISHU_USER_OAUTH_REDIRECT_URI`、`FEISHU_USER_OAUTH_SCOPES`、`FEISHU_USER_OAUTH_AUTHORIZE_URL`。
    - `src/api/feishuAuth.ts`：新增用户授权增强通道（`/api/feishu/auth/start`、`/api/feishu/auth/callback`、`/api/feishu/auth/status`）。
    - `src/storage/userOAuthStore.ts`：新增用户 OAuth token 本地持久化与有效性查询。
    - `src/app.ts`：注册 `feishuAuth` 路由。
  - IM 交付：
    - `src/integrations/feishu/reportImDelivery.ts`：
      - 默认输出目标升级为 `feishu_doc + slides`；
      - 先发“处理中卡片”，完成后更新“成果卡片”；
      - 卡片失败自动降级文本摘要；
      - 引入 `finalDeliverable.publishedArtifacts` 作为链接主数据源。
    - `src/integrations/feishu/cards.ts`：新增 `buildPipelineProgressCard`、`buildPipelineResultCard`。
    - `src/api/phase1.ts`：卡片回调新增 `continue_generate` / `need_more_info` 动作处理。
    - `src/api/feishuWebhookDispatch.ts`：补充 full 链路接单日志（identityMode、chatId、userId）。
  - 模板化输出：
    - `src/services/output/publisher.ts`：
      - 文档发布从纯文本升级为模板化 Markdown（摘要区、章节区、图表规划区、风险待办区）；
      - `chartSuggestions` 同步映射到文档表格和 slides 大纲。
  - 文档与配置：
    - `env.example`：默认恢复 `LARK_CLI_DEFAULT_AS=bot`，补齐双层身份配置项。
    - `README.md`：更新 IM 输出行为、新增授权增强接口说明与 IM 回归检查清单。
- **验证**：`npm run check` 通过。

### lark-cli 文档创建改为“个人目录优先 + 可回退”

- **原因**：`LARK_CLI_ENABLED=auto` 且命中文档创建时，若未配置 `LARK_CLI_FOLDER_TOKEN/FEISHU_TARGET_FOLDER_TOKEN` 会抛 `VALIDATION` 并中断链路，不符合“用户身份直连个人目录”的预期。
- **处理**：
  - `src/services/toolGateway/larkCliAdapter.ts`：
    - `createDocument` 改为使用 `docs +create --api-version v2`；
    - 有目录 token 时使用 `--parent-token`；
    - 无 token 且 `LARK_CLI_DEFAULT_AS=user` 时自动使用 `--parent-position my_library`；
    - 无 token 且 `--as bot` 时抛 `NOT_CONFIGURED`（可回退），不再阻断后续 adapter。
  - `env.example`：
    - 默认 `LARK_CLI_DEFAULT_AS` 调整为 `user`（本地联调更符合个人资源访问）；
    - 增加“无 token 自动落个人知识库”的注释说明。
- **验证建议**：`LARK_CLI_DEFAULT_AS=user` + 已执行 `lark-cli auth login` 后，再触发 IM/API 生成；若 CLI 不可用，将自动回退到 OpenAPI。

### 当前项目结构（概要）

- 本次未新增目录结构，核心代码仍集中在 `src/services/toolGateway/`、`src/config/`、`src/integrations/feishu/`。

## 2026-05-04

### workflow registry / capability probe / 阈值化补检索

- **目标**：补齐“官方 workflow skill 可追踪命中 + Adapter 能力探测 + Screening 阈值化 + Slides 双层交付”，并保持 reviewer callback 回环不退化。
- **处理**：
  - `src/services/agent/workflowSkillRegistry.ts`：新增官方 workflow 注册表，包含 `outputTargets`、`reviewRules`、`workflowSourceId`、`toolHints`、`priority`。
  - `src/services/agent/skillRouter.ts`：先匹配官方 workflow，再回退自定义 skill；命中时写入 `workflowMeta`。
  - `src/schemas/agentContracts.ts`：扩展 `SkillMatch`，新增 `workflowMeta` 与 `source=lark_cli_workflow`。
  - `src/prompts/agentPrompts.ts`、`src/prompts/reviewPrompts.ts`：Planner/Writer/Compliance 注入 `workflowMeta` 与 `reviewRules`。
  - `src/services/toolGateway/larkCliAdapter.ts`：新增 capability probe（`docsSearch/contactSearch/slidesPublish`）并缓存；扩展 `searchDocuments/searchUsers/getUserInfo/createSlides`。
  - `src/services/toolGateway/types.ts`、`gateway.ts`、`feishuMcpAdapter.ts`、`feishuOpenApiAdapter.ts`：补齐 Slides 统一接口与策略回退。
  - `src/services/resourcePool/screening.ts`：新增 `minCandidateCount/minCandidateScore` 触发阈值，并把外部来源打到 tags。
  - `src/services/retrieval/deepRetriever.ts`：限制深读边界，仅允许 screening 入选候选资源。
  - `src/services/output/publisher.ts`：Slides 改为双层交付（`outline_only` / `artifact_best_effort`）。
  - `src/config/env.ts`、`env.example`：新增 CLI 命令模板、Slides 层级、筛选阈值配置。
  - `README.md`：补充 workflow 与自定义 skill 的优先级/叠加规则、CLI 能力矩阵与阈值说明。
- **验证**：`npm run check` 通过；保持 API/chat/IM 共享同一 pipeline 与 callback 闭环。

### lark-cli 中层接入（全入口增强，不替代）

- **目标**：接入 `cli-main` 提供的 docs 命令契约与模板规范，提升报告产出与发布标准化；保留现有 LangGraph 主链路与 Gateway 回退机制。
- **处理**：
  - `src/services/agent/larkCliGuidance.ts`：新增 `lark-cli` 规范提供器，提取 `cli-main/tests/cli_e2e/docs` 的命令约定与质量检查提示。
  - `src/schemas/agentContracts.ts`：`SkillMatch` 新增可选 `larkCliGuidance` 契约。
  - `src/services/agent/skillRouter.ts`：路由命中后合并 `lark-cli` 规范到 `styleRules`，并透传 `larkCliGuidance`。
  - `src/prompts/reviewPrompts.ts`：Writer Prompt 注入 `larkCliGuidance`，作为可开关写作约束。
  - `src/services/toolGateway/larkCliAdapter.ts`：新增 CLI 适配层，封装 `docs +create/+update/+fetch` 与 stdout JSON 解析。
  - `src/services/toolGateway/gateway.ts`：文档能力新增策略路由（`lark_cli_first` 时优先 CLI，失败回退 MCP/OpenAPI）。
  - `src/services/output/publisher.ts`：抽象文档发布函数，支持按策略执行发布后 fetch 复核。
  - `src/config/env.ts` / `env.example`：新增 `LARK_CLI_*` 与 `FEISHU_DOC_PUBLISH_STRATEGY` 配置项。
  - `README.md`：补充 lark-cli 增强策略、配置说明与接入边界。
- **验证**：执行 `npm run check`，通过后确认 API/chat/飞书IM 均复用同一 `runReportPipeline`，因此自动共享规范注入与发布策略。

### 前端页面彻底替换为新问答页（chat）

- **目标**：将旧静态页入口完全切换到新上传的问答式前端，避免旧资源路径残留导致页面不一致。
- **处理**：
  - `src/app.ts`：根路由 `/` 固定返回 `chat.html`；新增 `/index.html -> /` 重定向。
  - `src/app.ts`：保留 `/chat.css`、`/chat.js` 静态资源路由，并新增旧路径兼容：
    - `/ui.css -> /chat.css`
    - `/ui.js -> /chat.js`
  - 删除旧样式文件：`src/web/styles.css`（不再使用）。
- **结果**：访问 `/`、`/index.html`、以及历史缓存中可能请求的 `/ui.css`、`/ui.js` 时，都会落到新问答页面资源。

### 类型检查附带修复（非前端替换主线）

- `src/integrations/feishu/reportImDelivery.ts`：补齐 `UserRequest.mentionedResourceIds`，解决 `npm run check` 的 TS 报错（字段缺失）。

### Git 合并冲突修复（env.ts / app.ts）

- **原因**：分支合并留下 `<<<<<<<` 标记；`env` 需在「飞书 HTTP 超时」与「机器人链路 / 可写目录 / URL 校验 token」间同时保留；`app` 需在「先 webhook」与「chat 路由」间合并，且避免在 `buildApp` 与 `start` 中对 report/phase1 **重复注册**。
- **处理**：
  - `src/config/env.ts`：合并 `FEISHU_HTTP_TIMEOUT_MS` 与 `FEISHU_BOT_PIPELINE`、`FEISHU_WRITABLE_DATA_DIR`、`FEISHU_VERIFICATION_TOKEN`。
  - `src/app.ts`：`buildApp` 内顺序为 `registerFeishuWebhookRoutes` → `registerChatRoutes`；移除对 `report`/`phase1` 的顶层静态 import；report/phase1 在 **`listen` 之前**于 `buildApp` 内动态 `import` 注册（见下条：Fastify 限制）。
  - `env.example`：补充上述机器人/目录/token 示例项。

### Fastify：`listen` 后不可再注册路由

- **现象**：`registerReportRoutes` / `registerPhase1Routes` 在 `app.listen()` 之后执行时报 `Fastify instance is already listening. Cannot add route!`，报告与 Phase1 HTTP 接口实际未挂载，仅 webhook/chat/静态页可用。
- **处理**：将上述注册移回 `buildApp()`，保证在 `listen()` 之前完成；仍用动态 `import()`，避免在 `app.ts` 顶层静态拉入 LangGraph。

### HEAD /api/feishu/webhook

- **原因**：Vercel 日志出现 `HEAD /api/feishu/webhook` → 404；飞书或前置探测先 HEAD，无路由则影响保存/校验。
- **处理**：对 `/api/feishu/webhook` 增加 **HEAD**，返回 **204**。

- **原因**：事件 2.0 下 `url_verification` 多在 `header.event_type`，`challenge` 在 `event` 内且无 `event.type`；旧逻辑未识别，误回 `{ message: "ok" }`。
- **处理**：扩展 `takeUrlVerificationChallenge`；可选环境变量 `FEISHU_VERIFICATION_TOKEN` 与后台一致时校验 token。

### 飞书 URL 校验 3s 超时（Vercel 冷启动）

- **原因**：`registerReportRoutes` / `phase1` 顶层静态 `import` 会拉入整条 LangGraph，`/api/feishu/webhook` 首包在未加载完模块前无法在 3s 内返回 `challenge`。
- **处理**：`src/api/report.ts` 与 `src/api/phase1.ts` 对 `runReportPipeline`、`runPhase1Mvp`、`handleBotMessageText`、`runFullPipelineAndNotifyChat` 等改为 **路由内动态 `import()`**，使 URL 校验路径不触发 LangGraph 装载。

### Vercel 只读文件系统：可写数据目录

- **原因**：Serverless 上 `/var/task` 只读，写 `src/data/resource-pool.json` 报 `EROFS`。
- **处理**：
  - 新增 `src/storage/writableDataDir.ts`：`VERCEL=1` 时用 `/tmp/feishu-agent-data`，否则 `src/data`；可用 `FEISHU_WRITABLE_DATA_DIR` 覆盖。
  - `memoryStore.ts`、`resourcePoolStore.ts` 改为使用该目录下的 `runtime-memories.json`、`resource-pool.json`。
  - `env.ts` 增加可选 `FEISHU_WRITABLE_DATA_DIR`。

### 飞书机器人 Webhook：默认走 LangGraph 全链路

- **原因**：会话内发需求应对齐「Intent→Skill→…→Writer→Review」主链路，而非仅 Phase1 云文档模板。
- **处理**：
  - `src/config/env.ts`：增加 `FEISHU_BOT_PIPELINE`，默认 `full`；`phase1` 时仍为「复制模板 + 锚点填文 + 卡片回链」。
  - `src/integrations/feishu/webhookMessageParse.ts`：解析明文 IM 文本事件（`sender_type !== app`、`message_id`、`open_id` 等），构造稳定 `UserRequest.sessionId`。
  - `src/integrations/feishu/reportImDelivery.ts`：`feishuImEventToUserRequest` → `runReportPipeline`，将报告格式化为会话文本并分片发送（单条约 3500 字以内）。
  - `src/api/phase1.ts`：`POST /api/feishu/webhook` 在校验通过后 **立即 200**，全链路/Phase1 在 **后台异步** 执行并发 IM（避免飞书回调超时）；并兼容飞书 **URL 校验** 时 `challenge` 在顶层或 `event` 内嵌套。
- **配置**：需有效 `BAILIAN_*`；全链路仅 IM 回投递时不强制 `FEISHU_TEMPLATE_*`，Phase1 仍需模板与目标文件夹。

### 网页应用远程调试脚本

- **原因**：网页应用在飞书桌面端「内新标签页」打开，需引入官方远程调试脚本便于联调。
- **处理**：在 `src/web/index.html` 的 `</body>` 前增加飞书 CDN 的 `remote-debug-0.0.1-alpha.6.js`（在 `/ui.js` 之后加载）。

### 当前项目结构（概要）

```
feishu_agent/
├── SKILLS/
├── cli-main/               # lark-cli docs E2E 契约样例（create/fetch/update）
├── docs/
├── src/
│   ├── api/
│   ├── config/
│   ├── graph/
│   ├── integrations/feishu/
│   ├── llm/
│   ├── phase1/
│   ├── prompts/
│   ├── services/
│   │   ├── agent/larkCliGuidance.ts
│   │   ├── output/publisher.ts
│   │   └── toolGateway/larkCliAdapter.ts
│   ├── shared/
│   ├── storage/
│   ├── types/
│   ├── web/                # 静态前端（index.html、ui.js、ui.css）
│   ├── app.ts
│   └── skills/
├── env.example
├── history.md
├── langgraph.json
├── package.json
└── tsconfig.json
```

## 2026-05-03

### 本次更改

- **原因**：`npm run dev` 启动时在 `src/config/env.ts` 的 Zod 校验阶段崩溃，`BAILIAN_API_KEY`、`BAILIAN_BASE_URL`、`BAILIAN_MODEL_ORCHESTRATOR`、`BAILIAN_MODEL_WRITER` 未设置（未复制 `.env` 或未填变量）时报 `ZodError`。
- **处理**：
  - `env.ts`：百炼相关变量增加与 `env.example` 一致的默认值；`BAILIAN_API_KEY` 默认空字符串，允许进程先启动。
  - `src/llm/client.ts`：在真正调用百炼接口前检查 `BAILIAN_API_KEY`，若为空则抛出明确错误，提示复制 `env.example` 为 `.env` 并填写 Key。

### 使用前注意

本地若要调用 LLM，仍需在项目根目录创建 `.env`（可复制 `env.example`），并填写有效的 `BAILIAN_API_KEY`。

### 当前项目结构（概要）

```
feishu_agent/
├── SKILLS/                 # 技能描述（业务 skill）
├── docs/
├── src/
│   ├── api/                # HTTP 路由（phase1、report 等）
│   ├── config/             # env.ts 环境校验
│   ├── graph/              # LangGraph 节点与编排
│   ├── integrations/feishu/
│   ├── llm/                # 百炼 client / model 封装
│   ├── phase1/
│   ├── prompts/
│   ├── services/           # agent、检索、tool gateway、流水线等
│   ├── shared/
│   ├── storage/
│   ├── types/
│   ├── web/                # 静态前端
│   ├── app.ts              # 入口
│   └── skills/
├── env.example
├── history.md
├── langgraph.json
├── package.json
└── tsconfig.json
```

---

**日期**：2026-05-05（资源层 clientB 并入）

## 本次更改摘要

实现 **文档资源三段式筛选**（文件夹路径 → 文件名/标题 → 摘要与标签），并与真飞书资源池的 **递归子文件夹枚举** 对齐，使第一段能用目录语义收窄候选。

### 行为说明

1. **数据结构**：`DocumentSummary` 新增 `folderPathSegments`（自资源池根文件夹向下的文件夹名序列，不含文档标题）。本地 mock 可为缺省或手写演示路径。
2. **飞书资源池（real）**：用 DFS 枚举 `folder` 子节点下的 docx（及指向 docx 的快捷方式），写入每条文档的 `folderPathSegments`；同一 doc token 去重；深度上限由环境变量控制。
3. **筛选（B2）**：对文档计算三段得分并与任务关键词匹配；文件夹维同时支持「路径包含信号」与「路径段被某信号包含」（避免短文件夹名在长 prompt 下永远得 0 分）；任一阶段在当前池中「存在命中」则在该维度上收紧集合，否则保留上一阶段全集。综合分 `folder×1 + title×1.2 + (summary+tags)×1.5` 用于排序与 `coarseScore`。`trace.threeStageDocs` 记录各阶段剩余条数。
4. **LLM 兜底**：文档池 JSON 增加 `folderPath` 字段便于语义挑选。

### 涉及文件

- `src/resource_pool/types.ts` — `folderPathSegments`
- `src/integrations/feishu/listFolder.ts` — `collectDocxEntriesUnderFolder`
- `src/resource_pool/feishuHybridPool.ts` — 使用递归枚举
- `src/resource_pool/screening.ts` — 三段漏斗与 trace
- `src/resource_pool/candidate_types.ts` — `trace.threeStageDocs`
- `src/resource_pool/manager.ts` — 查询文本含路径
- `src/config/env.ts`、`env.example` — `FEISHU_RESOURCE_MAX_FOLDER_DEPTH`
- `src/resource_pool/mock/documents.json` — 示例路径
- `src/services/retrieval/engine.ts`、`src/graph/nodes/retrieverNode.ts` — **将 B2/B3 资源池调试行写入 `styleHints`，并镜像到接口响应 `debugTrace`**（便于验收三段式筛选）
- `src/prompts/templateIntent.ts`、`plannerPrompt.ts`、`writerPrompt.ts` — **「以池内文档为模板」时的章节骨架与 Writer 约束**
- `src/services/writerContextSlim.ts`、`src/graph/nodes/buildWriterInput.ts`、`src/services/wordExport.ts` — **Writer 侧瘦身模板正文 / Word 按行解析 Markdown 标题**

### 如何验收「按任务选文件夹模板」


1. `.env`：`FEISHU_RESOURCE_POOL_SOURCE=real`，配置 `FEISHU_RESOURCE_FOLDER_TOKEN`（根文件夹）、凭证与 `FEISHU_RESOURCE_MAX_DOCX`（建议 ≥ 两目录下文档总数）。
2. 在云盘根下放置 `财务报告`、`工作报告` 两个子文件夹，各放至少一篇 **docx**；文件名可与任务相关以便观察第二段筛选。
3. 调用 `POST /generate-report`，在 **`prompt`（或 Planner 会后写入 `taskPlan` 的字段）里显式带上与文件夹名一致或可拆分为关键词的短语**，例如任务含「财务报告」则第一段路径更容易命中 `财务报告` 文件夹。
4. 查看响应里的 **`debugTrace`**（或与 `debugTrace` 一并返回的结构）：找到  
   - `B2_THREE_STAGE(...)`：`afterFolderPath` 应为第一段漏斗后的文档数（命中文件夹语义后会小于等于池内文档总数）。  
   - `B2_SELECTED_DOCS:`：每条含 `path=财务报告` 或 `path=工作报告`（多级时为 `一级/二级`），对照任务关键词判断是否进了预期目录。  
   - `RESOURCE_POOL(...pool_docs=N)`：确认枚举到的文档数量是否符合预期。

### 「学习模板」定义与实现补充（结构 + 文风）

对用户的「学习模板」对齐为两方面：
1. **Word/文档结构**：飞书 docx 块解析为 **带 `#` / `##` 层级的 Markdown**，并单独输出「模板骨架」目录树供 Planner 生成 `targetSections`、Writer 对齐 `sections`。
2. **文字风格**：从正文去掉标题行后截取 **文风摘录**，显式注入 `projectContext`，与 Planner/Writer 提示中的「文风摘录」一节对应。
3. **防照搬**：`analyst_node` 仍使用**完整** pool_doc 抽章节；`build_writer_input` 起对 Writer **瘦身** pool_doc（仅骨架 + `#` 标题行预览 + 短文风摘录），避免模型复述模板原文；Word 导出按行解析 `#` 标题为内置标题样式。

涉及：`src/integrations/feishu/docxBlocks.ts`、`src/resource_pool/context_bridge.ts`、`src/resource_pool/hydrator.ts`、`src/resource_pool/context_pack.ts`、`src/resource_pool/templateStyleExcerpt.ts`、`src/services/writerContextSlim.ts`、`src/graph/nodes/buildWriterInput.ts`、`src/services/wordExport.ts`、`plannerPrompt.ts`、`writerPrompt.ts`。

### 文件夹阶段「名字很相关却不收窄」的说明（已修复）

- **原因**：第一段只用「路径是否**包含**某个信号词」。云盘路径往往很短（例如 `财务报告`），信号却常是整句 `prompt`/plan 拆出的**长串**；长串不会是四字路径的子串，结果全体文档 `folderScore` 仍为 0，看起来就像「明明高度相关却没收窄」。  
- **修复**：在 `screening.ts` 增加 **`scoreFolderPathAgainstSignals`**：除原有规则外，若**某一文件夹名（路径段）被任一信号串包含**（例如长句子里含有「财务报告」），也算命中路径维，漏斗第一段即可剔掉另一文件夹下的文档。

### 「以文档为模板」但生成结构/文风不像模板（持续强化）

- **原因（结构）**：原先把飞书块拼成**无 `#` 标题的纯段落**，Planner/Writer 看不到 Word 式大纲层级。  
- **原因（文风）**：正文淹没在整块 JSON 里，没有单独的「文风」信号，模型更容易跟 skill 示例跑。  
- **修复**：`docxBlocks` 导出 **Markdown 标题层级**；`projectContext` 中 pool_doc 拆成 **【模板骨架】【模板正文参考】【文风摘录】** 三节；Orchestrator/Writer 提示与此对齐。详见上文「学习模板」一节。

---

## 当前项目结构（与资源层相关节选）

```
feishu_agent/
├── env.example
├── history.md
├── src/
│   ├── app.ts
│   ├── api/
│   ├── config/
│   │   └── env.ts
│   ├── integrations/feishu/
│   │   ├── listFolder.ts
│   │   └── ...
│   ├── resource_pool/
│   │   ├── candidate_types.ts
│   │   ├── feishuHybridPool.ts
│   │   ├── manager.ts
│   │   ├── mock/
│   │   ├── screening.ts
│   │   ├── types.ts
│   │   └── ...
│   ├── services/
│   │   └── retrieval/
│   │       └── engine.ts
│   └── ...
├── docs/
└── ...
```

---

## 2026-05-05 补充：Writer 输出校验（修复 `sections[n].content` 空串）

- **现象**：模型偶发返回空字符串 `sections[i].content`，Zod `min(1)` 触发 `too_small`，接口返回「请求参数或流程输出校验失败」。
- **处理**：`WriterOutputSchema`（`src/schemas/index.ts`）对 `title`、`summary`、`sections[].heading`、`sections[].content`、`chartSuggestions` 各字段在 **`trim()` 后若为空则填入中文占位文案**，避免解析失败；`openQuestions` 去掉空串。
- **实现**：统一使用 `.transform(...)`，去掉冗余 `.pipe(z.union(...))`，`npm run check` 已通过。

---

## 2026-05-05 补充：周报可读性、占位清理与 Word 段间距

- **`sanitizeWriterOutputReport`**（`src/services/writerOutputCleanup.ts`）：在 **`format_output`** 解析通过后，把 schema 兜底句「本节暂无内容…」改写为中性说明；剔除明显系统口吻的 `openQuestions`（若 Writer 仍产出）。
- **`writerPrompt.ts`**：增加「质量与版式」约束（禁止空小节、跨节去重、本周/下周语义）；对周报 skill / `reportType` 含「周报」时追加「周报专规」。
- **`plannerNode.ts`**：`taskIntent === "weekly_report"` 时 preliminary **`reportType` 设为「周报」**（原先只匹配「周报」子串，误落成「分析报告」）。
- **`analystNode.ts`**：`missingFields` 生成的追问改为 **`待补充信息：{field}`**，去掉「可通过 IM 联系人收集」模板句（避免混入成品追问列表）。
- **`wordExport.ts`**：导出时为标题与正文设置 **`spacing`（twips）**，列表项统一带段后距；入口处对传入 `report` 再跑一次 **`sanitizeWriterOutputReport`**，独立导出也可去掉技术占位。

---

## 2026-05-05 补充：模板蒸馏阶段 A / B / C（已实现）

### A — 结构化画像（入库即用）

- **`src/schemas/templateProfile.ts`**：`TemplateProfile`、`TemplateDistillation`、`wordExportHints`。
- **`src/llm/templateDistiller.ts`**：对每个入选资源池文档调用 Orchestrator 模型蒸馏 JSON；失败则用标题大纲 **启发式** 画像。
- **`RetrievalContext.templateDistillation`**：仅在存在文档画像时挂载；**`pool_template_profile:{resourceId}`** 追加到 `projectContext`。
- **Planner / Writer**：`useStrictTemplatePipeline()`；存在画像时 **`targetSections` 必须与 `sectionOrder` 一致**；**`useSources` 含 pool_doc + pool_template_profile**。

### B — Word 导出映射 + dotx 占位

- **`wordExportHints.sectionHeadingLevels`**：小节标题子串 → Word 内置标题层级。
- **`numberedListForSectionsIncluding`**：对该小节正文按行生成 **`1. 2. …`** 程序化编号段落。
- **`/generate-report-docx`**：`pickPrimaryTemplateProfile` 传入导出。
- **`docs/templates/README.md`**：说明未来 **dotx + OOXML/docxtemplater** 合并路径（当前检测到文件仅日志提示）。

### C — 文风

- 蒸馏 JSON 含 **`styleRules`、`forbiddenPatterns`、`anonymizedStyleSample`**（由模型归纳，启发式画像带缩短 `styleExcerpt`）。

### 其它

- **`weekly_report` intent**：`pickBestSkillDoc` 优先选含 **周报** 的 skill（如 `SKILLS/general-weekly.skill.md`），减轻财务 analyst 污染周报。
- **`getContextForReport(userRequest, taskPlan, { taskIntent })`**：`retriever_node` 传入 intent。

主要新增/修改路径：`templateProfile.ts`、`templateDistiller.ts`、`engine.ts`、`context_bridge.ts`、`schemas/index.ts`、`retrievalClient.ts`、`retrieverNode.ts`、`reportPipeline.ts`、`contracts.ts`、`api/report.ts`、`wordExport.ts`、`plannerPrompt.ts`、`writerPrompt.ts`、`templateIntent.ts`、`docs/templates/README.md`。

## 2026-05-05 合并说明

- **Git**：解决 `main` 与 `clientB` 在 `env.ts`、`env.example`、`contracts.ts`、`report.ts`、`retrieval/engine.ts`、`history.md` 等处的合并冲突。
- **检索**：`RetrievalEngine.getContextForReport` 同时保留 **资源池 B2/B3 + 模板蒸馏** 与 **Tool Gateway 补检索**（`fetchGatewayContext`），技能匹配维持 **reference → anchor** 双目录并支持 `taskIntent`（如周报优先）。
