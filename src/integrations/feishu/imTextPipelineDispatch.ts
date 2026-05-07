import { env } from "../../config/env.js";
import { assertFeishuMvpConfig, type FeishuMvpConfig } from "./feishuConfig.js";
import { buildFallbackGeneratedDocCard, buildUserOAuthRequiredCard } from "./cards.js";
import { sendCardMessage, sendTextMessage } from "./imMessage.js";
import type { ParsedFeishuImTextEvent } from "./webhookMessageParse.js";
import { logger } from "../../shared/logger.js";
import { createFeishuUserAuthorizeSession } from "./userOAuthAuthorizeFlow.js";
import { shouldRemindUat } from "./uatReminder.js";

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

function isUatOAuthRequiredError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("无有效飞书用户访问令牌");
}

async function notifyOAuthRequired(
  c: FeishuMvpConfig,
  imEvent: ParsedFeishuImTextEvent,
  pipeline: "full" | "phase1",
): Promise<void> {
  const { authUrl } = createFeishuUserAuthorizeSession({
    userId: imEvent.userId,
    replay: {
      chatId: imEvent.chatId,
      text: imEvent.text,
      messageId: imEvent.messageId,
      pipeline,
    },
  });
  if (shouldRemindUat(imEvent.userId, imEvent.chatId)) {
    await sendCardMessage(c, {
      receiveId: imEvent.chatId,
      card: buildUserOAuthRequiredCard({
        authUrl,
        userIdHint: imEvent.userId,
        fallbackAuthStartUrl: buildFallbackAuthStartUrl(imEvent.userId),
      }),
    });
    return;
  }
  await sendTextMessage(c, {
    receiveId: imEvent.chatId,
    text: `需要重新授权后才能继续处理。请点击授权：${authUrl}`,
  });
}

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
        if (isUatOAuthRequiredError(error)) {
          try {
            await notifyOAuthRequired(c, imEvent, "phase1");
            return;
          } catch (notifyErr) {
            logger.error("im pipeline phase1 oauth notify failed", { error: notifyErr });
          }
        }
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
      if (isUatOAuthRequiredError(error)) {
        try {
          await notifyOAuthRequired(c, imEvent, "full");
          return;
        } catch (notifyErr) {
          logger.error("im pipeline full oauth notify failed", { error: notifyErr });
        }
      }
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
