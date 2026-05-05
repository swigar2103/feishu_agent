import { logger } from "../../shared/logger.js";
import type { FeishuMvpConfig } from "./feishuConfig.js";
import { feishuHttpFetch } from "./httpFetch.js";
import { getTenantAccessToken } from "./token.js";

type BlockItem = Record<string, unknown> & {
  block_id?: string;
  block_type?: number;
  page?: { elements?: unknown[] };
  text?: { elements?: unknown[] };
  heading1?: { elements?: unknown[] };
  heading2?: { elements?: unknown[] };
  heading3?: { elements?: unknown[] };
  heading4?: { elements?: unknown[] };
  heading5?: { elements?: unknown[] };
  heading6?: { elements?: unknown[] };
  heading7?: { elements?: unknown[] };
  heading8?: { elements?: unknown[] };
  heading9?: { elements?: unknown[] };
};

type ListBlocksResponse = {
  code?: number;
  msg?: string;
  data?: {
    items?: BlockItem[];
    page_token?: string;
    has_more?: boolean;
  };
};

type BatchUpdateResponse = {
  code?: number;
  msg?: string;
};

function extractTextFromElements(elements: unknown[] | undefined): string {
  if (!elements?.length) return "";
  const parts: string[] = [];
  for (const el of elements) {
    if (!el || typeof el !== "object") continue;
    const o = el as Record<string, unknown>;
    const tr = o.text_run as { content?: string } | undefined;
    if (tr?.content) parts.push(tr.content);
  }
  return parts.join("");
}

function getElementsContainer(
  blockType: number | undefined,
  block: BlockItem,
): { elements?: unknown[] } | null {
  if (blockType === undefined) return null;
  if (blockType === 1) return block.page ?? null;
  if (blockType === 2) return block.text ?? null;
  if (blockType >= 3 && blockType <= 11) {
    const key = `heading${blockType - 2}` as keyof BlockItem;
    return (block[key] as { elements?: unknown[] }) ?? null;
  }
  return null;
}

/** 从块中提取可搜索的纯文本（用于匹配 [SECTION:XXX]） */
export function blockPlainText(block: BlockItem): string {
  const t = block.block_type;
  const c = getElementsContainer(t, block);
  return extractTextFromElements(c?.elements);
}

/**
 * 分页拉取文档内全部块。
 * @see https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/list
 */
export async function listAllDocumentBlocks(
  c: FeishuMvpConfig,
  documentId: string,
): Promise<BlockItem[]> {
  const access = await getTenantAccessToken(c);
  const out: BlockItem[] = [];
  let pageToken: string | undefined;

  for (;;) {
    const qs = new URLSearchParams();
    qs.set("page_size", "500");
    qs.set("document_revision_id", "-1");
    if (pageToken) qs.set("page_token", pageToken);

    const url = `${c.baseUrl}/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks?${qs.toString()}`;
    const res = await feishuHttpFetch(url, {
      headers: { Authorization: `Bearer ${access}` },
    });
    const data = (await res.json()) as ListBlocksResponse;
    if (!res.ok || data.code !== 0) {
      logger.error("飞书 list blocks 失败", { status: res.status, data });
      throw new Error(
        `飞书 list blocks: ${data.msg ?? res.status} (code=${data.code})`,
      );
    }
    const items = data.data?.items ?? [];
    out.push(...items);
    if (!data.data?.has_more || !data.data?.page_token) break;
    pageToken = data.data.page_token;
  }
  return out;
}

/**
 * 用批量更新把某个文本/标题块的内容整段替换为新的纯文本。
 * @see https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document-block/batch_update
 */
export async function replaceBlockWithPlainText(
  c: FeishuMvpConfig,
  documentId: string,
  blockId: string,
  plainText: string,
): Promise<void> {
  const access = await getTenantAccessToken(c);
  const url = `${c.baseUrl}/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/batch_update?document_revision_id=-1`;
  const body = {
    requests: [
      {
        block_id: blockId,
        update_text_elements: {
          elements: [
            {
              text_run: {
                content: plainText,
              },
            },
          ],
        },
      },
    ],
  };
  const res = await feishuHttpFetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as BatchUpdateResponse;
  if (!res.ok || data.code !== 0) {
    logger.error("飞书 batch_update 失败", { status: res.status, data, blockId });
    throw new Error(
      `飞书 batch_update: ${data.msg ?? res.status} (code=${data.code})`,
    );
  }
}

export type OutlineLevelEntry = { level: number; title: string };

/**
 * 将 docx 块转为：大纲标题列表、带层级 Markdown（# / ##…）、以及层级化的目录条目。
 * 扁平拼接会丢失 Word/飞书中的标题层级，Planner/Writer 无法「学习结构」。
 */
export function docxBlocksToOutlineAndMarkdown(blocks: BlockItem[]): {
  outline: string[];
  outlineLevels: OutlineLevelEntry[];
  bodyMarkdown: string;
} {
  const outline: string[] = [];
  const outlineLevels: OutlineLevelEntry[] = [];
  const mdParts: string[] = [];

  for (const block of blocks) {
    const t = block.block_type;
    const line = blockPlainText(block).replace(/\s+/g, " ").trim();
    if (!line) continue;

    if (t !== undefined && t >= 3 && t <= 11) {
      const level = t - 2;
      outline.push(line);
      outlineLevels.push({ level, title: line });
      const mdHeadingLevel = Math.min(level, 6);
      mdParts.push(`${"#".repeat(mdHeadingLevel)} ${line}`);
      continue;
    }

    mdParts.push(line);
  }

  const bodyMarkdown = mdParts.join("\n\n").trim();

  return {
    outline: outline.length > 0 ? outline : ["正文"],
    outlineLevels,
    bodyMarkdown: bodyMarkdown.length > 0 ? bodyMarkdown : "（空白正文）",
  };
}

export type { BlockItem };
