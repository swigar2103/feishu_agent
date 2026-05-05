# 项目变更记录

**日期**：2026-05-05

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
