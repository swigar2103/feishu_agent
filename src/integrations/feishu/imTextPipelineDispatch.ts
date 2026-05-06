import { env } from "../../config/env.js";
import { assertFeishuMvpConfig, type FeishuMvpConfig } from "./feishuConfig.js";
import { buildFallbackGeneratedDocCard } from "./cards.js";
import { sendCardMessage, sendTextMessage } from "./imMessage.js";
import type { ParsedFeishuImTextEvent } from "./webhookMessageParse.js";
import { logger } from "../../shared/logger.js";

/**
 * 与 webhook 一致：异步执行 IM 文本链路（phase1 或 full），自带错误通知。
 */
export function runImTextPipelineFireAndForget(
  c: FeishuMvpConfig,
  imEvent: ParsedFeishuImTextEvent,
  pipeline: "full" | "phase1",
): void {
  if (pipeline === "phase1") {
    void (async () => {
      try {
        assertFeishuMvpConfig();
        const { handleBotMessageText } = await import("../../phase1/botHandler.js");
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
        logger.error("im pipeline phase1 failed", { error });
        try {
          await sendTextMessage(c, {
            receiveId: imEvent.chatId,
            text: `Phase1 生成失败：${error instanceof Error ? error.message : String(error)}`,
          });
        } catch (notifyErr) {
          logger.error("im pipeline phase1 error notify failed", { error: notifyErr });
        }
      }
    })();
    return;
  }

  logger.info("webhook full pipeline accepted", {
    chatId: imEvent.chatId,
    userId: imEvent.userId,
    messageId: imEvent.messageId,
    identityMode: env.FEISHU_IDENTITY_MODE,
  });
  void (async () => {
    try {
      const { runFullPipelineAndNotifyChat } = await import("./reportImDelivery.js");
      await runFullPipelineAndNotifyChat(c, imEvent);
    } catch (error) {
      logger.error("im pipeline full failed", { error });
      try {
        await sendTextMessage(c, {
          receiveId: imEvent.chatId,
          text: `报告生成失败：${error instanceof Error ? error.message : String(error)}`,
        });
      } catch (notifyErr) {
        logger.error("im pipeline full error notify failed", { error: notifyErr });
      }
    }
  })();
}
