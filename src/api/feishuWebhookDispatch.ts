import type { FastifyReply } from "fastify";
import { env } from "../config/env.js";
import { assertFeishuMvpConfig, getFeishuMvpConfig } from "../integrations/feishu/feishuConfig.js";
import {
  buildFallbackGeneratedDocCard,
} from "../integrations/feishu/cards.js";
import { sendCardMessage, sendTextMessage } from "../integrations/feishu/imMessage.js";
import { parseFeishuImTextEvent } from "../integrations/feishu/webhookMessageParse.js";
import { logger } from "../shared/logger.js";
import type { FeishuWebhookBody } from "../schemas/feishuWebhookBody.js";

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

  if (env.FEISHU_BOT_PIPELINE === "phase1") {
    void (async () => {
      try {
        assertFeishuMvpConfig();
        const { handleBotMessageText } = await import("../phase1/botHandler.js");
        const result = await handleBotMessageText({
          userText: imEvent.text,
          chatId: imEvent.chatId,
        });
        await sendCardMessage(c, {
          receiveId: imEvent.chatId,
          card: buildFallbackGeneratedDocCard({
            title: result.copyName,
            docUrl: result.docUrl,
            sessionId: result.documentId,
          }),
        });
      } catch (error) {
        logger.error("webhook phase1 async failed", { error });
        try {
          await sendTextMessage(c, {
            receiveId: imEvent.chatId,
            text: `Phase1 生成失败：${error instanceof Error ? error.message : String(error)}`,
          });
        } catch (notifyErr) {
          logger.error("webhook phase1 error notify failed", { error: notifyErr });
        }
      }
    })();
  } else {
    void (async () => {
      try {
        const { runFullPipelineAndNotifyChat } = await import(
          "../integrations/feishu/reportImDelivery.js"
        );
        await runFullPipelineAndNotifyChat(c, imEvent);
      } catch (error) {
        logger.error("webhook full pipeline async failed", { error });
        try {
          await sendTextMessage(c, {
            receiveId: imEvent.chatId,
            text: `报告生成失败：${error instanceof Error ? error.message : String(error)}`,
          });
        } catch (notifyErr) {
          logger.error("webhook full pipeline error notify failed", { error: notifyErr });
        }
      }
    })();
  }

  await reply.status(200).send({ message: "ok" });
}
