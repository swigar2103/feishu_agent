import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { getFeishuMvpConfig } from "../integrations/feishu/feishuConfig.js";
import { feishuHttpFetch } from "../integrations/feishu/httpFetch.js";
import { runImTextPipelineFireAndForget } from "../integrations/feishu/imTextPipelineDispatch.js";
import {
  consumePendingOAuthState,
  createFeishuUserAuthorizeSession,
  splitOAuthScopes,
} from "../integrations/feishu/userOAuthAuthorizeFlow.js";
import { logger } from "../shared/logger.js";
import { getUserOAuthRecord, upsertUserOAuthRecord } from "../storage/userOAuthStore.js";

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

export async function registerFeishuAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/feishu/auth/start", async (request, reply) => {
    const parsed = StartQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ message: "invalid query", issues: parsed.error.issues });
    }
    try {
      const { userId, returnTo } = parsed.data;
      const { authUrl, state, expiresInMs } = createFeishuUserAuthorizeSession({
        userId,
        returnTo,
      });
      const scopes = splitOAuthScopes(env.FEISHU_USER_OAUTH_SCOPES);
      return reply.send({
        ok: true,
        identityMode: env.FEISHU_IDENTITY_MODE,
        userId,
        authUrl,
        state,
        expiresInMs,
        scopes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法创建授权会话";
      return reply.status(400).send({ message });
    }
  });

  app.get("/api/feishu/auth/callback", async (request, reply) => {
    const parsed = CallbackQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ message: "invalid callback query", issues: parsed.error.issues });
    }
    const pending = consumePendingOAuthState(parsed.data.state);
    if (!pending) {
      return reply.status(400).send({ message: "state 无效或已过期，请重新发起授权" });
    }

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
      /** 飞书 v2 token 接口常见两种包装：{ code, data: { access_token } } 或根级 { code, access_token } */
      const tokenBody = (await tokenResp.json()) as {
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
      const data = tokenBody.data;
      const accessToken = data?.access_token ?? tokenBody.access_token ?? "";
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
      const expiresInSec = data?.expires_in ?? tokenBody.expires_in ?? 7200;
      const rawScope =
        (typeof data?.scope === "string" && data.scope.trim()) ||
        (typeof tokenBody.scope === "string" && tokenBody.scope.trim()) ||
        "";
      const scopes = rawScope ? splitOAuthScopes(rawScope) : [];
      if (!rawScope) {
        logger.warn("feishu oauth token 响应未含 scope，已写入空列表；UAT 可能反复发授权卡直至飞书返回 scope", {
          userId: pending.userId,
        });
      }
      upsertUserOAuthRecord({
        userId: pending.userId,
        accessToken,
        refreshToken: data?.refresh_token ?? tokenBody.refresh_token,
        expiresAtMs: Date.now() + expiresInSec * 1000,
        scopes,
        grantedAtMs: Date.now(),
      });
      logger.info("feishu user oauth token stored", {
        userId: pending.userId,
        scopes,
        expiresInSec,
      });

      const replay = pending.replay;
      if (replay && c.appId && c.appSecret) {
        runImTextPipelineFireAndForget(
          c,
          {
            chatId: replay.chatId,
            messageId: replay.messageId,
            text: replay.text,
            userId: pending.userId,
          },
          replay.pipeline,
        );
      } else if (replay && (!c.appId || !c.appSecret)) {
        logger.warn("oauth IM replay skipped: missing FEISHU_APP_ID / FEISHU_APP_SECRET");
      }

      const followUp = replay
        ? "<p>授权已保存。正在后台继续处理您刚才在飞书中发送的需求，请稍候在同一会话查看结果卡片。</p>"
        : "<p>可关闭此页并返回飞书继续使用。</p>";

      return reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html><body style="font-family:Arial,sans-serif;padding:24px;">
<h3>授权成功</h3>
<p>用户 <code>${pending.userId}</code> 已完成文档相关能力授权。</p>
${followUp}
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
    const required = splitOAuthScopes(env.FEISHU_USER_OAUTH_SCOPES);
    const granted = new Set(record.scopes);
    const missingScopes = required.filter((s) => !granted.has(s));
    return reply.send({
      ok: true,
      authorized: record.expiresAtMs > Date.now(),
      identityMode: env.FEISHU_IDENTITY_MODE,
      userId: parsed.data.userId,
      scopes: record.scopes,
      missingScopes,
      expiresAtMs: record.expiresAtMs,
    });
  });
}
