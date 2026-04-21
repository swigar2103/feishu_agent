import { logger } from "../../shared/logger.js";
import type { FeishuConfig } from "./config.js";
import type { FeishuTokenManager } from "./tokenManager.js";

/**
 * 飞书低层 HTTP 客户端（Phase 4.1）。
 *
 * 职责：
 *   - 统一前缀 baseUrl
 *   - 自动注入 Authorization: Bearer <tenant_access_token>
 *   - 401/403/token invalid 时强制刷新 token 并重试一次
 *   - 统一错误封装（带 code/msg）
 *
 * 不做的事：
 *   - 不做业务层语义（检索 / 回写 / bitable 等留给 adapter 层）
 *   - 不做速率限流（留到 Phase 4.2 再按需加）
 */

export type FeishuApiResponse<T> = {
  code: number;
  msg: string;
  data?: T;
};

export class FeishuApiError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly httpStatus: number,
    public readonly raw: unknown,
  ) {
    super(message);
    this.name = "FeishuApiError";
  }
}

const TOKEN_INVALID_CODES = new Set([
  99991661, // access token invalid
  99991663, // access token expired
  99991664, // tenant access token invalid
]);

export class FeishuClient {
  constructor(
    private readonly config: FeishuConfig,
    private readonly tokenManager: FeishuTokenManager,
  ) {}

  /** 相对路径形如 "/im/v1/messages"；baseUrl 自动拼接 */
  async request<T = unknown>(
    pathname: string,
    init: { method?: string; query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = this.buildUrl(pathname, init.query);
    const doOnce = async (token: string): Promise<Response> =>
      fetch(url, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });

    let token = await this.tokenManager.getToken();
    let resp = await doOnce(token);

    if (resp.status === 401 || resp.status === 403) {
      logger.warn("[FeishuClient] token 可能失效，强制刷新后重试", { pathname, status: resp.status });
      token = await this.tokenManager.refresh();
      resp = await doOnce(token);
    }

    const text = await resp.text();
    let payload: FeishuApiResponse<T> | null = null;
    try {
      payload = text ? (JSON.parse(text) as FeishuApiResponse<T>) : null;
    } catch {
      throw new FeishuApiError(
        `飞书 ${pathname} 返回非 JSON (HTTP ${resp.status})`,
        -1,
        resp.status,
        text.slice(0, 500),
      );
    }

    if (!resp.ok || !payload) {
      throw new FeishuApiError(
        `飞书 ${pathname} HTTP ${resp.status}${payload?.msg ? `: ${payload.msg}` : ""}`,
        payload?.code ?? -1,
        resp.status,
        payload ?? text.slice(0, 500),
      );
    }

    // code !== 0 在飞书里就是业务失败
    if (payload.code !== 0) {
      // token 失效类错误走 fetch 以上的路径已经处理过一次；这里再刷新意义不大
      if (TOKEN_INVALID_CODES.has(payload.code)) {
        logger.warn("[FeishuClient] 业务层 token 失效，强制刷新并重试一次", {
          pathname,
          code: payload.code,
        });
        const retryToken = await this.tokenManager.refresh();
        const retryResp = await doOnce(retryToken);
        const retryText = await retryResp.text();
        try {
          const retryPayload = JSON.parse(retryText) as FeishuApiResponse<T>;
          if (retryPayload.code === 0) return (retryPayload.data ?? null) as T;
          throw new FeishuApiError(
            `飞书 ${pathname} 重试后仍业务错误: ${retryPayload.msg}`,
            retryPayload.code,
            retryResp.status,
            retryPayload,
          );
        } catch (err) {
          if (err instanceof FeishuApiError) throw err;
          throw new FeishuApiError(
            `飞书 ${pathname} 重试后返回非 JSON`,
            -1,
            retryResp.status,
            retryText.slice(0, 500),
          );
        }
      }
      throw new FeishuApiError(
        `飞书 ${pathname} 业务错误 code=${payload.code}: ${payload.msg}`,
        payload.code,
        resp.status,
        payload,
      );
    }

    return (payload.data ?? null) as T;
  }

  private buildUrl(pathname: string, query: Record<string, string | number | undefined> | undefined): string {
    const base = this.config.baseUrl.replace(/\/$/, "");
    const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
    const url = new URL(`${base}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
}
