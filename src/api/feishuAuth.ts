import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { getFeishuMvpConfig } from "../integrations/feishu/feishuConfig.js";
import { feishuHttpFetch } from "../integrations/feishu/httpFetch.js";
import { logger } from "../shared/logger.js";
import { getUserOAuthRecord, upsertUserOAuthRecord } from "../storage/userOAuthStore.js";

type PendingState = {
  userId: string;
  createdAtMs: number;
};

const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map<string, PendingState>();

const StartQuerySchema = z.object({
  userId: z.string().min(1),
  returnTo: z.string().optional(),
});

const CallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const StatusQuerySchema = z.object({
  userId: z.string().min(1),
});

function cleanupPendingStates(nowMs = Date.now()): void {
  for (const [state, item] of pendingStates.entries()) {
    if (item.createdAtMs + STATE_TTL_MS < nowMs) {
      pendingStates.delete(state);
    }
  }
}

function splitScopes(raw: string): string[] {
  return raw
    .split(/[,\s]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function registerFeishuAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/feishu/auth/start", async (request, reply) => {
    const parsed = StartQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ message: "invalid query", issues: parsed.error.issues });
    }
    if (!env.FEISHU_USER_OAUTH_REDIRECT_URI.trim()) {
      return reply.status(400).send({
        message: "缺少 FEISHU_USER_OAUTH_REDIRECT_URI，无法启用用户授权通道",
      });
    }
    cleanupPendingStates();
    const { userId, returnTo } = parsed.data;
    const state = crypto.randomUUID();
    pendingStates.set(state, { userId, createdAtMs: Date.now() });
    const scopes = splitScopes(env.FEISHU_USER_OAUTH_SCOPES);
    const authUrl = new URL(env.FEISHU_USER_OAUTH_AUTHORIZE_URL);
    authUrl.searchParams.set("app_id", env.FEISHU_APP_ID);
    authUrl.searchParams.set("redirect_uri", env.FEISHU_USER_OAUTH_REDIRECT_URI);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("scope", scopes.join(" "));
    if (returnTo?.trim()) {
      authUrl.searchParams.set("redirect", returnTo.trim());
    }
    return reply.send({
      ok: true,
      identityMode: env.FEISHU_IDENTITY_MODE,
      userId,
      authUrl: authUrl.toString(),
      state,
      expiresInMs: STATE_TTL_MS,
      scopes,
    });
  });

  app.get("/api/feishu/auth/callback", async (request, reply) => {
    const parsed = CallbackQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ message: "invalid callback query", issues: parsed.error.issues });
    }
    cleanupPendingStates();
    const pending = pendingStates.get(parsed.data.state);
    if (!pending) {
      return reply.status(400).send({ message: "state 无效或已过期，请重新发起授权" });
    }
    pendingStates.delete(parsed.data.state);

    try {
      const c = getFeishuMvpConfig();
      const tokenResp = await feishuHttpFetch(`${c.baseUrl}/open-apis/authen/v2/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: parsed.data.code,
          client_id: c.appId,
          client_secret: c.appSecret,
          redirect_uri: env.FEISHU_USER_OAUTH_REDIRECT_URI,
        }),
      });
      const tokenBody = (await tokenResp.json()) as {
        code?: number;
        msg?: string;
        data?: {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          scope?: string;
        };
      };
      const accessToken = tokenBody.data?.access_token ?? "";
      if (!tokenResp.ok || tokenBody.code !== 0 || !accessToken) {
        logger.error("feishu oauth token exchange failed", {
          status: tokenResp.status,
          userId: pending.userId,
          response: tokenBody,
        });
        return reply.status(502).send({
          message: "授权回调成功但换取 token 失败",
          detail: tokenBody.msg ?? tokenResp.status,
        });
      }
      const expiresInSec = tokenBody.data?.expires_in ?? 7200;
      const scopeText = tokenBody.data?.scope ?? env.FEISHU_USER_OAUTH_SCOPES;
      upsertUserOAuthRecord({
        userId: pending.userId,
        accessToken,
        refreshToken: tokenBody.data?.refresh_token,
        expiresAtMs: Date.now() + expiresInSec * 1000,
        scopes: splitScopes(scopeText),
        grantedAtMs: Date.now(),
      });
      return reply.type("text/html; charset=utf-8").send(`
<!doctype html>
<html><body style="font-family:Arial,sans-serif;padding:24px;">
<h3>授权成功</h3>
<p>用户 <code>${pending.userId}</code> 已完成增强能力授权，可返回飞书继续使用。</p>
</body></html>`);
    } catch (error) {
      logger.error("feishu oauth callback failed", { error });
      return reply.status(500).send({
        message: error instanceof Error ? error.message : "授权处理失败",
      });
    }
  });

  app.get("/api/feishu/auth/status", async (request, reply) => {
    const parsed = StatusQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ message: "invalid query", issues: parsed.error.issues });
    }
    const record = getUserOAuthRecord(parsed.data.userId);
    if (!record) {
      return reply.send({
        ok: true,
        authorized: false,
        identityMode: env.FEISHU_IDENTITY_MODE,
        userId: parsed.data.userId,
      });
    }
    return reply.send({
      ok: true,
      authorized: record.expiresAtMs > Date.now(),
      identityMode: env.FEISHU_IDENTITY_MODE,
      userId: parsed.data.userId,
      scopes: record.scopes,
      expiresAtMs: record.expiresAtMs,
    });
  });
}

