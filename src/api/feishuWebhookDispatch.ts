import type { FastifyReply } from "fastify";
import { env } from "../config/env.js";
import { getFeishuMvpConfig } from "../integrations/feishu/feishuConfig.js";
import { buildUserOAuthRequiredCard } from "../integrations/feishu/cards.js";
import { runImTextPipelineFireAndForget } from "../integrations/feishu/imTextPipelineDispatch.js";
import { sendCardMessage, sendTextMessage } from "../integrations/feishu/imMessage.js";
import { ensureUserOAuthReady } from "../integrations/feishu/userOAuthRefresh.js";
import { parseFeishuImTextEvent } from "../integrations/feishu/webhookMessageParse.js";
import {
  createFeishuUserAuthorizeSession,
  splitOAuthScopes,
} from "../integrations/feishu/userOAuthAuthorizeFlow.js";
import { shouldRemindUat } from "../integrations/feishu/uatReminder.js";
import type { FeishuWebhookBody } from "../schemas/feishuWebhookBody.js";
import { logger } from "../shared/logger.js";
import {
  userOAuthGrantedScopesCoverRequired,
} from "../storage/userOAuthStore.js";

const WEBHOOK_DEDUP_WINDOW_MS = 25_000;
const recentWebhookSeen = new Map<string, number>();
const latestMessageWatermarkByChat = new Map<string, number>();

function gcRecentWebhookSeen(now: number): void {
  for (const [key, expiresAt] of recentWebhookSeen.entries()) {
    if (expiresAt <= now) recentWebhookSeen.delete(key);
  }
}

function normalizeWebhookText(input: string): string {
  return input.trim().replace(/\s+/g, " ").slice(0, 200);
}

function markAndCheckDedup(keys: string[]): boolean {
  const now = Date.now();
  gcRecentWebhookSeen(now);
  const hit = keys.some((key) => {
    const expiresAt = recentWebhookSeen.get(key);
    return typeof expiresAt === "number" && expiresAt > now;
  });
  if (hit) return true;
  const expiresAt = now + WEBHOOK_DEDUP_WINDOW_MS;
  for (const key of keys) {
    recentWebhookSeen.set(key, expiresAt);
  }
  return false;
}

function isStaleWebhookEvent(input: {
  chatId: string;
  createTimeMs?: number;
}): { stale: boolean; reason?: string } {
  const now = Date.now();
  const msgTs = input.createTimeMs;
  if (!msgTs || !Number.isFinite(msgTs)) return { stale: false };
  const maxAgeMs = env.FEISHU_WEBHOOK_MAX_EVENT_AGE_SECONDS * 1000;
  if (now - msgTs > maxAgeMs) {
    return { stale: true, reason: "expired_by_age" };
  }
  const watermark = latestMessageWatermarkByChat.get(input.chatId) ?? 0;
  if (msgTs < watermark) {
    return { stale: true, reason: "older_than_chat_watermark" };
  }
  if (msgTs > watermark) {
    latestMessageWatermarkByChat.set(input.chatId, msgTs);
  }
  return { stale: false };
}

function buildFallbackAuthStartUrl(userId: string): string | undefined {
  const redirectUri = env.FEISHU_USER_OAUTH_REDIRECT_URI.trim();
  if (!redirectUri.startsWith("http://") && !redirectUri.startsWith("https://")) return undefined;
  try {
    const origin = new URL(redirectUri).origin;
    return `${origin}/api/feishu/auth/start?userId=${encodeURIComponent(userId)}&redirect=1`;
  } catch {
    return undefined;
  }
}

/**
 * IM 等非 url_verification 事件；仅在被 webhook 命中时动态加载，避免拖慢冷启动。
 */
export async function continueFeishuWebhookAfterChallenge(
  body: FeishuWebhookBody,
  reply: FastifyReply,
): Promise<void> {
  if (body.encrypt) {
    await reply.status(200).send({
      message: "已收到加密事件，请在后续版本实现 decrypt（飞书 事件 2.0 文档）",
    });
    return;
  }

  const event = body.event;
  if (!event || typeof event !== "object") {
    await reply.status(200).send({ message: "ok" });
    return;
  }

  const imEvent = parseFeishuImTextEvent(event as Record<string, unknown>);
  if (!imEvent) {
    await reply.status(200).send({
      message: "ok",
      hint: "忽略：非用户文本、或无法解析",
    });
    return;
  }

  const c = getFeishuMvpConfig();
  if (!c.appId || !c.appSecret) {
    logger.error("webhook: 缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
    await reply.status(200).send({ message: "ok" });
    return;
  }

  const eventId = typeof (body.header as Record<string, unknown> | undefined)?.event_id === "string"
    ? ((body.header as Record<string, unknown>).event_id as string).trim()
    : "";
  const normalizedText = normalizeWebhookText(imEvent.text);
  const dedupKeys = [
    eventId ? `event:${eventId}` : "",
    imEvent.messageId ? `message:${imEvent.messageId}` : "",
    `fingerprint:${imEvent.userId}:${imEvent.chatId}:${normalizedText}`,
  ].filter(Boolean);
  if (markAndCheckDedup(dedupKeys)) {
    logger.info("webhook: duplicate event dropped", {
      chatId: imEvent.chatId,
      userId: imEvent.userId,
      messageId: imEvent.messageId,
      eventId,
    });
    await reply.status(200).send({ message: "ok", hint: "duplicate_dropped" });
    return;
  }
  const staleCheck = isStaleWebhookEvent({
    chatId: imEvent.chatId,
    createTimeMs: imEvent.createTimeMs,
  });
  if (staleCheck.stale) {
    logger.info("webhook: stale event dropped", {
      chatId: imEvent.chatId,
      userId: imEvent.userId,
      messageId: imEvent.messageId,
      createTimeMs: imEvent.createTimeMs,
      reason: staleCheck.reason,
    });
    await reply.status(200).send({ message: "ok", hint: "stale_dropped" });
    return;
  }

  const uatRequiredScopes = splitOAuthScopes(env.FEISHU_USER_OAUTH_SCOPES);
  let uatOAuthIncomplete = false;
  if (env.FEISHU_MCP_IDENTITY === "uat") {
    const ensured = await ensureUserOAuthReady(imEvent.userId);
    uatOAuthIncomplete =
      !ensured.record || !userOAuthGrantedScopesCoverRequired(imEvent.userId, uatRequiredScopes);
    if (ensured.refreshed) {
      logger.info("webhook: UAT 用户 token 自动刷新成功", { userId: imEvent.userId });
    }
  }

  if (uatOAuthIncomplete) {
    logger.info("webhook: UAT 用户 OAuth 未就绪（无 token、已过期或 scope 未覆盖 .env 要求），发授权卡", {
      userId: imEvent.userId,
      requiredScopeCount: uatRequiredScopes.length,
    });
    if (shouldRemindUat(imEvent.userId, imEvent.chatId)) {
      try {
        const { authUrl } = createFeishuUserAuthorizeSession({
          userId: imEvent.userId,
          replay: {
            chatId: imEvent.chatId,
            text: imEvent.text,
            messageId: imEvent.messageId,
            pipeline: env.FEISHU_BOT_PIPELINE === "phase1" ? "phase1" : "full",
          },
        });
        await sendCardMessage(c, {
          receiveId: imEvent.chatId,
          card: buildUserOAuthRequiredCard({
            authUrl,
            userIdHint: imEvent.userId,
            fallbackAuthStartUrl: buildFallbackAuthStartUrl(imEvent.userId),
          }),
        });
      } catch (error) {
        logger.error("webhook: UAT 授权卡片发送失败", { error });
        try {
          await sendTextMessage(c, {
            receiveId: imEvent.chatId,
            text: `需要绑定文档搜索授权后才能继续。服务端配置异常：${
              error instanceof Error ? error.message : String(error)
            }。请联系管理员检查 FEISHU_USER_OAUTH_REDIRECT_URI 等环境变量。`,
          });
        } catch (notifyErr) {
          logger.error("webhook: UAT 授权失败通知发送失败", { error: notifyErr });
        }
      }
    } else {
      logger.info("webhook: UAT 授权提醒处于冷却期，本次不重复发卡", {
        userId: imEvent.userId,
        chatId: imEvent.chatId,
      });
      try {
        await sendTextMessage(c, {
          receiveId: imEvent.chatId,
          text: "当前文档能力授权已失效，且授权提醒处于冷却期。请稍后重试，或主动打开授权链接完成重新授权：/api/feishu/auth/start?userId=你的open_id",
        });
      } catch (notifyErr) {
        logger.error("webhook: UAT 冷却期文本提示发送失败", { error: notifyErr });
      }
    }
    await reply.status(200).send({ message: "ok", hint: "oauth_required" });
    return;
  }

  const pipeline = env.FEISHU_BOT_PIPELINE === "phase1" ? "phase1" : "full";
  runImTextPipelineFireAndForget(c, imEvent, pipeline);

  await reply.status(200).send({ message: "ok" });
}
