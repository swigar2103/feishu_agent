import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

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
  /** Tool Gateway: MCP 工具白名单，逗号分隔 */
  FEISHU_MCP_ALLOWED_TOOLS: z.string().default(
    "search-docs,fetch-doc,list-docs,get-file-content,create-doc,update-doc,get-comments,add-comment,search-users,get-user-info",
  ),
  /** Tool Gateway: 是否启用 lark-cli（auto 按能力与可用性探测） */
  LARK_CLI_ENABLED: z.enum(["auto", "true", "false"]).default("auto"),
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
  /** 用户授权增强：回调地址（需与开放平台一致） */
  FEISHU_USER_OAUTH_REDIRECT_URI: z.string().default(""),
  /** 用户授权增强：scope 列表（空格分隔） */
  FEISHU_USER_OAUTH_SCOPES: z.string().default("drive:drive docx:document"),
  /** 用户授权增强：授权页地址 */
  FEISHU_USER_OAUTH_AUTHORIZE_URL: z
    .string()
    .default("https://open.feishu.cn/open-apis/authen/v1/authorize"),
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
});

export const env = EnvSchema.parse(process.env);
