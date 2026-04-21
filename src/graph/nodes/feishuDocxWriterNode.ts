import { env } from "../../config/env.js";
import { publishReportAsDocument } from "../../services/feishu/docxWriter.js";
import { getFeishuClient } from "../../services/retrievalClient.js";
import type { ReportGraphStateType } from "../state.js";

/**
 * feishuDocxWriterNode（Phase 5）——"静默守护"节点：
 *   - 缺 writerOutput / mock 模式 / 总开关关闭 → debugTrace 记一行 skip
 *   - 真实模式 + 开关 auto|true → 创建飞书云文档并写入完整报告，把 docId/docUrl 放进 state
 *   - 任何失败（权限 / 网络 / Feishu 业务错误）只记 debugTrace，不阻塞后续 feishu_notify 和响应
 */
export async function feishuDocxWriterNode(
  state: ReportGraphStateType,
): Promise<Partial<ReportGraphStateType>> {
  const trace: string[] = [];

  if (!state.writerOutput || !state.userRequest) {
    trace.push("[feishu_docx] skip: 缺少 writerOutput/userRequest");
    return { debugTrace: trace };
  }

  if (env.FEISHU_DOCX_ENABLED === "false") {
    trace.push("[feishu_docx] skip: FEISHU_DOCX_ENABLED=false");
    return { debugTrace: trace };
  }

  const client = getFeishuClient();
  if (!client) {
    trace.push("[feishu_docx] skip: 飞书为 mock 模式，云文档回写仅在真实模式下生效");
    return { debugTrace: trace };
  }

  try {
    const result = await publishReportAsDocument(client, state.writerOutput, {
      folderToken: env.FEISHU_DOCX_FOLDER_TOKEN,
    });
    trace.push(
      `[feishu_docx] 云文档已创建 docId=${mask(result.documentId)} blocks=${result.appendedBlocks} url=${result.url}`,
    );
    return {
      feishuDocId: result.documentId,
      feishuDocUrl: result.url,
      debugTrace: trace,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    trace.push(`[feishu_docx] 失败(非阻塞): ${msg}`);
    return { debugTrace: trace };
  }
}

function mask(id: string): string {
  if (id.length <= 10) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}
