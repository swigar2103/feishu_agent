import { env } from "../../config/env.js";

/**
 * 带超时的 fetch，避免飞书 OpenAPI / MCP 在网络异常时无限挂起。
 * FEISHU_HTTP_TIMEOUT_MS=0 表示不启用超时。
 */
export async function feishuHttpFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const ms = env.FEISHU_HTTP_TIMEOUT_MS;
  if (ms <= 0) {
    return fetch(input, init);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`飞书 HTTP 请求超时（${ms}ms）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
