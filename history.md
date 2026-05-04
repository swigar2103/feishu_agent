# 项目变更记录

## 2026-05-04

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
