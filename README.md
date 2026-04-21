# 飞书 AI Agent 办公报告生成 Prototype（后端）

本项目是一个基于 TypeScript + Fastify + LangGraph.js 的报告生成后端骨架，包含：

- API 入口：`POST /generate-report`
- Word 导出：`POST /generate-report-docx`
- LangGraph 主流程：`parse_user_request -> planner_node -> build_writer_input -> writer_node -> format_output`
- Retrieval Client（本地 stub + Skill 文件加载）
- 百炼模型调用封装（Orchestrator / Writer）
- 全链路 Zod Schema 校验

## 1. 环境要求

- Node.js >= 20（建议 20/22）
- npm >= 9

## 2. 安装依赖

```bash
npm install
```

## 3. 配置环境变量

1. 复制 `.env.example` 为 `.env`
2. 填写你的百炼配置（你已完成这一步可跳过）

必填项：

- `BAILIAN_API_KEY`：已隐藏
- `BAILIAN_BASE_URL`
- `BAILIAN_MODEL_ORCHESTRATOR`
- `BAILIAN_MODEL_WRITER`
模型不可用thinking！！

.env设置如下：
BAILIAN_API_KEY=
BAILIAN_BASE_URL=
BAILIAN_MODEL_ORCHESTRATOR=
BAILIAN_MODEL_WRITER=
BAILIAN_MODEL_EMBEDDING=

可选项：

- `PORT`（默认 `3000`）
- `HOST`（默认 `0.0.0.0`）
- `LLM_TIMEOUT_MS`（默认 `30000`，设置为 `0` 表示不限制超时）

### 飞书集成（Phase 4）

当前默认走 **mock 模式**，不需要任何飞书凭证，主流程完全可用。

要切换到 **真实飞书模式**：

1. 在 [飞书开放平台](https://open.feishu.cn) 创建"企业自建应用"
2. 从"凭证与基础信息"里复制 AppID 与 AppSecret
3. 在"权限管理"里按需申请（至少选一个能测的，如 `contact:user.base:readonly`）
4. 在"版本管理与发布"里发布应用
5. 在 `.env` 中填入：

```bash
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx
FEISHU_USE_MOCK=auto   # auto: 有凭证自动启用；true: 强制 mock；false: 强制 real
FEISHU_DOMAIN=open.feishu.cn  # 海外 Lark 用 open.larksuite.com
```

重启服务，访问 `GET /healthz` 验证：

```json
{
  "ok": true,
  "feishu": {
    "mode": "real",
    "domain": "open.feishu.cn",
    "degraded": false,
    "hasAppId": true,
    "hasAppSecret": true,
    "health": { "healthy": true, "message": "tenant_access_token 获取成功" },
    "token": { "cached": true, "expiresInMs": 7190000 }
  }
}
```

> **模式速览**：  
> - Phase 4.1 完成了**凭证与 token 管理**（自动获取 / 自动续期 / 失败降级）  
> - Phase 4.2 完成了**真实检索飞书云盘 docx**（见下节）  
> - Phase 4.3 完成了**真实检索飞书群聊消息**（见下节）  
> - Phase 4.6 实现了**报告卡片推送**（见下节）  
> - Phase 5 实现了**报告回写云文档**（见下节）  
>  
> 即使某一层尚未完成或权限没开，降级逻辑会接住错误，不会阻塞主流程。

### 报告通知到飞书（Phase 4.6）

生成报告后自动把**摘要卡片**推到飞书指定会话，体验"生成完立刻在飞书里看到"。

**前置条件**：

1. 飞书真实模式已生效（`/healthz` 里 `feishu.mode=real`）
2. 飞书应用已申请 `im:message`（或 `im:message:send_as_bot`）权限并发布

**怎么拿到 chat_id（推荐）**：

1. 在任何一个你能管的飞书群里，**"+"号 → 添加机器人 → 搜索你的应用名** 把机器人拉进来
2. 调用 [API 调试台 - 获取用户或机器人所在的群列表](https://open.feishu.cn/api-explorer?apiName=list&project=im&resource=chat&version=v1)，选 `user_id_type=open_id`，直接点"调试"
3. 在返回结果里找到对应群，复制 `chat_id`（形如 `oc_xxxxxxxxxxxxxxxx`）

**或者获取你自己的 open_id**（私聊给你）：

1. 调用 [API 调试台 - 批量获取用户](https://open.feishu.cn/api-explorer?apiName=batch_get_id&project=contact&resource=user&version=v3)
2. body 填你的邮箱 / 手机号，返回结果里有 `open_id`（形如 `ou_xxxxxxxxxxxxxxxx`）
3. 注意需要 `contact:user.base:readonly` 权限

**配置**：

在 `.env` 填 **其中一个**（三选一，按优先级 chat_id > open_id > email）：

```bash
FEISHU_NOTIFY_CHAT_ID=oc_xxxxxxxxxxxxxxxxxxxx
# 或
FEISHU_NOTIFY_OPEN_ID=ou_xxxxxxxxxxxxxxxxxxxx
# 或
FEISHU_NOTIFY_EMAIL=you@company.com

FEISHU_NOTIFY_ENABLED=true   # 想临时关通知就改成 false
```

重启服务，调用 `POST /generate-report`，你应该在目标飞书会话里立即收到一张卡片：

- 标题：`📄 <报告 title>`
- 元信息：Skill ID / Session / 审阅通过/待完善 / 用户累计生成次数
- 报告摘要 + 前 4 个章节节选
- Top 3 待确认问题

`debugTrace` 末尾会多一行：

```
[feishu_notify] 已发送 receive=chat_id=oc_x…xxxx message_id=om_xxx
```

未配置或失败时会静默跳过（不影响主响应）：

```
[feishu_notify] skip: 未配置收件人（FEISHU_NOTIFY_CHAT_ID / _OPEN_ID / _EMAIL）
[feishu_notify] 失败(非阻塞): ...
```

### 报告回写飞书云文档（Phase 5）

在通知卡片之外，还会把**完整排版的周报**写成一篇飞书云 docx，卡片底部自动加一个 **"📄 查看完整文档"** 按钮直接跳转。

**前置条件**：在飞书应用权限里勾上并发布：

- `docx:document`：创建并写入云文档
- `drive:drive`：可选，指定父文件夹时需要

**配置**：

```bash
# auto：有权限自动写；true：强制写；false：关闭
FEISHU_DOCX_ENABLED=auto
# 可选：让周报落在指定云盘文件夹；留空则写到"我的空间"根目录
# 获取：浏览器打开目标文件夹，URL 里 /drive/folder/<TOKEN> 那段就是
FEISHU_DOCX_FOLDER_TOKEN=
# 卡片按钮跳转前缀；默认 www.feishu.cn 会自动跳到你所在租户
# 有自定义租户域名（yourco.feishu.cn）可以换成那个
FEISHU_DOCX_URL_PREFIX=https://www.feishu.cn/docx/
```

**生成的文档结构**：

- H1：报告标题
- 一段摘要
- 分割线
- H2：每个 section 标题 + 正文段落
- 分割线
- H2：待确认问题（无序列表）
- 分割线
- H2：图表建议（无序列表）

`debugTrace` 末尾会多出（成功时）：

```
[feishu_docx] 云文档已创建 docId=xxx…yyyy blocks=24 url=https://www.feishu.cn/docx/xxxxxxxx
[feishu_notify] 已发送 receive=chat_id=oc_x…xxxx message_id=om_xxx
```

失败或 mock 模式下会静默跳过：

```
[feishu_docx] skip: 飞书为 mock 模式，云文档回写仅在真实模式下生效
[feishu_docx] 失败(非阻塞): ...
```

> **执行顺序**：`memory_writer → feishu_docx_writer → feishu_notify → END`。  
> `feishu_docx_writer` 把 `docUrl` 写进 State，`feishu_notify` 再据此给卡片加按钮；任一节点失败都不阻塞后续和主响应。

### 真实检索飞书云盘（Phase 4.2）

让 Retrieval 层从 mock 数据切换成**真的读你飞书云盘里的 docx**。逻辑：

1. 读 `FEISHU_SEARCH_FOLDER_TOKEN` 指定的文件夹
2. 列出里面的 docx（自动翻页，忽略 folder/sheet/bitable）
3. 并行拉每篇 docx 的 `raw_content`（纯文本）
4. 对用户 query 做关键词打分（中文 2/3-gram + 英文分词 + 停用词过滤）
5. Top K 命中注入到 `RetrievalContext.projectContext`，`sourceType='doc'`

**前置权限**（Phase 5 已要求开，通常不需要再开）：

- `drive:drive`：列文件夹
- `docx:document`（或 `docx:document:readonly`）：读正文

**配置**：

```bash
# 把你的周报模板、历史报告、业务资料扔进一个文件夹，把 token 填这里
# 拿法：飞书云盘打开那个文件夹，URL 里 /drive/folder/<TOKEN> 就是
# 留空 → Retrieval 仍走 mock，主流程不受影响
FEISHU_SEARCH_FOLDER_TOKEN=
FEISHU_SEARCH_MAX_DOCS=10    # 单次最多扫几个 docx（防大目录）
FEISHU_SEARCH_TOP_K=5        # 最终注入到主流程的素材条数
```

**命中素材长啥样**（注入 Writer 前的一条 `projectContext`）：

```
sourceId:   feishu_docx_<document_token>
sourceType: doc
content:
  【飞书云文档】{文档标题}
  [原文链接] https://www.feishu.cn/docx/xxxxxxxx

  ……命中关键词附近 600 字左右的正文截断片段……
```

**可观测日志**：

```
# 配置了 folder_token 且命中
[FeishuRealAdapter] 真实检索命中 count=3 sources=drive_docx(3)

# 配置了但零命中（或接口失败），自动降级 mock
[FeishuRealAdapter] 真实检索零命中，降级到 mock 数据源 sources=drive_docx(no_folder_token)

# 单篇 docx 拉失败（已忽略该篇，不影响整体）
[FeishuDriveSearch] 单篇 docx 拉取失败，已忽略该篇 documentId=xxx error=...
```

> **设计理由**：这里没有直接调用飞书 Suite Search（全局搜索），原因是 Suite Search 需要 `search:docs:read_all` 等更高权限且通常要求走应用商店发布流程。自建应用用 **drive 列目录 + docx 读正文 + 本地关键词打分** 的组合，能用自己已有的权限跑通，体感延迟 1~3s 可接受。后续若你的应用升级到商店级权限，可以把 `driveSearch.ts` 的实现无缝替换成 Suite Search，接口签名不变。

### 真实检索飞书群聊消息（Phase 4.3）

把**指定群聊最近的讨论**也作为检索素材，让 Writer 能"读到"同事最近讨论的关键数字、风险描述、决议要点。逻辑：

1. 解析 `FEISHU_SEARCH_CHAT_ID`，未显式配置则自动回退到 `FEISHU_NOTIFY_CHAT_ID`（即你接收通知的群）
2. 分页拉最近 N 条消息（按 create_time 倒序，命中时间窗口外即停止）
3. 按 `msg_type` 解析纯文本：`text` / `post`（富文本）/ `interactive`（卡片）；图片、语音、文件等非文本消息忽略
4. 复用 Phase 4.2 的关键词打分函数（同样的中文 2/3-gram + 英文分词 + 停用词过滤），保证打分口径一致
5. Top K 命中注入到 `RetrievalContext.projectContext`，`sourceType='message'`

**前置权限**：

- `im:message.group_msg` — **读群聊消息**（必须开）
- `im:message.p2p_msg` — 读单聊消息（可选，如果你想把私聊也作为素材源）

权限改完必须去 **"版本管理与发布" 创建新版本 → 提交审批发布**，否则生效的还是旧 scope。发版后跑诊断确认：

```
cmd /c "npx tsx scripts/diagnose-im-access.ts"
cmd /c "npx tsx scripts/diagnose-im-access.ts \"支付流程优化\""   # 自定义 query
```

**配置**：

```bash
# 目标群 chat_id（留空 → 自动用 FEISHU_NOTIFY_CHAT_ID；填 "off" → 完全关掉 IM 检索路）
# FEISHU_SEARCH_CHAT_ID=
FEISHU_SEARCH_IM_LIMIT=80            # 最多拉最近多少条（翻页累计）
FEISHU_SEARCH_IM_TOP_K=3             # 打分后保留几条注入主流程
FEISHU_SEARCH_IM_WINDOW_HOURS=168    # 只看最近多少小时内的消息（默认 7 天）
```

**命中素材长啥样**（注入 Writer 前的一条 `projectContext`）：

```
sourceId:   feishu_im_<message_id>
sourceType: message
content:
  【飞书群聊讨论 · 2026-04-20 15:42】
  …支付流程较竞品多 2 个跳转，老用户投诉集中…
  (chat=oc_9***72de sender=ou_a***3b1f)
```

**可观测日志**：

```
# 正常命中
[FeishuRealAdapter] 真实检索命中 count=4 sources=drive_docx(1),im_messages(3)

# 权限没开，IM 这路静默失败不阻塞 drive 路
[FeishuRealAdapter] im 消息检索失败（非阻塞） error=... need scope: im:message.group_msg
[FeishuRealAdapter] 真实检索命中 count=1 sources=drive_docx(1),im_messages(error)

# 配置整体留空
... sources=drive_docx(no_folder_token),im_messages(no_chat_id)
```

> **设计理由**：IM 消息和 docx 的"信源密度"差异很大——docx 字多信息浓，IM 短消息碎片化。因此 `FEISHU_SEARCH_IM_TOP_K` 默认比 docx 小（3 vs 5），避免短消息挤掉高质量文档。时间窗口（`WINDOW_HOURS`）是另一把把关——一周以前的讨论通常和本周报告无关，排除掉有利于 LLM 聚焦。如果你的团队在群里沉淀了很多跨周决策，可以调大这个值。

## 4. Skill 文件放置规范

项目统一从根目录 `SKILLS/` 读取技能文件（单一技能库）。

每个 skill 使用 openclaw 风格 Markdown：

- Front matter：`name`、`description` 等元信息
- `## Guidance`：自然语言指导（会注入生成提示）
- `## StructuredSkill`：` ```json ... ``` ` 结构化技能定义（按 `SkillSchema` 校验）

匹配逻辑：

1. 优先 `industry + reportType` 精确匹配
2. 其次按 `reportType` 匹配
3. 再按 `industry` 匹配
4. 若仍未命中，回退到首个 skill 或内置 fallback（保证流程可运行）

## 5. 启动项目

开发模式（推荐）：

```bash
npm run dev
```

启动后可直接打开 GUI（飞书工作台风格）：

- [http://localhost:3000/](http://localhost:3000/)
- 页面支持：
  - 结构化报告生成
  - Word 报告导出
  - 个人知识库 / 历史文档 / IM 联系人输入
  - 自动展示 follow-up 追问建议

生产模式：

```bash
npm run build
npm run start
```

健康检查：

```bash
GET http://localhost:3000/healthz
```

## 6. 调用接口

### 6.1 请求

- URL：`POST http://localhost:3000/generate-report`
- Header：`Content-Type: application/json`

请求体示例：

```json
{
  "userId": "u_001",
  "sessionId": "s_001",
  "prompt": "请生成本周医疗运营报告，重点关注门诊量变化和风险项。",
  "industry": "医疗",
  "reportType": "周报",
  "extraContext": ["关注质量与合规", "给管理层阅读"],
  "personalKnowledge": ["用户偏好先结论后细节"],
  "historyDocs": ["上周风险项仍未闭环"],
  "imContacts": [{ "id": "u_alice", "name": "Alice", "role": "项目经理" }]
}
```

### 6.2 响应

```json
{
  "selectedSkillId": "skill-medical-weekly-report",
  "taskIntent": "weekly_report",
  "followUpQuestions": ["请补充字段：统计周期（可通过 IM 联系人收集）"],
  "reviewNotes": [],
  "taskPlan": {
    "reportType": "周报",
    "selectedSkillId": "skill-medical-weekly-report",
    "missingFields": [],
    "targetSections": ["执行摘要", "核心指标表现"],
    "targetTone": "专业、清晰",
    "useSources": ["msg_001", "doc_101"]
  },
  "report": {
    "title": "xxx",
    "summary": "xxx",
    "sections": [
      {
        "heading": "执行摘要",
        "content": "..."
      }
    ],
    "chartSuggestions": [
      {
        "type": "line",
        "title": "门诊量趋势",
        "purpose": "观察周期变化",
        "dataHint": "按日门诊量"
      }
    ],
    "openQuestions": []
  },
  "debugTrace": ["..."]
}
```

### 6.3 Word 导出

- URL：`POST http://localhost:3000/generate-report-docx`
- 请求体与 `/generate-report` 相同
- 响应为 `.docx` 文件流，可直接下载

## 7. Windows PowerShell 调用示例

```powershell
$body = @{
  userId = "u_001"
  sessionId = "s_001"
  prompt = "请生成本周医疗运营报告，重点关注门诊量变化和风险项。"
  industry = "医疗"
  reportType = "周报"
  extraContext = @("关注质量与合规","给管理层阅读")
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/generate-report" `
  -ContentType "application/json" `
  -Body $body
```

## 8. 常见问题排查

- `LLM 调用失败: 4xx/5xx`  
  检查 `BAILIAN_BASE_URL`、`BAILIAN_API_KEY`、模型名是否正确。

- `请求参数或流程输出校验失败`  
  检查请求体字段类型；以及 `SKILLS/*.md` 中 JSON 是否满足 `SkillSchema`。

- `技能 markdown 中未找到 JSON 内容`  
  确保 Skill 文件中存在 ` ```json ... ``` ` 代码块。

- 启动成功但输出不理想  
  优先优化 `SKILLS/*.md` 的 Guidance 与 StructuredSkill 内容。

## 9. 关键源码入口

- 应用入口：`src/app.ts`
- 路由：`src/api/report.ts`
- 流程入口函数：`src/services/reportPipeline.ts`（`generateReport`）
- 图定义：`src/graph/reportGraph.ts`
- Retrieval 读取：`src/services/retrievalClient.ts`
- Schema：`src/schemas/index.ts`
