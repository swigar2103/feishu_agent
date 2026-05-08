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
  // Phase1 飞书主链路（未配置时 /api/phase1/mvp 会报错，但不影响 /generate-report）
  FEISHU_BASE_URL: z.string().url().default("https://open.feishu.cn"),
  FEISHU_APP_ID: z.string().default(""),
  FEISHU_APP_SECRET: z.string().default(""),
  FEISHU_TEMPLATE_FILE_TOKEN: z.string().default(""),
  FEISHU_TARGET_FOLDER_TOKEN: z.string().default(""),
  FEISHU_COPY_NAME_PREFIX: z.string().default("AI报告-"),
  /** 选填：MVP 完成后通过机器人发回链接的目标会话（群 chat_id） */
  FEISHU_IM_NOTIFY_CHAT_ID: z.string().default(""),

  /** B 真飞书资源池：mock = 仅本地 JSON；real = 文档从云盘文件夹同步进池 */
  FEISHU_RESOURCE_POOL_SOURCE: z.enum(["mock", "real"]).default("mock"),
  /** 云盘文件夹 token（浏览器 /drive/folder/<TOKEN>）；FEISHU_RESOURCE_POOL_SOURCE=real 时必填 */
  FEISHU_RESOURCE_FOLDER_TOKEN: z.string().default(""),
  /** 单次最多把多少篇 docx 纳入资源池（上限 100） */
  FEISHU_RESOURCE_MAX_DOCX: z.coerce.number().int().positive().max(100).default(20),
  /** 真飞书资源池：自根文件夹向下最多遍历几层子文件夹（防过深目录） */
  FEISHU_RESOURCE_MAX_FOLDER_DEPTH: z.coerce.number().int().positive().max(64).default(16),

  /**
   * 为 true：POST /generate-report 与 /generate-report-docx 跳过 LangGraph/检索，仅返回固定演示云文档 URL。
   * 正式环境请设 false。
   */
  REPORT_PIPELINE_DEMO_SKIP: z.coerce.boolean().default(true),
  /** 演示模式下写入报告 JSON / Word 的云文档链接 */
  REPORT_PIPELINE_DEMO_URL: z
    .string()
    .default("https://jcneyh7qlo8i.feishu.cn/docx/YT5TdRz1CoWgyExOqRVcWvH0nzb")
    .transform((s) => s.trim()),
  /** 演示模式下返回 JSON / Word 前的等待毫秒数（默认 20s；设 0 则立即返回） */
  REPORT_PIPELINE_DEMO_DELAY_MS: z.coerce.number().int().nonnegative().default(20_000),
});

export const env = EnvSchema.parse(process.env);
