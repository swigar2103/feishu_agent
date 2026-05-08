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
  - 逗号分隔工具白名单，须与[官方远程 MCP 工具名](https://open.feishu.cn/document/mcp_open_tools/supported-tools)一致（如 `search-doc`、`add-comments`、`fetch-file`）
- `FEISHU_DOC_PUBLISH_VERIFY_MIN_CHARS`（默认 `50`）
  - 发布后 `fetch-doc` 验收：正文最短字符数；`0` 表示跳过长度阈值（仍会校检标题关键字）

### 6.4 lark-cli（可选增强）

- `LARK_CLI_ENABLED`：`auto`/`true`/`false`
- `LARK_CLI_GUIDANCE_REQUIRED`：模板层是否强制注入 lark-cli guidance（`true` 时缺失即失败）
- `LARK_CLI_BIN`：可执行文件名或绝对路径（默认 `lark-cli`）
- `LARK_CLI_PROFILE`：可选 profile
- `LARK_CLI_DEFAULT_AS`：默认身份（推荐 `bot`，作为服务端主流程）
- `LARK_CLI_TIMEOUT_MS`：单次命令超时（毫秒）
- `LARK_CLI_FOLDER_TOKEN`：`docs +create` 目标目录；为空时回退 `FEISHU_TARGET_FOLDER_TOKEN`
- `FEISHU_DOC_PUBLISH_STRATEGY`：`gateway_only`（默认）或 `lark_cli_first`
- `FEISHU_DOC_LARK_CLI_HARD_PREFER`：禁止「仅 lark-cli」在失败后回退 OpenAPI（`true` 仅当你强制 CLI）；**MCP 联调阶段建议 `false`**
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

lark-cli 分层策略（当前实现）：

- 模板层（Skill/Prompt guidance）强制使用 lark-cli guidance，不可静默回退。
- 执行层按能力分流：
  - 文档创建/更新/发布：lark-cli 优先（可配置 hard-prefer）
  - 检索类能力（search/list/view）：允许回退 openapi/mcp，保证可用性。
- user-aware：
  - 已授权用户优先 user scope（发布可自动落 `my_library`，检索优先按用户上下文）
  - 未授权用户自动回退 bot/openapi 路径，不阻断主流程。

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
- `GET /api/phase1/setup-check`：环境、OAuth 落盘、MCP 身份、资源池等自检（**不返回 token**；`nextSteps` 为待办说明）
- `GET /api/phase1/mcp-check`：MCP URL 与 `tools/list` 白名单覆盖探测
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

MCP 解析回归（README §12.5 P2）：

```bash
npm test
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

### 9.1 事件订阅链路（为什么改了代码飞书还是旧行为）

飞书只会向 **开放平台 → 事件配置 → 请求地址** 里填写的那一个 **公网 HTTPS** 发 `POST /api/feishu/webhook`，**不会**访问你本机的 `http://localhost:3000`。因此仅重启本机 `npm run dev` 不能保证飞书命中当前进程。

**按下面顺序修复链路：**

1. **内网穿透必须指到当前 dev 进程**  
   用 Cloudflare Tunnel、ngrok 等时，确保转发目标为 **`http://127.0.0.1:<PORT>`**（与本机 `npm run dev` 监听端口一致，`PORT` 见 `.env`）。

2. **TryCloudflare 每次启动子域会变**  
   `*.trycloudflare.com` 随机域名：**每次新开隧道**，都要回到飞书开放平台，把 **事件订阅请求地址** 更新为 **`https://<当前隧道域名>/api/feishu/webhook`**。旧域名上的请求会打到已过期的隧道或别的机器。

3. **同源自检（推荐）**  
   浏览器或 curl 访问（域名必须与事件订阅里填的 **协议+主机完全一致**）：  
   - `https://<你的公网域名>/api/feishu/demo-status`  
   - 若网关/Nginx **只配置了** `location` 指向 `/api/feishu/webhook`，可改用：`https://<你的公网域名>/api/feishu/webhook/demo-status`  
   期望看到 `bypassDemo`、`effectiveBypassDocUrl` 与当前仓库配置一致。  

   **`Route GET:/api/feishu/demo-status not found`（Fastify 404）**：对外进程仍是 **不含该路由的旧构建**。在 `oauth.zhongshu-sheng.com`（或等价主机）对应服务上：**拉最新代码、`npm run build`（若用 `dist`）、重启 Node/容器**，deploy 后再测。

4. **关掉多余的接收端**  
   云上若还跑着旧版 Node / Docker / Vercel 预览，飞书 URL 仍可能指向那边。临时调试请 **只保留一条** 指向本机穿透的订阅地址，或下线旧实例。

5. **OAuth 与 Webhook 用同一「当前环境」**  
   `.env` 里 `FEISHU_USER_OAUTH_REDIRECT_URI` 若也用了隧道根地址，**换隧道时请同步改** 飞书开放平台里的重定向 URL，避免出现「OAuth 回本机 A、Webhook 却进云端 B」。

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

---

## 12. MCP 服务端接入与完善指南（给后端同学）

本节用于指导“负责 MCP 服务器端”的同学：服务端准备好后，客户端（本仓库）要做哪些配置与改造，才能真正实现“正式文档产物优先、质量可验收”。

### 12.1 服务端最低能力（必须）

请确保 MCP 侧可稳定提供以下工具（名称须与飞书[远程 MCP 支持的工具列表](https://open.feishu.cn/document/mcp_open_tools/supported-tools)及 `FEISHU_MCP_ALLOWED_TOOLS` 一致）：

- `search-doc`
- `list-docs`
- `fetch-doc`
- `fetch-file`
- `create-doc`
- `update-doc`
- `get-comments`
- `add-comments`
- `search-user`
- `get-user`

参考官方能力列表：[远程 MCP 支持的工具列表](https://open.feishu.cn/document/mcp_open_tools/supported-tools)。

### 12.2 服务端返回契约（强烈建议统一）

为避免“调用成功但前端看不到内容”这类软失败，建议 MCP 统一返回：

- `create-doc`：至少返回 `id`、`title`、`url`
- `update-doc`：返回明确成功标记（如 `ok=true`）
- `fetch-doc`：返回 `id`、`title`、`content`（用于发布后抽样验收）

建议同时保证 `structuredContent` 与 `content.text(JSON)` 两种包装至少有一种可被稳定解析。

### 12.3 本仓库接入配置（服务端就绪后立即做）

在 `.env` 中配置：

- `FEISHU_MCP_URL=<你的 MCP endpoint>`
- `FEISHU_MCP_ALLOWED_TOOLS=search-doc,fetch-doc,list-docs,fetch-file,create-doc,update-doc,get-comments,add-comments,search-user,get-user`
- `FEISHU_MCP_IDENTITY=uat`（用户令牌 `X-Lark-MCP-UAT`：须在可写目录写入用户 OAuth，且业务请求带 `userId`；`tools/list` 无 `userId` 时 TAT 回退）或 `tat`（租户令牌）
- `FEISHU_USER_OAUTH_REDIRECT_URI`：须与开放平台「重定向 URL」**完全一致**（例：`https://www.feishu.space/api/feishu/auth/callback`）
- `FEISHU_USER_OAUTH_SCOPES`：须与后台勾选的用户权限一致，见下表「用户 OAuth Scope」
- `FEISHU_DOC_PUBLISH_STRATEGY=gateway_only`（推荐先稳定）
- `FEISHU_DOC_LARK_CLI_HARD_PREFER=false`（MCP 主导阶段建议先关闭 CLI 强优先）

说明：

- 若 `FEISHU_MCP_URL` 留空，日志会出现 `skip mcp by config`，不会命中 MCP。
- 文档发布是否走 MCP，以 `tool-gateway` 日志中的 `adapter` 字段为准。

#### 用户 OAuth Scope（写入 `FEISHU_USER_OAUTH_SCOPES`，与开发者后台「权限管理」勾选项一致）

以本仓库默认组合为例（空格分隔）：

| scope 键（须逐字一致） | 用途（对应本项目的 MCP / 链路） |
|------------------------|----------------------------------|
| `docx:document` | 新版云文档创建、编辑、读正文（`create-doc` / `update-doc` / `fetch-doc`） |
| `drive:drive` | 云空间文件管理（含读写类能力；Agent 发布到云盘时常需） |
| `drive:drive.search:readonly` | 云文档关键词搜索（文档搜索类 OpenAPI） |
| `search:docs:read` | 用户身份文档搜索能力；**MCP `search-doc` 报 [search:docs:read] / 99991679 时需列入本处并重新授权**（与上一项在权限列表中可能并存，缺一仍可能报错） |
| `contact:user:search` | `search-user` |
| `contact:user.base:readonly` | `get-user`（用户基本信息） |
| `wiki:wiki:readonly` | 知识库只读（文档在知识库里时建议保留） |

权威枚举与后台中文名以飞书 [权限列表](https://open.feishu.cn/document/ukTMukTMukTM/uYTM5UjL2ETO14iNxkTN/scope-list) 为准。  
**「应用身份已开通」≠「用户身份已开通」**：`FEISHU_MCP_IDENTITY=uat` 走 **user_access_token** 时，须在你截图的权限表里把 **权限类型 = 用户身份** 的对应项也开通（可按「身份类型」筛选核对）。仅应用身份开通时，MCP 仍可能报 `search:docs:read` / [99991679](https://open.feishu.cn/document/faq/trouble-shooting/how-to-resolve-error-99991679)。  
**改权限或 scope 后**：把 `FEISHU_USER_OAUTH_SCOPES` 补全（含报错中的 scope 键）→ 开放平台 **创建版本并发布** → 将 `FEISHU_USER_OAUTH_PROMPT=consent` 可[强制展示授权页](https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code) → 用户重新授权（IM 卡或 `GET /api/feishu/auth/start?userId=…`）→ 换到新 token 后可将 `FEISHU_USER_OAUTH_PROMPT` 置空；重定向 URL 变更时也须同样重新授权。

### 12.4 联调验收顺序（建议按此执行）

1. 启动本项目：`npm run dev`
2. `GET /api/phase1/setup-check`（推荐）与 `GET /api/phase1/mcp-check` 确认 MCP 与 OAuth 通道
3. 发送一次飞书 webhook（或群内 @机器人）
4. 检查日志必须出现：
   - `createDocument success ... adapter":"mcp"`
   - `updateDocument success ... adapter":"mcp"`
5. 打开产物链接，验证文档正文非空、结构完整（标题/摘要/分节）
6. 检查 IM：
   - 优先收到“链接+结构化摘要”卡片/文本
   - 不应再出现整篇正文刷屏

### 12.5 MCP 接好后，系统建议补完改造（优先级）

P0（建议本周完成）：

- ✅ 在 `src/services/output/publisher.ts` 增加「发布后抽样验收」：`create/update` 后统一 `viewDocument`（fetch-doc），校验正文长度（`FEISHU_DOC_PUBLISH_VERIFY_MIN_CHARS`）与标题关键字；失败抛错触发既有 `fallback` 链路。
- ✅ 在 `src/services/toolGateway/feishuMcpAdapter.ts` 增加更严格的返回校验与错误分类：`PERMISSION_DENIED` / `VALIDATION` / `INVALID_RESPONSE`；`create-doc` 缺少 `id`/`title`/`url` 直接抛错；`update-doc` 解析 `ok`/`success`/`boolean`。
- ✅ 工具名与飞书远程 MCP 文档对齐（`search-doc`、`fetch-file`、`add-comments`、`search-user`、`get-user` 等）。

P1（建议下个迭代）：

- ✅ 新增 MCP 健康探针接口 `GET /api/phase1/mcp-check`：`tools/list` 与白名单覆盖（`list` 失败时 `ok=false` 并返回错误信息）。
- ✅ 在 `reportImDelivery` / 结果卡片中增加产物来源（`artifactSource`：`mcp`/`openapi`/`lark_cli`）。

P2（质量增强）：

- ✅ 给 `create-doc/update-doc/fetch-doc` 增加回归测试（mock MCP 响应）：见 `src/services/toolGateway/mcpResponseParse.test.ts`，运行 `npm test`
- ✅ 在发布链路加埋点（结构化日志，便于 grep / 对接观测）：
  - `[publish-telemetry]`：`adapter`、`publish_status`（`published` / `fallback` / `verify_failed`）、`empty_doc_detected`（及 `mitigated_by`）、`output_type`、`sessionId` 等
  - `[im-telemetry]`：`card_fallback_triggered`（结果卡片失败改发文本时）

### 12.6 常见故障快速判断

- 日志出现 `skip mcp by config`：
  - 一定是 `FEISHU_MCP_URL` 未生效（空值或未加载到进程）。
- `adapter=openapi` 且文档有标题无正文：
  - MCP 未命中，走了 OpenAPI 兜底；优先修复 MCP 可用性。
- IM 出现文本降级：
  - 先看卡片接口错误（schema/字段），不一定是文档发布失败。

---

## 13. feishu.space 502 排障 SOP

适用现象：`http://127.0.0.1:3000/healthz` 正常，但 `https://www.feishu.space/healthz` 返回 502（Cloudflare Host Error）。

### 13.1 快速结论

- 这类情况通常不是 Node 业务代码崩溃，而是「公网域名 -> 本机服务」转发链路异常（隧道/反代/DNS）。

### 13.2 三步定位

1. 本地健康检查：
   - `http://127.0.0.1:3000/healthz` 应返回 `{\"ok\":true}`。
2. 公网健康检查：
   - `https://www.feishu.space/healthz` 应返回 200。
3. 使用自检接口（新增）：
   - `GET /api/phase1/public-reachability-check`
   - 若 `localHealth.ok=true` 且 `publicHealth.ok=false`，优先排查隧道层。

### 13.3 修复动作

- 重启 cloudflared 隧道进程/服务；
- 校验隧道 ingress 是否把 `www.feishu.space` 指向 `http://127.0.0.1:3000`；
- 校验 DNS/CNAME 仍指向正确 tunnel；
- 恢复后再次验证：
  - `https://www.feishu.space/healthz`
  - `https://www.feishu.space/api/phase1/config-check`

### 13.4 OAuth 注意事项

- OAuth 回调中的 `state` 一次性且有 TTL（默认 10 分钟）。
- 发生 502 后不要重放旧 callback URL；应重新调用：
  - `GET /api/feishu/auth/start?userId=<same_user>`
  - 让用户点击新授权链接完成回调。
- 从本版本开始，OAuth pending state 会持久化到可写目录（`oauth-pending-states.json`），同一 `userId` 只保留最新一条会话，减少误点旧卡片导致的 `state 无效`。
- 同时启用文件条目上限淘汰（默认 200 条，配置项 `FEISHU_OAUTH_PENDING_STATE_MAX_ITEMS`），避免长时间联调导致文件膨胀。
