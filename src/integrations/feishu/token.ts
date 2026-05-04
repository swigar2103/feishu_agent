import { logger } from "../../shared/logger.js";
import { feishuHttpFetch } from "./httpFetch.js";
import type { FeishuMvpConfig } from "./feishuConfig.js";

type TokenResponse = {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
};

let cache: { token: string; expiresAtMs: number } | null = null;
const SKEW_MS = 60_000;

export async function getTenantAccessToken(
  c: FeishuMvpConfig,
): Promise<string> {
  const now = Date.now();
  if (cache && cache.expiresAtMs > now + SKEW_MS) {
    return cache.token;
  }

  const url = `${c.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`;
  const res = await feishuHttpFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: c.appId, app_secret: c.appSecret }),
  });
  const data = (await res.json()) as TokenResponse;
  if (!res.ok || data.code !== 0 || !data.tenant_access_token) {
    logger.error("飞书 tenant_access_token 失败", { status: res.status, data });
    throw new Error(
      `飞书 token 失败: ${data.msg ?? res.status} (code=${data.code})`,
    );
  }
  const ttlSec = typeof data.expire === "number" ? data.expire : 7000;
  cache = {
    token: data.tenant_access_token,
    expiresAtMs: now + ttlSec * 1000,
  };
  return cache.token;
}
