# 项目变更记录

## 2026-05-08

### 分支合并：HEAD 与 clientB（冲突清除）

合并 `env.example`、`src/config/env.ts`：**HMRS** 与 **REPORT_PIPELINE_DEMO_\*** 环境项并存；`src/api/report.ts`：演示短路 + 沿用 dotx/template 匹配的完整 Word 导出；`src/api/phase1.ts`：卡片回调保留 `mark_done` 等交互，challenge 沿用多形态解析；撤回误放在 `/api/feishu/card-callback` 的 IM 演示发链（用户 IM 由 `imTextPipelineDispatch` 处理）。

### README：§9.1 增补 demo-status 备用路径与 404 说明

**修改**：`GET /api/feishu/webhook/demo-status` 与 `/api/feishu/demo-status` 共用同一响应；README §9.1 写明 Fastify 404 表示线上需重新构建/部署。

### README：§9.1 事件订阅链路与自检说明

**修改**：在 `README.md`「§9 飞书后台配置核对清单」下新增 **§9.1**，说明开放平台请求地址与实际进程的关系、`trycloudflare` 更换子域时需同步改订阅、以及如何用 `GET /api/feishu/demo-status` 做同源自检。

### 飞书 IM：`imDemoConfig` 短路仅发演示文档卡片（内置 jcney… 稿件）

**目标**：IM 文本到达后**不执行** Phase1 / LangGraph，只回一张「演示文档」卡片并可点击跳到固定云文档；避免因线上漏配 `.env` 仍跑出 MCP 产物链接。

**实现**：
- `src/integrations/feishu/imDemoConfig.ts`：`FEISHU_IM_PIPELINE_BYPASS_DEMO` 默认 `true`（**正式上线务必改为 `false`**）；`FEISHU_IM_BUILTIN_DEMO_DOCX_URL` 内置演示链接。
- `src/integrations/feishu/imTextPipelineDispatch.ts`：入口最先 `trySendImPipelineDemoBypass`；演示 URL = `FEISHU_DEMO_FIXED_REPORT_URL` 或非空则用内置常量。
- `src/integrations/feishu/reportImDelivery.ts`、`src/integrations/feishu/cards.ts`：`forcedPrimaryDocUrl` 与成果链注入保留为可选字段/历史兼容，正常短路时不会再跑此文件。
- `src/app.ts`：启动后打一条 `feishu im demo bypass` 日志，便于确认**本机进程**配置。
- `src/api/feishuWebhook.ts`：新增 `GET /api/feishu/demo-status` 与同响应的 `GET /api/feishu/webhook/demo-status`。

**恢复真实链路**：将 `FEISHU_IM_PIPELINE_BYPASS_DEMO` 设为 `false` 并重启进程。

---

### 高保真样式推进到 dotx 母版级

**目标**：将 Word 导出从"程序化白纸文档"升级为"与飞书模板视觉风格匹配的 dotx 母版驱动输出"。

**新增文件**：
- `src/services/dotxStyleRegistry.ts`：定义 4 种报告类型的色调主题（TemplatePalette），包含飞书品牌蓝/绿/深蓝/紫等，涵盖标题颜色、表头背景、callout 样式、字体等。
- `src/services/wordTableRenderer.ts`：将 bitable/sheet 数据快照（`assetDataSnapshots`）渲染为真实的 Word Table（含表头行样式、边框、单元格宽度适配）。
- `src/services/dotxMasterGenerator.ts`：为每个模板生成 `.dotx` 母版文件，文件存入 `src/data/templates/dotx/`。母版包含完整的段落样式（Normal/Heading1-3/CalloutBlock/ChecklistItem/TableCaption/GanttSlot）、模板章节占位标题、bitable 真实表格、甘特/时间线/图表槽占位框。

**已生成的 dotx 母版**（4 份）：
- `tpl_1778105636617.dotx`（长期项目方案与执行）— 紫色主题，含甘特/时间线槽
- `tpl_1778105636232.dotx`（业务经营周报）— 飞书蓝主题，含 callout/图表占位
- `tpl_1778105635849.dotx`（团队工作周报）— 飞书蓝主题，含 bitable 真实表格
- `tpl_1778105632230.dotx`（个人工作日报）— 绿色主题，含 sheet/bitable 表格

**修改文件**：
- `src/services/wordExport.ts`：
  - 完全重写：按 `reportType` 选择 TemplatePalette，注入自定义 Document styles
  - 标题加下划线 border（品牌色）、摘要用 CalloutBlock 样式
  - 甘特槽用 GanttSlot 样式、图表槽渲染为虚线占位框 Table
  - 接入 `assetDataSnapshots` 参数，将 bitable/sheet 数据渲染为真实 Word Table
  - 新增 `ensureDotxMasters` 懒加载触发函数
  - 导出 `getDotxRelativePath` 供外部使用
- `src/services/agent/templateSkillStore.ts`：
  - 扩展 `StoredTemplate` 加入 `embeddedAssets`、`assetDataSnapshots` 字段
  - `matchTemplateSkill` 返回值新增 `dotxRelativePath`（已生成时）和 `assetDataSnapshots`
- `src/api/report.ts`：
  - `/generate-report-docx` 端点调用 `matchTemplateSkill` 获取匹配模板，将 `templateId`、`reportType`、`assetDataSnapshots` 传入 `generateReportDocxBuffer`
- `src/api/hmrs.ts`：
  - 新增 `POST /api/hmrs/generate-dotx`：按需生成/强制刷新 dotx 母版
  - 新增 `GET /api/hmrs/dotx-status`：查询各模板的 dotx 生成状态

**项目结构**（新增目录）：
```
src/data/templates/dotx/          # dotx 母版文件（二进制，gitignore 可选）
src/services/dotxStyleRegistry.ts # 色调主题注册表
src/services/wordTableRenderer.ts # bitable/sheet → Word Table 转换
src/services/dotxMasterGenerator.ts # dotx 母版生成器
```

## 2026-05-07

### 高质量产物升级（Phase 1-5 一次落地）

- **目标**：
  - 把"用户给云盘 folder token + 文本化文档生成"升级为"上传到个人数据库分桶 + 自动写作风格蒸馏 + 模板槽位语义化 + 真实图表/甘特原生渲染"。
- **Phase 1：HMRS 上传分桶改造**：
  - `src/services/hmrs/hmrsRefreshService.ts`：移除"扫描云盘根目录兄弟文件夹"，改为 `discoverHmrsBucketSources` 直接从个人数据库内部三类纳管房间发现来源（`资源纳管库/已纳管文档房间`、`模板知识库/{周报|会议纪要|方案}模板房间/示例抽屉`）。
  - `src/services/hmrs/hmrsIngestService.ts`：新增 `IngestBucketRole`（work_material / template_example）；template 桶产物写入对应模板房间的结构抽屉，不再污染 `已纳管文档房间`；产物文件名加桶标签便于识别。
  - `src/services/hmrs/userDatabaseBootstrapService.ts`：根目录 README 改为"主动上传目录 vs 自动维护目录"显式分组，明确告诉用户在哪上传。
- **Phase 2：写作风格自动蒸馏（Hermes-like）**：
  - 新增 `src/services/hmrs/styleDistillationService.ts`：从 `已纳管文档房间`最近文档 + 编辑信号统计蒸馏 `StyleProfile`（toneTags/sentencePatterns/preferredSectionOrder/preferredVisualKinds/forbiddenWords/anonymizedStyleSample），写入 `个人画像库/我的偏好房间/风格抽屉/style_profile.json`。
  - 触发：HMRS refresh 完成后异步触发；`updateMemoryFromEditorFeedback` 累计 5 次编辑信号后增量触发。
  - 注入：`src/graph/nodes/plannerAgentNode.ts` 把 preferredSectionOrder/preferredVisualKinds/toneTags 注入 `BlueprintPlan.templateGuardrails`；`src/graph/nodes/writerAgentNode.ts` 把 toneTags/sentencePatterns/commonTerms/forbiddenWords/anonymizedStyleSample 注入 `rewriteHints`。
  - 缓存：`readStyleProfileSoft` 提供 5 分钟内存缓存，主链路读取失败也不阻塞。
- **Phase 3：模板槽位语义化**：
  - `src/schemas/agentContracts.ts`：`chartSlots/timelineSlots/ganttSlots` 增加 `dataSemantic`（kind/dimension/metric/periodHint）、`data`（实际数据点）、`status`（ready/needs_data）。
  - `src/services/agent/writerAgent.ts`：`buildDraftV2Extensions` 默认填 `dataSemantic` + `status=needs_data`。
  - `src/prompts/reviewPrompts.ts`：Writer System Prompt 增加"对每个槽位输出 dataSemantic + 抽取真实 data 数据点；缺数据则置 needs_data，禁止编造"硬约束。
- **Phase 4：ArtifactRenderer 节点 + ToolGateway 渲染能力**：
  - 新增 `src/services/render/artifactRenderer.ts`：按 hybrid 策略渲染——甘特优先飞书白板（PlantUML），失败回退 Mermaid PNG 上传图片；时间线/折线/柱状/饼用 Mermaid 渲染 PNG 后通过 `drive/v1/medias/upload_all` 上传。
  - 新增 `src/graph/nodes/artifactRendererNode.ts`：在 `compliance_reviewer` 与 `output_generator` 之间执行；输出 `renderedArtifacts: RenderedArtifact[]` 挂到 state。
  - `src/graph/state.ts`：新增 `renderedArtifacts` 字段。
  - `src/graph/reportGraph.ts`：插入 `artifact_renderer` 节点，并把 compliance 路由的 `to_publish` 改为 `artifact_renderer`，再走 `output_generator`。
  - ToolGateway 新增能力（`src/services/toolGateway/types.ts`、`capabilities.ts`、`priority.ts`、`gateway.ts`）：
    - `media.upload.image`：OpenAPI 真实实现 `drive/v1/medias/upload_all`。
    - `docx.block.image.insert`：OpenAPI 实现，按 `block_type=27` 创建 image block。
    - `docx.block.embed.insert`：OpenAPI 实现，按 `block_type=22` 用 url 引用白板/sheet/bitable。
    - `sheet.create / sheet.write`：先 `lark-cli` 实现，OpenAPI 暂留 NOT_SUPPORTED。
    - `sheet.chart.create`：lark-cli 与 OpenAPI 都暂留 NOT_SUPPORTED（待开放平台接口确认后接入）。
    - `whiteboard.create`：lark-cli 实现，OpenAPI 留 NOT_SUPPORTED。
- **Phase 5：Publisher 嵌入图片/引用块**：
  - `src/services/output/publisher.ts`：
    - `attachRenderedArtifactsToDocx`：发布飞书 docx 主体后，按 artifact 类型调用 `insertDocxImageBlock` / `insertDocxEmbedBlock`，统计 inserted/skipped/failed 写入 `[publish-telemetry]`。
    - `renderDraftAsTemplateMarkdown`：根据 slot.status 区分"已渲染为可视化对象"与"待补充数据"两种渲染策略，避免 markdown 占位与真实图形冲突。
  - `src/services/agent/outputGenerator.ts` + `src/graph/nodes/outputGeneratorNode.ts`：把 `renderedArtifacts` 透传到 publisher。
- **验证**：
  - `npm run check` 通过；
  - `ReadLints` 对所有改动文件无新增问题。
- **依赖外部能力**：
  - 真实图片块/引用块插入需要飞书开放平台开通：
    - `drive/v1/medias/upload_all`（权限：drive:drive）
    - `docx/v1/documents/{document_id}/blocks/{block_id}/children`（创建块；如果服务端实际 block_type 与本仓库假设不一致，请按官方 API 文档调整 `feishuOpenApiAdapter.ts` 内的 payload）
  - Mermaid PNG 回退依赖 `npx mmdc`（mermaid-cli），未安装时该回退会自动跳过并记录 warning。
  - 白板/电子表格创建当前依赖 lark-cli 安装且具备相关命令；缺失时自动回落到 PNG 嵌入。
- **当前项目结构（本次变更范围）**：
  - 新增：`src/services/hmrs/styleDistillationService.ts`、`src/services/render/artifactRenderer.ts`、`src/graph/nodes/artifactRendererNode.ts`
  - 修改：`src/services/hmrs/{hmrsRefreshService,hmrsIngestService,userDatabaseBootstrapService}.ts`、`src/services/agent/{memoryUpdater,writerAgent,outputGenerator}.ts`、`src/services/output/publisher.ts`、`src/services/toolGateway/{types,capabilities,priority,gateway,feishuOpenApiAdapter,larkCliAdapter,feishuMcpAdapter}.ts`、`src/graph/{state,reportGraph}.ts`、`src/graph/nodes/{plannerAgentNode,writerAgentNode,outputGeneratorNode}.ts`、`src/schemas/agentContracts.ts`、`src/prompts/reviewPrompts.ts`
  - 文档：`history.md`（本文件追加记录）

### 模型回切百炼（替换豆包）与超时参数收敛

- **原因**：
  - 用户反馈豆包 2.0 Pro 在当前链路下请求时延高、频繁触发 `LLM_TIMEOUT_MS=60000` 超时重试，体感明显慢于百炼 Qwen。
- **处理**：
  - `.env`：
    - 回切百炼兼容端点：
      - `BAILIAN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`
      - `BAILIAN_API_KEY=sk-***`
    - 模型调整为高吞吐优先：
      - `BAILIAN_MODEL_ORCHESTRATOR=qwen-turbo`
      - `BAILIAN_MODEL_WRITER=qwen-turbo`
    - 超时与重试收敛：
      - `LLM_TIMEOUT_MS` 从 `60000` 调整为 `45000`
      - `LLM_HTTP_RETRIES` 从 `2` 调整为 `1`
    - `BAILIAN_MODEL_EMBEDDING=text-embedding-v3` 保持可用配置。
- **验证**：
  - 使用 `chat/completions` 做端点烟雾测试，返回 `status 200`，模型回包正常（`model=qwen-turbo`）。
- **当前项目结构（本次变更范围）**：
  - 修改：`.env`
  - 文档：`history.md`（本文件追加记录）

### LLM 模型能力记忆（避免每次先报 400 再回退）

- **原因**：
  - 豆包共享 endpoint 不支持 `response_format=json_object`，此前每次 JSON 模式调用都会先触发一次 400，再回退到提示词约束 JSON；
  - 日志噪声大且额外消耗一次失败请求时延，用户体感为“卡住”。
- **处理**：
  - `src/llm/client.ts`：
    - 新增进程内能力缓存 `jsonResponseFormatUnsupportedModels`；
    - 模型一旦确认不支持 `response_format=json_object`，后续调用直接跳过该参数，直接走提示词约束 JSON；
    - 保留首次自动探测与回退逻辑，兼容不同模型能力。
- **验证**：
  - `npm run check` 通过；
  - `ReadLints` 对本次改动文件无新增问题。
- **当前项目结构（本次变更范围）**：
  - 修改：`src/llm/client.ts`
  - 文档：`history.md`（本文件追加记录）

### MCP 0 条日志降噪 + 检索噪声词过滤

- **原因**：
  - 用户反馈日志中出现 `_user_1` 查询与“解析后 0 条”告警，误导为 MCP 解析故障；
  - 实际存在两类情况：一类是查询词噪声（如 `_user_1`）导致无命中；另一类才是返回结构不兼容。
- **处理**：
  - `src/services/toolGateway/searchQueryNormalize.ts`：
    - 新增噪声 token 识别（`_user_1`、`ou_*/im_*/om_*/oc_*` 等 ID 样式）；
    - `compactDocumentSearchQuery` 从长查询中优先选“非噪声词”，避免退化到 `_user_1` 这类无意义检索词。
  - `src/services/toolGateway/mcpResponseParse.ts`：
    - 新增 `hasKnownSearchDocArrayField`，用于判断响应是否包含已知文档列表字段（即使为空数组）。
  - `src/services/toolGateway/feishuMcpAdapter.ts`：
    - 当 `rows=0` 且响应结构正常时，改记为 info（“当前查询无命中”）；
    - 仅在结构不识别时保留 warn（“字段可能不兼容”）。
- **验证**：
  - `npm run check` 通过；
  - `ReadLints` 对本次改动文件无新增问题。
- **当前项目结构（本次变更范围）**：
  - 修改：`src/services/toolGateway/searchQueryNormalize.ts`、`src/services/toolGateway/mcpResponseParse.ts`、`src/services/toolGateway/feishuMcpAdapter.ts`
  - 文档：`history.md`（本文件追加记录）

### Webhook 历史消息忽略（防旧任务补跑）

- **原因**：
  - 用户反馈“最新任务完成后，历史未回应消息又继续触发受理”，希望忽略旧记录，避免补跑风暴。
- **处理**：
  - `src/integrations/feishu/webhookMessageParse.ts`：
    - 解析并透传 `message.create_time`（`createTimeMs`）。
  - `src/config/env.ts`、`env.example`：
    - 新增 `FEISHU_WEBHOOK_MAX_EVENT_AGE_SECONDS`（默认 180 秒）。
  - `src/api/feishuWebhookDispatch.ts`：
    - 增加历史事件过滤：消息时间超过最大可接受延迟直接忽略；
    - 增加同 chat 时间水位：晚于水位才处理，低于水位的旧重投直接忽略。
- **验证**：
  - `npm run check` 通过；
  - `ReadLints` 对本次改动文件无新增问题。
- **当前项目结构（本次变更范围）**：
  - 修改：`src/integrations/feishu/webhookMessageParse.ts`、`src/api/feishuWebhookDispatch.ts`、`src/config/env.ts`、`env.example`
  - 文档：`history.md`（本文件追加记录）

### IM 受理风暴抑制（同 chat 串行锁）

- **原因**：
  - 用户反馈同一会话连续出现多条“报告任务已受理”卡片；
  - 仅靠 webhook 去重不足以覆盖“不同 message_id 但短时间并发到达”的场景。
- **处理**：
  - `src/integrations/feishu/imTextPipelineDispatch.ts`：
    - 新增按 `chatId` 的 full pipeline 串行锁（TTL 15 分钟）；
    - 同一 chat 在任务进行中收到新消息时，不再重复受理与启动新 pipeline；
    - 改为发送“上一条任务仍在处理中，本条暂不启动”的提示；
    - 在 full pipeline 结束（成功/失败）后释放锁。
- **验证**：
  - `npm run check` 通过；
  - `ReadLints` 对本次改动文件无新增问题。
- **当前项目结构（本次变更范围）**：
  - 修改：`src/integrations/feishu/imTextPipelineDispatch.ts`
  - 文档：`history.md`（本文件追加记录）

### 豆包 endpoint JSON 模式兼容（修复 Analyst 400）

- **原因**：
  - 切换到豆包共享 endpoint 后，日志出现 400：
    - `response_format.type=json_object is not supported by this model`
  - 在严格真实模式下，Analyst 节点不允许回退规则分析，因此链路报错中断。
- **处理**：
  - `src/llm/client.ts`：
    - 新增 `isUnsupportedJsonResponseFormat` 检测；
    - 当模型不支持 `response_format=json_object` 时，自动降级为“仅提示词约束 JSON”并立即重试同一请求；
    - 保留原有超时与可重试错误机制，避免强依赖某家模型对 `response_format` 的支持。
- **验证**：
  - `npm run check` 通过；
  - `ReadLints` 对本次改动文件无新增问题。
- **当前项目结构（本次变更范围）**：
  - 修改：`src/llm/client.ts`
  - 文档：`history.md`（本文件追加记录）

### Webhook 防重 + HMRS 中文目录名 + 模型切换（豆包 2.0 Pro）

- **原因**：
  - 用户反馈同一条 IM 触发多个“报告任务已受理”卡片，说明 webhook 存在重复投递未去重问题。
  - 用户反馈 HMRS 云盘目录仍为英文，不利于维护与理解。
  - 原编排模型配额耗尽，需要切换到可用模型端点。
- **处理**：
  - `src/api/feishuWebhookDispatch.ts`：
    - 新增 webhook 去重窗口（25s），基于 `event_id`、`message_id` 与 `user+chat+text` 指纹三重判定；
    - 命中重复时直接返回 `ok`，不再重复发“受理中”卡片与重复跑流水线。
  - `src/services/hmrs/hmrsStructureBuilder.ts`：
    - 新增 `HMRS_FOLDER_NAMES`，将 HMRS 目录显示名切换为中文（如“个人画像库/项目知识库/模板知识库/资源纳管库/会话沉淀库”）；
    - `buildRequiredFolders` 改为中文路径；
    - HMRS 根目录命名由 `*_mempalace` 改为 `*_个人数据库`（仅新建生效）。
  - `src/services/hmrs/userDatabaseBootstrapService.ts`：
    - 接入中文目录常量，bootstrap 与说明文档写入路径同步中文化；
    - 兼容复用旧根目录命名（同时识别 `*_mempalace` 与 `*_个人数据库`）。
  - `src/services/hmrs/hmrsIngestService.ts`：
    - 项目 room 与纳管 room 路径改为中文目录体系，保持纳管产物命名可读。
  - `.env`：
    - 模型参数切换为用户提供的豆包共享端点（OpenAI 兼容）：
      - `BAILIAN_BASE_URL=https://ark.cn-beijing.volces.com/api/v3`
      - `BAILIAN_API_KEY=ark-***`
      - `BAILIAN_MODEL_ORCHESTRATOR=ep-20260423223203-k4sbx`
      - `BAILIAN_MODEL_WRITER=ep-20260423223203-k4sbx`
- **验证**：
  - `npm run check` 通过；
  - `ReadLints` 对本次改动文件无新增问题。
- **当前项目结构（本次变更范围）**：
  - 修改：`src/api/feishuWebhookDispatch.ts`、`src/services/hmrs/hmrsStructureBuilder.ts`、`src/services/hmrs/userDatabaseBootstrapService.ts`、`src/services/hmrs/hmrsIngestService.ts`、`.env`
  - 文档：`history.md`（本文件追加记录）

### HMRS 中文可读维护（重名覆盖 + 目录说明 + 根目录复用）

- **原因**：
  - 用户反馈 HMRS 初始化后出现“看起来像两个数据库目录”，且 `imported_docs_room` 下文件名偏技术化、缺少可读说明。
  - 现有写入策略使用 `upload_all`，同名文件会追加而不是覆盖，长期会形成多份重复记录。
- **处理**：
  - `src/services/hmrs/hmrsRepository.ts`：
    - 新增同名清理逻辑 `removeFilesByName`；
    - `writeJsonObject/writeMarkdownObject` 改为“同名先删再写”，将写入语义从“追加”改为“覆盖更新”。
  - `src/services/hmrs/userDatabaseBootstrapService.ts`：
    - 新增 HMRS 根目录复用策略：除精确名匹配外，按 `_{userId}_mempalace` 后缀复用历史根目录，减少因昵称变化造成的二次建库。
    - 新增自动目录说明文档写入（根目录、`_system`、`people_wing`、`projects_wing`、`templates_wing`、`resources_wing/imported_docs_room`、`conversations_wing`），便于用户一眼理解各层用途。
  - `src/services/hmrs/hmrsIngestService.ts`：
    - 纳管产物改为中文可读文件名与标题字段（如 `文档索引_*.json`、`纳管记录_*.json`）；
    - 写入 `title/description/sourceFolderName` 等解释性字段，减少仅凭 token 难以辨识的问题。
    - 增加旧命名兼容清理：刷新时自动删除同来源的 `managed_folder_*.json` 与 `document_index_*.json` 历史技术文件名残留。
- **验证**：
  - 通过 `npm run check`（见本次记录后续步骤）确认类型与编译校验通过。
- **当前项目结构（本次变更范围）**：
  - 修改：`src/services/hmrs/hmrsRepository.ts`、`src/services/hmrs/userDatabaseBootstrapService.ts`、`src/services/hmrs/hmrsIngestService.ts`
  - 文档：`history.md`（本文件追加记录）

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
  - 补充：OAuth callback 成功后新增 `HmrsRefreshService.refreshForUser` 异步触发，授权完成即自动执行首轮纳管 refresh（无需手工先调 refresh API）

### HMRS 重构续推进：Wing/Room/Drawer 查询语义 + Refresh 服务接入

- **原因**：
  - 已完成 HMRS bootstrap/ingest 基础设施后，主链仍需补齐“分层暴露 + 按需刷新”能力，保证 Planner/Retriever 按 Wing/Room/Drawer 语义工作，并把纳管目录刷新纳入稳定入口。
  - 用户侧提出“folder token 不应手工前置配置”，需改为 Agent 自动管理，避免未运行前要求填 token。
- **处理**：
  - 新增 `src/services/hmrs/hmrsRefreshService.ts`：
    - 串联 `UserDatabaseBootstrapService` 与 `HmrsIngestService`；
    - 支持按 `HMRS_MANAGED_FOLDER_TOKENS` 逐个目录执行 refresh ingest；
    - 返回 `managedFolderCount/ingestedDocCount` 供上层观测。
  - `src/config/env.ts`、`env.example`：
    - 新增 `HMRS_MANAGED_FOLDER_TOKENS` 配置项（逗号分隔）作为**可选覆盖**；
    - 留空时由 refresh 自动发现可纳管目录。
  - `src/services/hmrs/hmrsRepository.ts`：
    - 新增 `listChildFolders`，用于自动发现候选纳管目录。
  - `src/services/hmrs/hmrsRefreshService.ts`：
    - 新增自动发现逻辑：当未配置 token 时，从用户网盘根目录枚举一级文件夹，排除 HMRS 根目录，选择含文档的文件夹作为纳管目标（上限 6 个）。
    - 增加 refresh 最小间隔节流（默认 15 分钟），避免每次请求重复扫描。
    - 将自动发现结果与刷新结果持久化写回 `_system/refresh_status.json`（`managedFolderTokens/lastRefreshAt/lastIngestAt/lastError`）。
    - 节流命中时返回最近一次有效 refresh 结果（无缓存时返回 bootstrap root token + 0 统计），避免空 token 返回。
    - `getRefreshStatus` 支持跨进程回读 `_system/refresh_status.json`（内存缓存 miss 时回源 Feishu），避免服务重启后状态丢失。
    - 增量 refresh：基于 managed folder 文档集合与 `modifiedTime` 生成 `folderSignature`，与上次 `refresh_status` 对比；未变化目录跳过 ingest，仅对变化目录重建索引。
  - `src/services/hmrs/hmrsRepository.ts`：
    - 新增 `readJsonObjectByName`，按同名文件的最新版本读取并解析 JSON（通过 ToolGateway `getFileContent`）。
    - `listDocsInFolder` 返回 `modifiedTime` 元数据，供增量 refresh 签名计算。
  - `src/services/hmrs/model/layerSchemas.ts`：
    - HMRS 基础对象新增 `wingId/roomId/drawerId` 字段（兼容可选），显式承载 MemPalace 语义位置。
  - `src/services/hmrs/model/memoryObjects.ts`：
    - 新增资源到 Wing/Room/Drawer 的推断映射（people/projects/resources/conversations）。
  - `src/services/hmrs/query/summaryQueryService.ts` 与 `src/services/hmrs/facade/memoryFacade.ts`：
    - 新增 `queryWingSummaries`、`queryRoomIndexes`；
    - facade 新增 `refreshManagedFolders` 统一入口。
    - `SummaryQueryService` 查询源升级：在本地 file-repo 结果之外，追加“基于 Feishu managed folders 的实时 L1/L2 补源”，并按 `qualityScore` 合并去重（向 Feishu HMRS 实体进一步收敛）。
  - Writer/Writeback 观测闭环：
    - `src/services/agent/writerAgent.ts`：
      - 新增 `[writer-telemetry]` 日志，记录模板命中（`selectedSkillId/workflowTemplateId`）、证据规模（`evidenceChars/evidenceSourceCount`）与产物结构命中（section/chart/timeline/gantt）。
    - `src/services/reportPipeline.ts`：
      - 新增 `[pipeline-telemetry] quality baseline computed`，统一输出章节覆盖、模板贴合度、产物就绪度与模板元素命中。
    - `src/services/agent/memoryUpdater.ts`：
      - 新增 `[memory-update-telemetry]`，记录 learned preferences / edit signals 与写回触发状态。
    - `src/services/hmrs/writeback/memoryWritebackService.ts`、`src/services/hmrs/repo/interfaces.ts`、`src/services/hmrs/repo/file/fileWritebackRepository.ts`：
      - 扩展 HMRS writeback payload `telemetry` 字段，并写入 `hmrs-writeback.jsonl`，可离线审计写回对象统计。
  - 严格真实模式（拒绝“无证据占位生成”）：
    - `src/config/env.ts`、`env.example` 新增 `AGENT_STRICT_FACT_MODE`（默认 true）。
    - `src/services/agent/analystAgent.ts`：
      - 严格模式下，`context.facts=0` 直接报错；
      - Analyst 解析失败时不再回退规则化 fallback 分析。
    - `src/services/agent/writerAgent.ts`：
      - 严格模式下，`analysisFactCount=0` 且 `evidenceSourceCount=0` 时拒绝生成；
      - Writer 失败时不再回退 `fallbackDraft`；
      - 严格模式下不再自动注入 chart/timeline/gantt 占位槽位。
  - 清理 mock 数据与干扰脚本：
    - 删除 `src/resource_pool/mock/*.json`（documents/contacts/projects/personas/feishu_details）。
    - 删除 `src/data/resource-pool.json`，避免旧池静态样本干扰生成链路。
    - 删除 `src/sync/resourceGovernance.ts`（旧资源治理同步脚本）。
    - `src/api/report.ts` 移除 `/mock/im-contacts` 与 `/resource-pool/sync` 接口，避免误调用旧 mock/旧池流程。
    - `src/services/resourcePool/poolManager.ts` 去除基于 `assets.md` 与 governance sync 的兜底生成逻辑，仅保留已持久化池 + 用户请求上下文扩展（联系人/历史）。
  - 可视化进度与 UAT 失效体验优化：
    - 新增 `src/services/progress/pipelineProgress.ts`：
      - 维护按 `sessionId` 的进度事件流（内存快照 + 订阅）。
    - `src/api/report.ts`：
      - 新增 `GET /api/report/progress?sessionId=...`（SSE），可实时查看流程阶段进度。
      - 在 `/generate-report` 与 `/generate-report-docx` 失败时，若检测到 UAT 无效，返回 `oauthRequired + authUrl`，便于前端直接引导重新授权。
    - `src/services/reportPipeline.ts` 与关键图节点（hmrs_summary/intent/planner/retriever/analyst/writer/output/memory_update）：
      - 增加阶段进度事件发布（start/done/failed + 节点结构化 meta）。
    - 新增 `src/integrations/feishu/uatReminder.ts` + `FEISHU_UAT_REMIND_COOLDOWN_SECONDS`：
      - 飞书 webhook 场景下，UAT 失效授权卡片按用户+会话冷却发送，避免高频重复提醒。
    - `src/api/chat.ts`：
      - 聊天生成与局部改写失败时同样附带 `oauthRequired + authUrl`（检测到 UAT 失效时）。
  - 检索/正文读取错误修复（针对 99992402 与 1770032）：
    - `src/services/toolGateway/feishuMcpAdapter.ts`：
      - `searchDocuments` 对 query 做最小合法性过滤（长度 < 2 直接跳过），减少下游搜索接口 field validation failed。
    - `src/integrations/feishu/docxRawContent.ts`：
      - `fetchDocxRawText` 支持可选 `userAccessToken`，允许优先用户身份读取正文。
    - `src/services/toolGateway/feishuOpenApiAdapter.ts`：
      - `viewDocument` 在 `preferUserScope` + `userId` 场景下优先使用 UAT 拉取 docx raw_content，降低 TAT 访问用户私有文档导致的 1770032 forBidden。
  - Wiki/Docx 读取路径纠偏（持续修复 1770032）：
    - `src/services/hmrs/expand/detailRetrievalService.ts`：
      - L3 展开优先使用候选 `link`（URL）作为 `viewDocument` 入参，不再仅依赖 `ext_doc_*` token，避免将 wiki token 误当 docx id。
    - `src/services/toolGateway/feishuOpenApiAdapter.ts`：
      - `normalizeDocxTokenForOpenApi` 对 URL 仅接受 `/docx/{id}`，若是 `/wiki/{token}` 直接返回空，避免继续调用 `docx raw_content` 触发 403。
  - MCP 文档搜索稳定性修复（持续修复 99992402）：
    - `src/services/toolGateway/feishuMcpAdapter.ts`：
      - `searchDocuments` 新增 query 清洗（去 HTML/特殊符号、限长）。
      - 当 MCP `search-doc` 返回 `VALIDATION` 时，不再中断主流程，自动回退 `list-docs` + 本地标题/摘要筛选。
    - `src/services/resourcePool/mcpSearchQueries.ts`：
      - 搜索词生成前统一清洗并缩短，减少无效参数进入 MCP 搜索接口。
      - 查询数上限由 6 降到 4，降低重复失败与延迟。
  - 模板结构抽取优先（Wiki 模板用于生成约束）：
    - `src/services/agent/writerAgent.ts`：
      - 新增 `extractTemplateSectionsFromDetailedContext`，从深读正文中自动抽取章节骨架（支持 Markdown 标题、中文序号标题、数字分级标题等）。
    - `src/graph/nodes/writerAgentNode.ts`：
      - Writer 前置注入模板骨架：若检测到有效模板章节（>=3），用其覆盖 `plan.targetSections`（按目标节数截断/补齐），并追加强制 rewriteHints，确保初稿结构贴近模板。
  - 用户态读取防 403（持续修复 1770032）：
    - `src/services/toolGateway/gateway.ts`：
      - UAT + `preferUserScope` 场景下，`document.view/document.fileContent` 执行序列中跳过 OpenAPI，避免 TAT 误读用户私有文档触发 `docx raw_content 403`。
    - `src/services/toolGateway/feishuMcpAdapter.ts`：
      - 文档搜索 query 进一步收敛（长短句仅保留首关键词），降低 MCP 下游 `doc_wiki/search` 参数校验失败概率。
  - 模板抽取独立能力（先于主流程接入）：
    - `src/services/hmrs/templateExtractionService.ts`（新增）：
      - 新增独立模板抽取服务：输入 `userId + documentRef(url/token)`，读取云文档正文后自动提取章节骨架（Markdown/中文序号/数字分级标题）。
      - 自动生成模板特征（`templateHints`、`chartRules`）与 `skillDraft` 草案，并持久化到 `src/data/hmrs/hmrs-template-skills.json`。
    - `src/api/hmrs.ts`：
      - 新增 `POST /api/hmrs/extract-template`：执行模板抽取并落盘。
      - 新增 `GET /api/hmrs/templates?userId=...`：按用户查询已抽取模板列表。
  - 模板抽取可用性增强：
    - `src/services/hmrs/templateExtractionService.ts`：
      - 当 `toolGateway.viewDocument` 未返回正文时，新增 `lark-cli docs +fetch --api-version v2 --as user` 兜底读取路径，提升公开链接模板抽取成功率。
      - `extractSections` 新增 XML 标题解析（优先提取 `<h1~h6>`），修复 docx XML 单行内容导致章节骨架提取为空的问题。
      - 新增模板名编码污染防护：当 `templateName` 出现 `????`/`�` 等异常字符时，自动回退使用 `sourceTitle`，避免落盘技能名乱码。
    - `src/data/hmrs/hmrs-template-skills.json`：
      - 修复已抽取模板中的 `templateName` 与 `skillDraft.name` 乱码（问号占位）为正确中文名称。
  - 模板深挖提取（嵌入数据源级）：
    - `src/services/hmrs/templateExtractionService.ts`：
      - 在 `embeddedAssets` 基础上新增 `assetDataSnapshots`：
        - `sheet`：调用 `lark-cli sheets +info/+read` 抽取工作表列表与样例单元格。
        - `bitable`：调用 `lark-cli base +table-list/+field-list/+record-list` 抽取表结构与样例记录。
      - 输出结构支持“模板骨架 + 版式块 + 嵌入对象 + 数据快照”一体化沉淀，便于后续 Skill 化与图表填充。
  - IM 场景 OAuth 失效体验修复（避免“跳过重新认证”）：
    - `src/integrations/feishu/imTextPipelineDispatch.ts`：
      - 在 `phase1/full` 异步链路 catch 中识别 `无有效飞书用户访问令牌（UAT）` 错误。
      - 发生该错误时主动发授权卡（含 replay 信息，授权后自动续跑）；若处于提醒冷却期，降级发送带授权链接的文本提示，不再静默仅报“生成失败”。
  - 主流程 API 硬修复（99992402 / 1770032）：
    - `src/services/toolGateway/searchQueryNormalize.ts`（新增）：
      - 统一文档检索 query 清洗与压缩策略，供 MCP adapter 与查询拆分共享。
    - `src/services/toolGateway/feishuMcpAdapter.ts`：
      - MCP HTTP 400 中命中 `field validation failed / 99992402` 时统一归类为 `VALIDATION`。
      - `searchDocuments` 改用共享 query 规范化，参数校验失败时稳定回退 `list-docs` 本地筛选。
    - `src/services/toolGateway/gateway.ts`：
      - `document.search` 遇到 `VALIDATION` 错误后短路，不再继续下一个 adapter 重复触发同类失败请求。
    - `src/services/resourcePool/mcpSearchQueries.ts`：
      - 使用共享 query 规范化函数，避免与 adapter 侧规则不一致。
    - `src/services/resourcePool/screening.ts`：
      - 外部文档/用户检索补充路径增加容错，失败不再打断主流程。
  - 模板 Skill 化接入主流程（按用途+名称命中）：
    - `src/services/agent/templateSkillStore.ts`（新增）：
      - 读取 `hmrs-template-skills.json`，基于用户、任务意图、报告类型、prompt 名称命中模板 Skill。
    - `src/services/agent/skillRouter.ts`：
      - 在 workflow 之前新增 `user_template` 命中分支，注入模板 sections/style/chart/hints 到 `SkillMatch`。
    - `src/graph/nodes/skillRouterNode.ts`：
      - 将 `prompt/userId` 传入 `routeSkill`，实现用户模板优先命中。
    - `src/schemas/agentContracts.ts`：
      - `SkillMatch.source` 扩展支持 `user_template`。
    - `src/services/agent/plannerAgent.ts`：
      - 命中 `user_template` 时强约束 `targetSections` 为模板章节顺序，减少 LLM 自由改写。
  - Writer/Word 模板版式链路增强：
    - `src/services/reportPipeline.ts`：
      - `runReportPipeline` 返回 `draft`（完整 Draft，含 timeline/gantt/chartSlots/sectionBlocks）供 Word 导出使用。
    - `src/api/report.ts`：
      - `/generate-report-docx` 调用 `generateReportDocxBuffer` 时透传 `draft`。
    - `src/services/wordExport.ts`：
      - 新增对 `draft.timelineSlots/ganttSlots/chartSlots/sectionBlocks` 的 docx 渲染（不再仅使用 WriterOutput 的纯文本 sections）。
  - 回归验证（4 模板 + 导出链路）：
    - 通过 `npx tsx` 直接调用 `routeSkill` 验证 4 份模板均命中 `source=user_template`，章节与模板一致。
    - 通过 `npx tsx` 调用 `generateReportDocxBuffer` 验证含 `timeline/gantt/chartSlots/sectionBlocks` 的 Draft 可成功导出 docx（bytes>0）。
    - 通过 `/generate-report` 全链路实测时，由于 `AGENT_STRICT_FACT_MODE=true` 且当前测试请求无事实证据，4 个用例在 Analyst 阶段被严格拦截（属于事实门禁预期行为，不是模板路由回归失败）。
  - `src/graph/nodes/hmrsSummaryNode.ts`：
    - screening 前触发 `refreshManagedFolders`（best effort）；
    - L1 查询改为按 wing 暴露；
    - `screeningReason` 增加 managed folder/ingest 统计。
  - `src/services/agent/plannerAgent.ts`：
    - Planner 读取改为 Wing/Room 语义查询，替代纯 flat L1/L2 读取。
  - `src/services/hmrs/expand/expansionPlanner.ts`：
    - L2 选择增加 room 多样性 boost，预算内优先覆盖更多主题 room。
  - `src/services/hmrs/writeback/memoryWritebackService.ts`：
    - 写回对象补齐 Wing/Room/Drawer 归档位置（style/template/exemplar）。
- **验证**：
  - `npm run check` 通过；
  - `ReadLints` 对本次改动文件无新增问题。
- **当前项目结构（本次变更范围）**：
  - 新增：`src/services/hmrs/hmrsRefreshService.ts`
  - 修改：`src/services/hmrs/{facade,memory model,query,expand,writeback}`、`src/graph/nodes/hmrsSummaryNode.ts`、`src/services/agent/plannerAgent.ts`、`src/config/env.ts`、`env.example`
  - 文档：`history.md`（本文件追加记录）

## 2026-05-06

### HMRS 第一版开工：Bootstrap + Feishu Repository + 单 Folder Ingest

- **目标**：
  - 按 MemPalace 方向落地 HMRS 第一版最小闭环：用户 OAuth 后自动初始化 HMRS，支持纳管单个飞书目录并生成基础索引对象。
- **新增模块**：
  - `src/services/hmrs/model/memPalaceTree.ts`
    - 定义 HMRS Manifest / RefreshStatus / RecallBudget / Permissions 结构。
  - `src/services/hmrs/hmrsStructureBuilder.ts`
    - 固化 Wing/Room/Drawer 基础目录树与根目录命名规则（`{nickname}_{userId}_mempalace`）。
  - `src/services/hmrs/hmrsRepository.ts`
    - 新增 Feishu-backed repository（UAT）：
      - root folder meta
      - create/list/find folder
      - ensureFolderPath
      - `drive/v1/files/upload_all` 写 JSON/Markdown 对象。
  - `src/services/hmrs/userDatabaseBootstrapService.ts`
    - OAuth 后自动创建 HMRS 根目录与基础目录树；
    - 写入 `_system/hmrs_manifest.json`、`refresh_status.json`、`recall_budget.json`、`permissions.json`；
    - 初始化 `style_identity.md`、`writing_thought.md`。
  - `src/services/hmrs/summaryBuilder.ts`
    - 生成 `folder_summary` 与 `document_index`。
  - `src/services/hmrs/hmrsIngestService.ts`
    - 支持单 folder 纳管：扫描 doc/docx，深读并写入项目 room 的 summary/docs drawer。
- **新增 API**：
  - `src/api/hmrs.ts`
    - `POST /api/hmrs/bootstrap`
    - `POST /api/hmrs/ingest-folder`
    - `GET /api/hmrs/root`
    - `POST /api/hmrs/refresh`（手动触发 refresh，用于联调自动发现/纳管结果）
    - `GET /api/hmrs/refresh-status`（读取最近一次 refresh 状态，便于前端/排障查看）
  - `src/app.ts` 注册 HMRS 路由。
- **OAuth 联动**：
  - `src/api/feishuAuth.ts`
    - 在 OAuth callback 成功后异步触发 `UserDatabaseBootstrapService.bootstrap()`，让用户授权后立即具备 HMRS 根目录。
- **验证**：
  - `npm run check` 通过；
  - `ReadLints` 无新增问题。

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

**日期**：2026-05-08（2）

### `/generate-report` 演示短路（与 HMRS / IM 演示并存）

- `src/config/env.ts`：新增 `REPORT_PIPELINE_DEMO_SKIP`、`REPORT_PIPELINE_DEMO_URL`、`REPORT_PIPELINE_DEMO_DELAY_MS`。
- `src/api/report.ts`：演示开启时不调用完整 `runReportPipeline`，`POST /generate-report` 经延迟后返回 JSON `{ "url": "<云文档链接>" }`；`generate-report-docx` 经延迟后返回极简 Word。
- 用户 IM 侧固定演示以 `imDemoConfig.ts` / `imTextPipelineDispatch.ts`（及上文「飞书 IM：imDemoConfig」条目）为准，**非** `/api/feishu/card-callback`。

---

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

## 2026-05-07（Cloudflare 固定域名 OAuth）

- **原因**：
  - `trycloudflare.com` 临时域名每次重启会变化，导致 `FEISHU_USER_OAUTH_REDIRECT_URI` 与飞书开放平台配置反复失配，OAuth 回调不稳定。
- **处理**：
  - 安装并验证 `cloudflared` 可用；
  - 完成 Cloudflare Tunnel 登录并确认本机证书落盘到 `C:\Users\Swigar\.cloudflared\cert.pem`；
  - 创建命名隧道：`feishu-oauth`；
  - 绑定固定子域名：`oauth.zhongshu-sheng.com -> feishu-oauth`；
  - 启动隧道转发本地服务：`cloudflared tunnel --url http://localhost:3000 run feishu-oauth`；
  - 更新 `.env`：`FEISHU_USER_OAUTH_REDIRECT_URI=https://oauth.zhongshu-sheng.com/api/feishu/auth/callback`。
- **当前项目结构（本次变更范围）**：
  - 修改：`.env`
  - 文档：`history.md`（本文件追加记录）

## 2026-05-07（报告失败日志增强）

- **原因**：
  - `generate-report failed` 日志仅保留 `pregelTaskId` 时，无法判断是百炼 API 失败、超时还是 JSON/Schema 解析失败，排障成本高。
- **处理**：
  - 新增 `src/shared/errorSummary.ts`：统一提取 `errorMessage` 与结构化错误摘要（含 `type/message/stack/cause/raw`）。
  - `src/services/agent/analystAgent.ts`：
    - Analyst 失败时输出 `[analyst] analyzeContext failed` 结构化日志（strictMode、factCount、errorSummary）；
    - 严格模式报错追加“原始原因”文本，避免只看到笼统报错。
  - `src/services/reportPipeline.ts`：
    - 在图执行失败时输出 `report graph 失败`，附 `sessionId/userId/errorSummary`。
  - `src/api/report.ts`：
    - `/generate-report` 与 `/generate-report-docx` 失败日志增加 `errorMessage + errorSummary`，便于终端直接定位根因。
- **当前项目结构（本次变更范围）**：
  - 新增：`src/shared/errorSummary.ts`
  - 修改：`src/services/agent/analystAgent.ts`、`src/services/reportPipeline.ts`、`src/api/report.ts`
  - 文档：`history.md`（本文件追加记录）

## 2026-05-07（Analyst 输出结构容错）

- **原因**：
  - 线上出现 `Analyst schema 不匹配`：模型把 `normalizedFacts` 输出为对象数组、`keyInsights` 输出为对象、`chartSuggestions` 字段缺失/别名化，严格模式下直接失败。
- **处理**：
  - `src/services/agent/analystAgent.ts`：
    - 改为先以 `z.unknown()` 接收模型原始 JSON，再执行本地归一化；
    - 新增对象到字符串的容错提取（`fact/text/content/summary/...`）；
    - 支持 `facts/cleanedFacts`、`insights/keyPoints/highlights`、`charts/chartSlots` 等别名字段映射；
    - 对缺省图表建议补基础槽位，最后统一走 `AnalysisResultSchema.parse` 强校验。
  - `src/prompts/agentPrompts.ts`：
    - 强化 Analyst 输出约束，明确数组元素类型与 `chartSuggestions` 必填字段。
- **当前项目结构（本次变更范围）**：
  - 修改：`src/services/agent/analystAgent.ts`、`src/prompts/agentPrompts.ts`
  - 文档：`history.md`（本文件追加记录）

## 2026-05-07（办公Agent系统对齐实施：Phase1-Phase5 首轮落地）

- **原因**：
  - 将系统从“报表生成流水线”对齐为“IM 入口 + HMRS 个人数据库 + 在线编辑协作 + 持续写回学习”的办公 Agent 主链路，并落实 OpenAPI/MCP 在目录治理与文档协作中的职责分层。
- **处理**：
  - **主链路契约收敛（Phase 1）**：
    - `src/graph/state.ts`：`callbackRoute` 语义改为 `to_writer/to_compliance/to_planner/to_analyst/to_publish`，新增 `blueprintPlan` 状态。
    - `src/graph/reportGraph.ts`：style/compliance 条件路由与新语义一致化。
    - `src/graph/nodes/plannerAgentNode.ts`：新增 `BlueprintPlan` 生成（sectionBlueprint + visualSlots + templateGuardrails）。
    - `src/graph/nodes/writerAgentNode.ts`：Writer 优先消费 blueprint 章节骨架与 guardrails。
    - `src/schemas/agentContracts.ts`：新增 `BlueprintPlanSchema`；`DetailedContext` 增加 `templateDistillation`。
    - `src/services/retrieval/deepRetriever.ts`、`src/graph/nodes/hmrsExpansionNode.ts`、`src/services/reportPipeline.ts`：修复 `retrievalContext`/`detailedContext` 双轨，`templateDistillation` 由深读上下文稳定回传。
  - **HMRS 目录治理补全（Phase 2）**：
    - `src/services/hmrs/hmrsRepository.ts`：新增 `move/copy/delete/task_check` 对应方法，补齐 `getFolderMeta`；新增目录结构巡检与自动补齐（`getMissingFolderPaths`/`ensureRequiredFolderLayout`）。
    - `src/services/hmrs/userDatabaseBootstrapService.ts`、`src/services/hmrs/hmrsRefreshService.ts`：接入布局巡检与修复，刷新时自动补齐缺失 Wing/Room/Drawer 路径。
  - **ToolGateway 单入口化（Phase 3）**：
    - `src/services/toolGateway/types.ts`：新增 drive 领域类型与接口（root/folder/list/create/move/copy/delete/task_check）。
    - `src/services/toolGateway/capabilities.ts`、`priority.ts`、`gateway.ts`：新增 `drive.*` 能力并纳入统一策略调度。
    - `src/services/toolGateway/feishuOpenApiAdapter.ts`：实现 drive OpenAPI 适配（用户态 UAT）。
    - `src/services/toolGateway/feishuMcpAdapter.ts`、`larkCliAdapter.ts`：补齐 drive 接口并明确 NOT_SUPPORTED 回退语义。
  - **模板记忆与写回增强（Phase 4）**：
    - `src/services/agent/templateSkillStore.ts`：模板读取由“单文件”升级为“`hmrs-template-skills.json` + `hmrs-catalog/index` 融合”，使模板记忆纳入 HMRS 数据面。
    - `src/services/hmrs/writeback/memoryWritebackService.ts`：新增写回质量分、信号去重、telemetry 扩展（dedupedSignalCount）。
  - **在线编辑闭环（Phase 5）**：
    - `src/services/agent/memoryUpdater.ts`：新增 `updateMemoryFromEditorFeedback`，把工作台编辑信号写入 HMRS。
    - `src/api/chat.ts`：手动局部编辑与 AI 局部改写改为统一走 `updateMemoryFromEditorFeedback`（不再仅写 runtime 内存）。
- **验证**：
  - `npm run check` 通过（TypeScript 全量校验）。
  - 关键改动文件 `ReadLints` 无新增问题。
- **当前项目结构（本次变更范围）**：
  - 核心链路：`src/graph/`、`src/services/reportPipeline.ts`
  - HMRS：`src/services/hmrs/`
  - ToolGateway：`src/services/toolGateway/`
  - 模板与记忆：`src/services/agent/templateSkillStore.ts`、`src/services/agent/memoryUpdater.ts`
  - 在线编辑接口：`src/api/chat.ts`
  - 文档：`history.md`（本文件追加记录）

## 2026-05-07（HMRS Drive 异步任务收敛增强）

- **原因**：
  - `move/delete` 在飞书 Drive 侧可能返回异步任务（ticket），若只返回初始状态，会导致上层拿到 `pending` 且缺少最终成功/失败结论，不利于目录治理可靠性。
- **处理**：
  - `src/services/hmrs/hmrsRepository.ts`：
    - 新增 `waitForTaskCompletion` 轮询器；
    - `moveFile/deleteFile` 在拿到 ticket 后自动执行 `task_check` 轮询（固定间隔与最大轮数），尽量收敛到 `success/failed`；
    - 对超时与失败增加结构化 warn 日志，包含 `op/ticket/error`，便于排障。
- **验证**：
  - `npm run check` 通过。
- **当前项目结构（本次变更范围）**：
  - 修改：`src/services/hmrs/hmrsRepository.ts`
  - 文档：`history.md`（本文件追加记录）

## 2026-05-07（HMRS Copy 异步任务收敛补齐）

- **原因**：
  - `copy/copyDocument` 在部分 Drive 场景下可能返回异步 ticket（而非即时 file token），若不收敛状态会导致后续流程拿不到复制结果 token。
- **处理**：
  - `src/services/toolGateway/types.ts`：
    - `GatewayDriveTaskStatus` 新增 `resultFileToken/resultUrl`；
    - `copyFile` 返回值支持 `task`（异步票据）与 `fileToken` 并存。
  - `src/services/toolGateway/feishuOpenApiAdapter.ts`：
    - `copyFile` 兼容同步 token 与异步 ticket 两种返回；
    - `parseTaskStatus` 解析任务结果中的文件 token/url。
  - `src/services/hmrs/hmrsRepository.ts`：
    - `copyFile/copyDocument` 接入任务轮询收敛；
    - 任务成功但无结果 token 时给出明确错误，避免静默失败。
  - `src/services/toolGateway/{gateway,feishuMcpAdapter,larkCliAdapter}.ts`：
    - 同步接口签名，保持统一能力契约。
- **验证**：
  - `npm run check` 通过。
- **当前项目结构（本次变更范围）**：
  - 修改：`src/services/toolGateway/`、`src/services/hmrs/hmrsRepository.ts`
  - 文档：`history.md`（本文件追加记录）

## 2026-05-07（Webhook 授权冷却期静默修复）

- **原因**：
  - 当 `FEISHU_MCP_IDENTITY=uat` 且用户 OAuth 已失效时，webhook 会进入授权提醒分支；若命中提醒冷却期，原逻辑仅记录日志不发消息，用户侧表现为“发了消息但机器人无任何回复”。
- **处理**：
  - `src/api/feishuWebhookDispatch.ts`：
    - 在“提醒冷却期”分支增加兜底文本提示，明确告知授权已失效并给出授权入口路径，避免静默。
- **验证**：
  - `npm run check` 通过。
- **当前项目结构（本次变更范围）**：
  - 修改：`src/api/feishuWebhookDispatch.ts`
  - 文档：`history.md`（本文件追加记录）

## 2026-05-07（OAuth start 增加浏览器直跳模式）

- **原因**：
  - `/api/feishu/auth/start` 设计为“返回授权链接 JSON”，用户直接在浏览器打开时会看到 JSON，以为“没有触发认证”。
- **处理**：
  - `src/api/feishuAuth.ts`：
    - `start` 查询参数新增 `redirect`（布尔）；
    - 当 `redirect=1` 时，接口直接 302 跳转到飞书授权页；
    - 默认行为保持不变（仍返回 JSON，兼容 API 调用方）。
- **验证**：
  - `npm run check` 通过。
- **当前项目结构（本次变更范围）**：
  - 修改：`src/api/feishuAuth.ts`
  - 文档：`history.md`（本文件追加记录）

## 2026-05-07（授权卡补充固定域名入口，避免旧域名残留）

- **原因**：
  - 用户可能点击到历史授权卡中的旧链接（如失效的 trycloudflare 域名），导致授权后回跳失败。
- **处理**：
  - `src/integrations/feishu/cards.ts`：
    - `buildUserOAuthRequiredCard` 新增 `fallbackAuthStartUrl` 字段；
    - 卡片底部增加“备用授权入口（固定域名）”链接。
  - `src/api/feishuWebhookDispatch.ts`、`src/integrations/feishu/imTextPipelineDispatch.ts`：
    - 基于 `FEISHU_USER_OAUTH_REDIRECT_URI` 自动推导固定域名入口：
      - `${origin}/api/feishu/auth/start?userId=...&redirect=1`
    - 发授权卡时同时写入该备用入口。
- **验证**：
  - `npm run check` 通过。
- **当前项目结构（本次变更范围）**：
  - 修改：`src/integrations/feishu/cards.ts`、`src/api/feishuWebhookDispatch.ts`、`src/integrations/feishu/imTextPipelineDispatch.ts`
  - 文档：`history.md`（本文件追加记录）

## 2026-05-07（授权卡主按钮切换为固定域名中转优先）

- **原因**：
  - 即便已增加备用入口，用户仍可能优先点击主按钮；主按钮若直接使用历史授权链接，仍有概率命中旧域名回调。
- **处理**：
  - `src/integrations/feishu/cards.ts`：
    - 授权卡主按钮 `open_url` 改为“固定域名中转入口优先”，即优先使用 `fallbackAuthStartUrl`，无该值才回退 `authUrl`。
- **验证**：
  - `npm run check` 通过。
- **当前项目结构（本次变更范围）**：
  - 修改：`src/integrations/feishu/cards.ts`
  - 文档：`history.md`（本文件追加记录）

## 2026-05-07（v0.5 质量回退修复：HMRS 反污染 + 真出图链路）

- **本轮聚焦的现象**：
  - 用户实测「团队工作周报」内容简陋、无任何甘特/图表，且出现重复的「文档ID为空」占位话术；
  - 根因为三层耦合：HMRS 自污染 → MCP search 只塞 snippet → 渲染链全断。
- **根因 1：HMRS 被 Writer 失败稿污染**
  - `MemoryWritebackService.writeFromDraft` 之前无门槛地把每次 Draft 写回 `templates_wing/structure_drawer` 与 `style_drawer`；
  - 下一轮 Planner / `templateSkillStore` 把这些污染条目当模板召回，Writer 只能复印「文档ID为空」雪球越滚越大。
- **根因 2：MCP search-doc 仅 snippet，没有正文**
  - `feishuMcpAdapter.searchDocuments` 把命中行直接 map 成 `GatewayDocument`，正文实际是 `周报 <hb>周报</hb>` 这种带 HTML 高亮的命中片段；这些壳被原样写到 `imported_docs_room` 的 `structureSummary`。
- **根因 3：图表/甘特/时间线渲染全部失败**
  - `package.json` 缺 `@mermaid-js/mermaid-cli`，`npx mmdc` 永远失败 → mermaid 路径全断；
  - `feishuMcpAdapter` 把 `uploadImageMedia / createWhiteboard / insertDocxImageBlock / insertDocxEmbedBlock` 全部 NOT_SUPPORTED，但 MCP create-doc 已经声明同源 `docs:document.media:upload` 与 `board:whiteboard:node:create` scope；
  - `writerAgent.buildDraftV2Extensions` 默认所有 chart/timeline/gantt 槽位 `status=needs_data`，ArtifactRenderer 完全不进入 ready 分支；
  - `publisher.renderDraftAsTemplateMarkdown` 用 chartSlot.status 误判，输出「图表（已渲染为可视化对象）」占位行，给用户造成「明明没图却写已渲染」的错觉。
- **修复（按 Step 1 → 2 → 5 → 4 → 3 → 6 → 7 实施）**：
  - **Step 1：清洗污染数据**
    - 写入一次性脚本 `src/scripts/purgeOwnerPollutedMemory.ts`（按 user rule 跑完即删）：
      - 删除 `src/data/hmrs/hmrs-catalog.json` / `hmrs-index.json` 中 owner 命中且 type ∈ {TemplateStructureIndex, StyleIdentitySummary, ExemplarSnippetPointer} 的条目；
      - 重置 `src/data/runtime-memories.json` 该 owner 的 `commonTerms / styleNotes / preferredStructure`；
      - 清空 `src/data/hmrs/hmrs-writeback.jsonl` 该 owner 的全部行；
      - 通过 `toolGateway.getRootFolderMeta` 直接定位 `{userId}_个人数据库` 根目录，避免 bootstrap 重写 system 对象造成 upload_all params error；遍历 `templates_wing/weekly_report_room/structure_drawer` 与 `people_wing/self_room/style_drawer` 删除残留文件。
    - 实测：本地清掉 1 个 catalog 条目、5 个 index 条目、9 行 writeback；云盘对应 drawer 已是空目录（写回门槛之前的写入实际只落本地索引，没真正在云盘留文件）。
  - **Step 2：阻断错误内容自动写回**
    - `src/services/hmrs/writeback/memoryWritebackService.ts`：新增 `evaluateDraftQuality(draft)` 与 `writeFromDraft` 准入门槛：
      - 命中 `/(文档|document)\s*ID|缺失|为空|无法获取|无法加载|无法访问|占位|todo|fallback|VALIDATION:1002/i` → reject；
      - `summary.length < 80` 或 sections 数 < 期望 60% → reject；
      - 任意 section 内容 < 30 字 / 命中污染语 → reject；
      - `openQuestions` 含 `Writer JSON 生成未通过校验` → reject；
      - reject 时 `logger.warn` 跳过写回，不再污染 HMRS。
  - **Step 5：补上 mermaid-cli 兜底**
    - `package.json`：`@mermaid-js/mermaid-cli@^11.14.0` 加入 `devDependencies`。
    - `src/services/render/artifactRenderer.ts`：
      - `resolveMermaidCliCommand` 优先用 `node_modules/.bin/mmdc(.cmd)` 二进制，避免 `npx` 联网下载卡住主链；
      - `renderMermaidToPng` 改返回 `{ ok, png?, stderr? }`；
      - `tryImageFallback` 改返回 `{ artifact, warning? }`；
      - chart/timeline/gantt 三处调用按新形态消费，渲染失败时把 `mmdc:` 与 `upload:` 原因写进 `RenderOutput.warnings`，便于上层定位失败原因。
  - **Step 4：接通 MCP 出图三件套**
    - `src/services/toolGateway/priority.ts`：把 `media.upload.image / docx.block.image.insert / docx.block.embed.insert / whiteboard.create` 优先级调整为 MCP-first（用户选择 `hybrid_mcp_first`），失败回退 OpenAPI / lark-cli。
    - `src/services/toolGateway/feishuMcpAdapter.ts`：
      - 新增 `MCP_RENDER_CANDIDATES`，列出 `upload-media / docx.media.upload / media-upload / drive.media.upload`、`create-whiteboard / whiteboard.node.create / board.whiteboard.node.create / create-board`、`insert-docx-image-block / docx.block.image.insert / update-doc.image.insert`、`insert-docx-embed-block / docx.block.embed.insert / update-doc.embed.insert` 等候选 tool 名；
      - 新增 `tryMcpToolByCandidates`：依次试调每个候选名，命中即用；远程未暴露时统一抛 `NOT_SUPPORTED`，让 ToolGateway 自动 fallback；命中 `PERMISSION_DENIED / VALIDATION` 直接抛出避免无意义重试。
      - 把 `uploadImageMedia / createWhiteboard / insertDocxImageBlock / insertDocxEmbedBlock` 从 NOT_SUPPORTED 改为真实实现（透传 base64 / parent_node / docID 等多种字段名兼容服务端实现）。
  - **Step 3：search-doc 接 fetch-doc 深读 + 清洗 `<hb>` 标签**
    - `src/services/toolGateway/feishuMcpAdapter.ts`：
      - 新增 `stripHighlightTags`：剥离 `<hb> / <em> / <mark> / <b> / <strong> / <font> / <span>` 与常见 HTML 实体，避免高亮 HTML 被原样塞进 HMRS；
      - `searchDocuments` 命中后调用新增 `deepFetchSearchHits`：对前 6 篇逐一走 `fetch-doc` 拉正文（截断 8K 字符），写入 `GatewayDocument.content`，`summary` 取正文前 480 字；
      - `listDocuments` 同步清洗 snippet。
    - `src/services/resourcePool/screening.ts.mapDocToResourceSummary`：优先消费 `doc.content`（深读正文）作为 `summary`；命中深读时分数从 0.32 提到 0.55，并打 `tags=["deep_fetched"]`，让 Writer 拿到第一手原文 evidence。
  - **Step 6：Writer 真的能产出 status=ready；Publisher 严格依据 renderedArtifacts**
    - `src/services/agent/writerAgent.ts.buildDraftV2Extensions`：
      - 新增 `extractGanttDataFromSections / extractTimelineDataFromSections / extractChartDataFromSections` 启发式正则，从 section 内容抽取「日期+任务+负责人」三元组、时间线 `{label, when, note}` 与图表 `{categories, series}`；
      - evidence 充分时把对应槽位 `status` 升到 `ready` 并填充 `data`，让 ArtifactRenderer 真正进入渲染分支；
      - 抽取结果严格对齐 `agentContracts` schema（gantt/timeline 字段名、chart 的 categories+series 形态）。
    - `src/services/output/publisher.ts.renderDraftAsTemplateMarkdown`：
      - 新增 `renderedArtifacts` 入参；
      - 「已渲染为可视化对象」hint 区块改为以 `renderedArtifacts.slotId` 集合为开关：实际渲染成功的槽位才输出已渲染提示，否则回退到「待补充数据」清单；
      - 杜绝「明明没图却写已渲染」的错觉占位。
  - **Step 7：本节追加到 history.md**（按 project rule，仅更新唯一 .md 文件，不新建）。
- **数据流影响**：
  - IM → Planner → MCP search-doc → MCP fetch-doc 全文（清洗 `<hb>`）→ Writer evidence 含真实正文；
  - Writer 抽取真实数据点 → chart/gantt/timeline status=ready + data；
  - ArtifactRenderer 优先调 MCP `upload-media + whiteboard:node:create`，失败回 OpenAPI/lark-cli，再回本地 `mmdc` PNG；
  - publisher 仅在 renderedArtifacts 中真正包含 slotId 时输出「已渲染」提示；
  - Compliance 通过且未命中污染语料的稿子，才写回 HMRS templates_wing / style_drawer。
- **验证**：
  - 运行 purge 脚本：本地条目按预期下线（catalog -1 / index -5 / writeback -9 / runtime-memories owner 重置），随后删除脚本与空 `src/scripts/` 目录；
  - `npx tsc --noEmit -p tsconfig.json` 通过；
  - `ReadLints` 对所有改动文件无新增问题。
- **当前项目结构（本次变更范围）**：
  - 写回质量门控：`src/services/hmrs/writeback/memoryWritebackService.ts`
  - MCP / OpenAPI / 调度策略：`src/services/toolGateway/feishuMcpAdapter.ts`、`src/services/toolGateway/priority.ts`
  - 检索深读消费：`src/services/resourcePool/screening.ts`
  - Writer 与渲染：`src/services/agent/writerAgent.ts`、`src/services/render/artifactRenderer.ts`、`src/services/output/publisher.ts`
  - 依赖：`package.json`（`@mermaid-js/mermaid-cli` devDep）
  - 文档：`history.md`（本文件追加 v0.5 章节）
  - 一次性资产已清理：`src/scripts/purgeOwnerPollutedMemory.ts`、空目录 `src/scripts/` 已按 user rule 删除

## 2026-05-07（v0.5.1 Writer slot 缺字段守护）

- **现象**：
  - v0.5 上线后第一轮跑团队工作周报，Writer LLM 返回 chartSlots 但缺 `metricHint`，DraftSchema 直接挂掉，触发 `严格真实模式：Writer 失败且不允许兜底占位稿。chartSlots[0..2].metricHint Required`。
- **根因**：
  - LLM 偶发会输出缺必填字段的 chart/timeline/gantt 槽位（`metricHint / slotId / periodHint / task`）；
  - 之前 `repairDraftPayload` 直接把 `record.chartSlots` 透传，没补全必填字段；retry 也只是请求模型再来一次，未做结构归一化。
- **处理**：
  - `src/services/agent/writerAgent.ts`：
    - 新增 `normalizeChartSlotsArray / normalizeTimelineSlotsArray / normalizeGanttSlotsArray`：对 LLM 返回的每个 slot 元素，按 `slotId / chartType / title / metricHint / periodHint / task` 等必填字段补默认值（仅补结构，不编造业务数据）。
    - 新增 `preNormalizeDraftPayload`：在 `DraftSchema.safeParse` 之前先做轻量结构归一化。
    - `writeDraft` 主链：first-pass 与 retry 之前都先调用 `preNormalizeDraftPayload`，retry 仍失败时再走 `repairDraftPayload`，保证「LLM 缺字段」场景下不会一路抛到上层；retry prompt 文案显式提示「每个 chartSlots/timelineSlots/ganttSlots 元素必须含 slotId 与各自必填字段」。
    - `repairDraftPayload`：`record.{chart,timeline,gantt}Slots` 也改为先经 normalize，再回退到 `v2.*` 兜底骨架。
- **验证**：
  - `npx tsc --noEmit -p tsconfig.json` 通过；
  - `ReadLints` 对本次改动文件无新增问题。
- **当前项目结构（本次变更范围）**：
  - 修改：`src/services/agent/writerAgent.ts`
  - 文档：`history.md`（本文件追加 v0.5.1 章节）

## 2026-05-07（v0.5.2 evidence 反污染 + 槽位 data 智能注入 + 发布前质量门控）

- **现象**：
  - v0.5/v0.5.1 上线后再跑「团队工作周报」，云端文档仍是「围绕 docID 为空错误日志」的纯文字稿，没有甘特/时间线/图表，且生成出"图表槽位（待补充数据）"占位段。
  - 终端日志关键证据：
    - `[hmrs-writeback] draft quality gate rejected ... reasons: ["summary_too_short(67)","summary_contains_polluted_phrase","section_polluted:..."]`：v0.5 的写回门控正确拒绝了垃圾稿（说明 HMRS 自身已不会再被污染），但污染仍来自上游；
    - `chartHits:0, timelineHits:0, ganttHits:0, artifactCount:0`：ArtifactRenderer 完全没出图；
    - 模型 evidence 显示有 6 篇外部文档共 1529 字符，但全是请求 trace 哈希 `2026050712174519F83A96235AD1763BF6` 这类系统失败痕迹。
- **根因（三连问）**：
  1. **evidence 来源被污染**：用户云盘里残留的"过往失败日志/占位文档"被 `search-doc` 命中，`fetch-doc` 深读出来的就是错误日志正文 → Analyst/Writer 把它当真实素材"分析与撰写" → 整篇都在描述 docID 为空。
  2. **chartSlots 即使被 LLM 输出，data 也是空**：`preNormalizeDraftPayload` 只补必填结构，不会主动注入 data；`buildDraftV2Extensions` 的 evidence 抽取仅在 `record.chartSlots` 缺失时才走，LLM 返了空槽就被原样 schema 通过 → ArtifactRenderer 的 `status === "ready" && data 非空` 双条件不满足，整链不出图。
  3. **publisher 没做发布前门控**：MemoryWritebackService 的门控只防 HMRS 污染，云端飞书文档照发，用户看到的仍是污染正文。
- **处理**：
  - **A. evidence 反污染（双层）**：
    - 新增 `src/shared/evidenceQuality.ts`：`detectDocumentPollution({title, content})` 综合判定 `VALIDATION:\d+` 编码、连续 ≥2 个失败哈希、结构化失败关键词（`文档ID为空/参数校验失败/兜底占位稿/Writer 失败` 等），软提示（`无法获取/缺失/占位`）累计 ≥3 才算污染，避免误伤正常业务文档。
    - `src/services/toolGateway/feishuMcpAdapter.ts.deepFetchSearchHits`：每篇 fetch-doc 拉到正文后立即跑 `detectDocumentPollution`，命中即丢弃整篇，并 `WARN` 记录 `droppedByPollution / keptCount` 便于追踪。
    - `src/services/resourcePool/screening.ts.fetchExternalCandidates`：在 docs → resourceSummary 之前再跑一次同样过滤（兼容 listDocuments 路径与未来 adapter 升级），双保险。
  - **B. 槽位 data 智能注入**（v0.5 抽取逻辑的二次接入）：
    - `src/services/agent/writerAgent.ts` 新增 `enrichDraftSlotsWithSectionEvidence(draft)`：DraftSchema 校验通过后扫一遍 chart/timeline/gantt 槽位；任意槽位 `status !== ready` 或 `data` 为空时，用 `extractGanttDataFromSections / extractTimelineDataFromSections / extractChartDataFromSections` 从已写好的 sections 里启发式抽真实数据回填，并升级 `status=ready`；抽不到就保持 `needs_data`，让模板层走「待补充」清单（不再编造数据）。
    - 在 `writeDraft` 主链 first-pass / repair / retry / retry+repair 四条路径成功后都接入 enrich，并在 telemetry 增 `readyChartSlots / readyGanttSlots / readyTimelineSlots` 字段，定位"为什么没出图"问题更直接。
  - **C. publisher 发布前质量门控**：
    - `src/services/output/publisher.ts.publishFeishuDoc`：发布前先调 `evaluateDraftQuality(draft)`，命中时：
      1. 用 `renderQualityRejectMarkdown` 把云端正文换成「自检稿」（说明命中原因 + 建议补素材的下一步），保留原 title；
      2. 跳过 artifact 附加，避免在污染稿上插入图表造成误导；
      3. IM 通知文案改为「报告生成已暂缓，已发布自检稿到云端，请补素材后重试」；
      4. `publish-telemetry` 增 `publish_status: quality_reject_note / quality_reject_published` 与 `reasons` 字段，返回 `PublishedArtifact.status = "fallback"`。
    - 复用 `MemoryWritebackService.evaluateDraftQuality`，避免 publisher 与 writeback 双轨判定漂移。
- **验证**：
  - `npx tsc --noEmit -p tsconfig.json` 通过；`ReadLints` 对所有改动文件无问题。
  - 期望端到端：
    - 用户云盘里残留的失败日志/占位文档不再进 evidence；
    - 真实素材命中时，Writer 输出 chart/timeline/gantt 槽位经 enrich 升到 `ready` → ArtifactRenderer 真出图（MCP 优先 / OpenAPI / mmdc PNG 三层回退）；
    - 即使 Writer 输出退化成污染稿，publisher 发到云端的也是自检说明稿，不会再让用户看到「整篇 docID 为空」的正文。
- **当前项目结构（本次变更范围）**：
  - 新增：`src/shared/evidenceQuality.ts`（共享文档污染判定）
  - 修改：`src/services/toolGateway/feishuMcpAdapter.ts`（deepFetch 污染过滤）
  - 修改：`src/services/resourcePool/screening.ts`（外部候选二次过滤）
  - 修改：`src/services/agent/writerAgent.ts`（`enrichDraftSlotsWithSectionEvidence` 接入 4 条成功路径）
  - 修改：`src/services/output/publisher.ts`（发布前 evaluateDraftQuality 门控 + 自检稿 + 通知改写）
  - 文档：`history.md`（本文件追加 v0.5.2 章节）

## 2026-05-07（v0.5.3 Writer 槽位 data 字符串胁迫；模板蒸馏断链根因诊断）

### 1. Writer 紧急 schema bug（已修）

- **现象**：`严格真实模式：Writer 失败 ... chartSlots[0].data.series[0].values[0..2] Expected number, received string`。
- **根因**：LLM 偶发把 `chartSlots[0].data.series[0].values` 输出为字符串数组（如 `["12","8","3"]` 或带单位 `"12%"`），DraftSchema 要求 `number[]`，校验直接挂掉。v0.5.1 的 `preNormalizeDraftPayload` 只补必填字段，不做类型胁迫；v0.5.2 的 `enrichDraftSlotsWithSectionEvidence` 在 schema 校验之后才跑——此路径无法救。
- **处理（`src/services/agent/writerAgent.ts`）**：
  - 新增 `coerceNumber(v)`：`"12" / "12%" / "1,234" / "12人"` → 12，剥离 `%, , 元万项个次人份天小时`，非有限值返 `null`。
  - 新增 `coerceString(v)`：number/boolean → string，去空白。
  - 新增 `coerceChartSlotData(rawData, fallbackChartType)`：
    - `categories` 强制 string 数组（丢空串）；
    - `series[].values` 用 `coerceNumber` 转换并过滤 NaN；
    - `series[].name` 缺失时填 `数值N`；
    - 胁迫后空数据则丢弃 `data` 字段，让 enrich 接管。
  - 新增 `coerceChartDataSemantic(raw, chartType)`：`kind` 不在 `line/bar/pie/table/image` 时按 `chartType` 推导兜底。
  - 新增 `coerceTimelineData / coerceGanttData`：兼容 LLM 用 `title/date/from/to/responsible` 等异名字段；任一关键字段（label+when 或 task+start+end）缺失即丢弃该条。
  - `normalizeChartSlotsArray / normalizeTimelineSlotsArray / normalizeGanttSlotsArray` 全部接入对应的 `coerce*` 函数；preNormalize 阶段就把 LLM 输出的脏类型清理干净。
- **验证**：`npx tsc --noEmit` 通过；`ReadLints` 全绿。

### 2. 模板蒸馏断链根因（已诊断，v0.6 修复，本版本仅文档化）

- **用户期望工作流**：与用户对话 → 回顾历史偏好 → 阅读用户上传的素材与模板 → 自主完成结构规划/资料整理/内容撰写。
- **当前实测发现**（在排查"为什么生成的内容跟模板完全不像"时挖出来的）：
  - 用户已经把 5 篇模板（团队工作周报 / 业务经营周报 / 个人工作日报 / 会议记录简洁版 / 长期方案与执行）放进飞书云盘的 `templates_wing/<room>/structure_drawer` 子目录。
  - **但**：
    1. `.env` 中 `FEISHU_RESOURCE_FOLDER_TOKEN` 为空，`HMRS_MANAGED_FOLDER_TOKENS` 为空 —— `buildHybridResourcePoolFromFeishuFolder` 不会自动扫这些子目录；
    2. `hmrs-catalog.json` 里 **没有** `wingId === "templates_wing"` 的条目（用户手动放进云盘的文件，HMRS 自身并没有触发 `HmrsIngestService.ingestManagedFolder({bucketRole:"template_example"})` 把它们登记进 catalog/index）；
    3. `hmrs-index.json` 里少数 `TemplateStructureIndex` 条目的 `structureSummary` 实际是 search-doc 命中后的 snippet（如 "团队工作周报 文档候选：团队工作周报"），不是真正的章节骨架；
    4. `deepRetrieveContext` 中 `fetchDetailByExpansion` 不返回 `templateDistillation`，`buildFallbackTemplateDistillation` 仅按 `plan.targetSections` 反向回填空壳 profile（既无 listPatterns 也无 styleRules）；
    5. `useStrictTemplatePipeline` 因此恒为 false → `WriterPrompt.templateBlock` 不启用 → Writer 完全看不到用户那 5 篇模板的章节顺序、字段标签、列表语法、文风样本。
- **结果**：Writer 只能按 `selectedSkill.sections`（`["执行摘要","关键进展","下一步计划"]` 这种默认）写，自然"和模板完全不像"。
- **v0.6 待办闭环**（已在本次会话明确，下一阶段实施，不在本次提交范围）：
  1. **模板自动纳管**：当 user 把 docx 放进 `templates_wing/<report_room>/structure_drawer` 后，HMRS 应自动 / 半自动调用 `HmrsIngestService.ingestManagedFolder({bucketRole:"template_example"})` 触发结构提取；推荐路径是给前端"模板抽屉"加个"立即扫描"按钮，触发 `MemoryFacade.refreshManagedFolders` 时把 `templates_wing` 子目录也一起 list/ingest。
  2. **真正的模板结构提取**：扩展 `summaryBuilder.buildDocumentIndexes`，对模板 docx 调用 `toolGateway.viewDocument` 拉正文，按 `## 标题` / 中文小标题行抽取章节骨架，把 `structureSummary` 从"标题摘要"升级为 JSON 化的 `{sectionOrder, listPatterns, styleSample}`；同时把 LLM 蒸馏 (`distillOneDocument`) 扩展一个 `distillFromHmrsDetails` 入口，从 raw text 直接蒸馏 `TemplateProfile`。
  3. **模板蒸馏注入 HMRS 通道**：在 `deepRetrieveContext` / `fetchDetailByExpansion` 加一步：当 `selectedSkillId` 形如 `user-template-*` 或 `hmrs_tpl_*`、或 `expansion.finalResourceIds` 含 `templates_wing` 来源时，把对应 `sourceDetail.detail` 跑一遍 `distillFromHmrsDetails`，结果合并进 `templateDistillation.profilesByResourceId`，让 `useStrictTemplatePipeline` 真正生效。
  4. **WriterPrompt 兜底文风**：在 `templateBlock` 启用时，强制把 `anonymizedStyleSample`、`listPatterns`、`forbiddenPatterns` 拼到 user prompt（当前仅在 `pool_template_profile` JSON 序列化片段里出现，模型不一定能吃透）。
  5. **诊断 telemetry**：在 `hmrsExpansionNode` 输出 `template_profiles=N` 之外，加 `pool_doc_count / strict_pipeline_enabled / template_skill_match` 字段，便于下次 5 分钟内定位"为什么没走严格模板"。
- **当前用户的临时绕行办法**（不改代码也能用）：
  1. 在 `.env` 设 `HMRS_MANAGED_FOLDER_TOKENS=<5 个 docx 所在的文件夹 token>`，重启 server，让现有的 HMRS 纳管逻辑把它们扫进 catalog；
  2. 或者在飞书 IM 发消息时在 prompt 里**显式带上"以这个文档为模板：<5 个链接之一>"** —— 触发 `userWantsPoolDocumentTemplate`（关键词"作为模板/这个文档"），让 `shouldHonorPoolDocumentStructure` 返回 true，绕过 `templateDistillation` 走 `pool_doc` 旁路。
- **当前项目结构（本次变更范围）**：
  - 修改：`src/services/agent/writerAgent.ts`（新增 `coerceNumber / coerceString / coerceChartSlotData / coerceChartDataSemantic / coerceTimelineData / coerceGanttData`，三个 `normalize*SlotsArray` 全部接入）
  - 文档：`history.md`（追加 v0.5.3 章节，含 v0.6 模板蒸馏接入蓝图）

---

## v0.6 — 模板蒸馏接入全链路修复（2026-05-07）

### 根因回顾（三处断链）

| 断链编号 | 位置 | 症状 |
|---|---|---|
| Gap 1 | `ingestManagedFolder` 写云盘 JSON，`fetchDetailByExpansion` 从不回读 | 云盘 structureDrawer 里的模板 JSON 永远不进入检索链路 |
| Gap 2 | `bucketParentPath` 传 `examplesDrawer` 完整路径 | 写入路径变成嵌套的 `示例抽屉/结构抽屉` 而非正确的 `周报模板房间/结构抽屉` |
| Gap 3 | 本地 `hmrs-catalog.json` / `hmrs-index.json` 无 `templates_wing` 条目 | `templateSkillStore.loadTemplates()` 找不到模板，`useStrictTemplatePipeline` 恒为 false |

### 修复内容（4 个模块）

#### 模块 A：修复 bucketParentPath + 动态 room 发现（消除 Gap 2）

- **`src/services/hmrs/hmrsStructureBuilder.ts`**
  - `HMRS_FOLDER_NAMES` 新增 `dailyReportRoom: "日报模板房间"` 和 `bizWeeklyRoom: "业务周报模板房间"` 两个键
  - `buildRequiredFolders()` 同步追加这两个 room 的 structureDrawer / examplesDrawer 路径，自动确保云盘文件夹存在

- **`src/services/hmrs/hmrsRefreshService.ts`**
  - `discoverHmrsBucketSources` 重写为**动态枚举** `templates_wing` 下所有 room 子目录：`listChildFolders(userId, templatesWingToken)` 枚举所有 room，对每个 room 扫描 `示例抽屉`；有文档即加入 sources
  - `parentPath` 传 **room 路径**（不含 `/示例抽屉` 最后一段），根本修复 Gap 2 的错误写入路径问题
  - 新增 room 或用户自建额外模板房间，无需修改代码自动兼容

#### 模块 B：lark-cli outline 提取 + JSON structureSummary（为 Gap 1/3 提供数据源）

- **`src/services/toolGateway/capabilities.ts`** — 新增 `"document.outline"` capability

- **`src/services/toolGateway/types.ts`** — `FeishuToolGatewayApi` 接口新增 `fetchDocumentOutline(documentId, context?): Promise<string[]>`

- **`src/services/toolGateway/priority.ts`** — `document.outline` 优先级 `["lark_cli", "mcp", "openapi"]`（lark-cli 是唯一支持该操作的 adapter）

- **`src/services/toolGateway/larkCliAdapter.ts`**
  - 新增 `extractOutlineSections(raw)` 辅助函数：兼容多种返回形态（outline 字符串/items 数组/sections 数组/包装层）
  - 实现 `fetchDocumentOutline`：调用 `docs +fetch --api-version v2 --scope outline --doc <id>`，失败时静默返回 `[]`

- **`src/services/toolGateway/feishuMcpAdapter.ts`** — 新增 `fetchDocumentOutline` stub，抛 `NOT_SUPPORTED`，让 ToolGateway 自动 fallback 到 lark-cli

- **`src/services/toolGateway/feishuOpenApiAdapter.ts`** — 同上，stub 抛 `NOT_SUPPORTED`

- **`src/services/toolGateway/gateway.ts`** — 新增 `fetchDocumentOutline` 路由，使用 `executeWithPolicy("document.outline", ...)` + 捕获所有异常返回 `[]`（永不抛出，不阻塞主链路）

- **`src/services/hmrs/summaryBuilder.ts`** — `DocumentIndexEntry` 新增可选字段 `structureSummary?: string`；`buildDocumentIndexes` 接收 `GatewayDocument & { structureSummary?: string }[]` 并透传 `structureSummary`

- **`src/services/hmrs/hmrsIngestService.ts`**
  - 新增辅助函数 `inferReportType(title)` 和 `extractHeadingsFromContent(content)` 用于 fallback 时从正文提取章节标题
  - 对 `template_example` 桶中每篇文档：调用 `toolGateway.fetchDocumentOutline(doc.token)`，成功则组装 `{"sectionOrder":[...],"reportType":"..."}` JSON 字符串
  - fallback：从正文中提取 `## 标题` 行，同样组装 structureSummary
  - 写入的 `docIndexes` 条目携带 `structureSummary`，存入云盘 JSON artifacts

#### 模块 C：syncTemplateArtifactsToLocalCatalog（消除 Gap 1 + Gap 3）

- **`src/services/hmrs/hmrsRefreshService.ts`**
  - 新增 `syncTemplateArtifactsToLocalCatalog(userId, rootFolderToken, repo)` 函数
  - 流程：枚举 `templates_wing` 下所有 room → 扫描每个 room 的 `结构抽屉` → 读取所有 `.json` 文件 → 解析 `items[].{docToken, title, structureSummary}` → 构造 `L1CatalogObject`（type=`TemplateStructureIndex`，wingId=`templates_wing`） 和 `L2IndexObject`（structureSummary=JSON字符串） → 调用 `FileCatalogRepository.upsert` / `FileIndexRepository.upsert` 写入本地
  - 在 `refreshForUser` 主循环结束后异步（void + catch）调用，不阻塞刷新主链路

#### 模块 D：fetchDetailByExpansion 自动注入 TemplateProfile（消除 Gap 3 后半段）

- **`src/services/hmrs/expand/detailRetrievalService.ts`**
  - 新增 `buildTemplateProfileFromL2StructureSummary(resourceId, title, jsonStr)` — 解析 `structureSummary` JSON，构建完整 `TemplateProfile`（sectionOrder/styleRules/slotHints）
  - 新增 `buildTemplateDistillationFromExpanded({expandedL2Ids, userId})` — 查询本地 `FileIndexRepository`，过滤 `type === "TemplateStructureIndex"` 的 L2 条目，批量构建 `profilesByResourceId`，返回 `TemplateDistillation`
  - `fetchDetailByExpansion` 在返回前调用 `buildTemplateDistillationFromExpanded`，结果合并到 `DetailedContext.templateDistillation`
  - `useStrictTemplatePipeline`（在 `src/prompts/templateIntent.ts`）检测到 `profilesByResourceId` 非空后自动激活，Writer 将按模板真实 sectionOrder 写作

### 数据流变化（修复后）

```
用户将模板 docx 放入 "模板知识库/<room>/示例抽屉"
↓ hmrsSummaryNode 刷新时
discoverHmrsBucketSources（动态枚举所有 room）
↓
ingestManagedFolder（bucketParentPath = roomPath）
↓
fetchDocumentOutline（lark-cli docs +fetch --scope outline）
↓ → structureSummary = '{"sectionOrder":[...],"reportType":"..."}'
写入云盘 结构抽屉/*.json
↓ syncTemplateArtifactsToLocalCatalog
L1(type=TemplateStructureIndex) + L2(structureSummary) 写入本地 catalog/index
↓ hmrsExpansionNode → fetchDetailByExpansion
buildTemplateDistillationFromExpanded 检测 TemplateStructureIndex → 构建 TemplateProfile
↓
DetailedContext.templateDistillation.profilesByResourceId 非空
↓
useStrictTemplatePipeline = true → WriterPrompt.templateBlock 启用
↓
Writer 按真实 sectionOrder 写作 ✓
```

### 关键文件变更汇总

| 文件 | 变更类型 | 说明 |
|---|---|---|
| `src/services/hmrs/hmrsStructureBuilder.ts` | 修改 | 新增 dailyReportRoom/bizWeeklyRoom，buildRequiredFolders 追加路径 |
| `src/services/hmrs/hmrsRefreshService.ts` | 修改 | 动态 room 发现、bucketParentPath 修复、syncTemplateArtifactsToLocalCatalog |
| `src/services/hmrs/hmrsIngestService.ts` | 修改 | inferReportType/extractHeadingsFromContent、outline 提取、structureSummary JSON |
| `src/services/hmrs/summaryBuilder.ts` | 修改 | DocumentIndexEntry 新增 structureSummary 字段，buildDocumentIndexes 透传 |
| `src/services/toolGateway/capabilities.ts` | 修改 | 新增 `document.outline` |
| `src/services/toolGateway/types.ts` | 修改 | FeishuToolGatewayApi 新增 fetchDocumentOutline 声明 |
| `src/services/toolGateway/priority.ts` | 修改 | `document.outline` 优先级 `lark_cli > mcp > openapi` |
| `src/services/toolGateway/larkCliAdapter.ts` | 修改 | extractOutlineSections、fetchDocumentOutline 实现 |
| `src/services/toolGateway/feishuMcpAdapter.ts` | 修改 | fetchDocumentOutline stub（NOT_SUPPORTED） |
| `src/services/toolGateway/feishuOpenApiAdapter.ts` | 修改 | fetchDocumentOutline stub（NOT_SUPPORTED） |
| `src/services/toolGateway/gateway.ts` | 修改 | fetchDocumentOutline 路由（永不抛出） |
| `src/services/hmrs/expand/detailRetrievalService.ts` | 修改 | buildTemplateDistillationFromExpanded、自动注入 TemplateProfile |
| `history.md` | 修改 | 追加 v0.6 章节 |

### 验证

- `npx tsc --noEmit` 通过（全部 4 个模块完成后验证）

### 当前项目整体结构

```
d:\飞书办公Agent\
├── src/
│   ├── config/          env 配置
│   ├── graph/           LangGraph 节点（hmrsSummaryNode, hmrsExpansionNode, etc.）
│   ├── integrations/    飞书 IM/OAuth 集成
│   ├── prompts/         LLM prompt 构建（含 templateIntent.ts）
│   ├── schemas/         Zod schema（agentContracts, templateProfile, layerSchemas）
│   ├── services/
│   │   ├── agent/       Writer/Planner/Analyst/SkillRouter agents
│   │   ├── hmrs/        HMRS 核心（Ingest/Refresh/Expand/Writeback/Facade）
│   │   │   ├── expand/  detailRetrievalService（v0.6 新增 TemplateProfile 注入）
│   │   │   ├── model/   layerSchemas
│   │   │   └── repo/    FileCatalogRepository / FileIndexRepository
│   │   ├── output/      publisher（含 quality gate）
│   │   ├── render/      artifactRenderer（mermaid-cli + MCP）
│   │   ├── retrieval/   deepRetriever / engine
│   │   ├── resourcePool/ screening / evidence pollution filter
│   │   └── toolGateway/ ToolGateway（MCP / lark-cli / OpenAPI 三适配器）
│   ├── shared/          logger, evidenceQuality（污染检测）
│   └── data/hmrs/       hmrs-catalog.json, hmrs-index.json（本地 L1/L2 存储）
├── history.md           变更日志（本文件）
└── package.json
```
