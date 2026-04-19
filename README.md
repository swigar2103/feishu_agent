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
