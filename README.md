# 飞书办公 Agent 协同系统（Tool Gateway 版）

本项目已从线性流程重构为多阶段 Agent 工作流，并新增 **Tool Gateway**：

- 上层 Agent（Planner / Analyst / Writer / Reviewer / Memory）不变
- 外部能力统一通过 Tool Gateway 调用
- Tool Gateway 默认策略：**优先 MCP，失败自动回退 OpenAPI/SDK**
- 可选增强：文档发布可切换为 **lark-cli 优先**，失败后自动回退 Gateway

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

### 2.3 lark-cli 文档增强（可选）

- 开启后（`FEISHU_DOC_PUBLISH_STRATEGY=lark_cli_first` 且 `LARK_CLI_ENABLED=true`）：
  - `viewDocument/createDocument/updateDocument` 优先走 `LarkCliAdapter`
  - `LarkCliAdapter` 内部调用：`docs +fetch` / `docs +create` / `docs +update`
  - CLI 异常自动回退原 Gateway（MCP -> OpenAPI）
- 适用目标：增强报告发布阶段的标准化（命令契约、状态校验、fetch 复核），而不是替代现有 LangGraph 生成链路。

### 2.4 官方 workflow skill 优先级规则

- `Skill Router` 优先尝试命中官方 workflow skill（如 `standup-report`、`meeting-summary`），命中后写入 `workflowMeta`（含 `workflowSourceId`、`outputTargets`、`reviewRules`）。
- 若未命中官方 workflow，再回退 `src/skills` 与 `SKILLS` 的自定义业务技能。
- 叠加规则：
  - 官方 workflow skill 可以与用户 style memory 共同生效；
  - 官方 workflow 的 `reviewRules` 会参与 Reviewer 审查；
  - 自定义 reviewer 规则仍保留，不会被替换。

---

## 3. 哪些模块已接入 Tool Gateway

- `Resource Screening`
  - 保留规则粗筛 + LLM 兜底
  - 候选不足时通过 Gateway 补充文档/用户资源
- `Retriever`
  - 对候选资源深读时通过 Gateway 调用文档查看、文件内容、评论读取
- `Output Generator`（经 `publisher`）
  - 文档输出支持策略切换：`gateway_only`（默认）或 `lark_cli_first`（失败自动回退）
- `Resource Pool Manager`（轻度）
  - 联系人信息可通过 Gateway 补充用户详情

---

## 4. 飞书事件接入（P1 / P2）

### 4.1 Webhook 消息处理

`src/api/phase1.ts` 已支持：

- `POST /api/feishu/webhook`
  - `url_verification` challenge
  - 明文消息事件解析（忽略应用自身发送的消息）
  - **默认（`FEISHU_BOT_PIPELINE=full`）**：异步触发 `runReportPipeline`（LangGraph 全链路），回发“结果链接为主 + 结构化摘要为辅 + 状态卡片交互”
  - **`FEISHU_BOT_PIPELINE=phase1`**：异步触发 `handleBotMessageText`（云文档模板链），并回发「生成文档」交互卡片
  - 回调尽快返回 200，避免飞书网关超时

> 当前加密事件体 `encrypt` 仍为占位提示，后续可补解密逻辑。

### 4.2 卡片回调

- `POST /api/feishu/card-callback`
  - 支持卡片动作 `mark_done` / `continue_generate` / `need_more_info`
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
- `FEISHU_IDENTITY_MODE`：`bot_default`（推荐，服务端应用身份主导）或 `user_default`（联调）
- `FEISHU_USER_OAUTH_REDIRECT_URI`：用户授权增强回调地址（需与开放平台一致）
- `FEISHU_USER_OAUTH_SCOPES`：用户授权增强 scopes（空格分隔）
- `FEISHU_USER_OAUTH_AUTHORIZE_URL`：用户授权页地址（默认内置）
- `FEISHU_WRITABLE_DATA_DIR`（可选）：记忆/资源池 JSON 的目录；Vercel 未设置时默认 `/tmp/feishu-agent-data`（避免只读盘）
- `FEISHU_VERIFICATION_TOKEN`（可选）：与开放平台事件配置里的 **Verification Token** 一致；配置后 URL 校验请求会校验 token，避免误配后台时仍显示通过

### 6.3 Tool Gateway MCP（可选但推荐）

- `FEISHU_MCP_URL`
  - 示例：`https://mcp.feishu.cn/mcp`
  - 留空则直接走 fallback adapter
- `FEISHU_MCP_ALLOWED_TOOLS`
  - 逗号分隔工具白名单

### 6.4 lark-cli（可选增强）

- `LARK_CLI_ENABLED`：`auto`/`true`/`false`
- `LARK_CLI_BIN`：可执行文件名或绝对路径（默认 `lark-cli`）
- `LARK_CLI_PROFILE`：可选 profile
- `LARK_CLI_DEFAULT_AS`：默认身份（推荐 `bot`，作为服务端主流程）
- `LARK_CLI_TIMEOUT_MS`：单次命令超时（毫秒）
- `LARK_CLI_FOLDER_TOKEN`：`docs +create` 目标目录；为空时回退 `FEISHU_TARGET_FOLDER_TOKEN`
- `FEISHU_DOC_PUBLISH_STRATEGY`：`gateway_only`（默认）或 `lark_cli_first`
- `LARK_CLI_CMD_DOCS_SEARCH`：文档搜索命令模板（支持 `{query}`）
- `LARK_CLI_CMD_CONTACT_SEARCH`：用户搜索命令模板（支持 `{query}`）
- `LARK_CLI_CMD_CONTACT_GET`：用户详情命令模板（支持 `{userId}`）
- `LARK_CLI_CMD_SLIDES_CREATE`：Slides 创建命令模板（支持 `{title}`、`{outline}`）
- `FEISHU_SLIDES_DELIVERY_LEVEL`：`outline_only`（默认）或 `artifact_best_effort`

初始化示例：

```bash
npm install -g @larksuite/cli
npx skills add larksuite/cli -y -g
lark-cli config init --new
lark-cli auth status
```

用户授权增强（可选，仅在需要用户私域资源时）：

```bash
# 1) 服务端生成授权链接（示例）
GET /api/feishu/auth/start?userId=ou_xxx

# 2) 用户浏览器完成授权后由回调落库
GET /api/feishu/auth/callback?code=...&state=...

# 3) 查询授权状态
GET /api/feishu/auth/status?userId=ou_xxx
```

### 6.5 Resource Screening 阈值

- `RESOURCE_SCREENING_MIN_CANDIDATE_COUNT`：本地候选最小数量阈值，低于该值才触发外部补检索。
- `RESOURCE_SCREENING_MIN_CANDIDATE_SCORE`：topN 平均分阈值，低于该值才触发外部补检索。
- 目标：避免“逢任务就外部查”，保留 Resource Pool 本地价值并控制延迟。

---

## 6.6 IM 回归检查（建议）

建议至少覆盖以下场景：

1. 未授权用户（`FEISHU_IDENTITY_MODE=bot_default`）：
   - 可收到“处理中”卡片
   - 完成后可收到成果链接卡片（文档/演示稿）
2. 已授权用户（调用 `/api/feishu/auth/start` 完成授权）：
   - `/api/feishu/auth/status?userId=...` 返回 `authorized=true`
   - 同类请求可继续走增强路径（日志会带 `userOAuthReady=true`）
3. 卡片发送失败：
   - 自动回退文本摘要，不丢主结果
4. 产物部分失败：
   - 结果卡片状态显示“部分完成”，并保留已成功链接

---

## 7. API 一览

- `POST /generate-report`：Agent 主流程生成
- `POST /generate-report-docx`：导出 Word
- `POST /resource-pool/sync`：手动资源治理同步
- `POST /api/phase1/mvp`：Phase1 手动触发
- `POST /api/phase1/bot-message`：机器人文本入口
- `POST /api/feishu/webhook`：飞书事件回调
- `POST /api/feishu/card-callback`：卡片动作回调
- `GET /api/feishu/auth/start`：生成用户授权增强链接
- `GET /api/feishu/auth/callback`：用户授权增强回调
- `GET /api/feishu/auth/status`：查询用户授权状态
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
