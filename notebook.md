Intent Agent：识别用户要做什么报告
Planner Agent：拆分任务流程
Retriever Agent：去飞书和外部知识源找材料
Writer Agent：生成文档正文
Analyst Agent：处理表格、指标、图表建议
Reviewer Agent：做结构检查、术语检查、风格对齐


feishu-ai-agent-prototype/
├── src/
│   ├── app.ts
│   │   功能：应用启动入口。初始化 Fastify 服务，注册路由，加载环境变量，启动 HTTP 服务。
│   │   归属：你负责。
│   │
│   ├── api/
│   │   └── report.ts
│   │       功能：报告生成 API 路由层。接收 POST /generate-report 请求，校验 UserRequest，
│   │             调用 reportPipeline，返回 report / taskPlan / debugTrace。
│   │       归属：你负责。
│   │
│   ├── graph/
│   │   ├── state.ts
│   │   │   功能：定义 LangGraph 的共享状态结构，包括 userRequest、retrievalContext、
│   │   │         taskPlan、writerInput、writerOutput、debugTrace。
│   │   │   归属：你负责。
│   │   │
│   │   ├── nodes/
│   │   │   ├── parseUserRequest.ts
│   │   │   │   功能：对用户输入做标准化和 schema 校验，生成初始 state。
│   │   │   │   归属：你负责。
│   │   │   │
│   │   │   ├── plannerNode.ts
│   │   │   │   功能：主规划节点。先调用 retrievalClient 获取上下文，再调用 orchestratorModel
│   │   │   │         产出 TaskPlan。它是“决策层”核心。
│   │   │   │   依赖：依赖 retrievalClient 返回符合 RetrievalContextSchema 的结果。
│   │   │   │   归属：你负责。
│   │   │   │
│   │   │   ├── buildWriterInput.ts
│   │   │   │   功能：把 userRequest + taskPlan + retrievalContext 组装成 WriterInput，
│   │   │   │         供 writerNode 使用。
│   │   │   │   归属：你负责。
│   │   │   │
│   │   │   ├── writerNode.ts
│   │   │   │   功能：调用 writerModel，根据 WriterInput 生成 WriterOutput。
│   │   │   │   归属：你负责。
│   │   │   │
│   │   │   └── formatOutput.ts
│   │   │       功能：最终输出整理与校验，确保返回值结构稳定，并补充 debugTrace。
│   │   │       归属：你负责。
│   │   │
│   │   └── reportGraph.ts
│   │       功能：定义整个 LangGraph 流程图：
│   │             START → parseUserRequest → plannerNode → buildWriterInput
│   │             → writerNode → formatOutput → END
│   │       归属：你负责。
│   │
│   ├── llm/
│   │   ├── client.ts
│   │   │   功能：统一封装阿里云百炼 API 调用客户端，处理 baseURL、API key、模型名、
│   │   │         超时、错误处理、结构化输出模式。
│   │   │   归属：你负责。
│   │   │
│   │   ├── orchestratorModel.ts
│   │   │   功能：封装“模型1：Orchestrator / Planner”的调用逻辑。
│   │   │         输入 userRequest + retrievalContext，输出 TaskPlan。
│   │   │   归属：你负责。
│   │   │
│   │   └── writerModel.ts
│   │       功能：封装“模型2：Writer / Analyst”的调用逻辑。
│   │             输入 WriterInput，输出 WriterOutput。
│   │       归属：你负责。
│   │
│   ├── prompts/
│   │   ├── plannerPrompt.ts
│   │   │   功能：Orchestrator / Planner 的 system/user prompt 模板，
│   │   │         强约束输出 TaskPlan JSON。
│   │   │   归属：你负责。
│   │   │
│   │   └── writerPrompt.ts
│   │       功能：Writer / Analyst 的 prompt 模板，
│   │             强约束输出 WriterOutput JSON。
│   │       归属：你负责。
│   │
│   ├── services/
│   │   ├── retrievalClient.ts（zsh提供）
│   │   │   功能：retrieval 的统一接入层。
│   │   │         对你这边来说，它暴露唯一主函数：
│   │   │         getContextForReport(userRequest): Promise<RetrievalContext>
│   │   │
│   │   │         这里可以先是本地 import / mock，之后可切换成：
│   │   │         - HTTP 调用对方服务
│   │   │         - MCP 调用
│   │   │         - 共享 monorepo 内模块调用
│   │   │
│   │   │         关键点：这个文件的“对外契约”由你定，但其内部 retrieval 逻辑、
│   │   │         skill/memory/history 的真实拼装能力由对方主导提供。
│   │   │   归属：接口壳你可先写，但最终内容按分工属于对方交付。
│   │   │
│   │   └── reportPipeline.ts
│   │       功能：主业务服务层。封装 generateReport(userRequest) 主函数，
│   │             内部调用 reportGraph 或 graph.invoke，供 API 层复用。
│   │       归属：你负责。
│   │
│   ├── schemas/
│   │   └── index.ts
│   │       功能：放 6 个核心 zod schema：
│   │             UserRequestSchema
│   │             SkillSchema
│   │             RetrievalContextSchema
│   │             TaskPlanSchema
│   │             WriterInputSchema
│   │             WriterOutputSchema
│   │       归属：你负责。
│   │       说明：虽然 RetrievalContext 对接对方模块，但 schema 契约必须由你这里统一定义。
│   │
│   ├── types/
│   │   └── contracts.ts
│   │       功能：补充通用类型定义、接口签名、跨模块 contract 常量。
│   │             例如：
│   │             - generateReport 函数签名
│   │             - getContextForReport 函数签名
│   │             - SourceType 枚举
│   │       归属：你负责。
│   │
│   ├── config/
│   │   └── env.ts
│   │       功能：读取并校验环境变量，如：
│   │             BAILIAN_API_KEY
│   │             BAILIAN_BASE_URL
│   │             BAILIAN_MODEL_ORCHESTRATOR
│   │             BAILIAN_MODEL_WRITER
│   │             BAILIAN_MODEL_EMBEDDING
│   │       归属：你负责。
│   │
│   └── shared/
│       ├── logger.ts
│       │   功能：统一日志工具，打印请求、节点执行、报错、调试 trace。
│       │   归属：你负责。
│       │
│       └── utils.ts
│           功能：通用工具函数，例如文本清洗、空值处理、JSON 安全解析、数组去重等。
│           归属：你负责。
│
├── tests/
│   └── reportPipeline.test.ts
│       功能：主流程测试。验证输入 UserRequest 后，
│             是否能得到符合 WriterOutputSchema 的结果。
│       归属：你负责。
│       依赖：依赖 retrievalClient 的 mock/真实返回。
│
├── .env.example
│   功能：环境变量模板文件，占位所有 API key、模型名、base url。
│   归属：你负责。
│
├── package.json
│   功能：项目依赖与脚本配置。
│   归属：你负责。
│
├── tsconfig.json
│   功能：TypeScript 编译配置。
│   归属：你负责。
│
└── langgraph.json
    功能：LangGraph 项目配置文件，用于 graph 入口配置与开发工具支持。
    归属：你负责。




1) 飞书需求入口是否实现
结论：当前是本地模拟入口，不是飞书真实入口。
证据：入口是 POST /generate-report + 本地 Web 页面提交，没有飞书事件订阅/webhook/bot 鉴权代码。
模拟程度：可做“用户输入→生成报告”demo。
缺失模块：飞书 Bot、事件回调、消息卡片发送、会话上下文绑定。
2) Intent Agent 是否实现
结论：有独立 intentNode，但为规则关键词识别，非 LLM intent 推断。
识别逻辑：周报/日报/复盘/分析关键词映射为 intent 字符串。
支持程度：基础分类可用，但复杂任务类型识别能力有限。
3) 行业 Skill 模板选择是否实现
结论：已实现（本地技能库匹配），属于真实逻辑 + 本地数据源。
数据来源：SKILLS/*.md（兼容 src/skills），解析 JSON 并经 SkillSchema 校验。
匹配逻辑：industry+reportType 精确匹配 → reportType → industry → fallback。
不足：无外部 skill 服务、无语义检索/评分机制。
4) 用户记忆 + 项目历史记忆是否实现
结论：读取已实现，写回未实现。
读取来源：src/data/memories.md 静态数据 + 请求体里的 personalKnowledge/historyDocs。
项目历史：作为输入字段拼入 projectContext。
动态性：当前是静态/请求注入，非持续学习存储。
memory 写回：未看到 update/save 机制。
5) Planner 生成执行计划是否实现
结论：存在两层：
plannerNode：静态占位 plan（pending-skill-selection）。
analystNode -> generateTaskPlan：真实 LLM 规划并输出 TaskPlan。
输入输出：LLM 规划阶段输入 userRequest + retrievalContext，输出 TaskPlan。
Schema 校验：有（TaskPlanSchema.parse）。
关键问题：命名/职责有断裂——“planner_node”并非最终 Planner。
6) Retriever 调用飞书消息/文档/表格/日历/外部检索是否实现
结论：未真实实现，当前为 mock 聚合。
已有：searchEverything（本地 assets.md 过滤）。
未有：searchMessages/readDoc/readTable/readCalendar/externalSearch 真实 API。
日历/外部：仅 placeholder 文本。
demo 支撑：可支撑“上下文拼装”演示，不支撑真实企业数据检索演示。
7) 缺信息后自动追问 / 向同事收集是否实现
结论：仅提示级实现，无 agentic 执行闭环。
已有：根据 missingFields 生成 followUpQuestions 文本。
没有：流程暂停/恢复、自动发 IM/卡片、同事消息采集、人工确认状态机。
8) Analyst 数据清洗、统一指标口径、推荐图表是否实现
结论：Analyst 不是独立数据处理模块，更多是“计划生成节点”。
当前 analystNode 实际做：调用规划 LLM + 生成追问列表。
不具备：真实数据清洗、指标口径统一、结构化分析引擎。
图表推荐：主要在 Writer 输出字段中体现，为文本生成层。
9) Writer 生成报告初稿是否实现
结论：已实现（真实 LLM + 结构化输出）。
输出字段：title/summary/sections/chartSuggestions/openQuestions 完整。
质量：取决于模型与上下文质量；工程上具备可演示性。
可演示程度：本地 demo 足够，企业级稳定性未验证。
10) Reviewer 按行业规范 + 用户风格检查是否实现
结论：有独立 reviewerNode，但能力较弱。
现有检查：目标章节是否覆盖、是否有 openQuestions。
没有：行业规范库校验、用户风格一致性深度审查、LLM 二次审阅。
11) 输出到飞书文档 / 多维表格 / 幻灯片是否实现
结论：未实现真实飞书输出。
当前输出终点：API JSON + 本地 Word 文件下载。
outputTargets 仅透传字段，不触发实际 createDoc/createBitable/createSlides。
12) 用户修改后写回 memory 是否实现
结论：未实现。
没有：修改输入接口、diff、memory update、风格学习与下一轮生效闭环。
当前是“读 memory”，不是“读写 memory”。
13) LangGraph 主流程是否真的打通
结论：主链路真实跑在 LangGraph 上。
节点顺序：parse -> intent -> planner -> retriever -> analyst -> buildWriterInput -> writer -> reviewer -> format。
generateReport/runReportPipeline 都调用 reportGraph.invoke(...)。
debugTrace：每节点都追加，具备调试价值。
但逻辑上存在职责错位：最终 TaskPlan 在 analyst 产出，不在 planner。
14) schema / contract / 类型约束是否完备
结论：工程化程度中上，schema 真正被广泛使用。
有效点：入口请求、节点中间态、LLM 输出、API 响应均有 Zod 校验。
风险点：
taskIntent 仅 string，未 enum 约束。
少量语义字段（如 styleHints/debugTrace）为自由文本，易漂移。
存在“节点名与职责不一致”导致的隐式契约风险。
15) 当前系统真实完成度评估
已完成：本地输入→检索上下文（mock）→LLM 规划→LLM 写作→审查→结构化输出/Word。
部分完成（mock/stub）：Skill/Memory/Retrieval/Reviewer 的产品级能力。
未实现：真实飞书入口、真实多源检索、自动追问协作、输出回飞书、memory 写回学习。
定位判断：
是 prototype：是。
是“可演示 demo”：是（本地演示）。
是“真正飞书 AI 办公 agent”：否，还差核心平台接入与闭环能力