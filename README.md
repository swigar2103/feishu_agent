# 飞书办公 Agent 协同系统（Tool Gateway 版）

本项目已从线性流程重构为多阶段 Agent 工作流，并新增 **Tool Gateway**：

- 上层 Agent（Planner / Analyst / Writer / Reviewer / Memory）不变
- 外部能力统一通过 Tool Gateway 调用
- Tool Gateway 默认策略：**优先 MCP，失败自动回退 OpenAPI/SDK**

---

## 1. 在线主流程（LangGraph）

主流程由 `src/graph/reportGraph.ts` 执行：

1. `Request Guard`
2. `Resource Screening`
3. `Intent Agent`
4. `Skill Router`
5. `Planner Agent`
6. `Retriever`
7. `Analyst`
8. `Writer`
9. `Style Reviewer`
10. `Compliance Reviewer`
11. `Output Generator`
12. `Memory Update`
13. `Resource Pool Enricher`

### Callback 回环

- 风格不通过 -> 回 `Writer`
- 结构/缺失问题 -> 回 `Planner`
- 数据/口径问题 -> 回 `Analyst`

---

## 2. Tool Gateway 设计（本次重点）

新增统一工具层：

- `src/services/toolGateway/types.ts`
- `src/services/toolGateway/feishuMcpAdapter.ts`
- `src/services/toolGateway/feishuOpenApiAdapter.ts`
- `src/services/toolGateway/gateway.ts`

### 2.1 能力覆盖

对外统一暴露：

- 文档：`search/list/view/getFileContent/create/update`
- 评论：`getComments/addComment`
- 用户：`searchUsers/getUserInfo`

### 2.2 路由策略

每个工具调用遵循：

1. 先调用 `FeishuMcpAdapter`
2. 失败后自动调用 `FeishuOpenApiAdapter`

上层模块不直接依赖 MCP/OpenAPI 细节。

---

## 3. 哪些模块已接入 Tool Gateway

- `Resource Screening`
  - 保留规则粗筛 + LLM 兜底
  - 候选不足时通过 Gateway 补充文档/用户资源
- `Retriever`
  - 对候选资源深读时通过 Gateway 调用文档查看、文件内容、评论读取
- `Output Generator`（经 `publisher`）
  - 文档输出优先走 Gateway 的创建/更新/评论
- `Resource Pool Manager`（轻度）
  - 联系人信息可通过 Gateway 补充用户详情

---

## 4. 飞书事件接入（P1 / P2）

### 4.1 Webhook 消息处理

`src/api/phase1.ts` 已支持：

- `POST /api/feishu/webhook`
  - `url_verification` challenge
  - 明文消息事件解析（忽略应用自身发送的消息）
  - **默认（`FEISHU_BOT_PIPELINE=full`）**：异步触发 `runReportPipeline`（LangGraph 全链路），在会话内分条发送文字报告
  - **`FEISHU_BOT_PIPELINE=phase1`**：异步触发 `handleBotMessageText`（云文档模板链），并回发「生成文档」交互卡片
  - 回调尽快返回 200，避免飞书网关超时

> 当前加密事件体 `encrypt` 仍为占位提示，后续可补解密逻辑。

### 4.2 卡片回调

- `POST /api/feishu/card-callback`
  - 支持卡片动作 `mark_done`
  - 收到后更新原卡片为“已处理”

---

## 5. 资源池与记忆持久化

- 资源池存储、记忆存储默认在可写数据目录下的 `resource-pool.json`、`runtime-memories.json`（本地为 `src/data/`；**Vercel Serverless** 上为 **`/tmp/feishu-agent-data`**，因部署目录只读）。
- 可通过环境变量 `FEISHU_WRITABLE_DATA_DIR` 覆盖目录。
- 资源治理入口：`POST /resource-pool/sync`

---

## 6. 环境变量

复制 `env.example` 为 `.env`，按下面配置。

### 6.1 基础模型

- `BAILIAN_API_KEY`
- `BAILIAN_BASE_URL`
- `BAILIAN_MODEL_ORCHESTRATOR`
- `BAILIAN_MODEL_WRITER`
- 可选：`BAILIAN_MODEL_EMBEDDING`

### 6.2 飞书基础（Phase1 + fallback）

- `FEISHU_BASE_URL`（默认 `https://open.feishu.cn`）
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_TEMPLATE_FILE_TOKEN`
- `FEISHU_TARGET_FOLDER_TOKEN`
- `FEISHU_COPY_NAME_PREFIX`
- `FEISHU_IM_NOTIFY_CHAT_ID`（可选）
- `FEISHU_BOT_PIPELINE`：`full`（默认，Webhook 走 LangGraph 全链路并发会话文字）或 `phase1`（云文档模板 + 卡片）
- `FEISHU_WRITABLE_DATA_DIR`（可选）：记忆/资源池 JSON 的目录；Vercel 未设置时默认 `/tmp/feishu-agent-data`（避免只读盘）
- `FEISHU_VERIFICATION_TOKEN`（可选）：与开放平台事件配置里的 **Verification Token** 一致；配置后 URL 校验请求会校验 token，避免误配后台时仍显示通过

### 6.3 Tool Gateway MCP（可选但推荐）

- `FEISHU_MCP_URL`
  - 示例：`https://mcp.feishu.cn/mcp`
  - 留空则直接走 fallback adapter
- `FEISHU_MCP_ALLOWED_TOOLS`
  - 逗号分隔工具白名单

---

## 7. API 一览

- `POST /generate-report`：Agent 主流程生成
- `POST /generate-report-docx`：导出 Word
- `POST /resource-pool/sync`：手动资源治理同步
- `POST /api/phase1/mvp`：Phase1 手动触发
- `POST /api/phase1/bot-message`：机器人文本入口
- `POST /api/feishu/webhook`：飞书事件回调
- `POST /api/feishu/card-callback`：卡片动作回调
- `GET /api/phase1/config-check`：飞书配置自检
- `GET /api/phase1/debug-resource-check`：模板/目标目录可读写探针
- `GET /healthz`：健康检查

---

## 8. 本地启动

```bash
npm install
npm run dev
```

类型检查：

```bash
npm run check
```

---

## 9. 飞书后台配置核对清单（刚需）

在飞书开放平台逐项确认：

1. 创建企业自建应用并获取 `App ID/App Secret`
2. 开启机器人能力并允许加入群
3. 配置事件订阅 URL：
   - `https://<你的公网域名>/api/feishu/webhook`
4. 订阅消息事件（如 `im.message.receive_v1`）
5. 配置卡片回调 URL：
   - `https://<你的公网域名>/api/feishu/card-callback`
6. 开通所需权限（至少包括消息收发、docx 读写、drive 文件能力）
7. 应用发布到可测试范围（企业成员/测试成员）

---

## 10. 联调顺序（推荐）

1. `.env` 填完整
2. `GET /api/phase1/config-check`
3. `GET /api/phase1/debug-resource-check?deleteProbeDoc=true`
4. `POST /api/phase1/mvp` 验证模板复制与写回
5. 再用群里 `@机器人` 验证 webhook 触发
6. 点击卡片按钮，验证 `card-callback` 更新

---

## 11. 关键代码入口

- 主流程入口：`src/services/reportPipeline.ts`
- LangGraph 图：`src/graph/reportGraph.ts`
- Graph 状态：`src/graph/state.ts`
- Agent contracts：`src/schemas/agentContracts.ts`
- Tool Gateway：`src/services/toolGateway/*`
- Resource Screening：`src/services/resourcePool/screening.ts`
- Retriever 深读：`src/services/retrieval/deepRetriever.ts`
- 输出发布：`src/services/output/publisher.ts`
- 飞书路由：`src/api/phase1.ts`
- 飞书 adapter：`src/integrations/feishu/*`
