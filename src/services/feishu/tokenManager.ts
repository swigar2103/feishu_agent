import { logger } from "../../shared/logger.js";
import type { FeishuConfig } from "./config.js";

/**
 * tenant_access_token 管理器（Phase 4.1）。
 *
 * 特性：
 *   - 进程内缓存：避免每次 API 调用都去换 token
 *   - 提前刷新：到期前 tokenRefreshBufferMs（默认 5 分钟）主动刷新，避免临界点 401
 *   - 并发去重：同时多个调用时只发起一次刷新请求
 *   - 强制刷新：401 后可由上层调用 refresh() 强制重拿
 *   - 无副作用：本模块不直接调业务 API，只负责 token
 */

type TokenCache = {
  token: string;
  /** 过期时间戳（ms），本地时钟 */
  expiresAt: number;
};

type FeishuTokenResponse = {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number; // 秒
};

export class FeishuTokenManager {
  private cache: TokenCache | null = null;
  private refreshingPromise: Promise<string> | null = null;

  constructor(private readonly config: FeishuConfig) {}

  /** 取一个可用 token。缓存命中且未到刷新阈值时直接返回；否则触发刷新。*/
  async getToken(): Promise<string> {
    if (this.isFresh(this.cache)) {
      return this.cache!.token;
    }
    return this.refresh();
  }

  /** 强制刷新（用于 401 后的重试路径）*/
  async refresh(): Promise<string> {
    if (this.refreshingPromise) return this.refreshingPromise;

    this.refreshingPromise = this.doRefresh().finally(() => {
      this.refreshingPromise = null;
    });
    return this.refreshingPromise;
  }

  /** 诊断用，不泄漏 token 本身 */
  describe(): { cached: boolean; expiresInMs: number | null } {
    if (!this.cache) return { cached: false, expiresInMs: null };
    return {
      cached: true,
      expiresInMs: Math.max(0, this.cache.expiresAt - Date.now()),
    };
  }

  private isFresh(cache: TokenCache | null): cache is TokenCache {
    if (!cache) return false;
    return Date.now() + this.config.tokenRefreshBufferMs < cache.expiresAt;
  }

  private async doRefresh(): Promise<string> {
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error("飞书凭证缺失（FEISHU_APP_ID / FEISHU_APP_SECRET）");
    }

    const url = `${this.config.baseUrl}/auth/v3/tenant_access_token/internal`;
    const body = {
      app_id: this.config.appId,
      app_secret: this.config.appSecret,
    };

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `飞书 token 接口网络失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`飞书 token 接口 HTTP ${resp.status}: ${text.slice(0, 300)}`);
    }

    const data = (await resp.json().catch(() => null)) as FeishuTokenResponse | null;
    if (!data) {
      throw new Error("飞书 token 接口返回非 JSON");
    }
    if (data.code !== 0 || !data.tenant_access_token || !data.expire) {
      throw new Error(`飞书 token 接口业务错误 code=${data.code} msg=${data.msg ?? "(无)"}`);
    }

    const expiresAt = Date.now() + data.expire * 1000;
    this.cache = { token: data.tenant_access_token, expiresAt };
    logger.info("[FeishuTokenManager] tenant_access_token 已刷新", {
      expiresInSec: data.expire,
    });
    return data.tenant_access_token;
  }
}
