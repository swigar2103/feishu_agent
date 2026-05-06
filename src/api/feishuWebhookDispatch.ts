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
import type { FeishuWebhookBody } from "../schemas/feishuWebhookBody.js";
import { logger } from "../shared/logger.js";
import {
  userOAuthGrantedScopesCoverRequired,
} from "../storage/userOAuthStore.js";

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
        card: buildUserOAuthRequiredCard({ authUrl, userIdHint: imEvent.userId }),
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
    await reply.status(200).send({ message: "ok", hint: "oauth_required" });
    return;
  }

  const pipeline = env.FEISHU_BOT_PIPELINE === "phase1" ? "phase1" : "full";
  runImTextPipelineFireAndForget(c, imEvent, pipeline);

  await reply.status(200).send({ message: "ok" });
}
