import { logger } from "../../shared/logger.js";
import type { UserRequest } from "../../schemas/index.js";
import { runReportPipeline } from "../../services/reportPipeline.js";
import type { FeishuMvpConfig } from "./feishuConfig.js";
import type { FinalDeliverable } from "../../schemas/agentContracts.js";
import { env } from "../../config/env.js";
import { hasValidUserOAuth } from "../../storage/userOAuthStore.js";
import { buildPipelineProgressCard, buildPipelineResultCard } from "./cards.js";
import { sendCardMessage, sendTextMessage, updateCardMessage } from "./imMessage.js";
import type { ParsedFeishuImTextEvent } from "./webhookMessageParse.js";

/** 飞书 text 消息建议控制单条体积，预留表头等余量 */
const FEISHU_TEXT_CHUNK_SIZE = 3500;

export function feishuImEventToUserRequest(
  parsed: ParsedFeishuImTextEvent,
): UserRequest {
  const safeSession = parsed.messageId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 120);
  return {
    userId: parsed.userId,
    sessionId: `im_${safeSession}`,
    prompt: parsed.text,
    extraContext: [],
    personalKnowledge: [],
    historyDocs: [],
    imContacts: [],
    outputFormat: "structured",
    outputTargets: ["feishu_doc", "slides"],
    mentionedResourceIds: [],
  };
}

function formatReportBody(input: Awaited<ReturnType<typeof runReportPipeline>>): string {
  const { report, followUpQuestions, selectedSkillId, taskIntent } = input;
  const header: string[] = [];
  if (taskIntent) header.push(`【任务意图】${taskIntent}`);
  if (selectedSkillId) header.push(`【技能】${selectedSkillId}`);
  if (followUpQuestions?.length) {
    header.push(`【待补充】\n${followUpQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`);
  }
  const sectionsText = report.sections
    .map((s) => `【${s.heading}】\n${s.content}`)
    .join("\n\n");
  const tail: string[] = [];
  if (report.openQuestions?.length) {
    tail.push(`【开放问题】\n${report.openQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`);
  }
  const main = [
    `# ${report.title}`,
    report.summary,
    sectionsText,
    ...tail,
  ]
    .filter(Boolean)
    .join("\n\n");

  return [header.join("\n"), main].filter(Boolean).join("\n\n");
}

function mapArtifactLabel(type: "feishu_doc" | "bitable" | "slides"): string {
  if (type === "feishu_doc") return "报告文档";
  if (type === "slides") return "演示稿";
  return "多维表格";
}

function buildStructuredSummary(input: Awaited<ReturnType<typeof runReportPipeline>>): string[] {
  const items: string[] = [];
  if (input.report.summary) {
    items.push(`摘要：${input.report.summary.slice(0, 120)}`);
  }
  const topSections = input.report.sections.slice(0, 3).map((section) => section.heading);
  if (topSections.length > 0) {
    items.push(`核心章节：${topSections.join("、")}`);
  }
  if (input.report.chartSuggestions.length > 0) {
    items.push(`图表规划：${input.report.chartSuggestions.length} 项（已写入成果模板）`);
  }
  if (input.followUpQuestions?.length) {
    items.push(`待补信息：${input.followUpQuestions.slice(0, 2).join("；")}`);
  }
  const expectedTargets = input.outputTargets ?? [];
  if (expectedTargets.length > 0) {
    items.push(`目标产物：${expectedTargets.map((target) => mapArtifactLabel(target)).join("、")}`);
  }
  return items.slice(0, 5);
}

function extractResultLinks(deliverable?: FinalDeliverable): Array<{ label: string; url: string }> {
  if (!deliverable?.publishedArtifacts?.length) return [];
  return deliverable.publishedArtifacts
    .filter((item) => Boolean(item.url))
    .map((item) => ({
      label: mapArtifactLabel(item.type),
      url: item.url,
    }));
}

export function chunkForFeishuIm(text: string, maxLen = FEISHU_TEXT_CHUNK_SIZE): string[] {
  if (text.length <= maxLen) return [text];
  const total = Math.ceil(text.length / maxLen);
  const chunks: string[] = [];
  for (let p = 0; p < total; p++) {
    const slice = text.slice(p * maxLen, (p + 1) * maxLen);
    const label = `[${p + 1}/${total}] `;
    chunks.push(`${label}${slice}`);
  }
  return chunks;
}

/**
 * 后台任务：跑全链路报告并发会话文本（多分片）。
 */
export async function runFullPipelineAndNotifyChat(
  c: FeishuMvpConfig,
  parsed: ParsedFeishuImTextEvent,
): Promise<void> {
  const isBotDefault = env.FEISHU_IDENTITY_MODE === "bot_default";
  const userOAuthReady = hasValidUserOAuth(parsed.userId);
  const authHint = isBotDefault
    ? userOAuthReady
      ? "已检测到用户增强授权：必要时可读取用户私域资源。"
      : "当前走应用身份主链路；如需个人私域资源，可补充用户授权。"
    : "当前优先用户身份执行。";

  const userRequest = feishuImEventToUserRequest(parsed);
  const progressCard = buildPipelineProgressCard({
    title: "报告任务已受理",
    sessionId: userRequest.sessionId,
    userId: parsed.userId,
    authHint,
  });
  let progressMessageId: string | undefined;
  try {
    const progress = await sendCardMessage(c, {
      receiveId: parsed.chatId,
      card: progressCard,
    });
    progressMessageId = progress.messageId;
  } catch {
    await sendTextMessage(c, {
      receiveId: parsed.chatId,
      text: "已收到需求，正在全链路生成报告，请稍候…",
    });
  }

  const result = await runReportPipeline(userRequest);
  const links = extractResultLinks(result.finalDeliverable);
  const summary = buildStructuredSummary(result);
  const expectedTargetCount = result.outputTargets?.length ?? 0;
  const status: "completed" | "partial" | "need_info" =
    result.followUpQuestions?.length
      ? "need_info"
      : expectedTargetCount > 0 && links.length < expectedTargetCount
        ? "partial"
        : links.length > 0
          ? "completed"
          : "partial";
  const resultCard = buildPipelineResultCard({
    title: result.report.title,
    status,
    summary,
    links,
    sessionId: userRequest.sessionId,
  });

  logger.info("im pipeline completed", {
    sessionId: userRequest.sessionId,
    chatId: parsed.chatId,
    userId: parsed.userId,
    identityMode: env.FEISHU_IDENTITY_MODE,
    userOAuthReady,
    artifactCount: links.length,
    progressMessageId: progressMessageId ?? "",
  });

  try {
    if (progressMessageId) {
      await updateCardMessage(c, { messageId: progressMessageId, card: resultCard });
      return;
    }
    await sendCardMessage(c, { receiveId: parsed.chatId, card: resultCard });
  } catch (error) {
    logger.warn("飞书 结果卡片发送失败，降级为文本摘要", {
      error: error instanceof Error ? error.message : String(error),
      sessionId: userRequest.sessionId,
      chatId: parsed.chatId,
    });
    const body = formatReportBody(result);
    const chunks = chunkForFeishuIm(body);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      await sendTextMessage(c, { receiveId: parsed.chatId, text: chunk });
    }
  }
}
