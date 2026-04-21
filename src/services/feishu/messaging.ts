import { env } from "../../config/env.js";
import type { WriterOutput } from "../../schemas/index.js";
import { logger } from "../../shared/logger.js";
import type { FeishuClient } from "./client.js";

/**
 * 飞书消息服务（Phase 4.6）。
 *
 * 职责：
 *   - 根据 .env 配置（chat_id / open_id / email）决定收件方
 *   - 把 WriterOutput 组装成飞书交互式卡片
 *   - 调用 /im/v1/messages 发送
 *
 * 权限：只需 im:message（或 im:message:send_as_bot）
 *
 * 外发失败不是致命错误——上层以守护节点方式调用，静默吞掉异常但透出 debugTrace。
 */

export type NotifyTarget = {
  receiveIdType: "chat_id" | "open_id" | "email";
  receiveId: string;
};

/** 基于 env 推断唯一的收件方；返回 null 表示未配置，应跳过发送 */
export function resolveNotifyTarget(): NotifyTarget | null {
  if (env.FEISHU_NOTIFY_ENABLED === "false") return null;
  if (env.FEISHU_NOTIFY_CHAT_ID) {
    return { receiveIdType: "chat_id", receiveId: env.FEISHU_NOTIFY_CHAT_ID };
  }
  if (env.FEISHU_NOTIFY_OPEN_ID) {
    return { receiveIdType: "open_id", receiveId: env.FEISHU_NOTIFY_OPEN_ID };
  }
  if (env.FEISHU_NOTIFY_EMAIL) {
    return { receiveIdType: "email", receiveId: env.FEISHU_NOTIFY_EMAIL };
  }
  return null;
}

/** 构造一张 "报告已生成" 的交互式卡片（飞书卡片 JSON schema v2） */
export function buildReportCard(params: {
  report: WriterOutput;
  skillId?: string;
  sessionId: string;
  reviewPass?: boolean;
  overallScore?: number;
  usageCount?: number;
  /** Phase 5：若有云文档链接，在卡片底部加 "查看完整文档" 按钮 */
  docUrl?: string;
}): Record<string, unknown> {
  const { report, skillId, sessionId, reviewPass, overallScore, usageCount, docUrl } = params;

  const sectionLines = report.sections
    .slice(0, 4)
    .map((s) => `**${escapeMd(s.heading)}**\n${truncate(escapeMd(s.content), 160)}`)
    .join("\n\n");

  const openQuestionsLine =
    report.openQuestions.length > 0
      ? report.openQuestions
          .slice(0, 3)
          .map((q) => `- ${escapeMd(truncate(q, 60))}`)
          .join("\n")
      : "（无）";

  const reviewTag = reviewPass
    ? `<font color='green'>✓ 审阅通过</font>`
    : `<font color='orange'>△ 有待完善</font>`;

  const metaLine = [
    `📚 Skill: \`${skillId ?? "-"}\``,
    `🆔 Session: \`${sessionId}\``,
    reviewPass !== undefined ? `${reviewTag}${overallScore !== undefined ? ` (${(overallScore * 100).toFixed(0)}分)` : ""}` : "",
    usageCount !== undefined ? `🧠 用户累计生成 ${usageCount} 次` : "",
  ]
    .filter(Boolean)
    .join("  \u2022  ");

  return {
    schema: "2.0",
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: reviewPass === false ? "orange" : "blue",
      title: {
        tag: "plain_text",
        content: `📄 ${truncate(report.title, 60)}`,
      },
    },
    body: {
      direction: "vertical",
      elements: [
        {
          tag: "markdown",
          content: metaLine,
          text_align: "left",
          text_size: "notation",
        },
        { tag: "hr" },
        {
          tag: "markdown",
          content: `**摘要**\n${escapeMd(truncate(report.summary, 260))}`,
        },
        { tag: "hr" },
        {
          tag: "markdown",
          content: sectionLines || "_暂无章节_",
        },
        { tag: "hr" },
        {
          tag: "markdown",
          content: `**待确认问题（Top 3）**\n${openQuestionsLine}`,
        },
        ...(docUrl
          ? [
              { tag: "hr" },
              {
                tag: "button",
                text: { tag: "plain_text", content: "📄 查看完整文档" },
                type: "primary",
                width: "default",
                multi_url: {
                  url: docUrl,
                  pc_url: docUrl,
                  android_url: docUrl,
                  ios_url: docUrl,
                },
              },
            ]
          : []),
      ],
    },
  };
}

/** 发送卡片消息到指定 target */
export async function sendReportCard(
  client: FeishuClient,
  target: NotifyTarget,
  card: Record<string, unknown>,
): Promise<{ message_id?: string }> {
  const result = await client.request<{ message_id?: string }>(
    "/im/v1/messages",
    {
      method: "POST",
      query: { receive_id_type: target.receiveIdType },
      body: {
        receive_id: target.receiveId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      },
    },
  );
  logger.info("[Feishu] 报告卡片消息已发送", {
    target: target.receiveIdType,
    messageId: result?.message_id,
  });
  return result ?? {};
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

/** 飞书 markdown 在 tag/卡片中对 `_*[]<>` 敏感，这里做最简转义。*/
function escapeMd(text: string): string {
  return text.replace(/\r?\n/g, "\n").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
