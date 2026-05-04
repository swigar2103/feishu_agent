# 项目变更记录

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
