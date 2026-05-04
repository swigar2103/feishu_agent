import { logger } from "../../shared/logger.js";
import type { UserRequest } from "../../schemas/index.js";
import { runReportPipeline } from "../../services/reportPipeline.js";
import type { FeishuMvpConfig } from "./feishuConfig.js";
import { sendTextMessage } from "./imMessage.js";
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
    outputTargets: ["feishu_doc"],
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
  const userRequest = feishuImEventToUserRequest(parsed);
  await sendTextMessage(c, {
    receiveId: parsed.chatId,
    text: "已收到需求，正在全链路生成报告（Intent→Skill→Planner→…），请稍候…",
  });

  const result = await runReportPipeline(userRequest);
  const body = formatReportBody(result);
  const chunks = chunkForFeishuIm(body);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    try {
      await sendTextMessage(c, { receiveId: parsed.chatId, text: chunk });
    } catch (e) {
      logger.error("飞书 分片发报告失败", { index: i, error: e });
      throw e;
    }
  }
}
