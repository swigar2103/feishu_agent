import { getFeishuMvpConfig } from "./feishuConfig.js";
import { feishuHttpFetch } from "./httpFetch.js";
import { splitOAuthScopes } from "./userOAuthAuthorizeFlow.js";
import { logger } from "../../shared/logger.js";
import { getUserOAuthRecord, upsertUserOAuthRecord, type UserOAuthRecord } from "../../storage/userOAuthStore.js";

type EnsureUserOAuthReadyResult = {
  record: UserOAuthRecord | null;
  refreshed: boolean;
};

type OAuthTokenResp = {
  code?: number;
  msg?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  data?: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
};

/**
 * UAT 模式下确保用户 token 可用：
 * - 未过期（预留 60s）直接返回；
 * - 过期且有 refresh_token 则自动刷新；
 * - 刷新失败则返回 null，由上层继续走授权卡。
 */
export async function ensureUserOAuthReady(userId: string): Promise<EnsureUserOAuthReadyResult> {
  const nowMs = Date.now();
  const existing = getUserOAuthRecord(userId);
  if (!existing) return { record: null, refreshed: false };
  if (existing.expiresAtMs > nowMs + 60_000) {
    return { record: existing, refreshed: false };
  }
  if (!existing.refreshToken?.trim()) {
    logger.info("oauth refresh skipped: refresh_token missing", { userId });
    return { record: null, refreshed: false };
  }

  const c = getFeishuMvpConfig();
  if (!c.appId.trim() || !c.appSecret.trim()) {
    logger.warn("oauth refresh skipped: missing FEISHU_APP_ID/FEISHU_APP_SECRET", { userId });
    return { record: null, refreshed: false };
  }

  try {
    const resp = await feishuHttpFetch(`${c.baseUrl}/open-apis/authen/v2/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: existing.refreshToken,
        client_id: c.appId,
        client_secret: c.appSecret,
      }),
    });
    const body = (await resp.json()) as OAuthTokenResp;
    const data = body.data;
    const accessToken = data?.access_token ?? body.access_token ?? "";
    if (!resp.ok || body.code !== 0 || !accessToken) {
      logger.warn("oauth refresh failed", {
        userId,
        status: resp.status,
        code: body.code,
        msg: body.msg,
      });
      return { record: null, refreshed: false };
    }

    const expiresInSec = data?.expires_in ?? body.expires_in ?? 7200;
    const rawScope =
      (typeof data?.scope === "string" && data.scope.trim()) ||
      (typeof body.scope === "string" && body.scope.trim()) ||
      "";
    const nextScopes = rawScope ? splitOAuthScopes(rawScope) : existing.scopes;
    const refreshed: UserOAuthRecord = {
      userId: existing.userId,
      accessToken,
      refreshToken: data?.refresh_token ?? body.refresh_token ?? existing.refreshToken,
      expiresAtMs: Date.now() + expiresInSec * 1000,
      scopes: nextScopes,
      grantedAtMs: existing.grantedAtMs,
    };
    upsertUserOAuthRecord(refreshed);
    logger.info("oauth refresh succeeded", {
      userId,
      expiresInSec,
      scopeCount: refreshed.scopes.length,
    });
    return { record: refreshed, refreshed: true };
  } catch (error) {
    logger.warn("oauth refresh exception", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { record: null, refreshed: false };
  }
}

