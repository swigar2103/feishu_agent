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

  // 飞书（Phase 4）——全部 optional，缺失时自动走 mock 模式
  FEISHU_APP_ID: z.string().optional(),
  FEISHU_APP_SECRET: z.string().optional(),
  // "auto"（默认）：有凭证就走真实，没有就 mock；"true"：强制 mock；"false"：强制真实
  FEISHU_USE_MOCK: z.enum(["auto", "true", "false"]).default("auto"),
  // 国内飞书用 open.feishu.cn；海外 Lark 用 open.larksuite.com
  FEISHU_DOMAIN: z.string().default("open.feishu.cn"),
  // 距离过期多久开始主动刷新 tenant_access_token（默认提前 5 分钟）
  FEISHU_TOKEN_REFRESH_BUFFER_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(5 * 60 * 1000),

  // Phase 4.6 报告通知：生成完报告后向该 chat/用户发送卡片消息
  // 三选一（按优先级）：FEISHU_NOTIFY_CHAT_ID > FEISHU_NOTIFY_OPEN_ID > FEISHU_NOTIFY_EMAIL
  FEISHU_NOTIFY_CHAT_ID: z.string().optional(),
  FEISHU_NOTIFY_OPEN_ID: z.string().optional(),
  FEISHU_NOTIFY_EMAIL: z.string().optional(),
  // 总开关：false 时完全跳过通知（即使配了 ID）；默认开
  FEISHU_NOTIFY_ENABLED: z.enum(["true", "false"]).default("true"),

  // Phase 5 云文档回写：把完整周报写成飞书 docx 云文档
  //   auto（默认）= 有飞书凭证就尝试写，没权限会在运行期降级并打 trace
  //   true        = 强制开启
  //   false       = 强制关闭（即使凭证齐全）
  FEISHU_DOCX_ENABLED: z.enum(["auto", "true", "false"]).default("auto"),
  // 创建的文档放在哪个云空间文件夹下；为空则落在"我的空间"根目录
  // 获取方法：浏览器打开目标文件夹，URL 形如 https://xxx.feishu.cn/drive/folder/<TOKEN>，取最后那一段
  FEISHU_DOCX_FOLDER_TOKEN: z.string().optional(),
  // 最终展示给用户点击的 URL 前缀。默认的 www.feishu.cn 可以识别并跳到你所在租户
  // 如果你有自定义租户域名（如 yourco.feishu.cn）可以写这里，体验更好
  FEISHU_DOCX_URL_PREFIX: z.string().default("https://www.feishu.cn/docx/"),

  // Phase 4.2 真实检索：扫飞书云盘文件夹下的 docx 作为素材
  //   未配置 folder_token → searchEverything 仍然降级 mock（不阻塞主流程）
  //   配置后 → 列目录 → 拉 raw_content → 关键词打分 → 返回 Top N
  FEISHU_SEARCH_FOLDER_TOKEN: z.string().optional(),
  // 单次最多扫描的 docx 数（超过这个数就停止拉 raw_content，避免大目录拖慢）
  FEISHU_SEARCH_MAX_DOCS: z.coerce.number().int().positive().default(10),
  // 最终返回给主流程的素材条数（按相关度排序后截断）
  FEISHU_SEARCH_TOP_K: z.coerce.number().int().positive().default(5),

  // Phase 4.3 真实检索：把指定飞书群聊的近期消息也作为素材
  //   未配置 chat_id → 跳过这路，不影响主流程
  //   配置后 → 拉最近 N 条群消息 → 关键词打分 → 返回 Top M 条作为 asset
  // 为简化配置，留空时会自动回退使用 FEISHU_NOTIFY_CHAT_ID（即你当前接收通知的群）
  FEISHU_SEARCH_CHAT_ID: z.string().optional(),
  // 拉取最近多少条群消息；太大容易触发限流，50~200 之间比较合适
  FEISHU_SEARCH_IM_LIMIT: z.coerce.number().int().positive().default(80),
  // 关键词打分后返回给主流程的群消息素材条数
  FEISHU_SEARCH_IM_TOP_K: z.coerce.number().int().positive().default(3),
  // 只回溯最近多少小时内的消息（更老的不考虑，避免召回陈旧上下文）。默认 7 天
  FEISHU_SEARCH_IM_WINDOW_HOURS: z.coerce.number().int().positive().default(24 * 7),
});

export const env = EnvSchema.parse(process.env);
