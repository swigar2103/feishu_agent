import { env } from "../../config/env.js";
import type { RetrievalContext } from "../../schemas/index.js";
import { logger } from "../../shared/logger.js";
import { FeishuClient } from "../feishu/client.js";
import { resolveFeishuConfig, type FeishuConfig } from "../feishu/config.js";
import { searchDocsInFolder, type DocxSearchHit } from "../feishu/driveSearch.js";
import { searchMessagesInChat, type ImMessageHit } from "../feishu/imSearch.js";
import { FeishuTokenManager } from "../feishu/tokenManager.js";
import { parseJsonFromMd } from "./mdParser.js";

type AssetType = RetrievalContext["projectContext"][0];

/**
 * Retrieval 层对接飞书的统一抽象。
 * Phase 4.1 只定义 searchEverything；Phase 4.2 会扩展 getDoc / listBitableRecords 等。
 */
export interface FeishuAdapter {
  readonly mode: "mock" | "real";
  searchEverything(query: string): Promise<AssetType[]>;
}

// ============ Mock 实现（保留现状）============
export class FeishuMockAdapter implements FeishuAdapter {
  readonly mode = "mock" as const;
  private assets: AssetType[] = [];

  constructor() {
    try {
      this.assets = parseJsonFromMd<AssetType[]>("src/data/assets.md");
    } catch (err) {
      logger.warn("[FeishuMockAdapter] assets.md 读取失败，使用空资产集", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.assets = [];
    }
  }

  async searchEverything(query: string): Promise<AssetType[]> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const results = this.assets.filter(
      (asset) =>
        asset.content.toLowerCase().includes(query.toLowerCase()) ||
        query.toLowerCase().includes("报告"),
    );
    return results.length > 0 ? results : this.assets.slice(0, 2);
  }
}

// ============ Real 实现（Phase 4.1 骨架 + 4.2 真实检索）============
/**
 * FeishuRealAdapter：
 *   - Phase 4.1：启动时获取一次 tenant_access_token 做健康自检；healthCheck 暴露给 /healthz
 *   - Phase 4.2：searchEverything 接入真实 drive/docx 检索
 *       - 配置了 FEISHU_SEARCH_FOLDER_TOKEN → 扫目录下 docx、拉 raw_content、关键词打分
 *       - 未配置 / 接口失败 / 零命中 → 降级到内置 MockAdapter（保证主流程连贯）
 *   - Phase 4.3（待做）：再追加 IM 消息检索源
 */
export class FeishuRealAdapter implements FeishuAdapter {
  readonly mode = "real" as const;
  private readonly client: FeishuClient;
  private readonly fallback = new FeishuMockAdapter();
  private lastHealth: { healthy: boolean; at: string; message: string } = {
    healthy: false,
    at: new Date().toISOString(),
    message: "未执行健康检查",
  };

  constructor(
    config: FeishuConfig,
    public readonly tokenManager: FeishuTokenManager,
  ) {
    this.client = new FeishuClient(config, tokenManager);
  }

  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    try {
      await this.tokenManager.getToken();
      const ok = { healthy: true, at: new Date().toISOString(), message: "tenant_access_token 获取成功" };
      this.lastHealth = ok;
      return { healthy: true, message: ok.message };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastHealth = { healthy: false, at: new Date().toISOString(), message };
      return { healthy: false, message };
    }
  }

  getLastHealth(): { healthy: boolean; at: string; message: string } {
    return this.lastHealth;
  }

  async searchEverything(query: string): Promise<AssetType[]> {
    const realResults: AssetType[] = [];
    const sources: string[] = [];

    // Phase 4.2：飞书云盘 docx 检索
    if (env.FEISHU_SEARCH_FOLDER_TOKEN) {
      try {
        const hits = await searchDocsInFolder(this.client, {
          folderToken: env.FEISHU_SEARCH_FOLDER_TOKEN,
          query,
          maxDocs: env.FEISHU_SEARCH_MAX_DOCS,
          topK: env.FEISHU_SEARCH_TOP_K,
        });
        for (const h of hits) {
          realResults.push(docxHitToAsset(h));
        }
        sources.push(`drive_docx(${hits.length})`);
      } catch (err) {
        logger.warn("[FeishuRealAdapter] drive docx 检索失败（非阻塞，将降级 mock）", {
          query,
          error: err instanceof Error ? err.message : String(err),
        });
        sources.push("drive_docx(error)");
      }
    } else {
      sources.push("drive_docx(no_folder_token)");
    }

    // Phase 4.3：飞书群聊消息检索
    const chatId = resolveImSearchChatId();
    if (chatId) {
      try {
        const hits = await searchMessagesInChat(this.client, {
          chatId,
          query,
          limit: env.FEISHU_SEARCH_IM_LIMIT,
          topK: env.FEISHU_SEARCH_IM_TOP_K,
          windowHours: env.FEISHU_SEARCH_IM_WINDOW_HOURS,
        });
        for (const h of hits) {
          realResults.push(imHitToAsset(h, chatId));
        }
        sources.push(`im_messages(${hits.length})`);
      } catch (err) {
        logger.warn("[FeishuRealAdapter] im 消息检索失败（非阻塞）", {
          query,
          error: err instanceof Error ? err.message : String(err),
        });
        sources.push("im_messages(error)");
      }
    } else {
      sources.push("im_messages(no_chat_id)");
    }

    if (realResults.length > 0) {
      logger.info("[FeishuRealAdapter] 真实检索命中", {
        count: realResults.length,
        sources: sources.join(","),
      });
      return realResults;
    }

    logger.info("[FeishuRealAdapter] 真实检索零命中，降级到 mock 数据源", {
      query,
      sources: sources.join(","),
    });
    try {
      await this.tokenManager.getToken();
    } catch (err) {
      logger.warn("[FeishuRealAdapter] token 获取失败（仍继续 mock）", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return this.fallback.searchEverything(query);
  }

  // 给后续 Phase 4.2+ 直接用的低层通道，不对外暴露
  internalClient(): FeishuClient {
    return this.client;
  }
}

// ============ 工具：DocxSearchHit → RetrievalContext Asset 映射 ============
function docxHitToAsset(hit: DocxSearchHit): AssetType {
  const header = `【飞书云文档】${hit.name}${hit.url ? `\n[原文链接] ${hit.url}` : ""}`;
  return {
    sourceId: `feishu_docx_${hit.token}`,
    sourceType: "doc",
    content: `${header}\n\n${hit.snippet}`,
  };
}

/** 把 IM 消息命中封装成 RetrievalContext 的 asset（sourceType=message） */
function imHitToAsset(hit: ImMessageHit, chatId: string): AssetType {
  const timeLabel = hit.createTime ? ` · ${hit.createTime.slice(0, 16).replace("T", " ")}` : "";
  const header = `【飞书群聊讨论${timeLabel}】`;
  return {
    sourceId: `feishu_im_${hit.messageId}`,
    sourceType: "message",
    content: `${header}\n${hit.snippet}\n(chat=${maskTail(chatId)} sender=${maskTail(hit.senderId ?? "")})`,
  };
}

/**
 * 确定 IM 检索用的 chat_id：
 *   - 显式值 "off" / "false" → 关闭这路
 *   - 有 FEISHU_SEARCH_CHAT_ID → 用它
 *   - 没有 → 自动回退到 FEISHU_NOTIFY_CHAT_ID（通常就是你当前接收通知的群）
 *   - 两个都没有 → 返回 null（上层就跳过这路）
 */
function resolveImSearchChatId(): string | null {
  const explicit = env.FEISHU_SEARCH_CHAT_ID?.trim();
  if (explicit && /^(off|false|none)$/i.test(explicit)) return null;
  if (explicit) return explicit;
  const fallback = env.FEISHU_NOTIFY_CHAT_ID?.trim();
  return fallback && fallback.length > 0 ? fallback : null;
}

function maskTail(s: string): string {
  if (!s) return "";
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

// ============ 工厂 ============
export type CreatedAdapter = {
  adapter: FeishuAdapter;
  config: FeishuConfig;
  degraded: boolean;
  degradationReason?: string;
};

/**
 * 按 env 选 adapter；real 模式下凭证缺失会降级回 mock 并打警告。
 * 进程内单例在 engine 层持有即可。
 */
export function createFeishuAdapter(): CreatedAdapter {
  const config = resolveFeishuConfig();
  logger.info("[Feishu] 适配器决策", {
    mode: config.mode,
    reason: config.diagnostic.resolvedReason,
    domain: config.domain,
  });

  if (config.mode === "mock") {
    return { adapter: new FeishuMockAdapter(), config, degraded: false };
  }

  if (!config.diagnostic.hasAppId || !config.diagnostic.hasAppSecret) {
    const reason = "real 模式但凭证缺失（AppID/AppSecret），降级到 mock";
    logger.warn(`[Feishu] ${reason}`);
    return {
      adapter: new FeishuMockAdapter(),
      config: { ...config, mode: "mock" },
      degraded: true,
      degradationReason: reason,
    };
  }

  const tokenManager = new FeishuTokenManager(config);
  const real = new FeishuRealAdapter(config, tokenManager);
  return { adapter: real, config, degraded: false };
}
