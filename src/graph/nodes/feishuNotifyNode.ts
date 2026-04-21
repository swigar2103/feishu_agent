import { env } from "../../config/env.js";
import {
  buildReportCard,
  resolveNotifyTarget,
  sendReportCard,
} from "../../services/feishu/messaging.js";
import { getFeishuClient } from "../../services/retrievalClient.js";
import type { ReportGraphStateType } from "../state.js";

/**
 * feishuNotifyNode（Phase 4.6）——"静默守护"节点：
 *   - mock 模式 / 通知关闭 / 无收件人时：debugTrace 记一行 skip，不报错
 *   - 真实模式 + 配置齐全时：把报告组装成飞书交互式卡片，发送到 chat_id / open_id / email
 *   - 发送失败（网络 / 权限不足等）只打 debugTrace，绝不影响主响应
 */
export async function feishuNotifyNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  const trace: string[] = [];

  if (!state.writerOutput || !state.userRequest) {
    trace.push("[feishu_notify] skip: 缺少 writerOutput/userRequest");
    return { debugTrace: trace };
  }

  if (env.FEISHU_NOTIFY_ENABLED === "false") {
    trace.push("[feishu_notify] skip: FEISHU_NOTIFY_ENABLED=false");
    return { debugTrace: trace };
  }

  const target = resolveNotifyTarget();
  if (!target) {
    trace.push(
      "[feishu_notify] skip: 未配置收件人（FEISHU_NOTIFY_CHAT_ID / _OPEN_ID / _EMAIL）",
    );
    return { debugTrace: trace };
  }

  const client = getFeishuClient();
  if (!client) {
    trace.push("[feishu_notify] skip: 飞书为 mock 模式，通知仅在真实模式下触发");
    return { debugTrace: trace };
  }

  try {
    const card = buildReportCard({
      report: state.writerOutput,
      skillId: state.retrievalContext?.matchedSkill.skillId,
      sessionId: state.userRequest.sessionId,
      reviewPass: state.reviewReport?.pass,
      overallScore: state.reviewReport?.overallScore,
      usageCount: state.injectedMemorySnapshot?.usageCount,
      docUrl: state.feishuDocUrl ?? undefined,
    });
    const result = await sendReportCard(client, target, card);
    trace.push(
      `[feishu_notify] 已发送 receive=${target.receiveIdType}=${mask(target.receiveId)} message_id=${result.message_id ?? "-"}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    trace.push(`[feishu_notify] 失败(非阻塞): ${msg}`);
  }

  return { debugTrace: trace };
}

function mask(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}
