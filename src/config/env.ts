import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const EnvSchema = z.object({
  BAILIAN_API_KEY: z.string().min(1, "BAILIAN_API_KEY 未配置"),
  BAILIAN_BASE_URL: z.string().url("BAILIAN_BASE_URL 必须是 URL"),
  BAILIAN_MODEL_ORCHESTRATOR: z.string().min(1),
  BAILIAN_MODEL_WRITER: z.string().min(1),
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
  /** 飞书 OpenAPI / MCP 的 fetch 超时（毫秒）；0 表示不限制 */
  FEISHU_HTTP_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(90_000),
});

export const env = EnvSchema.parse(process.env);
