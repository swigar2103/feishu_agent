import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
dotenv.config({ path: envFile });

const EnvSchema = z.object({
  /** 未配置时进程可启动；实际调用 LLM 时在 client 层报错 */
  BAILIAN_API_KEY: z.string().default(""),
  BAILIAN_BASE_URL: z
    .string()
    .url("BAILIAN_BASE_URL 必须是 URL")
    .default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  BAILIAN_MODEL_ORCHESTRATOR: z.string().default("qwen2.5-vl-72b-instruct"),
  BAILIAN_MODEL_WRITER: z.string().default("qwen2.5-7b-instruct"),
  BAILIAN_MODEL_EMBEDDING: z.string().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LLM_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30000),
  /** 单次 LLM 调用：当 LLM_TIMEOUT_MS 为 0（旧版「无限制」）时使用的兜底超时，避免 fetch 永久挂起 */
  LLM_ZERO_TIMEOUT_FALLBACK_MS: z.coerce.number().int().positive().default(600_000),
  /** 整段报告图（多节点串行）总超时；0 表示不限制（不推荐） */
  REPORT_PIPELINE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(1_800_000),
  /**
   * LangGraph 单轮 invoke 的递归步数上限（默认 25 易被 reviewer 回路占满）
   * @see https://langchain-ai.github.io/langgraphjs/troubleshooting/errors/GRAPH_RECURSION_LIMIT/
   */
  REPORT_GRAPH_RECURSION_LIMIT: z.coerce.number().int().positive().default(64),
  /**
   * 百炼返回限流/云端超时/5xx 时，除首次外额外重试次数（例如 2 表示最多共 3 次请求）
   */
  LLM_HTTP_RETRIES: z.coerce.number().int().nonnegative().default(2),
  /** 重试前等待基数（毫秒），实际等待 = backoff * 已尝试次数 */
  LLM_RETRY_BACKOFF_MS: z.coerce.number().int().nonnegative().default(4_000),
  // Phase1 飞书主链路（未配置时 /api/phase1/mvp 会报错，但不影响 /generate-report）
  FEISHU_BASE_URL: z.string().url().default("https://open.feishu.cn"),
  FEISHU_APP_ID: z.string().default(""),
  FEISHU_APP_SECRET: z.string().default(""),
  FEISHU_TEMPLATE_FILE_TOKEN: z.string().default(""),
  FEISHU_TARGET_FOLDER_TOKEN: z.string().default(""),
  FEISHU_COPY_NAME_PREFIX: z.string().default("AI报告-"),
  /** 选填：MVP 完成后通过机器人发回链接的目标会话（群 chat_id） */
  FEISHU_IM_NOTIFY_CHAT_ID: z.string().default(""),
  /** Tool Gateway: 飞书官方 MCP endpoint（留空则自动走 fallback adapter） */
  FEISHU_MCP_URL: z.string().default(""),
  /** Tool Gateway: MCP 工具白名单，逗号分隔（须与飞书远程 MCP 工具名一致） */
  FEISHU_MCP_ALLOWED_TOOLS: z.string().default(
    "search-doc,fetch-doc,list-docs,fetch-file,create-doc,update-doc,get-comments,add-comments,search-user,get-user",
  ),
  /**
   * MCP 接入身份：tat=租户访问令牌 X-Lark-MCP-TAT；uat=用户访问令牌 X-Lark-MCP-UAT（须完成用户 OAuth 且请求上下文中带 userId）。
   * tools/list 探测无 userId 时自动用 TAT 回退（需配置 FEISHU_APP_ID/SECRET）。
   */
  FEISHU_MCP_IDENTITY: z.enum(["tat", "uat"]).default("tat"),
  /**
   * 发布后 fetch 验收：正文有效字符数低于该阈值视为空文档（0 表示不做长度阈值，仍校验标题）
   */
  FEISHU_DOC_PUBLISH_VERIFY_MIN_CHARS: z.coerce.number().int().nonnegative().default(50),
  /**
   * 深读/检索 viewDocument：正文短于该值时继续尝试下一个 Gateway adapter（lark-cli / OpenAPI raw_content），
   * 避免 MCP fetch-doc 只解析到摘要片段就提前返回。
   */
  FEISHU_VIEW_DOCUMENT_MIN_CHARS: z.coerce.number().int().nonnegative().default(600),
  /** Tool Gateway: 是否启用 lark-cli（auto 按能力与可用性探测） */
  LARK_CLI_ENABLED: z.enum(["auto", "true", "false"]).default("auto"),
  /** 模板层是否强制要求 lark-cli guidance 注入（true 时缺失即失败） */
  LARK_CLI_GUIDANCE_REQUIRED: z.coerce.boolean().default(true),
  /** lark-cli 可执行文件名或绝对路径 */
  LARK_CLI_BIN: z.string().default("lark-cli"),
  /** Tool Gateway: lark-cli profile（可选） */
  LARK_CLI_PROFILE: z.string().default(""),
  /** lark-cli 默认身份，等价于命令行的 --as */
  LARK_CLI_DEFAULT_AS: z.enum(["bot", "user"]).default("bot"),
  /** lark-cli 单次命令超时（毫秒） */
  LARK_CLI_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** docs +create 的文件夹 token；为空时回退 FEISHU_TARGET_FOLDER_TOKEN */
  LARK_CLI_FOLDER_TOKEN: z.string().default(""),
  /** 命令模板：文档搜索（支持 {query} 占位） */
  LARK_CLI_CMD_DOCS_SEARCH: z.string().default("docs +search"),
  /** 命令模板：用户搜索（支持 {query} 占位）；留空表示禁用 */
  LARK_CLI_CMD_CONTACT_SEARCH: z.string().default(""),
  /** 命令模板：用户详情（支持 {userId} 占位）；留空则由 searchUsers 兜底 */
  LARK_CLI_CMD_CONTACT_GET: z.string().default(""),
  /** 命令模板：Slides 创建（支持 {title}/{outline} 占位）；留空表示禁用 */
  LARK_CLI_CMD_SLIDES_CREATE: z.string().default(""),
  /** Slides 交付层级：outline_only 必做；artifact_best_effort 尝试真实发布 */
  FEISHU_SLIDES_DELIVERY_LEVEL: z
    .enum(["outline_only", "artifact_best_effort"])
    .default("outline_only"),
  /** 文档发布策略：gateway_only 保持原路由；lark_cli_first 优先尝试 lark-cli */
  FEISHU_DOC_PUBLISH_STRATEGY: z.enum(["gateway_only", "lark_cli_first"]).default("gateway_only"),
  /** 文档发布能力是否禁止 lark-cli 失败后回退（创建/更新）；MCP 联调阶段建议 false */
  FEISHU_DOC_LARK_CLI_HARD_PREFER: z.coerce.boolean().default(false),
  /** Resource Screening: 本地候选低于该数量时触发外部补检索 */
  RESOURCE_SCREENING_MIN_CANDIDATE_COUNT: z.coerce.number().int().positive().default(3),
  /** Resource Screening: topN 候选平均分低于该阈值时触发外部补检索 */
  RESOURCE_SCREENING_MIN_CANDIDATE_SCORE: z.coerce.number().min(0).max(1).default(0.35),
  /** 飞书 OpenAPI / MCP 的 fetch 超时（毫秒）；0 表示不限制 */
  FEISHU_HTTP_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(90_000),
  /**
   * 飞书机器人 webhook（/api/feishu/webhook）收到 IM 文本后走哪条链路：
   * - full：LangGraph 全链路 runReportPipeline，优先回结果卡片（链接+摘要），文本兜底
   * - phase1：复制云文档模板并按锚点填小节，回交互卡片链
   */
  FEISHU_BOT_PIPELINE: z.enum(["full", "phase1"]).default("full"),
  /**
   * 双层身份策略：
   * - bot_default：主流程走应用身份，用户授权仅作增强能力
   * - user_default：优先用户身份（仅建议联调）
   */
  FEISHU_IDENTITY_MODE: z.enum(["bot_default", "user_default"]).default("bot_default"),
  /**
   * 编辑工作台对外基址（用于 IM 结果卡片「进入编辑工作台」深链）。
   * 例如：https://www.feishu.space
   */
  FEISHU_WORKBENCH_BASE_URL: z.string().default(""),
  /** 用户授权增强：回调地址（需与开放平台一致） */
  FEISHU_USER_OAUTH_REDIRECT_URI: z.string().default(""),
  /** 用户授权增强：scope 列表（空格分隔） */
  FEISHU_USER_OAUTH_SCOPES: z
    .string()
    .default(
      "drive:drive drive:drive.search:readonly search:docs:read docx:document",
    ),
  /**
   * 授权页 `prompt`：留空默认；`consent` 时强制展示同意页（新增 scope 或遇 99991679 后建议开一次，再改回空）。
   * @see https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code
   */
  FEISHU_USER_OAUTH_PROMPT: z
    .string()
    .default("")
    .transform((s) => (s.trim() === "consent" ? "consent" : "")),
  /** 用户授权增强：授权页地址 */
  FEISHU_USER_OAUTH_AUTHORIZE_URL: z
    .string()
    .default("https://open.feishu.cn/open-apis/authen/v1/authorize"),
  /** OAuth pending state 文件条目上限，超过后按 createdAtMs 淘汰旧记录 */
  FEISHU_OAUTH_PENDING_STATE_MAX_ITEMS: z.coerce.number().int().positive().default(200),
  /**
   * 可写数据目录（runtime-memories.json、resource-pool.json）。
   * 不设且 VERCEL=1 时默认 /tmp/feishu-agent-data；本地默认 src/data。
   */
  FEISHU_WRITABLE_DATA_DIR: z.string().optional(),
  /**
   * 事件订阅「请求地址」校验时 body 里的 Verification Token；
   * 与开放平台事件配置页一致时填上（也可不配，服务端不校验 token）。
   */
  FEISHU_VERIFICATION_TOKEN: z.string().optional(),

  /** B 真飞书资源池：mock = 仅本地 JSON；real = 文档从云盘文件夹同步进池 */
  FEISHU_RESOURCE_POOL_SOURCE: z.enum(["mock", "real"]).default("mock"),
  /** 云盘文件夹 token（浏览器 /drive/folder/<TOKEN>）；FEISHU_RESOURCE_POOL_SOURCE=real 时必填 */
  FEISHU_RESOURCE_FOLDER_TOKEN: z.string().default(""),
  /** 单次最多把多少篇 docx 纳入资源池（上限 100） */
  FEISHU_RESOURCE_MAX_DOCX: z.coerce.number().int().positive().max(100).default(20),
  /** 真飞书资源池：自根文件夹向下最多遍历几层子文件夹（防过深目录） */
  FEISHU_RESOURCE_MAX_FOLDER_DEPTH: z.coerce.number().int().positive().max(64).default(16),
  /** HMRS：总开关（开启后按任务类型灰度切流） */
  HMRS_ENABLED: z.coerce.boolean().default(true),
  /** HMRS：灰度任务类型，逗号分隔（weekly_report,meeting_summary,templated_doc） */
  HMRS_ROLLOUT_TASK_TYPES: z.string().default("weekly_report,meeting_summary,templated_doc"),
  /** HMRS：是否记录旧/新检索差异日志 */
  HMRS_DIFF_LOG_ENABLED: z.coerce.boolean().default(true),
  /** HMRS：召回预算硬上限（最多展开条目数） */
  HMRS_RECALL_MAX_ITEMS: z.coerce.number().int().positive().default(6),
  /** HMRS：召回预算硬上限（最多展开字符预算） */
  HMRS_RECALL_MAX_CHARS: z.coerce.number().int().positive().default(30_000),
});

export const env = EnvSchema.parse(process.env);
