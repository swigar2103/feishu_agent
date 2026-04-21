import { env } from "../../config/env.js";
import type { WriterOutput } from "../../schemas/index.js";
import { logger } from "../../shared/logger.js";
import type { FeishuClient } from "./client.js";

/**
 * 飞书云文档回写服务（Phase 5）。
 *
 * 职责：
 *   1. 创建一篇空的 docx 云文档（可指定父文件夹 folder_token）
 *   2. 把 WriterOutput（title / summary / sections / openQuestions）映射成飞书 block 数组，
 *      分批写入（飞书 children 单次上限 ≈ 50 条，这里保守 30 条一批）
 *   3. 返回 documentId + 前端可点击的 URL
 *
 * 权限需求：
 *   - docx:document（创建 & 写入块）
 *   - drive:drive（可选，指定 folder_token 时需要）
 *
 * 容错：
 *   - 所有失败都向上抛，由守护节点捕获并记 debugTrace，不影响主响应
 */

/** 飞书 docx block_type 枚举（只取我们会用的） */
const BLOCK_TYPE = {
  PAGE: 1,
  TEXT: 2,
  HEADING1: 3,
  HEADING2: 4,
  HEADING3: 5,
  BULLET: 12,
  DIVIDER: 22,
} as const;

/** 单次向 children 接口提交的 block 数上限（飞书官方上限 50，取 30 稳妥） */
const BATCH_SIZE = 30;

type CreateDocxResp = {
  document: {
    document_id: string;
    revision_id: number;
    title?: string;
  };
};

type AppendChildrenResp = {
  children?: Array<{ block_id: string }>;
  document_revision_id?: number;
};

export type CreateDocumentResult = {
  documentId: string;
  url: string;
  title: string;
};

/** 创建一篇空文档，返回 documentId + 可点击 URL */
export async function createDocument(
  client: FeishuClient,
  opts: { title: string; folderToken?: string },
): Promise<CreateDocumentResult> {
  const body: Record<string, string> = { title: opts.title };
  if (opts.folderToken) body.folder_token = opts.folderToken;

  const data = await client.request<CreateDocxResp>("/docx/v1/documents", {
    method: "POST",
    body,
  });

  if (!data?.document?.document_id) {
    throw new Error("飞书 /docx/v1/documents 返回体缺少 document_id");
  }
  const documentId = data.document.document_id;
  const url = buildDocUrl(documentId);
  logger.info("[FeishuDocx] 云文档已创建", { documentId, url });
  return { documentId, url, title: data.document.title ?? opts.title };
}

/** 把 WriterOutput 的内容按块分批 append 到指定文档末尾 */
export async function writeReportToDocument(
  client: FeishuClient,
  documentId: string,
  report: WriterOutput,
): Promise<{ appendedBlocks: number; batches: number }> {
  const blocks = buildBlocksFromReport(report);
  if (blocks.length === 0) {
    return { appendedBlocks: 0, batches: 0 };
  }

  let batches = 0;
  let appended = 0;
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const chunk = blocks.slice(i, i + BATCH_SIZE);
    await client.request<AppendChildrenResp>(
      `/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
      {
        method: "POST",
        query: { document_revision_id: -1 },
        body: { children: chunk, index: -1 },
      },
    );
    batches += 1;
    appended += chunk.length;
  }
  logger.info("[FeishuDocx] 内容已写入", { documentId, appendedBlocks: appended, batches });
  return { appendedBlocks: appended, batches };
}

/** 对外一站式调用：建文档 + 写内容，全流程封装 */
export async function publishReportAsDocument(
  client: FeishuClient,
  report: WriterOutput,
  opts: { folderToken?: string } = {},
): Promise<CreateDocumentResult & { appendedBlocks: number }> {
  const created = await createDocument(client, {
    title: report.title || "AI 生成报告",
    folderToken: opts.folderToken,
  });
  const { appendedBlocks } = await writeReportToDocument(client, created.documentId, report);
  return { ...created, appendedBlocks };
}

// ===================== Block 构造 =====================

type FeishuBlock = Record<string, unknown>;

/** 把一段纯文本拆成一个 text block（飞书不允许 content 为空字符串） */
function textBlock(content: string): FeishuBlock {
  const safe = content.trim().length > 0 ? content : "—";
  return {
    block_type: BLOCK_TYPE.TEXT,
    text: {
      elements: [{ text_run: { content: safe } }],
      style: {},
    },
  };
}

function headingBlock(content: string, level: 1 | 2 | 3): FeishuBlock {
  const blockType =
    level === 1
      ? BLOCK_TYPE.HEADING1
      : level === 2
        ? BLOCK_TYPE.HEADING2
        : BLOCK_TYPE.HEADING3;
  const payloadKey = `heading${level}` as const;
  return {
    block_type: blockType,
    [payloadKey]: {
      elements: [{ text_run: { content: content || "—" } }],
      style: {},
    },
  };
}

function bulletBlock(content: string): FeishuBlock {
  return {
    block_type: BLOCK_TYPE.BULLET,
    bullet: {
      elements: [{ text_run: { content: content || "—" } }],
      style: {},
    },
  };
}

function dividerBlock(): FeishuBlock {
  return { block_type: BLOCK_TYPE.DIVIDER, divider: {} };
}

/**
 * WriterOutput → Block[] 映射：
 *   - H1: 报告标题
 *   - 一段摘要
 *   - ——
 *   - H2 每个 section 标题 + 正文段落
 *   - ——
 *   - H2 "待确认问题"
 *   - bullet × openQuestions
 *   - ——
 *   - H2 "图表建议"（若有）
 *   - bullet × chartSuggestions（type + title + purpose）
 */
export function buildBlocksFromReport(report: WriterOutput): FeishuBlock[] {
  const blocks: FeishuBlock[] = [];

  blocks.push(headingBlock(report.title, 1));
  blocks.push(textBlock(`摘要：${report.summary}`));
  blocks.push(dividerBlock());

  for (const section of report.sections) {
    blocks.push(headingBlock(section.heading, 2));
    // 保守起见把正文按 \n 断行成多个段落块（飞书单 block 长度建议 ≤ 2000）
    const paragraphs = splitIntoParagraphs(section.content);
    for (const p of paragraphs) {
      blocks.push(textBlock(p));
    }
  }

  if (report.openQuestions.length > 0) {
    blocks.push(dividerBlock());
    blocks.push(headingBlock("待确认问题", 2));
    for (const q of report.openQuestions) {
      blocks.push(bulletBlock(q));
    }
  }

  if (report.chartSuggestions.length > 0) {
    blocks.push(dividerBlock());
    blocks.push(headingBlock("图表建议", 2));
    for (const c of report.chartSuggestions) {
      blocks.push(bulletBlock(`【${c.type}】${c.title} — ${c.purpose}`));
    }
  }

  return blocks;
}

/** 按换行切段，并把过长段落（>1800）再切；避免单 block 超限 */
function splitIntoParagraphs(text: string): string[] {
  const rough = text.split(/\n{2,}|\r\n{2,}/).flatMap((line) => line.split(/\n|\r\n/));
  const out: string[] = [];
  for (const p of rough.map((s) => s.trim()).filter(Boolean)) {
    if (p.length <= 1800) {
      out.push(p);
    } else {
      // 超长段落按 1800 字硬切，避免单 block body 过大
      for (let i = 0; i < p.length; i += 1800) {
        out.push(p.slice(i, i + 1800));
      }
    }
  }
  return out.length > 0 ? out : ["—"];
}

// ===================== URL 组装 =====================

/** 组装用户可点击的云文档 URL：{prefix}{documentId} */
export function buildDocUrl(documentId: string): string {
  const prefix = env.FEISHU_DOCX_URL_PREFIX.endsWith("/")
    ? env.FEISHU_DOCX_URL_PREFIX
    : `${env.FEISHU_DOCX_URL_PREFIX}/`;
  return `${prefix}${documentId}`;
}
