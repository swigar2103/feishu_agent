# 资源与检索层（B）说明 — 给其他同事看的简略版

本文说明 **工作台 `/generate-report` 用到的「资源池 + 检索」** 这一套在做什么、怎么开关真飞书、以及和 A/C 怎么配合。**不要求读者先读完所有代码。**

---

## 1. 这一套解决什么问题？

用户在工作台写好需求后，主流程会先 **从「资料池」里挑出相关文档 / 联系人 / 项目说明 / 用户画像摘要**，再 **把摘要展开成可用的正文段落**，装进统一的 **`RetrievalContext`**（里的 `projectContext`），交给后面的 Analyst / Writer 去写报告。

可以理解为：**我们只负责「把飞书侧（或 Mock）的资料准备好」**，不负责决定 LangGraph 下一步跳哪个节点。

---

## 2. 两种模式：本地 Mock / 真实飞书

| 模式 | 说明 |
|------|------|
| **mock**（默认） | 文档、联系人等在仓库 `src/resource_pool/mock/` 下的 JSON。**不用飞书也能跑通 demo。** |
| **real** | 从飞书 **云盘指定文件夹** 里枚举 **新版云文档（docx）**，自动生成「文档摘要列表」；写报告时再调飞书接口拉 **正文块**。联系人 / 项目 / 画像仍可继续用本地 JSON（混合池）。 |

切换方式见下文 **「环境变量」**。

---

## 3. B1～B5 分别是什么（和业务对齐）

| 代号 | 名字 | 做什么 |
|------|------|--------|
| **B1** | Resource Pool Manager | 四类资料的结构与查询：**文档摘要、联系人、项目、用户画像**。 |
| **B2** | Resource Screening | 按任务里的关键词粗筛候选；不够用时会调大模型做一次 JSON 格式的补充筛选（可选）。 |
| **B3** | Retriever / Hydrator | 对候选条目做「深度读取」：文档拉正文大纲与正文，拼成 **任务上下文包**，再转成 `projectContext` 里的条目。 |
| **B4** | Resource Pool Enricher | 根据「本条任务里哪些资料真的有用」去 **调高权重**，返回新快照；适合做记忆闭环（由 **A** 决定在流程哪一步调用）。 |
| **B5** | 飞书适配层 | Mock：读本地 JSON 假数据；Real：读飞书 docx。**换实现不换上层拼装逻辑**。 |

代码主目录：**`src/resource_pool/`**。飞书底层 HTTP：**`src/integrations/feishu/`**（列文件夹、`raw_content`、拉 blocks 等）。

---

## 4. A / C 同学需要知道的「边界」

- **我们只产出数据**：候选列表、`RetrievalContext` / `projectContext` 片段、可选的 **Hydrated 包**。**不接管** LangGraph 的节点跳转和 callback。
- **字段名保持稳定**：上层已用的 **`RetrievalContext`、`UserRequest`、`TaskPlan`** 我们不会随便改字段名；若必须改契约，应由 **A 发起**后对齐全队。
- **报告里的 `pool_doc:` / `persona:` 等前缀**：表示这条上下文来自资源池拼装，便于你们做溯源或展示。

---

## 5. 给开发同学：常用入口与环境变量

### 5.1 主流程调用检索（A 侧已接好）

- `src/services/retrievalClient.ts`  
  - **`getContextForReport(userRequest, taskPlan)`** → 返回完整的 **`RetrievalContext`**。
- **Graph** 里在 **`planner` 之后** 调用 Retriever；`taskPlan` 里的 `targetSections`、`useSources` 等会影响 B2 的关键词信号。

### 5.2 资源池写回内存（可选，B4 + A）

- **`applyResourceUsage` / `usageEvidenceFromScreeningCandidates`**：`src/resource_pool/enricher.ts`（也通过 `resource_pool/index.ts` 导出）。
- **`commitResourcePoolReplacement(manager)`**：`src/services/retrievalClient.ts` —— 把更新后的池挂回 **进程内单例**检索引擎（持久化存储需你们另做）。

### 5.3 真飞书资源池 — `.env`

与 Phase1「模板拷贝」共用一套 **`FEISHU_APP_ID` / `FEISHU_APP_SECRET`**（`tenant_access_token`）。

额外三项（也在仓库 **`env.example`** 里）：  

```
FEISHU_RESOURCE_POOL_SOURCE=mock   # 或 real
FEISHU_RESOURCE_FOLDER_TOKEN=      # real 必填：云盘文件夹 token（URL 里 /drive/folder/ 后面那段）
FEISHU_RESOURCE_MAX_DOCX=20        # 单次最多纳入多少篇 docx
```

**注意：** 应用要对文件夹及其中云文档 **有读权限**；只支持 **当前文件夹这一层** 的 docx（子文件夹不会自动递归）。

### 5.4 工作台自测时可以看什么

成功时返回 JSON（或控制台）里常能看到：

- `debugTrace` 中有 **`retriever_node` / loaded contexts**。  
- `taskPlan.useSources` 里可能有 **`pool_doc:feishu_doc_<token>`**（表示来自飞书）；mock 时为本地 id。  
- `styleHints`（若透出）中带 **`RESOURCE_POOL(source=real|mock;...)`** 等调试信息。

---

## 6. 和 Phase1「模板生成到文件夹」的关系

那是 **另一条接口**（`/api/phase1/...`），负责 **复制模板、按块写云文档**。  
**资源池检索**走的是 **`/generate-report`**，两者可以共用飞书应用凭证，**不必共用同一个文件夹 token**。

---

## 7. 想改文档时找谁？

- Mock 演示数据：**`src/resource_pool/mock/`**、**`src/resource_pool/mock/feishu_details.json`**（仅 Mock 适配器）。  
- 真飞书单篇读失败会自动 **回退**到 Mock 细节（容错）。  

如有契约变更，请在 PR 里 **@负责 A 的同学** 同步 LangGraph state / API 是否要透传 Screening 结果全文。
