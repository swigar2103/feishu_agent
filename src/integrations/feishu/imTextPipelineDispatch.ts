import { env } from "../../config/env.js";
import { assertFeishuMvpConfig, type FeishuMvpConfig } from "./feishuConfig.js";
import {
  FEISHU_IM_BUILTIN_DEMO_DOCX_URL,
  FEISHU_IM_PIPELINE_BYPASS_DEMO,
} from "./imDemoConfig.js";
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

const CHAT_PIPELINE_LOCK_TTL_MS = 15 * 60 * 1000;
const chatPipelineLocks = new Map<string, { startedAt: number; messageId: string }>();

function tryAcquireChatPipelineLock(chatId: string, messageId: string): boolean {
  const now = Date.now();
  const current = chatPipelineLocks.get(chatId);
  if (current && now - current.startedAt < CHAT_PIPELINE_LOCK_TTL_MS) {
    return false;
  }
  chatPipelineLocks.set(chatId, { startedAt: now, messageId });
  return true;
}

function releaseChatPipelineLock(chatId: string, messageId: string): void {
  const current = chatPipelineLocks.get(chatId);
  if (!current) return;
  if (current.messageId !== messageId) return;
  chatPipelineLocks.delete(chatId);
}

/** 源码开关 + 内置 URL：`FEISHU_IM_PIPELINE_BYPASS_DEMO` 关闭时永远不短路。 */
function resolveImBypassDemoDocUrl(): string {
  if (!FEISHU_IM_PIPELINE_BYPASS_DEMO) return "";
  return env.FEISHU_DEMO_FIXED_REPORT_URL.trim() || FEISHU_IM_BUILTIN_DEMO_DOCX_URL;
}

function imBypassSessionId(imEvent: ParsedFeishuImTextEvent): string {
  const safeSession = imEvent.messageId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 120);
  return `im_${safeSession}`;
}

/** LangGraph / Phase1 均不跑：仅投递一张「演示文档」卡片（或纯文本兜底）。 */
async function trySendImPipelineDemoBypass(
  c: FeishuMvpConfig,
  imEvent: ParsedFeishuImTextEvent,
): Promise<boolean> {
  const docUrl = resolveImBypassDemoDocUrl();
  if (!docUrl) return false;
  const sessionId = imBypassSessionId(imEvent);
  logger.info("feishu im bypass: demo doc card only", {
    chatId: imEvent.chatId,
    userId: imEvent.userId,
    sessionId,
  });
  try {
    await sendCardMessage(c, {
      receiveId: imEvent.chatId,
      card: buildFallbackGeneratedDocCard({
        title: "演示文档",
        docUrl,
        sessionId,
      }),
    });
  } catch {
    await sendTextMessage(c, {
      receiveId: imEvent.chatId,
      text: docUrl,
    });
  }
  return true;
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
  void (async () => {
    if (await trySendImPipelineDemoBypass(c, imEvent)) return;

    if (pipeline === "phase1") {
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
      return;
    }

    logger.info("webhook full pipeline accepted", {
      chatId: imEvent.chatId,
      userId: imEvent.userId,
      messageId: imEvent.messageId,
      identityMode: env.FEISHU_IDENTITY_MODE,
    });
    if (!tryAcquireChatPipelineLock(imEvent.chatId, imEvent.messageId)) {
      logger.info("webhook full pipeline skipped: chat pipeline is busy", {
        chatId: imEvent.chatId,
        userId: imEvent.userId,
        messageId: imEvent.messageId,
      });
      try {
        await sendTextMessage(c, {
          receiveId: imEvent.chatId,
          text: "上一条任务仍在处理中，为避免重复受理，本条已暂不启动。请等待上一条完成后再发新需求。",
        });
      } catch (notifyErr) {
        logger.error("im pipeline busy notify failed", { error: notifyErr });
      }
      return;
    }
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
    } finally {
      releaseChatPipelineLock(imEvent.chatId, imEvent.messageId);
    }
  })();
}

/**
 * 自检：与当前进程的 IM 短路逻辑一致。**飞书上看到的卡片由「实际收到 webhook 的那一个服务」生成**，
 * 须在「事件订阅里填的请求地址」上访问或通过隧道 curl 校验，而不是仅凭本机是否重启 npm。
 */
export function describeImPipelineDemoConfig(): {
  bypassDemo: boolean;
  effectiveBypassDocUrl: string;
} {
  return {
    bypassDemo: FEISHU_IM_PIPELINE_BYPASS_DEMO,
    effectiveBypassDocUrl: resolveImBypassDemoDocUrl(),
  };
}
