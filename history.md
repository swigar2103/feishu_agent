# 项目变更记录

## 2026-05-05

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
